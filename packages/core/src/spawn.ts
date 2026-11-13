/**
 * The harness-neutral contract for starting one manager or worker sub-agent. The
 * loop depends only on this; each harness supplies its own `SpawnFn`.
 */

/**
 * A marker line prepended to every sub-agent prompt, so a spawned role is told
 * apart from a user session: an entry point that sees it never starts or redirects
 * into a nested loop, which would otherwise deadlock a worker on its own first edit.
 */
export const WORKER_SENTINEL = "[ledgerpi:subagent]";

/**
 * Which failure branch produced a failed spawn. Tagged literally at each branch
 * inside a `SpawnFn`, never inferred from `error` text: refusals and settled agents
 * both carry arbitrary host or agent strings, so identical text can name different
 * sources. `other` is the defensive default for an unclassified failure: no current
 * branch resolves untagged, but direct construction of a `SpawnResult` without a
 * detail must still have a closed fallback.
 */
export type SpawnFailureDetail = "aborted" | "timeout" | "refused" | "agent-error" | "other";

export interface SpawnResult {
	/** The agent's final text, or undefined when it failed, errored, or was stopped. */
	text?: string;
	/** True when the agent settled successfully. */
	ok: boolean;
	/** Populated on failure. */
	error?: string;
	/** The failure category of the branch that resolved not-ok; undefined on success. */
	detail?: SpawnFailureDetail;
	tokens?: { input?: number; output?: number; total?: number };
	durationMs?: number;
}

export interface SpawnOptions {
	type: string;
	prompt: string;
	model?: string | null;
	thinkingLevel?: string;
	maxTurns?: number;
	cwd?: string;
	/**
	 * Output-token cap for this spawn. Set on worker spawns only, from the config's
	 * `workerMaxTokens`; absent means the model's own default cap. The Claude
	 * `SpawnFn` ignores it.
	 */
	maxOutputTokens?: number;
	description: string;
	signal?: AbortSignal;
	timeoutMs: number;
}

/**
 * Start one sub-agent and resolve with its result. Must never reject: every failure
 * path resolves with `ok: false`, because the loop treats a broken spawn as a
 * distinct outcome from a failed gate rather than throwing through its caller.
 */
export type SpawnFn = (opts: SpawnOptions) => Promise<SpawnResult>;
