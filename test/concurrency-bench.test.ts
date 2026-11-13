import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BenchConfigError,
	type BenchErrorKind,
	buildPrompt,
	buildRequestBody,
	classifyRequest,
	decodeTps,
	findKnee,
	loadProvider,
	type Observation,
	PROVIDER_ENV,
	parseBenchArgs,
	percentile,
	type ResultRow,
	resolveApiKey,
	resolveBaseUrl,
	resolveProviderName,
	SseParser,
	type StreamSummary,
	summarize,
	totalTps,
} from "../bench/concurrency/bench.ts";

const root = join(tmpdir(), `ledgerpi-concurrency-bench-test-${process.pid}`);
mkdirSync(root, { recursive: true });
process.env.PI_CODING_AGENT_DIR = root;

let failures = 0;
const check = (label: string, cond: boolean, detail: unknown = "") => {
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${JSON.stringify(detail)}`}`);
	if (!cond) failures++;
};

function errorKind(fn: () => unknown): BenchErrorKind | "none" | "other" {
	try {
		fn();
		return "none";
	} catch (err) {
		return err instanceof BenchConfigError ? err.kind : "other";
	}
}

const sse = (payload: unknown) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
const tokenChunk = (content: string, field = "content") => sse({ choices: [{ delta: { [field]: content } }] });
const finishChunk = sse({ choices: [{ delta: {}, finish_reason: "length" }] });
const usageChunk = (completion: number, prompt = 100) =>
	sse({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } });

function parse(chunks: string[], times: number[] = chunks.map((_, i) => 1000 + i * 10)): StreamSummary {
	const p = new SseParser();
	chunks.forEach((c, i) => {
		p.push(c, times[i]);
	});
	p.end(times[times.length - 1] ?? 0);
	return p.summary();
}

function caseArgs() {
	const d = parseBenchArgs([]);
	check("args: defaults", d.levels.join() === "1,2,4,8,15,20" && d.inputTokens.join() === "16000,48000", d);
	check(
		"args: default modes, model, reps, output and timeout",
		d.modes.join() === "distinct,shared-prefix" &&
			d.model === "qwen3.8-27b" &&
			d.maxOutput === 2048 &&
			d.reps === 3 &&
			d.timeoutS === 600,
		d,
	);
	const a = parseBenchArgs(["--levels", "8, 2,2,1", "--modes", "shared-prefix", "--timeout-s", "0.5", "--out", "/x"]);
	check("args: levels sorted and de-duplicated", a.levels.join() === "1,2,8", a.levels);
	check(
		"args: modes, timeout and out parsed",
		a.modes.join() === "shared-prefix" && a.timeoutS === 0.5 && a.out === "/x",
		a,
	);
	check("args: timeout with 2 decimals is accepted", parseBenchArgs(["--timeout-s", "1.25"]).timeoutS === 1.25);
	check("args: --provider is read", parseBenchArgs(["--provider", "local"]).provider === "local");
	check("args: no --provider is undefined", d.provider === undefined, d);

	const usage: string[][] = [["--nope"], ["--levels"], ["extra"], ["--timeout-s", "-1"], ["--provider"]];
	for (const argv of usage)
		check(`args: ${argv.join(" ")} is a usage error`, errorKind(() => parseBenchArgs(argv)) === "usage");
	const bad: string[][] = [
		["--levels", "0"],
		["--levels", "1,-2"],
		["--levels", "1.5"],
		["--levels", "abc"],
		["--levels", ""],
		["--levels", ","],
		["--input-tokens", "0"],
		["--reps", "0"],
		["--reps", "1.5"],
		["--max-output", "0"],
		["--modes", "bogus"],
		["--modes", "distinct,"],
		["--modes", ""],
		["--timeout-s", "0"],
		["--timeout-s", "1.234"],
		["--timeout-s", "abc"],
	];
	for (const argv of bad) {
		check(
			`args: ${argv.join(" ")} is a malformed value`,
			errorKind(() => parseBenchArgs(argv)) === "malformed-value",
		);
	}
}

