import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	CLAUDE_MANAGER_DEFAULT,
	CLAUDE_WORKER_DEFAULT,
	disabledByEnv,
	type LedgerpiConfig,
	loadConfig,
} from "../../core/src/config.ts";
import { readRegularFile } from "../../core/src/files.ts";
import { detectGate } from "../../core/src/gate.ts";
import { workTreeRoot } from "../../core/src/git.ts";
import { type LockHolder, lockHolder } from "../../core/src/lock.ts";
import { report } from "../../core/src/report.ts";
import { ABORTED_HANDOFF, type SolveArgs, type SolveOutcome, solveTask } from "../../core/src/solve.ts";
import type { LedgerEvent } from "./protocol.ts";
import { rendezvous } from "./rendezvous.ts";

/** Policy refused the run: expected behavior, not an error. */
const EXIT_REFUSED = 3;
/** Bad usage or a tool-layer failure. */
const EXIT_ERROR = 2;

const USAGE = `usage:
  ledgerctl solve [--cwd <dir>] [--gate <cmd>] [--plan-file <path>] [--fanout off|advise|ask|on] [--session <id>]   task on stdin; JSONL on stdout, for the plugin
  ledgerctl status [--json] [--cwd <dir>]
  ledgerctl stop [--cwd <dir>]`;

/** Why the loop cannot run under Claude Code, or null when it can. */
function inactiveReason(cfg: LedgerpiConfig): string | null {
	if (disabledByEnv()) return "disabled by LEDGERPI=0";
	if (cfg.switchedOff) return "disabled by enabled = false in the ledgerpi config";
	if (cfg.claude === null) return "no usable [claude] section in the ledgerpi config";
	return null;
}

function emitLine(event: LedgerEvent): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Say a run did not start, as the tool result the model reads. */
function refuse(reason: string): number {
	emitLine({ type: "refused", reason });
	return EXIT_REFUSED;
}

/** Refuse a run that nothing else is doing, so the work falls back to the caller. */
function punt(reason: string): number {
	return refuse(`${reason} Implement the task directly.`);
}

/** Wrap a path as one shell word that no character in it can break out of. */
function shellQuote(path: string): string {
	return `'${path.replaceAll("'", "'\\''")}'`;
}

/** The refusal for a work tree another loop holds. It does not invite the caller to edit beside that loop. */
function refuseLocked(root: string): number {
	const quoted = shellQuote(root);
	return refuse(
		`Another ledger loop is editing \`${root}\`. Wait for it to finish, \`ledgerctl status --json --cwd ${quoted}\` reports it under \`lock\`, or run \`ledgerctl stop --cwd ${quoted}\`, and leave this tree alone until then.`,
	);
}

/** Print how a call ended, as the tool result the model reads, and return the exit code for it. */
function deliver(outcome: SolveOutcome): number {
	switch (outcome.kind) {
		case "rejected":
			return punt(outcome.message);
		case "busy":
			return refuseLocked(outcome.root);
		case "canceled":
			emitLine({ type: "done", handoff: ABORTED_HANDOFF });
			return 0;
		case "ran":
			emitLine({ type: "done", handoff: outcome.handoff });
			return 0;
	}
}

/** The live loop holding the lock on the work tree containing `cwd`, or null when there is none. */
function lockedTree(cfg: LedgerpiConfig, cwd: string): (LockHolder & { root: string }) | null {
	const root = workTreeRoot(cwd);
	if (root === null) return null;
	const holder = lockHolder(cfg.stateDir, root);
	return holder === null ? null : { ...holder, root };
}

