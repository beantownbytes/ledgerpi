import { type GateRunner, type GateVerdict, outputTail, timedOutVerdict } from "../../core/src/gate.ts";
import type { SolveRejection } from "../../core/src/solve.ts";
import type {
	DshAgent,
	DshExecutionPolicy,
	DshPluginContext,
	DshShell,
	DshShellExecution,
	DshShellResult,
} from "./dsh.ts";
import { errorText, waitAtMost } from "./spawn.ts";

const PROBE_TIMEOUT_MS = 10_000;
const SETTLE_WAIT_MS = 10_000;
const TIMED_OUT = Symbol("gate timed out");

export type DshPolicyResolution =
	| { kind: "resolved"; policy: DshExecutionPolicy }
	| { kind: "unavailable"; message: string };

/** The sandbox policy of `parent`'s session as it is now, or why there is none. */
export function sessionPolicy(ctx: DshPluginContext, parent: DshAgent): DshPolicyResolution {
	const sandbox = ctx.get("sandboxPolicy");
	if (sandbox === undefined) {
		return { kind: "unavailable", message: "No sandbox policy service is available to contain the run." };
	}
	try {
		return { kind: "resolved", policy: sandbox.resolve({ session: parent.session }) };
	} catch (err) {
		return { kind: "unavailable", message: `The sandbox policy cannot be resolved: ${errorText(err)}` };
	}
}

/**
 * Why `shell` cannot run a command in `runPath` under `policy`, or null when it can
 * or once `signal` aborts. Preparation and the command together get 10 s, after
 * which the command is killed, whenever it starts.
 */
async function probeProblem(
	shell: DshShell,
	policy: DshExecutionPolicy,
	runPath: string,
	signal: AbortSignal,
): Promise<string | null> {
	let execution: DshShellExecution | undefined;
	let expired = false;
	const probe = async (): Promise<string | null> => {
		try {
			const spec = shell.resolve({
				command: "true",
				workdir: runPath,
				timeoutMs: PROBE_TIMEOUT_MS,
				sandboxPolicy: policy,
				signal,
			});
			execution = await shell.execute(spec);
			if (expired) execution.kill();
			const result = await execution.result();
			if (signal.aborted) return null;
			if (result.timedOut) return `timed out after ${result.timeoutMs} ms`;
			if (result.exitCode === 0) return null;
			const status = result.exitCode === null ? `signal ${result.signal}` : `exit code ${result.exitCode}`;
			const stderr = result.stderr.text.trim();
			return stderr ? `${status}: ${stderr}` : status;
		} catch (err) {
			return signal.aborted ? null : errorText(err);
		}
	};
	const problem = await waitAtMost(probe(), PROBE_TIMEOUT_MS);
	if (problem !== undefined) return problem;
	expired = true;
	execution?.kill();
	return signal.aborted ? null : `timed out after ${PROBE_TIMEOUT_MS} ms`;
}

type GateSandbox =
	| { kind: "confined" | "full-access"; shell: DshShell; policy: DshExecutionPolicy }
	| { kind: "refused"; rejection: SolveRejection };

/** The shell and policy a gate of `parent` runs with as they are now, or why it must not run. */
function gateSandbox(ctx: DshPluginContext, parent: DshAgent): GateSandbox {
	const refused = (reason: SolveRejection["reason"], message: string): GateSandbox => ({
		kind: "refused",
		rejection: { reason, message },
	});
	const shell = ctx.get("shell");
	if (shell === undefined) return refused("gate-unavailable", "No shell service is available to run the gate.");
	const resolution = sessionPolicy(ctx, parent);
	if (resolution.kind === "unavailable") return refused("sandbox-unavailable", resolution.message);
	const { policy } = resolution;
	switch (policy.mode) {
		case "danger-full-access":
			return { kind: "full-access", shell, policy };
		case "workspace-write":
		case "read-only":
			return shell.sandboxMode === undefined
				? refused(
						"gate-unconfined",
						`The session's sandbox mode is "${policy.mode}", but the shell does not sandbox commands.`,
					)
				: { kind: "confined", shell, policy };
		default:
			return refused("sandbox-unavailable", `The sandbox mode "${policy.mode}" is not supported.`);
	}
}

/**
 * Why a run in `runPath` cannot have its gate held to the parent's sandbox, or null
 * when it can. A confining mode is tried with a command that does nothing. Also null
 * once `signal` aborts, which `solveTask` then reports as canceled.
 */
