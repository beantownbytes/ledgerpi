/**
 * The public types of the `ledgerpi` service. This file imports nothing, so a plugin
 * can type-check against it under its own compiler settings.
 */

/** The model route of an agent; either part may be unknown. */
export interface DshRoute {
	provider?: string;
	model?: string;
}

/** The part of a dsh session the service reads. */
export interface DshSession {
	readonly id: string;
	readonly header: { readonly cwd?: string };
	/** The header of the session's latest model request, or undefined before the first one. */
	requestHeader(): { readonly config: DshRoute } | undefined;
}

/** The part of a dsh agent the service reads. */
export interface DshAgent {
	readonly id: string;
	readonly session: DshSession;
	readonly options: DshRoute;
}

/** Why the service will not run anything. */
export type DshInactiveReason = "env-disabled" | "switched-off" | "no-dsh-table" | "no-preset-registry";

/** Whether the service would run a call now. */
export type DshStatus = { apiVersion: 1; active: true } | { apiVersion: 1; active: false; reason: DshInactiveReason };

/** One run asked of the service. */
export interface DshSolveRequest {
	/** The live agent the run is for. */
	parent: DshAgent;
	task: string;
	/** The run directory; a relative one is resolved against the parent's working directory. */
	cwd?: string;
	/**
	 * The gate command; absent means the configured or detected one. Whichever it is,
	 * each gate run goes through dsh's shell (`bash -c`) under the parent session's
	 * sandbox policy, resolved again for that run. Under `danger-full-access` that
	 * policy bounds nothing.
	 */
	gate?: string;
	/** A plan file; a relative path is resolved against the run directory. */
	planFile?: string;
	/** `off`, `advise`, `ask` or `on`. */
	fanout?: string;
	/** A `provider/modelId` for the manager role. */
	managerModel?: string;
	/** A `provider/modelId` for the worker role. */
	workerModel?: string;
	signal?: AbortSignal;
	/** Receives status updates; a throw from it is ignored. */
	onProgress?: (iter: number, label: string) => void;
	/** The entry point stamped on the audit row; `service` when absent. The `ledger_solve` tool passes `tool`. */
	entry?: "service" | "tool";
}

/** What the gate did, if one ran. */
export interface DshGateVerdict {
	/**
	 * Whether the gate command ran to a verdict. False when it was aborted or could not
	 * be run, including when it could not be held to the parent's sandbox; a run that
	 * ends on such a verdict has not converged.
	 */
	ran: boolean;
	/** True only when the gate command exited zero. */
	passed: boolean;
	command?: string;
	/** A tail of combined stdout/stderr on failure, or why the gate did not run. */
	output?: string;
}

/** One task of the manager's list. */
export interface DshTask {
	desc: string;
	status: "todo" | "done";
}

/** What fan-out did. */
export interface DshFanoutSummary {
	/** The effective setting: the lower of the config and the per-call override. */
	setting: "off" | "advise" | "ask" | "on";
	max: number;
	/** Rounds that ran concurrent candidates. */
	rounds: number;
	downgrades: string[];
	escapes: string[];
	/** Times the user was asked to confirm a best-of-n round. */
	asked: number;
	/** Rounds by the manager's recommended mode. */
	advised: Record<"serial" | "best-of-n" | "fleet" | "none", number>;
}

/** Where the run's time went, by role. */
export interface DshRoleTiming {
	managerMs: number;
	workerMs: number;
	gateMs: number;
	managerCalls: number;
	workerCalls: number;
	gateRuns: number;
}

/** A finished run: the loop's result and what the run cost and used. */
export interface DshRunResult {
	/** True when the gate passed (or, with no gate, the manager declared done). */
	converged: boolean;
	iters: number;
	calls: number;
	tokens: number;
	gate: DshGateVerdict | null;
	stop: "done" | "budget" | "no-progress" | "spawn-failure" | "unconverged" | "aborted";
	/** For `stop: "spawn-failure"`, which failure ended the run. */
	stopDetail?: "aborted" | "timeout" | "refused" | "agent-error" | "other";
	/** For `stop: "spawn-failure"`, the error line of the spawn that ended the run. */
	stopError?: string;
	notes: string;
	tasks: DshTask[];
	/** The model the manager role ran on, or null when it ran on the session model. */
	managerModel: string | null;
	/** The model the worker role ran on, or null when it ran on the session model. */
	workerModel: string | null;
	/** Who wrote the plan: the caller or the manager. */
	planSource: "caller" | "manager";
	/** Null when the effective fan-out setting was off. */
	fanout?: DshFanoutSummary | null;
	timing: DshRoleTiming;
	roleTokens: { manager: number; worker: number };
	/** A line for each role whose answers came from another model than it was to run on. */
	mismatches: string[];
	ledgerDir: string;
	durationMs: number;
	cwd: string;
}

/** Who holds a work tree's run lock. */
export interface DshLockHolder {
	pid: number;
	/** Set when `pid` is a long-lived host process, which must not be signaled to stop the loop. */
	shared?: true;
}

/** Why a call was turned down. */
export interface DshSolveRejection {
	/**
	 * A stable code for the cause. A run that has a gate is also turned down, before
	 * the work tree is locked, when the gate cannot be held to the parent's sandbox:
	 * `gate-unavailable` (no shell service), `gate-unconfined` (the sandbox mode
	 * confines but the shell does not sandbox commands) or `sandbox-unavailable` (no
	 * sandbox policy service, a policy that cannot be resolved, an unknown mode, or a
	 * confining mode under which a command that does nothing fails).
	 */
	reason: string;
	message: string;
	/** The request property at fault, when one is. */
	field?: string;
}

/** How a call ended. Only `ran` writes an audit row. */
export type DshSolveOutcome = { warnings: string[] } & (
	| { kind: "inactive"; reason: DshInactiveReason }
	| { kind: "canceled" }
	| ({ kind: "rejected" } & DshSolveRejection)
	| { kind: "busy"; root: string; holder: DshLockHolder | null }
	| { kind: "ran"; result: DshRunResult; handoff: string }
	| { kind: "failed"; message: string }
);

/** The `ledgerpi` service. */
export interface LedgerpiService {
	/** Never throws. */
	status(): DshStatus;
	/** Never rejects. */
	solve(request: DshSolveRequest): Promise<DshSolveOutcome>;
	/** Whether `id` is the session of a manager or worker that is running now. */
	isLedgerChild(id: string): boolean;
}