function caseResolution() {
	const provider = { baseUrl: "https://llm.example/v1/", apiKey: "placeholder" };
	check(
		"base url: flag wins and loses trailing slash",
		resolveBaseUrl("http://127.0.0.1:1/v1//", provider) === "http://127.0.0.1:1/v1",
	);
	check("base url: falls back to the provider", resolveBaseUrl(undefined, provider) === "https://llm.example/v1");
	check("base url: neither source is no-base-url", errorKind(() => resolveBaseUrl(undefined, {})) === "no-base-url");
	check(
		"base url: blank flag falls through to the missing error",
		errorKind(() => resolveBaseUrl("  ", {})) === "no-base-url",
	);
	let baseUrlMessage = "";
	try {
		resolveBaseUrl(undefined, {}, "local");
	} catch (err) {
		baseUrlMessage = (err as Error).message;
	}
	check(
		"base url: the missing error names the selected provider",
		baseUrlMessage.includes("providers.local.baseUrl") && !baseUrlMessage.includes("<id>"),
		baseUrlMessage,
	);

	check("provider name: flag wins over env", resolveProviderName("flag-id", "env-id") === "flag-id");
	check("provider name: env is used without a flag", resolveProviderName(undefined, "env-id") === "env-id");
	check("provider name: a blank flag falls through to env", resolveProviderName("  ", "env-id") === "env-id");
	check("provider name: neither source is undefined", resolveProviderName(undefined, "") === undefined);

	check("key: env wins over the provider", resolveApiKey("env-key", provider) === "env-key");
	check("key: empty env falls back to the provider as written", resolveApiKey("", provider) === "placeholder");
	check("key: unset env falls back to the provider", resolveApiKey(undefined, provider) === "placeholder");
	check("key: no key anywhere is no-key", errorKind(() => resolveApiKey(undefined, {})) === "no-key");
	check(
		"key: empty env and blank provider key is no-key",
		errorKind(() => resolveApiKey("", { apiKey: " " })) === "no-key",
	);
	let message = "";
	try {
		resolveApiKey("", { apiKey: "!secret-command --token hunter2" });
	} catch (err) {
		message = (err as Error).message;
	}
	check("key: a !-prefixed provider key is refused", message !== "");
	check(
		"key: the refusal names the env var and never echoes the key",
		message.includes("LEDGERPI_BENCH_API_KEY") && !message.includes("hunter2") && !message.includes("secret-command"),
		message,
	);
	check("key: env still beats a !-prefixed provider key", resolveApiKey("env-key", { apiKey: "!cmd" }) === "env-key");
	check("key: env still beats a $VAR provider key", resolveApiKey("env-key", { apiKey: "$SOME_VAR" }) === "env-key");
	const refusedKeys: Array<{ label: string; key: string; secret: string }> = [
		{ label: "$VAR", key: "$HUNTER_VAR", secret: "HUNTER_VAR" },
		{ label: "${VAR}", key: "${HUNTER_VAR}", secret: "HUNTER_VAR" },
		{ label: "a$$b", key: "a$$hunterb", secret: "hunterb" },
		{ label: "$!x", key: "$!hunterx", secret: "hunterx" },
	];
	for (const { label, key, secret } of refusedKeys) {
		let refusal: BenchConfigError | undefined;
		try {
			resolveApiKey("", { apiKey: key });
		} catch (err) {
			if (err instanceof BenchConfigError) refusal = err;
		}
		check(`key: a ${label} provider key is no-key`, refusal?.kind === "no-key");
		const text = refusal?.message ?? "";
		check(
			`key: the ${label} refusal names the env var, the syntax, and never echoes the key`,
			text.includes("LEDGERPI_BENCH_API_KEY") &&
				text.includes("shell/variable syntax") &&
				!text.includes(secret) &&
				!text.includes(key),
			text,
		);
	}
	check(
		"key: a blank provider key still says there is no provider apiKey",
		(() => {
			try {
				resolveApiKey("", { apiKey: " " });
			} catch (err) {
				return (err as Error).message.includes("no provider apiKey");
			}
			return false;
		})(),
	);

	writeFileSync(
		join(root, "models.json"),
		JSON.stringify({
			providers: { local: { baseUrl: "http://h/v1", apiKey: "k", other: 1 }, remote: { baseUrl: "http://r/v1" } },
		}),
	);
	const loaded = loadProvider("local");
	check(
		"provider: read from models.json under the agent dir",
		loaded.baseUrl === "http://h/v1" && loaded.apiKey === "k",
		loaded,
	);
	check("provider: a named provider selects its own entry", loadProvider("remote").baseUrl === "http://r/v1");
	check(
		"provider: a provider missing from models.json is no-provider",
		errorKind(() => loadProvider("ghost")) === "no-provider",
	);
	let missingMessage = "";
	try {
		loadProvider("ghost");
	} catch (err) {
		missingMessage = (err as Error).message;
	}
	check("provider: the missing-provider error names it", missingMessage.includes('"ghost"'), missingMessage);
	check(
		"provider: an inherited object key is not a provider",
		errorKind(() => loadProvider("constructor")) === "no-provider",
	);
	writeFileSync(join(root, "models.json"), "{not json");
	check("provider: malformed models.json is an empty entry", Object.keys(loadProvider("local")).length === 0);
	check(
		"provider: absent file is an empty entry",
		loadProvider("local", join(root, "missing.json")).baseUrl === undefined,
	);
}

