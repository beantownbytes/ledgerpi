import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendRegularFile, readRegularFile, writeRegularFile } from "../../packages/core/src/files.ts";
import {
	type BenchArgs,
	BenchConfigError,
	buildPrompt,
	buildRequestBody,
	charsPerToken,
	chatCompletionsUrl,
	classifyRequest,
	KEY_ENV,
	loadProvider,
	type Mode,
	newNonce,
	type Observation,
	PROVIDER_ENV,
	parseBenchArgs,
	type RequestResult,
	type ResultRow,
	resolveApiKey,
	resolveBaseUrl,
	resolveProviderName,
	SseParser,
	summarize,
	USAGE,
} from "./bench.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILLER_DIR = join(REPO_ROOT, "packages", "core", "src");
const PROBE_CHARS = 4000;
const FILE_MODE = 0o644;

interface Endpoint {
	url: string;
	key: string;
	timeoutS: number;
}

/** The default output directory: a UTC-timestamped folder under the user's state directory, never the repo. */
function defaultOutDir(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(homedir(), ".local", "state", "ledgerpi-bench", "concurrency", stamp);
}

/** Source text from the core package, concatenated in a stable order, used as prompt filler. */
function loadFiller(): string {
	const names = readdirSync(FILLER_DIR)
		.filter((n) => n.endsWith(".ts"))
		.sort();
	const filler = names.map((n) => readRegularFile(join(FILLER_DIR, n)) ?? "").join("\n");
	if (filler.trim() === "") throw new Error(`no filler text found in ${FILLER_DIR}`);
	return filler;
}

/**
 * Send one streaming chat-completions request and record what happened. Never rejects: a timeout,
 * a transport failure, a non-2xx status and a bad stream are all returned in the observation.
 * The bench's own timer is the only one: it starts before the request is created, covers headers
 * through the end of the body, and destroys the request when it fires (`node:http(s)` has no default
 * timeouts of its own).
 */
