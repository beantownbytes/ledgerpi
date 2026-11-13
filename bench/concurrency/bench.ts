import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { agentDir } from "../../packages/core/src/config.ts";
import { readRegularFile } from "../../packages/core/src/files.ts";

export const MODES = ["distinct", "shared-prefix"] as const;
export type Mode = (typeof MODES)[number];

export const KEY_ENV = "LEDGERPI_BENCH_API_KEY";
export const PROVIDER_ENV = "LEDGERPI_BENCH_PROVIDER";
/** A level counts as the knee once its total tok/s is below this multiple of the previous level's. */
export const KNEE_RATIO = 1.1;
const ERROR_BODY_BYTES = 512;

/** Why a run cannot start; every kind maps to exit 2 and none is raised after the first request is sent. */
export type BenchErrorKind =
	| "usage"
	| "malformed-value"
	| "unknown-arm"
	| "no-provider"
	| "no-base-url"
	| "no-key"
	| "out-exists";

export class BenchConfigError extends Error {
	kind: BenchErrorKind;
	constructor(kind: BenchErrorKind, message: string) {
		super(message);
		this.name = "BenchConfigError";
		this.kind = kind;
	}
}

export interface BenchArgs {
	/** Explicit `--base-url`; resolved against models.json by {@link resolveBaseUrl}. */
	baseUrl: string | undefined;
	/** Explicit `--provider`; combined with {@link PROVIDER_ENV} by {@link resolveProviderName}. */
	provider: string | undefined;
	model: string;
	/** Ascending, de-duplicated. */
	levels: number[];
	inputTokens: number[];
	modes: Mode[];
	maxOutput: number;
	reps: number;
	timeoutS: number;
	out: string | undefined;
}

export const USAGE = `usage: run.ts [--provider ID] [--base-url URL] [--model ID] [--levels 1,2,4,8,15,20] [--input-tokens 16000,48000]
              [--modes distinct,shared-prefix] [--max-output 2048] [--reps 3] [--timeout-s 600] [--out DIR]
The provider is --provider, else ${PROVIDER_ENV}; it is optional only when --base-url is given.
The API key comes from ${KEY_ENV}, else the selected provider's apiKey in models.json.`;

const DEFAULTS = {
	model: "qwen3.8-27b",
	levels: "1,2,4,8,15,20",
	inputTokens: "16000,48000",
	modes: MODES.join(","),
	maxOutput: "2048",
	reps: "3",
	timeoutS: "600",
};

export function malformed(flag: string, raw: string, want: string): BenchConfigError {
	return new BenchConfigError("malformed-value", `--${flag} ${JSON.stringify(raw)}: expected ${want}`);
}

export function positiveInt(flag: string, raw: string): number {
	if (!/^[1-9]\d*$/.test(raw.trim())) throw malformed(flag, raw, "a positive integer");
	return Number(raw.trim());
}

function positiveIntList(flag: string, raw: string): number[] {
	const items = raw.split(",").map((s) => s.trim());
	if (items.every((s) => s === "")) throw malformed(flag, raw, "a non-empty comma-separated list");
	return [...new Set(items.map((s) => positiveInt(flag, s)))];
}

function modeList(raw: string): Mode[] {
	const items = raw.split(",").map((s) => s.trim());
	if (items.every((s) => s === "")) throw malformed("modes", raw, "a non-empty comma-separated list");
	return [
		...new Set(
			items.map((s) => {
				const mode = MODES.find((m) => m === s);
				if (!mode) throw malformed("modes", s, `one of ${MODES.join(", ")}`);
				return mode;
			}),
		),
	];
}

export function positiveSeconds(flag: string, raw: string): number {
	const text = raw.trim();
	if (!/^\d+(\.\d+)?$/.test(text)) throw malformed(flag, raw, "a positive number");
	if ((text.split(".")[1] ?? "").length > 2) throw malformed(flag, raw, "at most 2 decimals");
	const value = Number(text);
	if (!(value > 0)) throw malformed(flag, raw, "a number above 0");
	return value;
}

/**
 * Parse and validate the benchmark command line. No file or network access.
 *
 * @param argv The arguments after the script name.
 * @throws {BenchConfigError} `usage` for an unknown flag, missing value, or positional argument;
 * `malformed-value` for a level or rep that is not a positive integer, an empty list, an unknown
 * mode, or a timeout that is not above 0 with at most 2 decimals.
 */