function caseSse() {
	const full = parse([tokenChunk("Hel"), tokenChunk("lo"), finishChunk, usageChunk(2, 123), "data: [DONE]\n\n"]);
	check(
		"sse: tokens, finish, usage and done are read",
		full.tokenChunks === 2 &&
			full.finishReason === "length" &&
			full.usage?.completion_tokens === 2 &&
			full.usage.prompt_tokens === 123 &&
			full.done &&
			full.error === null,
		full,
	);
	check("sse: first and last token times", full.firstTokenAt === 1000 && full.lastTokenAt === 1010, full);

	const whole = `${tokenChunk("Hello")}${finishChunk}${usageChunk(1)}data: [DONE]\n\n`;
	const split = parse([whole.slice(0, 20), whole.slice(20, 47), whole.slice(47)], [1, 2, 3]);
	check(
		"sse: a chunk boundary mid-line loses nothing",
		split.tokenChunks === 1 && split.firstTokenAt === 3 && split.usage?.completion_tokens === 1 && split.done,
		split,
	);

	const crlf = parse([tokenChunk("a").replace(/\n/g, "\r\n"), "data: [DONE]\r\n\r\n"]);
	check("sse: CRLF line endings", crlf.tokenChunks === 1 && crlf.done, crlf);

	const reasoning = parse(
		[
			tokenChunk("thinking", "reasoning_content"),
			tokenChunk("answer"),
			finishChunk,
			usageChunk(2),
			"data: [DONE]\n\n",
		],
		[5, 9, 9, 9, 9],
	);
	check(
		"sse: reasoning_content counts as the first token",
		reasoning.firstTokenAt === 5 && reasoning.lastTokenAt === 9 && reasoning.tokenChunks === 2,
		reasoning,
	);

	const emptyFirst = parse(
		[sse({ choices: [{ delta: { role: "assistant", content: "" } }] }), tokenChunk("x")],
		[1, 7],
	);
	check("sse: an empty delta is not the first token", emptyFirst.firstTokenAt === 7, emptyFirst);

	const noUsage = parse([tokenChunk("a"), finishChunk, "data: [DONE]\n\n"]);
	check("sse: missing usage leaves it null", noUsage.usage === null && noUsage.done, noUsage);

	const errored = parse([tokenChunk("a"), sse({ error: { message: "engine died" } })]);
	check("sse: an error payload is recorded", errored.error === "engine died" && !errored.done, errored);
	const badJson = parse(["data: {oops\n\n"]);
	check("sse: a malformed payload is an error", badJson.error !== null, badJson);

	const afterDone = parse(["data: [DONE]\n\n", tokenChunk("late")]);
	check("sse: nothing after [DONE] is read", afterDone.tokenChunks === 0 && afterDone.done, afterDone);

	const noNewline = parse([tokenChunk("a"), "data: [DONE]"]);
	check("sse: a final line without a newline is flushed by end()", noNewline.done, noNewline);

	const comments = parse([": keep-alive\n\n", "event: ping\n", tokenChunk("a")]);
	check("sse: comments and event lines are ignored", comments.tokenChunks === 1 && comments.error === null, comments);
}

const MAX = 100;

function obs(over: Partial<Omit<Observation, "stream">> & { stream?: Partial<StreamSummary> }): Observation {
	const { stream, ...rest } = over;
	return {
		sentAt: 1000,
		endedAt: 3000,
		timedOut: false,
		transportError: null,
		status: 200,
		errorBody: null,
		stream: {
			firstTokenAt: 1500,
			lastTokenAt: 2500,
			tokenChunks: 100,
			usage: { prompt_tokens: 16050, completion_tokens: 100 },
			finishReason: "length",
			done: true,
			error: null,
			...stream,
		},
		...rest,
	};
}

