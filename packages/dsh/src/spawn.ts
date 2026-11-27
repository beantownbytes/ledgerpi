import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DshConfig } from "../../core/src/config.ts";
import type { RoleTally } from "../../core/src/solve.ts";
import {
	type SpawnFailureDetail,
	type SpawnFn,
	type SpawnOptions,
	type SpawnResult,
	WORKER_SENTINEL,
} from "../../core/src/spawn.ts";
import {
	type DshAgent,
	type DshEvents,
	type DshLlm,
	type DshRole,
	type DshSubagentActivation,
	type DshSubagentResult,
	type DshSubagents,
	isWithin,
	LEDGER_PRESETS,
	parentRoute,
	realPathOrNull,
} from "./dsh.ts";

const DEFAULT_EFFORT = "high";
const DISPOSE_WAIT_MS = 10_000;

/** The effort to send for a role, or why the role cannot be started. */
export type DshEffort = { kind: "send"; reasoningEffort: string | undefined } | { kind: "refused"; message: string };

/** The models and efforts of one run. */
export interface DshRoles {
	/** The `provider/modelId` each role runs on, or null for the session model. */
	models: Readonly<Record<DshRole, string | null>>;
	/** The effort for `role` on its current route, checked once per run for each route. */
	effort(role: DshRole): Promise<DshEffort>;
}

export interface DshRolesOptions {
	parent: DshAgent;
	/** Absent means efforts are sent unchecked. */
	llm: DshLlm | undefined;
	dsh: DshConfig;
	/** The call's own model refs, already validated; absent or empty means none. */
	requested: Partial<Record<DshRole, string>>;
	/** Cancels the model checks. */
	signal?: AbortSignal;
}

/** What the spawner needs from one run. */
export interface DshSpawnerContext {
	parent: DshAgent;
	subagents: DshSubagents;
	events: DshEvents;
	roles: DshRoles;
	/** The real path of the run directory. */
	runPath: string;
	ledgerDir: string;
	/** The live ledger children by session id; each spawn adds its child and removes it once the child is gone. */
	children: Map<string, DshRole>;
	/** How long to wait for a child to be disposed; 10 seconds when absent. */
	disposeWaitMs?: number;
}

type StopCause = "aborted" | "timeout";

type Failure = SpawnResult & { ok: false };

const failure = (detail: SpawnFailureDetail, error: string): Failure => ({ ok: false, detail, error });

const stoppedBy = (cause: StopCause, timeoutMs: number): Failure =>
	failure(cause, cause === "aborted" ? "aborted" : `timed out after ${timeoutMs} ms`);

/** The message of a thrown value. */
export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const errorCode = (err: unknown): string | undefined => {
	const code = (err as { code?: unknown } | null | undefined)?.code;
	return typeof code === "string" ? code : undefined;
};