export function parseBenchArgs(argv: string[]): BenchArgs {
	let values: Record<string, string | boolean | undefined>;
	try {
		({ values } = parseArgs({
			args: argv,
			strict: true,
			allowPositionals: false,
			options: {
				provider: { type: "string" },
				"base-url": { type: "string" },
				model: { type: "string" },
				levels: { type: "string" },
				"input-tokens": { type: "string" },
				modes: { type: "string" },
				"max-output": { type: "string" },
				reps: { type: "string" },
				"timeout-s": { type: "string" },
				out: { type: "string" },
			},
		}));
	} catch (err) {
		throw new BenchConfigError("usage", (err as Error).message);
	}
	const str = (flag: string): string | undefined => values[flag] as string | undefined;
	return {
		provider: str("provider"),
		baseUrl: str("base-url"),
		model: str("model") ?? DEFAULTS.model,
		levels: positiveIntList("levels", str("levels") ?? DEFAULTS.levels).sort((a, b) => a - b),
		inputTokens: positiveIntList("input-tokens", str("input-tokens") ?? DEFAULTS.inputTokens),
		modes: modeList(str("modes") ?? DEFAULTS.modes),
		maxOutput: positiveInt("max-output", str("max-output") ?? DEFAULTS.maxOutput),
		reps: positiveInt("reps", str("reps") ?? DEFAULTS.reps),
		timeoutS: positiveSeconds("timeout-s", str("timeout-s") ?? DEFAULTS.timeoutS),
		out: str("out"),
	};
}

/** One `providers.<id>` entry of pi's models.json; either field may be absent. */
export interface ProviderEntry {
	baseUrl?: string;
	apiKey?: string;
}

/** The default models.json path under pi's agent directory. */
export function modelsJsonPath(): string {
	return join(agentDir(), "models.json");
}

/**
 * The provider id: `flag` when non-blank, else `envValue` when non-blank.
 *
 * @returns The trimmed id, or undefined when neither source names one.
 */
export function resolveProviderName(flag: string | undefined, envValue: string | undefined): string | undefined {
	return flag?.trim() || envValue?.trim() || undefined;
}

/**
 * Read `providers.<name>` from a models.json file.
 *
 * @param name The provider id, a key of the file's `providers` object.
 * @returns The entry's string fields, or an empty entry when the file is absent, unreadable, or malformed.
 * @throws {BenchConfigError} `no-provider` naming `name` when the file parses but has no such provider.
 */
export function loadProvider(name: string, path: string = modelsJsonPath()): ProviderEntry {
	const text = readRegularFile(path);
	if (text === undefined) return {};
	let parsed: { providers?: Record<string, unknown> } | null;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {};
	}
	const providers = parsed?.providers;
	const entry = providers && Object.hasOwn(providers, name) ? providers[name] : undefined;
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new BenchConfigError("no-provider", `provider ${JSON.stringify(name)} is not in ${path} under "providers"`);
	}
	const fields = entry as Record<string, unknown>;
	return {
		baseUrl: typeof fields.baseUrl === "string" ? fields.baseUrl : undefined,
		apiKey: typeof fields.apiKey === "string" ? fields.apiKey : undefined,
	};
}

/**
 * The endpoint base URL: the `--base-url` value, else the provider's, without a trailing slash.
 *
 * @param providerName The provider id named in the error message.
 * @throws {BenchConfigError} `no-base-url` when neither source provides one.
 */
export function resolveBaseUrl(flag: string | undefined, provider: ProviderEntry, providerName = "<id>"): string {
	const url = (flag?.trim() || provider.baseUrl?.trim() || "").replace(/\/+$/, "");
	if (!url) {
		throw new BenchConfigError(
			"no-base-url",
			`no base URL: pass --base-url or set providers.${providerName}.baseUrl in ${modelsJsonPath()}`,
		);
	}
	return url;
}

export function chatCompletionsUrl(baseUrl: string): string {
	return `${baseUrl}/chat/completions`;
}

/**
 * The bearer token: `envKey` when non-empty, else the provider's `apiKey` as written. In pi a
 * provider key starting with `!` is a shell command and one containing `$` is an environment
 * variable reference (`$VAR`, `${VAR}`) or an escape (`$$`, `$!`); the bench neither runs nor
 * expands them and refuses any such key rather than sending it literally.
 *
 * @throws {BenchConfigError} `no-key` naming {@link KEY_ENV}; the message never contains a key.
 */
export function resolveApiKey(envKey: string | undefined, provider: ProviderEntry): string {
	if (envKey) return envKey;
	const key = provider.apiKey?.trim();
	if (key && !key.startsWith("!") && !key.includes("$")) return key;
	const why = key
		? "the provider apiKey uses pi's shell/variable syntax, which the benchmark never runs or expands"
		: "no provider apiKey";
	throw new BenchConfigError("no-key", `no usable API key (${why}): set ${KEY_ENV}`);
}