function caseClassify() {
	const ok = classifyRequest(obs({}), MAX);
	check(
		"classify: a clean stream is ok with TTFT, decode rate and token counts",
		ok.outcome === "ok" &&
			ok.ttft_ms === 500 &&
			ok.completion_tokens === 100 &&
			ok.prompt_tokens === 16050 &&
			ok.detail === null &&
			!ok.short_output,
		ok,
	);
	check(
		"classify: decode tok/s is (tokens - 1) over first-to-last token time",
		Math.abs((ok.decode_tps ?? 0) - 99) < 1e-9,
		ok.decode_tps,
	);

	const short = classifyRequest(obs({ stream: { usage: { prompt_tokens: 10, completion_tokens: 40 } } }), MAX);
	check(
		"classify: fewer tokens than max-output stays ok, flagged short_output",
		short.outcome === "ok" && short.short_output,
		short,
	);

	const timeout = classifyRequest(
		obs({
			timedOut: true,
			endedAt: 9000,
			status: 200,
			stream: { done: false, usage: null, finishReason: null, tokenChunks: 7 },
		}),
		MAX,
	);
	check(
		"classify: timeout keeps TTFT and the partial token count",
		timeout.outcome === "timeout" &&
			timeout.ttft_ms === 500 &&
			timeout.completion_tokens === 7 &&
			timeout.decode_tps === null,
		timeout,
	);
	const timeoutNoHeaders = classifyRequest(
		obs({
			timedOut: true,
			status: null,
			stream: {
				firstTokenAt: null,
				lastTokenAt: null,
				tokenChunks: 0,
				usage: null,
				done: false,
				finishReason: null,
			},
		}),
		MAX,
	);
	check(
		"classify: timeout before headers is a timeout with no TTFT",
		timeoutNoHeaders.outcome === "timeout" && timeoutNoHeaders.ttft_ms === null,
		timeoutNoHeaders,
	);
	const timeoutOverThrow = classifyRequest(obs({ timedOut: true, transportError: "aborted", status: 500 }), MAX);
	check(
		"classify: timeout wins over a transport error and a bad status",
		timeoutOverThrow.outcome === "timeout",
		timeoutOverThrow,
	);

	const transport = classifyRequest(obs({ transportError: "ECONNRESET", status: null }), MAX);
	check(
		"classify: a thrown fetch is a transport-error with its message",
		transport.outcome === "transport-error" && transport.detail === "ECONNRESET",
		transport,
	);
	const transportOverHttp = classifyRequest(obs({ transportError: "terminated", status: 500 }), MAX);
	check(
		"classify: transport-error wins over http-error",
		transportOverHttp.outcome === "transport-error",
		transportOverHttp,
	);
	check(
		"classify: no headers and no throw is a transport-error",
		classifyRequest(obs({ status: null }), MAX).outcome === "transport-error",
	);

	const http = classifyRequest(obs({ status: 500, errorBody: "x".repeat(2000) }), MAX);
	check(
		"classify: non-2xx is http-error with the body cut to 512 bytes",
		http.outcome === "http-error" && http.status === 500 && http.detail?.length === 512,
		http.detail?.length,
	);
	const multibyte = classifyRequest(obs({ status: 401, errorBody: "é".repeat(400) }), MAX);
	check(
		"classify: the body cut is by bytes",
		new TextEncoder().encode(multibyte.detail ?? "").length <= 512,
		multibyte.detail?.length,
	);
	check("classify: 401 and 301 are http-errors", classifyRequest(obs({ status: 301 }), MAX).outcome === "http-error");
	const httpOverStream = classifyRequest(obs({ status: 503, stream: { error: "e" } }), MAX);
	check("classify: http-error wins over stream-error", httpOverStream.outcome === "http-error", httpOverStream);

	const faults: [string, Partial<StreamSummary>][] = [
		["an SSE error payload", { error: "engine died" }],
		["no [DONE]", { done: false }],
		["no finish_reason", { finishReason: null }],
		["no usage chunk", { usage: null }],
		["no first token", { firstTokenAt: null, lastTokenAt: null, tokenChunks: 0 }],
	];
	for (const [label, stream] of faults) {
		const r = classifyRequest(obs({ stream }), MAX);
		check(
			`classify: 2xx with ${label} is a stream-error`,
			r.outcome === "stream-error" && r.decode_tps === null && !r.short_output,
			r,
		);
	}

	check("decode tok/s: null when first and last token share a timestamp", decodeTps(1, 1500, 1500) === null);
	const single = classifyRequest(obs({ stream: { lastTokenAt: 1500 } }), MAX);
	check(
		"decode tok/s: a request whose t_last equals t_first is ok with a null rate",
		single.outcome === "ok" && single.decode_tps === null,
		single,
	);
	check("decode tok/s: null without a first token", decodeTps(0, null, null) === null);
}

function row(over: Partial<ResultRow>): ResultRow {
	return {
		outcome: "ok",
		status: 200,
		detail: null,
		ttft_ms: 100,
		decode_tps: 50,
		completion_tokens: 100,
		prompt_tokens: 1000,
		short_output: false,
		sent_ms: 0,
		ended_ms: 1000,
		mode: "distinct",
		size: 16000,
		level: 1,
		rep: 1,
		request: 0,
		...over,
	};
}