/** `lockedTree` for reporting: a lock that cannot be read comes back as `{ error }`, never a throw. */
function lockReport(cfg: LedgerpiConfig, cwd: string): ReturnType<typeof lockedTree> | { error: string } {
	try {
		return lockedTree(cfg, cwd);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/** The `lock:` line of the status text. */
function lockLine(lock: ReturnType<typeof lockReport>): string {
	if (lock === null) return "lock: free";
	if ("error" in lock) return `lock: unreadable (${lock.error})`;
	return `lock: held by pid ${lock.pid} (${lock.root})`;
}

async function solve(cfg: LedgerpiConfig, args: SolveArgs): Promise<number> {
	for (const warning of cfg.warnings) report(warning);
	const inactive = inactiveReason(cfg);
	const claude = cfg.claude;
	if (inactive !== null || claude === null) return punt(`ledgerpi is inactive: ${inactive}.`);
	const controller = new AbortController();
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		process.once(signal, () => controller.abort());
	}
	return deliver(
		await solveTask(cfg, args, {
			harness: "claude",
			entry: "tool",
			provider: "anthropic",
			managerModel: claude.manager,
			workerModel: claude.worker,
			sessionModel: null,
			signal: controller.signal,
			onProgress: (iter, label) => emitLine({ type: "progress", text: `ledger ${iter}/${cfg.maxIters}: ${label}` }),
			spawner: (ledger) => rendezvous(join(ledger.dir, "steps"), claude, emitLine),
		}),
	);
}

/** The most recent Claude Code run in the audit log, or null. */
function lastRun(cfg: LedgerpiConfig): Record<string, unknown> | null {
	const text = readRegularFile(cfg.auditLog);
	if (text === undefined) return null;
	for (const line of text.trimEnd().split("\n").reverse()) {
		try {
			const row = JSON.parse(line) as Record<string, unknown>;
			if (row.event === "run" && row.harness === "claude") return row;
		} catch {
			// A torn or foreign line is not a run; keep looking.
		}
	}
	return null;
}

function status(cfg: LedgerpiConfig, cwd: string, asJson: boolean): number {
	const reason = inactiveReason(cfg);
	const state = {
		active: reason === null,
		reason,
		manager: cfg.claude?.manager ?? CLAUDE_MANAGER_DEFAULT,
		worker: cfg.claude?.worker ?? CLAUDE_WORKER_DEFAULT,
		managerSource: cfg.claude?.sources.manager ?? "default",
		workerSource: cfg.claude?.sources.worker ?? "default",
		gate: detectGate(cfg, cwd) ?? null,
		lock: lockReport(cfg, cwd),
		maxIters: cfg.maxIters,
		fanout: cfg.fanout,
		fanoutMax: cfg.fanoutMax,
		auditLog: cfg.auditLog,
		warnings: cfg.warnings,
		lastRun: lastRun(cfg),
	};
	if (asJson) {
		console.log(JSON.stringify(state, null, 2));
		return 0;
	}
	const run = state.lastRun;
	console.log(
		[
			`ledgerpi: ${state.active ? "active" : `inactive (${reason})`}`,
			`manager: ${state.manager} (${state.managerSource})`,
			`worker: ${state.worker} (${state.workerSource})`,
			`gate: ${state.gate?.trim() ?? "(none detected)"}`,
			lockLine(state.lock),
			`maxIters: ${state.maxIters}`,
			`fanout: ${state.fanout} (max ${state.fanoutMax})`,
			`audit log: ${state.auditLog}`,
			...state.warnings,
			run
				? `last run: ${run.converged ? "converged" : "unconverged"} (${run.stop}), ${run.iters} rounds, ${run.calls} calls, ${run.tokens} tokens`
				: "last run: none",
		].join("\n"),
	);
	return 0;
}

function stop(cfg: LedgerpiConfig, cwd: string): number {
	const holder = lockedTree(cfg, cwd);
	if (holder === null) {
		console.log("ledgerpi: no ledger loop is running in this repository.");
		return 0;
	}
	process.kill(holder.pid, "SIGTERM");
	console.log("ledgerpi: stopping the ledger loop.");
	return 0;
}

/** Run the CLI and return its exit code; a failure prints one line and exits 2. */
export async function main(argv: string[]): Promise<number> {
	try {
		return await dispatch(argv);
	} catch (err) {
		console.error(`ledgerctl: ${err instanceof Error ? err.message : String(err)}`);
		return EXIT_ERROR;
	}
}

async function dispatch(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	let values: { cwd?: string; gate?: string; "plan-file"?: string; fanout?: string; session?: string; json?: boolean };
	try {
		({ values } = parseArgs({
			args: rest,
			options: {
				cwd: { type: "string" },
				gate: { type: "string" },
				"plan-file": { type: "string" },
				fanout: { type: "string" },
				session: { type: "string" },
				json: { type: "boolean" },
			},
		}));
	} catch (err) {
		console.error(`${(err as Error).message}\n${USAGE}`);
		return EXIT_ERROR;
	}
	const cwd = resolve(values.cwd ?? process.cwd());
	const cfg = loadConfig();
	switch (command) {
		case "solve":
			return solve(cfg, {
				cwd,
				gate: values.gate,
				planFile: values["plan-file"],
				fanout: values.fanout,
				session: values.session ?? `claude-${randomUUID()}`,
				task: readFileSync(0, "utf8"),
			});
		case "status":
			return status(cfg, cwd, values.json === true);
		case "stop":
			return stop(cfg, cwd);
		default:
			console.error(USAGE);
			return EXIT_ERROR;
	}
}