export interface Usage {
	prompt_tokens: number | null;
	completion_tokens: number;
}

/** What an SSE response body carried, with times in the caller's clock (ms). */
export interface StreamSummary {
	firstTokenAt: number | null;
	lastTokenAt: number | null;
	/** Chunks that carried token text; a lower bound on tokens when no usage chunk arrived. */
	tokenChunks: number;
	usage: Usage | null;
	finishReason: string | null;
	done: boolean;
	error: string | null;
}

/** The fields of one chat-completions stream chunk that the benchmark reads. */
interface StreamChunk {
	error?: { message?: unknown };
	choices?: { delta?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }[];
	usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
}

/** Incremental parser for an OpenAI-style chat-completions SSE stream. */
export class SseParser {
	private buffer = "";
	private state: StreamSummary = {
		firstTokenAt: null,
		lastTokenAt: null,
		tokenChunks: 0,
		usage: null,
		finishReason: null,
		done: false,
		error: null,
	};

	/** Feed decoded text; a line may be split across calls. `now` stamps any token seen in this call. */
	push(text: string, now: number): void {
		this.buffer += text;
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			this.line(this.buffer.slice(0, newline).replace(/\r$/, ""), now);
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
		}
	}

	/** Process a final line that lacked a trailing newline. */
	end(now: number): void {
		const rest = this.buffer.replace(/\r$/, "");
		this.buffer = "";
		this.line(rest, now);
	}

	summary(): StreamSummary {
		return { ...this.state, usage: this.state.usage && { ...this.state.usage } };
	}

	private line(line: string, now: number): void {
		const s = this.state;
		if (s.done || !line.startsWith("data:")) return;
		const payload = line.slice(5).trim();
		if (payload === "[DONE]") {
			s.done = true;
			return;
		}
		let chunk: StreamChunk | null;
		try {
			chunk = JSON.parse(payload);
		} catch {
			s.error ??= "malformed SSE payload";
			return;
		}
		if (chunk?.error) {
			s.error ??= typeof chunk.error.message === "string" ? chunk.error.message : JSON.stringify(chunk.error);
			return;
		}
		const choice = chunk?.choices?.[0];
		const delta = choice?.delta;
		if (nonEmpty(delta?.content) || nonEmpty(delta?.reasoning_content)) {
			s.firstTokenAt ??= now;
			s.lastTokenAt = now;
			s.tokenChunks++;
		}
		if (typeof choice?.finish_reason === "string") s.finishReason = choice.finish_reason;
		if (chunk?.usage && typeof chunk.usage.completion_tokens === "number") {
			s.usage = {
				prompt_tokens: typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : null,
				completion_tokens: chunk.usage.completion_tokens,
			};
		}
	}
}

function nonEmpty(v: unknown): boolean {
	return typeof v === "string" && v !== "";
}

export type Outcome = "ok" | "timeout" | "transport-error" | "http-error" | "stream-error";

/** Everything the runner saw of one request; times are ms on one clock. */
export interface Observation {
	sentAt: number;
	endedAt: number;
	/** The abort timer fired, before headers or mid-stream. */
	timedOut: boolean;
	/** Message of a fetch or body-read failure that was not the timer. */
	transportError: string | null;
	/** Response status, null when no headers arrived. */
	status: number | null;
	/** Body of a non-2xx response; only the first 512 bytes are kept. */
	errorBody: string | null;
	stream: StreamSummary;
}

export interface RequestResult {
	outcome: Outcome;
	status: number | null;
	/** Failure detail for every outcome but `ok`. */
	detail: string | null;
	ttft_ms: number | null;
	/** Per-request decode rate; set only for `ok`, null when first and last token share a timestamp. */
	decode_tps: number | null;
	/** Reported by usage when present, else the token-bearing chunk count. */
	completion_tokens: number;
	prompt_tokens: number | null;
	/** `ok` that stopped before `max-output` tokens. */
	short_output: boolean;
	sent_ms: number;
	ended_ms: number;
}

function truncateBytes(text: string, max: number): string {
	const bytes = new TextEncoder().encode(text);
	return bytes.length <= max ? text : new TextDecoder().decode(bytes.subarray(0, max));
}

/** Per-request decode tok/s: `(completion_tokens - 1) / (t_last - t_first)`, null when the two times are equal or unset. */
export function decodeTps(completionTokens: number, firstAt: number | null, lastAt: number | null): number | null {
	if (firstAt === null || lastAt === null || lastAt === firstAt) return null;
	return (completionTokens - 1) / ((lastAt - firstAt) / 1000);
}