function caseSummary() {
	const v = [15, 20, 35, 40, 50];
	check("percentile: nearest rank p50 and p90", percentile(v, 50) === 35 && percentile(v, 90) === 50, [
		percentile(v, 50),
		percentile(v, 90),
	]);
	check(
		"percentile: input order does not matter and p0..p100 clamp",
		percentile([50, 15, 40], 50) === 40 && percentile([3], 90) === 3 && percentile([1, 2], 0) === 1,
	);
	check("percentile: empty list is null", percentile([], 50) === null);

	const batch = [
		row({ sent_ms: 100, ended_ms: 1100, completion_tokens: 100 }),
		row({ sent_ms: 100, ended_ms: 2100, completion_tokens: 300 }),
	];
	check("total tok/s: ok tokens over first send to last finish", totalTps(batch) === 200, totalTps(batch));
	const mixed = [...batch, row({ outcome: "timeout", ended_ms: 9000, completion_tokens: 50 })];
	check(
		"total tok/s: non-ok rows add no tokens but do stretch the wall clock",
		Math.abs(totalTps(mixed) - 400 / 9) < 1e-9,
		totalTps(mixed),
	);
	check("total tok/s: no ok request is 0", totalTps([row({ outcome: "http-error" })]) === 0);

	const knee = (tps: number[]) => findKnee(tps.map((total_tps, i) => ({ level: [1, 2, 4, 8][i], total_tps })));
	check("knee: first level under 1.10x the previous", knee([100, 190, 200, 210]) === 4, knee([100, 190, 200, 210]));
	check("knee: 1.11x is not below, 1.09x is", knee([100, 111, 123]) === "not-reached" && knee([100, 109]) === 2);
	check("knee: still scaling is not-reached", knee([100, 200, 400, 800]) === "not-reached");
	check(
		"knee: a level with n_ok == 0 (throughput 0) can be the knee",
		knee([100, 200, 0, 0]) === 4,
		knee([100, 200, 0, 0]),
	);
	check("knee: the first level cannot be the knee", knee([0, 0]) === "not-reached");
	check("knee: a single level is not-reached", knee([100]) === "not-reached");

	const rows: ResultRow[] = [
		row({ level: 1, request: 0, ttft_ms: 100, decode_tps: 60, sent_ms: 0, ended_ms: 2000 }),
		row({ level: 2, request: 0, ttft_ms: 200, decode_tps: 30, sent_ms: 0, ended_ms: 2000 }),
		row({ level: 2, request: 1, ttft_ms: 400, decode_tps: 20, sent_ms: 0, ended_ms: 2000, short_output: true }),
		row({ level: 4, request: 0, outcome: "http-error", ttft_ms: null, decode_tps: null }),
		row({ level: 4, request: 1, outcome: "timeout", ttft_ms: null, decode_tps: null, ended_ms: 5000 }),
		row({ level: 1, mode: "shared-prefix", decode_tps: 10 }),
	];
	const groups = summarize(rows);
	check(
		"summary: one group per mode and size",
		groups.length === 2,
		groups.map((g) => [g.mode, g.size]),
	);
	const g = groups[0];
	check(
		"summary: cells in ascending level order",
		g.cells.map((c) => c.level).join() === "1,2,4",
		g.cells.map((c) => c.level),
	);
	const [c1, c2, c4] = g.cells;
	check(
		"summary: counts, short_output and rates",
		c1.n === 1 &&
			c1.n_ok === 1 &&
			c2.n === 2 &&
			c2.n_short_output === 1 &&
			c4.n === 2 &&
			c4.n_ok === 0 &&
			c4.error_rate === 1 &&
			c4.timeout_rate === 0.5,
		g.cells,
	);
	check(
		"summary: TTFT and decode percentiles come from ok rows only",
		c2.ttft_p50_ms === 200 &&
			c2.ttft_p90_ms === 400 &&
			c2.decode_tps_p50 === 20 &&
			c4.ttft_p50_ms === null &&
			c4.decode_tps_p50 === null,
		g.cells,
	);
	check(
		"summary: total tok/s per cell",
		c1.total_tps === 50 && c2.total_tps === 100 && c4.total_tps === 0,
		g.cells.map((c) => c.total_tps),
	);
	check(
		"summary: slowdown is lowest-level p50 over this level's, null without ok requests",
		c1.slowdown === 1 && c2.slowdown === 3 && c4.slowdown === null,
		g.cells.map((c) => c.slowdown),
	);
	check("summary: knee is the first level whose throughput falls", g.knee === 4, g.knee);
	check(
		"summary: knee not-reached for a single level",
		groups[1].knee === "not-reached" && groups[1].cells[0].slowdown === 1,
		groups[1],
	);

	const noBase = summarize([
		row({ level: 1, outcome: "http-error", decode_tps: null }),
		row({ level: 2, decode_tps: 40 }),
	])[0];
	check(
		"summary: slowdown null when the lowest level has no ok request",
		noBase.cells[1].slowdown === null,
		noBase.cells,
	);

	const twoReps = summarize([
		row({ rep: 1, sent_ms: 0, ended_ms: 1000 }),
		row({ rep: 2, sent_ms: 5000, ended_ms: 7000 }),
	])[0].cells[0];
	check(
		"summary: reps are independent batches, not one long wall clock",
		Math.abs(twoReps.total_tps - 200 / 3) < 1e-9,
		twoReps.total_tps,
	);
}

function casePrompts() {
	const filler = "const answer = 42;\n";
	const batchA = "1111111111111111";
	const batchB = "2222222222222222";
	const distinctA = buildPrompt("distinct", 4000, filler, batchA, "aaaaaaaaaaaaaaaa");
	const distinctB = buildPrompt("distinct", 4000, filler, batchA, "bbbbbbbbbbbbbbbb");
	check(
		"prompt: distinct requests differ from the first characters",
		distinctA.slice(0, 20) !== distinctB.slice(0, 20),
		[distinctA.slice(0, 20), distinctB.slice(0, 20)],
	);
	check("prompt: distinct starts with the nonce", distinctA.startsWith("Request aaaaaaaaaaaaaaaa"));
	check(
		"prompt: distinct ignores the batch nonce",
		buildPrompt("distinct", 4000, filler, batchB, "aaaaaaaaaaaaaaaa") === distinctA,
	);
	const sharedA = buildPrompt("shared-prefix", 4000, filler, batchA, "aaaaaaaaaaaaaaaa");
	const sharedB = buildPrompt("shared-prefix", 4000, filler, batchA, "bbbbbbbbbbbbbbbb");
	const sharedOtherBatch = buildPrompt("shared-prefix", 4000, filler, batchB, "aaaaaaaaaaaaaaaa");
	const commonPrefix = (x: string, y: string) => {
		let n = 0;
		while (n < x.length && x[n] === y[n]) n++;
		return n;
	};
	const common = commonPrefix(sharedA, sharedB);
	check(
		"prompt: shared-prefix requests of one batch share all but a short suffix",
		common > 3900 && sharedA !== sharedB,
		common,
	);
	const crossBatch = commonPrefix(sharedA, sharedOtherBatch);
	check("prompt: shared-prefix batches differ from the first characters", crossBatch < 30, crossBatch);
	check("prompt: shared-prefix starts with the batch nonce", sharedA.startsWith(`Batch ${batchA}`));
	check(
		"prompt: shared-prefix ends with the request nonce and instruction",
		sharedA.endsWith("\n\nRequest aaaaaaaaaaaaaaaa: Summarize the code above in detail."),
	);
	for (const p of [distinctA, distinctB, sharedA, sharedB, sharedOtherBatch])
		check("prompt: length is the requested size", p.length === 4000, p.length);
	check(
		"prompt: empty filler degrades to no body",
		buildPrompt("distinct", 100, "", batchA, "aaaaaaaaaaaaaaaa").includes("aaaaaaaaaaaaaaaa"),
	);

	const body = buildRequestBody("m", "hi", 128) as any;
	check(
		"body: streaming with usage, greedy, no EOS stop, thinking off",
		body.stream === true &&
			body.stream_options.include_usage === true &&
			body.temperature === 0 &&
			body.ignore_eos === true &&
			body.chat_template_kwargs.enable_thinking === false,
		body,
	);
	check(
		"body: model, prompt and token cap",
		body.model === "m" &&
			body.max_tokens === 128 &&
			body.messages[0].role === "user" &&
			body.messages[0].content === "hi",
		body,
	);
}