export async function gateCheck(
	ctx: DshPluginContext,
	parent: DshAgent,
	runPath: string,
	signal: AbortSignal,
): Promise<SolveRejection | null> {
	const sandbox = gateSandbox(ctx, parent);
	switch (sandbox.kind) {
		case "refused":
			return sandbox.rejection;
		case "full-access":
			return null;
		case "confined": {
			const problem = await probeProblem(sandbox.shell, sandbox.policy, runPath, signal);
			return problem === null
				? null
				: { reason: "sandbox-unavailable", message: `The sandbox cannot run a command: ${problem}` };
		}
	}
}

/** A command's stdout followed by its stderr, starting on a line of its own. */
function combinedOutput({ stdout, stderr }: DshShellResult): string {
	const gap = stdout.text && stderr.text && !stdout.text.endsWith("\n") ? "\n" : "";
	return `${stdout.text}${gap}${stderr.text}`;
}

/**
 * Runs the gate `command` in `cwd` on `shell` under `policy`. The timeout covers the
 * preparation of the command too and is not subject to the shell's cap. A command
 * that outlives it, or whose caller aborts, is killed and given 10 s to end.
 */
async function runInShell(
	shell: DshShell,
	policy: DshExecutionPolicy,
	command: string,
	cwd: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<GateVerdict> {
	const notRun = (output: string): GateVerdict => ({ ran: false, passed: false, command, output });
	const deadline = new AbortController();
	// Its reason is that of whichever fired first, the caller's signal or the deadline.
	const stop = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
	let execution: DshShellExecution | undefined;
	// Listening before the command starts, since a shell can abort while preparing it.
	const canceled = new Promise<{ kind: "canceled" }>((resolve) => {
		stop.addEventListener("abort", () => resolve({ kind: "canceled" }), { once: true });
	});
	const start = async () => {
		const spec = shell.resolve({
			command,
			workdir: cwd,
			timeoutMs,
			onExpiry: "none",
			sandboxPolicy: policy,
			signal: stop,
		});
		execution = await shell.execute(spec);
		if (stop.aborted) execution.kill();
		return execution.result();
	};
	const ending = start().then(
		(result) => ({ kind: "result" as const, result }),
		(error: unknown) => ({ kind: "error" as const, error }),
	);

	const first = await waitAtMost(Promise.race([canceled, ending]), timeoutMs);
	if (first?.kind === "canceled") {
		execution?.kill();
		await waitAtMost(ending, SETTLE_WAIT_MS);
		return notRun("aborted");
	}
	let end = first;
	if (end === undefined) deadline.abort(TIMED_OUT);
	if (end === undefined || (end.kind === "result" && end.result.timedOut)) {
		execution?.kill();
		end ??= await waitAtMost(ending, SETTLE_WAIT_MS);
	}
	const result = end?.kind === "result" ? end.result : undefined;
	if (stop.reason === TIMED_OUT || result?.timedOut) {
		return timedOutVerdict(command, result ? combinedOutput(result) : "");
	}
	if (end === undefined) return notRun("aborted");
	if (end.kind === "error") return notRun(signal?.aborted ? "aborted" : errorText(end.error));
	if (end.result.aborted) return notRun("aborted");
	if (end.result.exitCode === 0) return { ran: true, passed: true, command };
	const output = outputTail(combinedOutput(end.result));
	return {
		ran: true,
		passed: false,
		command,
		output: end.result.sandbox?.denied ? `${output}\n[sandbox denied a write]` : output,
	};
}

/**
 * Runs gates through dsh's shell, held to the sandbox policy the session of `parent`
 * has at each run. A gate that cannot be held to it is not run. Never rejects.
 */
export function dshGateRunner(ctx: DshPluginContext, parent: DshAgent): GateRunner {
	return async (command, cwd, timeoutMs, signal) => {
		const notRun = (output: string): GateVerdict => ({ ran: false, passed: false, command, output });
		if (signal?.aborted) return notRun("aborted");
		try {
			const sandbox = gateSandbox(ctx, parent);
			if (sandbox.kind === "refused") return notRun(sandbox.rejection.message);
			return await runInShell(sandbox.shell, sandbox.policy, command, cwd, timeoutMs, signal);
		} catch (err) {
			return notRun(errorText(err));
		}
	};
}