/**
 * Classify one request. Precedence, first match wins: `timeout`, `transport-error`, `http-error`,
 * `stream-error` (2xx but an SSE error payload, no `[DONE]`, no finish_reason, no usage chunk, or no
 * first token), else `ok`.
 */
export function classifyRequest(obs: Observation, maxOutput: number): RequestResult {
	const s = obs.stream;
	const completion = s.usage?.completion_tokens ?? s.tokenChunks;
	const base = {
		status: obs.status,
		ttft_ms: s.firstTokenAt === null ? null : s.firstTokenAt - obs.sentAt,
		completion_tokens: completion,
		prompt_tokens: s.usage?.prompt_tokens ?? null,
		sent_ms: obs.sentAt,
		ended_ms: obs.endedAt,
	};
	const failed = (outcome: Outcome, detail: string): RequestResult => ({
		...base,
		outcome,
		detail,
		decode_tps: null,
		short_output: false,
	});
	if (obs.timedOut) return failed("timeout", "abort timer fired");
	if (obs.transportError !== null) return failed("transport-error", obs.transportError);
	if (obs.status === null) return failed("transport-error", "no response");
	if (obs.status < 200 || obs.status > 299) {
		return failed("http-error", truncateBytes(obs.errorBody ?? "", ERROR_BODY_BYTES));
	}
	const streamFault = s.error
		? s.error
		: !s.done
			? "no [DONE]"
			: s.finishReason === null
				? "no finish_reason"
				: s.usage === null
					? "no usage chunk"
					: s.firstTokenAt === null
						? "no first token"
						: null;
	if (streamFault !== null) return failed("stream-error", streamFault);
	return {
		...base,
		outcome: "ok",
		detail: null,
		decode_tps: decodeTps(completion, s.firstTokenAt, s.lastTokenAt),
		short_output: completion < maxOutput,
	};
}

/** One request's result tagged with the sweep cell it belongs to; one line of results.jsonl. */
export interface ResultRow extends RequestResult {
	mode: Mode;
	/** The requested input size in tokens; `prompt_tokens` is what the server counted. */
	size: number;
	level: number;
	rep: number;
	request: number;
}