const runEntry = fileURLToPath(new URL("../bench/concurrency/run.ts", import.meta.url));
const childAgentDir = join(root, "child-agent");
mkdirSync(childAgentDir, { recursive: true });

type StubBehavior = "ok" | "http-500" | "stall" | "probe-500";

interface Stub {
	baseUrl: string;
	behavior: StubBehavior;
	received: number;
	/** Method, path and authorization header of every request, in arrival order. */
	requests: { method: string | undefined; url: string | undefined; auth: string | undefined }[];
	close(): Promise<void>;
}

const sendOk = (res: ServerResponse, promptTokens: number, completionTokens: number) => {
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.write(tokenChunk("a"));
	res.write(tokenChunk("b"));
	res.write(finishChunk);
	res.write(usageChunk(completionTokens, promptTokens));
	res.end("data: [DONE]\n\n");
};

/**
 * An SSE stub on 127.0.0.1. Requests with `max_tokens` 1 are the run's calibration probe and succeed
 * unless the behavior is `probe-500`.
 */
async function startStub(): Promise<Stub> {
	const stub: Stub = { baseUrl: "", behavior: "ok", received: 0, requests: [], close: async () => {} };
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		stub.received++;
		stub.requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
		let raw = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			raw += chunk;
		});
		req.on("end", () => {
			const body = JSON.parse(raw) as { max_tokens: number; messages: { content: string }[] };
			const promptTokens = Math.ceil(body.messages[0].content.length / 4);
			if (stub.behavior === "probe-500") {
				res.writeHead(500, { "content-type": "text/plain" });
				return void res.end("boom");
			}
			if (body.max_tokens === 1 || stub.behavior === "ok") return sendOk(res, promptTokens, body.max_tokens);
			if (stub.behavior === "http-500") {
				res.writeHead(500, { "content-type": "text/plain" });
				return void res.end("boom");
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(tokenChunk("a"));
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	stub.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	stub.close = () =>
		new Promise<void>((done) => {
			server.close(() => done());
			server.closeAllConnections();
		});
	return stub;
}

interface ChildResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function writeProviderAgentDir(name: string, baseUrl: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify({
			providers: { local: { baseUrl, apiKey: "k" }, unreachable: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k" } },
		}),
	);
	return dir;
}

function runBench(
	args: string[],
	agentDir = childAgentDir,
	extraEnv: Record<string, string> = {},
): Promise<ChildResult> {
	return new Promise((done) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", runEntry, ...args], {
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				LEDGERPI_BENCH_API_KEY: "test-key",
				[PROVIDER_ENV]: "",
				...extraEnv,
			},
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("close", (code) => done({ code, stdout, stderr }));
	});
}