function observeRequest(endpoint: Endpoint, body: Record<string, unknown>): Promise<Observation> {
	return new Promise((resolve) => {
		const parser = new SseParser();
		const decoder = new TextDecoder("utf-8");
		const sentAt = performance.now();
		let timedOut = false;
		let settled = false;
		let status: number | null = null;
		let errorBody: string | null = null;
		let transportError: string | null = null;
		let req: ClientRequest | undefined;
		let res: IncomingMessage | undefined;

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				sentAt,
				endedAt: performance.now(),
				timedOut,
				transportError,
				status,
				errorBody,
				stream: parser.summary(),
			});
		};
		const abort = () => {
			req?.destroy();
			res?.destroy();
		};
		const fail = (err: unknown) => {
			if (settled) return;
			if (!timedOut) transportError = err instanceof Error ? err.message : String(err);
			abort();
			finish();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			abort();
			finish();
		}, endpoint.timeoutS * 1000);

		try {
			const url = new URL(endpoint.url);
			const send = url.protocol === "https:" ? httpsRequest : httpRequest;
			const json = JSON.stringify(body);
			req = send(
				url,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${endpoint.key}`,
						"content-length": Buffer.byteLength(json),
					},
				},
				(response) => {
					res = response;
					status = response.statusCode ?? null;
					const ok = status !== null && status >= 200 && status <= 299;
					let errorText = "";
					response.on("data", (chunk: Buffer) => {
						const text = decoder.decode(chunk, { stream: true });
						if (ok) parser.push(text, performance.now());
						else errorText += text;
					});
					response.on("end", () => {
						const rest = decoder.decode();
						if (ok) {
							parser.push(rest, performance.now());
							parser.end(performance.now());
						} else {
							errorBody = errorText + rest;
						}
						finish();
					});
					response.on("error", fail);
					response.on("close", () => {
						if (!response.complete) fail(new Error("response closed before the body ended"));
					});
				},
			);
			req.on("error", fail);
			req.end(json);
		} catch (err) {
			fail(err);
		}
	});
}

/** Measure how many filler characters make one prompt token with a single 1-token request. */
async function calibrate(endpoint: Endpoint, model: string, filler: string): Promise<number> {
	const prompt = buildPrompt("distinct", PROBE_CHARS, filler, newNonce(), newNonce());
	const result = classifyRequest(await observeRequest(endpoint, buildRequestBody(model, prompt, 1)), 1);
	if (result.outcome !== "ok" || !result.prompt_tokens) {
		throw new Error(`calibration request failed: ${result.outcome}${result.detail ? ` (${result.detail})` : ""}`);
	}
	return charsPerToken(PROBE_CHARS, result.prompt_tokens);
}

/** Fire `level` requests at once and wait for all of them. */
async function runBatch(
	endpoint: Endpoint,
	args: BenchArgs,
	mode: Mode,
	level: number,
	chars: number,
	filler: string,
): Promise<RequestResult[]> {
	const batchNonce = newNonce();
	return Promise.all(
		Array.from({ length: level }, async () => {
			const prompt = buildPrompt(mode, chars, filler, batchNonce, newNonce());
			const body = buildRequestBody(args.model, prompt, args.maxOutput);
			return classifyRequest(await observeRequest(endpoint, body), args.maxOutput);
		}),
	);
}

async function sweep(args: BenchArgs, endpoint: Endpoint, outDir: string): Promise<ResultRow[]> {
	const filler = loadFiller();
	const resultsPath = join(outDir, "results.jsonl");
	const cpt = await calibrate(endpoint, args.model, filler);
	const rows: ResultRow[] = [];
	for (const mode of args.modes) {
		for (const size of args.inputTokens) {
			const chars = Math.round(size * cpt);
			for (let rep = 1; rep <= args.reps; rep++) {
				for (const level of args.levels) {
					const batch = await runBatch(endpoint, args, mode, level, chars, filler);
					const batchRows = batch.map((r, i): ResultRow => ({ ...r, mode, size, level, rep, request: i + 1 }));
					appendRegularFile(resultsPath, batchRows.map((r) => `${JSON.stringify(r)}\n`).join(""), FILE_MODE);
					rows.push(...batchRows);
					const ok = batch.filter((r) => r.outcome === "ok").length;
					console.error(`${mode} size=${size} rep=${rep} level=${level}: ${ok}/${batch.length} ok`);
				}
			}
		}
	}
	return rows;
}

/**
 * Run the benchmark. Every configuration problem is raised as a {@link BenchConfigError} before the
 * first request; once requests start, per-request failures are recorded as data and do not abort.
 *
 * @returns The directory that received `results.jsonl` and `summary.json`.
 */
export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<string> {
	const args = parseBenchArgs(argv);
	const providerName = resolveProviderName(args.provider, env[PROVIDER_ENV]);
	if (!providerName && !args.baseUrl?.trim()) {
		throw new BenchConfigError(
			"usage",
			`no provider: pass --provider <id> or set ${PROVIDER_ENV}, or pass --base-url`,
		);
	}
	let provider: ReturnType<typeof loadProvider> = {};
	if (providerName) {
		try {
			provider = loadProvider(providerName);
		} catch (err) {
			const absentButUnneeded =
				err instanceof BenchConfigError && err.kind === "no-provider" && args.baseUrl?.trim();
			if (!absentButUnneeded) throw err;
		}
	}
	const baseUrl = resolveBaseUrl(args.baseUrl, provider, providerName);
	const key = resolveApiKey(env[KEY_ENV], provider);
	const outDir = resolve(args.out ?? defaultOutDir());
	if (existsSync(outDir)) throw new BenchConfigError("out-exists", `--out ${outDir} already exists`);
	mkdirSync(outDir, { recursive: true });
	const endpoint: Endpoint = { url: chatCompletionsUrl(baseUrl), key, timeoutS: args.timeoutS };
	const rows = await sweep(args, endpoint, outDir);
	writeRegularFile(join(outDir, "summary.json"), `${JSON.stringify(summarize(rows), null, "\t")}\n`, FILE_MODE);
	return outDir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2), process.env).then(
		(outDir) => {
			console.log(outDir);
		},
		(err: unknown) => {
			if (err instanceof BenchConfigError) {
				console.error(`${err.message}\n${USAGE}`);
				process.exitCode = 2;
			} else {
				console.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
}