function splitRef(ref: string): { provider: string; model: string } {
	const slash = ref.indexOf("/");
	return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

async function checkEffort(
	llm: DshLlm,
	route: { provider: string; model: string },
	configured: string | null,
	signal: AbortSignal | undefined,
): Promise<DshEffort> {
	const reasoningEffort = configured ?? DEFAULT_EFFORT;
	try {
		await llm.resolveCallConfig({ ...route, reasoningEffort }, signal);
		return { kind: "send", reasoningEffort };
	} catch (err) {
		if (configured !== null || errorCode(err) !== "UNSUPPORTED_REASONING_EFFORT") {
			return { kind: "refused", message: errorText(err) };
		}
	}
	try {
		await llm.resolveCallConfig(route, signal);
		return { kind: "send", reasoningEffort: undefined };
	} catch (err) {
		return { kind: "refused", message: errorText(err) };
	}
}

/**
 * Settle each role's model (the call's ref, else the `[dsh]` ref, else the session
 * model) and its reasoning effort. An unset `[dsh]` effort means `high`, dropped when
 * the model rejects it; a configured one the model rejects refuses the role.
 */
export function dshRoles({ parent, llm, dsh, requested, signal }: DshRolesOptions): DshRoles {
	const models = {
		manager: requested.manager || dsh.manager,
		worker: requested.worker || dsh.worker,
	};
	const checked = new Map<string, Promise<DshEffort>>();
	return {
		models,
		async effort(role) {
			const configured = dsh[`${role}Effort`];
			const ref = models[role];
			const { provider, model } = ref === null ? parentRoute(parent) : splitRef(ref);
			if (llm === undefined || !provider || !model) {
				return { kind: "send", reasoningEffort: configured ?? DEFAULT_EFFORT };
			}
			const key = JSON.stringify([role, provider, model]);
			let effort = checked.get(key);
			if (effort === undefined) {
				effort = checkEffort(llm, { provider, model }, configured, signal);
				checked.set(key, effort);
			}
			return effort;
		},
	};
}

/** `work`'s value, or null as soon as `signal` aborts. */
async function unlessAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
	if (signal === undefined) return work;
	let onAbort = () => {};
	const aborted = new Promise<null>((resolve) => {
		onAbort = () => resolve(null);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([aborted, work]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** Watch for whichever comes first of the caller's abort and the call timeout. */
function watchStop(signal: AbortSignal | undefined, timeoutMs: number) {
	const timer = new AbortController();
	let cause: StopCause | null = null;
	let settle: (why: StopCause) => void = () => {};
	const stopped = new Promise<StopCause>((resolve) => {
		settle = resolve;
	});
	const stop = (why: StopCause) => {
		cause ??= why;
		settle(cause);
	};
	const onAbort = () => stop("aborted");
	signal?.addEventListener("abort", onAbort, { once: true });
	const handle = setTimeout(() => {
		stop("timeout");
		timer.abort();
	}, timeoutMs);
	return {
		startup: signal ? AbortSignal.any([signal, timer.signal]) : timer.signal,
		stopped,
		cause: (): StopCause | null => cause,
		clear: () => {
			clearTimeout(handle);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

/** Dispose a child; a teardown failure never changes how its spawn ended. */
async function dispose(activation: DshSubagentActivation): Promise<void> {
	try {
		await activation.dispose();
	} catch {}
}

async function waitAtMost(work: Promise<void>, ms: number): Promise<void> {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<void>((resolve) => {
		handle = setTimeout(resolve, ms);
	});
	await Promise.race([work, limit]);
	clearTimeout(handle);
}

function settledResult(role: DshRole, result: DshSubagentResult, turnError: string | undefined): SpawnResult {
	if (result.stopReason !== "completed") {
		return failure("agent-error", turnError ?? `stop reason ${result.stopReason}`);
	}
	const text = result.output.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
	if (role === "manager" && !text.trim()) return failure("agent-error", "the manager returned no text");
	return { ok: true, text };
}

/** The real path of `cwd` when it lies in the run directory or among its candidate checkouts. */
function containedPath(context: DshSpawnerContext, cwd: string): string | null {
	const path = realPathOrNull(cwd);
	if (path === null) return null;
	const candidates = realPathOrNull(join(context.ledgerDir, "candidates"));
	const inside = isWithin(context.runPath, path) || (candidates !== null && isWithin(candidates, path));
	return inside ? path : null;
}

/** Start one child, follow it to its end or to a stop, and dispose it. */
async function runChild(
	context: DshSpawnerContext,
	tally: RoleTally,
	role: DshRole,
	opts: SpawnOptions,
	cwd: string,
	reasoningEffort: string | undefined,
): Promise<SpawnResult> {
	const childId = randomUUID();
	const ref = context.roles.models[role];
	const watch = watchStop(opts.signal, opts.timeoutMs);
	let tokens: { input: number; output: number; total: number } | undefined;
	let turnError: string | undefined;
	let unsubscribe = () => {};
	// Settles once a child that outlived the spawn is gone; until then it stays guarded.
	let leaving: Promise<void> | undefined;

	const follow = async (): Promise<SpawnResult> => {
		context.children.set(childId, role);
		unsubscribe = context.events.on("session/event", (session, event) => {
			if (session.id !== childId) return;
			if (event.type === "turn/end") {
				turnError = event.data.reason.error?.message ?? turnError;
			} else if (event.type === "assistant/message") {
				const { message, usage } = event.data;
				tally.models[role] = `${message.source.provider}/${message.source.model}`;
				if (usage === undefined) return;
				const total = usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
				tokens ??= { input: 0, output: 0, total: 0 };
				tokens.input += usage.inputTokens;
				tokens.output += usage.outputTokens;
				tokens.total += total;
				tally.tokens[role] += total;
			}
		});
		const starting = (async () =>
			context.subagents.startActivation({
				provider: "spawn",
				label: opts.description,
				parent: context.parent,
				childId,
				delivery: "caller",
				agentPreset: LEDGER_PRESETS[role],
				cwd,
				prompt: [{ type: "text", text: `${WORKER_SENTINEL}\n${opts.prompt}` }],
				signal: watch.startup,
				agentOptions: {
					...(ref === null ? {} : splitRef(ref)),
					reasoningEffort,
					...(opts.maxOutputTokens === undefined ? {} : { maxTokens: opts.maxOutputTokens }),
				},
			}))();

		let started: DshSubagentActivation | StopCause;
		try {
			started = await Promise.race([watch.stopped, starting]);
		} catch (err) {
			const cause = watch.cause();
			if (cause !== null) return stoppedBy(cause, opts.timeoutMs);
			const code = errorCode(err);
			return failure("refused", code === undefined ? errorText(err) : `${code}: ${errorText(err)}`);
		}
		if (typeof started === "string") {
			leaving = starting.then(
				(late) => {
					late.result.catch(() => {});
					return dispose(late);
				},
				() => {},
			);
			return stoppedBy(started, opts.timeoutMs);
		}

		const activation = started;
		const end = await Promise.race([
			watch.stopped.then((cause) => ({ cause })),
			activation.result.then(
				(result) => ({ result }),
				(error: unknown) => ({ error }),
			),
		]);
		watch.clear();
		if ("cause" in end) {
			leaving = dispose(activation);
			await waitAtMost(leaving, context.disposeWaitMs ?? DISPOSE_WAIT_MS);
			return stoppedBy(end.cause, opts.timeoutMs);
		}
		try {
			return "result" in end
				? settledResult(role, end.result, turnError)
				: failure("agent-error", errorText(end.error));
		} finally {
			leaving = dispose(activation);
			await waitAtMost(leaving, context.disposeWaitMs ?? DISPOSE_WAIT_MS);
		}
	};

	let outcome: SpawnResult;
	try {
		outcome = await follow();
	} finally {
		watch.clear();
		unsubscribe();
		const forget = () => {
			context.children.delete(childId);
		};
		if (leaving === undefined) forget();
		else void leaving.then(forget);
	}
	return { ...outcome, tokens };
}

async function spawnRole(context: DshSpawnerContext, tally: RoleTally, opts: SpawnOptions): Promise<SpawnResult> {
	const role = (["manager", "worker"] as const).find((name) => LEDGER_PRESETS[name] === opts.type);
	if (role === undefined) return failure("refused", `unknown ledger role "${opts.type}"`);
	const wanted = opts.cwd ?? context.runPath;
	const cwd = containedPath(context, wanted);
	if (cwd === null) return failure("refused", `\`${wanted}\` is not a directory inside this run`);
	if (opts.signal?.aborted) return stoppedBy("aborted", opts.timeoutMs);
	const effort = await unlessAborted(context.roles.effort(role), opts.signal);
	if (effort === null || opts.signal?.aborted) return stoppedBy("aborted", opts.timeoutMs);
	if (effort.kind === "refused") return failure("refused", effort.message);
	return runChild(context, tally, role, opts, cwd, effort.reasoningEffort);
}

/**
 * The `SpawnFn` of one dsh run, which starts each role as a subagent of the parent,
 * and the tally of what its children used. The `SpawnFn` never rejects, and runs a
 * child only in the run directory or a candidate checkout. It takes each role's model
 * and effort from `context.roles`, not from the spawn options, and has no turn limit.
 */
export function createDshSpawner(context: DshSpawnerContext): { spawn: SpawnFn; tally: RoleTally } {
	const tally: RoleTally = { tokens: { manager: 0, worker: 0 }, models: { manager: null, worker: null } };
	const spawn: SpawnFn = async (opts) => {
		const startedAt = Date.now();
		let outcome: SpawnResult;
		try {
			outcome = await spawnRole(context, tally, opts);
		} catch (err) {
			outcome = failure("refused", errorText(err));
		}
		return { ...outcome, durationMs: Date.now() - startedAt };
	};
	return { spawn, tally };
}