const readRows = (out: string): ResultRow[] =>
	readFileSync(join(out, "results.jsonl"), "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as ResultRow);

const SMALL_SWEEP = ["--modes", "distinct", "--input-tokens", "200", "--max-output", "8", "--reps", "1"];

async function caseBoundaryRejections(stub: Stub) {
	const emptyAgentDir = join(root, "empty-agent");
	mkdirSync(emptyAgentDir, { recursive: true });
	const providerAgentDir = writeProviderAgentDir("provider-agent", stub.baseUrl);
	const cases: [string, string[], string?][] = [
		["an unknown flag", ["--base-url", stub.baseUrl, "--bogus"]],
		["a non-numeric --levels", ["--base-url", stub.baseUrl, "--levels", "abc"]],
		["level 0", ["--base-url", stub.baseUrl, "--levels", "0"]],
		["a missing base URL", [], emptyAgentDir],
		["a provider missing from models.json", ["--provider", "ghost"], providerAgentDir],
		["a named provider with no baseUrl and no models.json", ["--provider", "local"], emptyAgentDir],
	];
	for (const [label, args, agentDir] of cases) {
		const before = stub.received;
		const result = await runBench(args, agentDir);
		check(`boundary: ${label} exits 2`, result.code === 2, result);
		check(`boundary: ${label} sends no request`, stub.received === before, stub.received - before);
	}
	check("boundary: rejections reached the stub zero times", stub.received === 0, stub.received);

	const noProvider = await runBench([], emptyAgentDir);
	check(
		"boundary: no provider and no --base-url is a usage error naming the flag and env var",
		noProvider.code === 2 && noProvider.stderr.includes("--provider") && noProvider.stderr.includes(PROVIDER_ENV),
		noProvider,
	);
	const ghost = await runBench(["--provider", "ghost"], providerAgentDir);
	check(
		"boundary: a provider missing from models.json is named in the error",
		ghost.stderr.includes('"ghost"') && ghost.stderr.includes("models.json"),
		ghost.stderr,
	);
	const noUrl = await runBench(["--provider", "local"], emptyAgentDir);
	check(
		"boundary: the no-base-url error names the selected provider",
		noUrl.stderr.includes("providers.local.baseUrl"),
		noUrl.stderr,
	);
}

async function caseBoundaryProvider(stub: Stub) {
	stub.behavior = "ok";
	const agentDir = writeProviderAgentDir("provider-sweep-agent", stub.baseUrl);
	const flagWins = join(root, "out-provider-flag");
	let before = stub.received;
	const byFlag = await runBench(
		["--provider", "local", "--levels", "1", ...SMALL_SWEEP, "--out", flagWins],
		agentDir,
		{
			[PROVIDER_ENV]: "unreachable",
		},
	);
	check(
		"boundary: --provider wins over the env var and selects the entry",
		byFlag.code === 0 && stub.received > before,
		byFlag,
	);
	const byEnv = join(root, "out-provider-env");
	before = stub.received;
	const fromEnv = await runBench(["--levels", "1", ...SMALL_SWEEP, "--out", byEnv], agentDir, {
		[PROVIDER_ENV]: "local",
	});
	check("boundary: the env var selects the provider alone", fromEnv.code === 0 && stub.received > before, fromEnv);
	const unreachableOut = join(root, "out-provider-unreachable");
	before = stub.received;
	const wrong = await runBench(
		["--provider", "unreachable", "--levels", "1", ...SMALL_SWEEP, "--out", unreachableOut],
		agentDir,
	);
	check("boundary: a different provider uses its own base URL", wrong.code === 1 && stub.received === before, wrong);
	const withUrl = join(root, "out-provider-optional");
	before = stub.received;
	const noProvider = await runBench(["--base-url", stub.baseUrl, "--levels", "1", ...SMALL_SWEEP, "--out", withUrl]);
	check(
		"boundary: --base-url makes the provider optional",
		noProvider.code === 0 && stub.received > before,
		noProvider,
	);
	const absentOut = join(root, "out-provider-absent-with-url");
	before = stub.received;
	const absentWithUrl = await runBench(
		["--base-url", stub.baseUrl, "--levels", "1", ...SMALL_SWEEP, "--out", absentOut],
		agentDir,
		{ [PROVIDER_ENV]: "ghost" },
	);
	check(
		"boundary: --base-url ignores a named provider that models.json lacks",
		absentWithUrl.code === 0 && stub.received > before,
		absentWithUrl,
	);
	before = stub.received;
	const absentNoKey = await runBench(
		[
			"--base-url",
			stub.baseUrl,
			"--provider",
			"ghost",
			"--levels",
			"1",
			...SMALL_SWEEP,
			"--out",
			join(root, "out-nokey"),
		],
		agentDir,
		{ LEDGERPI_BENCH_API_KEY: "" },
	);
	check(
		"boundary: an absent provider with --base-url and no API key still exits 2 before any request",
		absentNoKey.code === 2 && stub.received === before,
		absentNoKey,
	);
}

async function caseBoundaryRefusals(stub: Stub) {
	const existingOut = join(root, "out-existing");
	mkdirSync(existingOut, { recursive: true });
	writeFileSync(join(existingOut, "sentinel.txt"), "keep me");
	const listingBefore = readdirSync(existingOut).sort().join();
	let before = stub.received;
	const existing = await runBench(["--base-url", stub.baseUrl, "--levels", "1", ...SMALL_SWEEP, "--out", existingOut]);
	check("boundary: an existing --out exits 2", existing.code === 2, existing);
	check("boundary: an existing --out sends no request", stub.received === before, stub.received - before);
	check(
		"boundary: an existing --out is left untouched",
		readdirSync(existingOut).sort().join() === listingBefore &&
			readFileSync(join(existingOut, "sentinel.txt"), "utf8") === "keep me",
		readdirSync(existingOut),
	);

	const shellKeyAgentDir = join(root, "shell-key-agent");
	mkdirSync(shellKeyAgentDir, { recursive: true });
	writeFileSync(
		join(shellKeyAgentDir, "models.json"),
		JSON.stringify({ providers: { local: { baseUrl: stub.baseUrl, apiKey: "!echo x" } } }),
	);
	before = stub.received;
	const shellKey = await runBench(["--provider", "local", "--levels", "1", ...SMALL_SWEEP], shellKeyAgentDir, {
		LEDGERPI_BENCH_API_KEY: "",
	});
	check("boundary: an unusable provider key exits 2", shellKey.code === 2, shellKey);
	check("boundary: an unusable provider key sends no request", stub.received === before, stub.received - before);
	check(
		"boundary: the unusable-key error names the env var and never echoes the key",
		shellKey.stderr.includes("LEDGERPI_BENCH_API_KEY") && !shellKey.stderr.includes("echo x"),
		shellKey.stderr,
	);
}

async function caseBoundarySweep(stub: Stub) {
	stub.behavior = "ok";
	const out = join(root, "out-ok");
	const result = await runBench(["--base-url", stub.baseUrl, "--levels", "1,2", ...SMALL_SWEEP, "--out", out]);
	check(
		"boundary: a clean sweep exits 0 and prints the out dir",
		result.code === 0 && result.stdout.trim() === out,
		result,
	);
	check(
		"boundary: every request is a POST to /v1/chat/completions with the bearer key",
		stub.requests.length > 0 &&
			stub.requests.every(
				(r) => r.method === "POST" && r.url === "/v1/chat/completions" && r.auth === "Bearer test-key",
			),
		stub.requests,
	);
	const rows = readRows(out);
	check(
		"boundary: 3 ok rows at levels 1 and 2",
		rows.length === 3 &&
			rows.every((r) => r.outcome === "ok" && r.mode === "distinct" && r.completion_tokens === 8) &&
			rows.filter((r) => r.level === 1).length === 1 &&
			rows.filter((r) => r.level === 2).length === 2,
		rows,
	);
	const groups = JSON.parse(readFileSync(join(out, "summary.json"), "utf8")) as ReturnType<typeof summarize>;
	const cells = groups[0]?.cells ?? [];
	check(
		"boundary: summary.json has one group with cells for levels 1 and 2",
		groups.length === 1 &&
			groups[0].mode === "distinct" &&
			groups[0].size === 200 &&
			cells.map((c) => c.level).join() === "1,2" &&
			cells.map((c) => c.n_ok).join() === "1,2" &&
			cells.every((c) => c.error_rate === 0 && c.total_tps > 0),
		groups,
	);
}

async function caseBoundaryCalibrationFailure(stub: Stub) {
	stub.behavior = "probe-500";
	const out = join(root, "out-probe-500");
	const before = stub.received;
	const result = await runBench(["--base-url", stub.baseUrl, "--levels", "1", ...SMALL_SWEEP, "--out", out]);
	check("boundary: a failing calibration probe exits 1", result.code === 1, result);
	check(
		"boundary: the calibration failure is named on stderr",
		result.stderr.includes("calibration request failed"),
		result.stderr,
	);
	check("boundary: only the probe was sent", stub.received - before === 1, stub.received - before);
	check("boundary: no results.jsonl is written", !existsSync(join(out, "results.jsonl")), readdirSync(out));
}

async function caseBoundaryHttpError(stub: Stub) {
	stub.behavior = "http-500";
	const out = join(root, "out-500");
	const result = await runBench(["--base-url", stub.baseUrl, "--levels", "1,2", ...SMALL_SWEEP, "--out", out]);
	check("boundary: a 500 from the server still exits 0", result.code === 0, result);
	const rows = readRows(out);
	check(
		"boundary: every non-probe request is an http-error that keeps the body",
		rows.length === 3 && rows.every((r) => r.outcome === "http-error" && r.status === 500 && r.detail === "boom"),
		rows,
	);
}

async function caseBoundaryTimeout(stub: Stub) {
	stub.behavior = "stall";
	const out = join(root, "out-stall");
	const result = await runBench([
		"--base-url",
		stub.baseUrl,
		"--levels",
		"1,2",
		...SMALL_SWEEP,
		"--timeout-s",
		"0.5",
		"--out",
		out,
	]);
	check("boundary: stalled requests still exit 0", result.code === 0, result);
	const rows = readRows(out);
	check(
		"boundary: a stall past --timeout-s is a timeout that keeps the first-token TTFT",
		rows.length === 3 &&
			rows.every((r) => r.outcome === "timeout" && typeof r.ttft_ms === "number" && r.ttft_ms >= 0),
		rows,
	);
}

async function main() {
	caseArgs();
	caseResolution();
	caseSse();
	caseClassify();
	caseSummary();
	casePrompts();

	const stub = await startStub();
	try {
		await caseBoundaryRejections(stub);
		await caseBoundaryRefusals(stub);
		await caseBoundarySweep(stub);
		await caseBoundaryProvider(stub);
		await caseBoundaryCalibrationFailure(stub);
		await caseBoundaryHttpError(stub);
		await caseBoundaryTimeout(stub);
	} finally {
		await stub.close();
	}

	rmSync(root, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