/** Nearest-rank percentile (`p` in 0..100); null for an empty list. */
export function percentile(values: number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Seconds from the first send to the last finish of one batch. */
function batchWallS(batch: RequestResult[]): number {
	return (Math.max(...batch.map((r) => r.ended_ms)) - Math.min(...batch.map((r) => r.sent_ms))) / 1000;
}

function okTokens(batch: RequestResult[]): number {
	return batch.filter((r) => r.outcome === "ok").reduce((sum, r) => sum + r.completion_tokens, 0);
}

/** Tokens per second over `batches`: ok completion tokens over the summed batch wall clocks. 0 when no request is ok. */
export function totalTps(...batches: RequestResult[][]): number {
	const tokens = batches.reduce((sum, b) => sum + okTokens(b), 0);
	const wallS = batches.reduce((sum, b) => sum + (b.length === 0 ? 0 : batchWallS(b)), 0);
	return tokens > 0 && wallS > 0 ? tokens / wallS : 0;
}

export interface CellSummary {
	mode: Mode;
	size: number;
	level: number;
	n: number;
	n_ok: number;
	n_short_output: number;
	/** Share of requests that were not `ok`. */
	error_rate: number;
	timeout_rate: number;
	ttft_p50_ms: number | null;
	ttft_p90_ms: number | null;
	decode_tps_p50: number | null;
	/** Ok tokens over batch wall clock, pooled across reps (total ok tokens over total batch wall time). */
	total_tps: number;
	/** decode_tps_p50 at the lowest level over this level's; null when either side has no ok request. */
	slowdown: number | null;
}

export interface GroupSummary {
	mode: Mode;
	size: number;
	cells: CellSummary[];
	/** First level whose total tok/s falls below {@link KNEE_RATIO} times the previous level's, else `not-reached`. */
	knee: number | "not-reached";
}

function cellSummary(mode: Mode, size: number, level: number, rows: ResultRow[]): CellSummary {
	const ok = rows.filter((r) => r.outcome === "ok");
	const reps = new Map<number, ResultRow[]>();
	for (const r of rows) reps.set(r.rep, [...(reps.get(r.rep) ?? []), r]);
	const ttfts = ok.flatMap((r) => (r.ttft_ms === null ? [] : [r.ttft_ms]));
	const rates = ok.flatMap((r) => (r.decode_tps === null ? [] : [r.decode_tps]));
	return {
		mode,
		size,
		level,
		n: rows.length,
		n_ok: ok.length,
		n_short_output: ok.filter((r) => r.short_output).length,
		error_rate: rows.length === 0 ? 0 : (rows.length - ok.length) / rows.length,
		timeout_rate: rows.length === 0 ? 0 : rows.filter((r) => r.outcome === "timeout").length / rows.length,
		ttft_p50_ms: percentile(ttfts, 50),
		ttft_p90_ms: percentile(ttfts, 90),
		decode_tps_p50: percentile(rates, 50),
		total_tps: totalTps(...reps.values()),
		slowdown: null,
	};
}

/**
 * The knee over cells already sorted by ascending level: the first level after the first whose total
 * tok/s is below {@link KNEE_RATIO} times the previous level's. A level with no ok request has
 * throughput 0 and can be the knee.
 */
export function findKnee(cells: Pick<CellSummary, "level" | "total_tps">[]): number | "not-reached" {
	for (let i = 1; i < cells.length; i++) {
		if (cells[i].total_tps < KNEE_RATIO * cells[i - 1].total_tps) return cells[i].level;
	}
	return "not-reached";
}

/** Summarize result rows per (mode, size), each with its cells in ascending level order, slowdown and knee. */
export function summarize(rows: ResultRow[]): GroupSummary[] {
	const groups = new Map<string, ResultRow[]>();
	for (const r of rows) {
		const key = `${r.mode}\u0000${r.size}`;
		groups.set(key, [...(groups.get(key) ?? []), r]);
	}
	return [...groups.values()].map((groupRows) => {
		const { mode, size } = groupRows[0];
		const levels = [...new Set(groupRows.map((r) => r.level))].sort((a, b) => a - b);
		const cells = levels.map((level) =>
			cellSummary(
				mode,
				size,
				level,
				groupRows.filter((r) => r.level === level),
			),
		);
		const base = cells[0]?.decode_tps_p50 ?? null;
		for (const c of cells) {
			c.slowdown = base !== null && c.decode_tps_p50 !== null ? base / c.decode_tps_p50 : null;
		}
		return { mode, size, cells, knee: findKnee(cells) };
	});
}

const INSTRUCTION = "Summarize the code above in detail.";

/** Repeat `filler` to exactly `length` characters. */
function fill(filler: string, length: number): string {
	if (length <= 0 || filler === "") return "";
	return filler.repeat(Math.ceil(length / filler.length)).slice(0, length);
}

/** A fresh request nonce: 16 hex characters. */
export function newNonce(): string {
	return randomBytes(8).toString("hex");
}

/** Characters of filler per prompt token, from one calibration request. */
export function charsPerToken(probeChars: number, probePromptTokens: number): number {
	return probeChars / probePromptTokens;
}

/**
 * A prompt of about `chars` characters.
 *
 * `distinct` starts with the request nonce, so no two requests share a cache prefix. `shared-prefix`
 * starts with a `Batch <batchNonce>` header, then the same filler body, with only the request nonce
 * in a short trailing suffix: requests of one batch share all but the suffix, while two batches
 * differ from the first characters and so never hit each other's prefix cache.
 *
 * @param filler Source text repeated to fill the prompt.
 * @param batchNonce Per-batch token, shared by every request of a batch; used by `shared-prefix` only.
 * @param nonce Per-request token; 16 characters from {@link newNonce}.
 */
export function buildPrompt(mode: Mode, chars: number, filler: string, batchNonce: string, nonce: string): string {
	switch (mode) {
		case "distinct": {
			const head = `Request ${nonce}\n\n`;
			const tail = `\n\n${INSTRUCTION}`;
			return head + fill(filler, chars - head.length - tail.length) + tail;
		}
		case "shared-prefix": {
			const head = `Batch ${batchNonce}\n\n`;
			const tail = `\n\nRequest ${nonce}: ${INSTRUCTION}`;
			return head + fill(filler, chars - head.length - tail.length) + tail;
		}
	}
}

/** The chat-completions request body; `maxOutput` 1 gives the calibration probe. */
export function buildRequestBody(model: string, prompt: string, maxOutput: number): Record<string, unknown> {
	return {
		model,
		messages: [{ role: "user", content: prompt }],
		stream: true,
		stream_options: { include_usage: true },
		temperature: 0,
		max_tokens: maxOutput,
		ignore_eos: true,
		chat_template_kwargs: { enable_thinking: false },
	};
}
