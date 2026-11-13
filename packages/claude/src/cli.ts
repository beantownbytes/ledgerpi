import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { auditRun } from "../../core/src/audit.ts";
import {
	asFanoutSetting,
	CLAUDE_MANAGER_DEFAULT,
	CLAUDE_WORKER_DEFAULT,
	type ClaudeRoles,
	disabledByEnv,
	type LedgerpiConfig,
	loadConfig,
} from "../../core/src/config.ts";
import { readPlanFile, readRegularFile } from "../../core/src/files.ts";
import { detectGate } from "../../core/src/gate.ts";
import { headInfo, isGitRepo, workTreeRoot } from "../../core/src/git.ts";
import { handoffBlock } from "../../core/src/handoff.ts";
import { Ledger } from "../../core/src/ledger.ts";
import { runLoop } from "../../core/src/loop.ts";
import { report } from "../../core/src/report.ts";
import { acquireLock, type LockHolder, lockHolder } from "./lock.ts";
import type { LedgerEvent } from "./protocol.ts";
import { type RoleTally, rendezvous } from "./rendezvous.ts";

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

/** A line for each role whose answers came from a model other than the configured one. */
function modelMismatches(configured: ClaudeRoles, tally: RoleTally): string[] {
	return (["manager", "worker"] as const).flatMap((role) => {
		const ran = tally.models[role];
		return ran === null || ran === configured[role]
			? []
			: [`The ${role} ran on ${ran}, not the configured ${configured[role]}.`];
	});
}

interface SolveArgs {
	cwd: string;
	gate?: string;
	planFile?: string;
	fanout?: string;
	session: string;
	task: string;
}

async function solve(cfg: LedgerpiConfig, args: SolveArgs): Promise<number> {
	for (const warning of cfg.warnings) report(warning);
	const inactive = inactiveReason(cfg);
	const claude = cfg.claude;
	if (inactive !== null || claude === null) return punt(`ledgerpi is inactive: ${inactive}.`);
	const task = args.task.trim();
	if (!task) return punt("No task was provided.");
	const root = isGitRepo(args.cwd) ? workTreeRoot(args.cwd) : null;
	if (root === null) return punt(`\`${args.cwd}\` is not a git repository.`);
	const planPath = args.planFile?.trim();
	let plan: string | undefined;
	if (planPath) {
		const read = readPlanFile(planPath);
		if ("error" in read) return punt(`${read.error}.`);
		plan = read.plan;
	}
	const fanout = asFanoutSetting(args.fanout);
	if (args.fanout !== undefined && fanout === undefined) {
		report(`[ledgerpi] ignoring --fanout ${JSON.stringify(args.fanout)}: expected off, advise, ask or on`);
	}
	const release = acquireLock(cfg.stateDir, root);
	if (release === null) {
		const quoted = shellQuote(root);
		return refuse(
			`Another ledger loop is editing \`${root}\`. Wait for it to finish, \`ledgerctl status --json --cwd ${quoted}\` reports it under \`lock\`, or run \`ledgerctl stop --cwd ${quoted}\`, and leave this tree alone until then.`,
		);
	}

	const controller = new AbortController();
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		process.once(signal, () => controller.abort());
	}
	try {
		const ledger = new Ledger(cfg, args.session, `${Date.now()}-${randomUUID().slice(0, 8)}`);
		const { spawn, tally } = rendezvous(join(ledger.dir, "steps"), claude, emitLine);
		const startedAt = Date.now();
		const headStart = headInfo(args.cwd);
		const looped = await runLoop({
			spawn,
			cfg,
			ledger,
			cwd: args.cwd,
			task,
			gateCommand: args.gate?.trim() || detectGate(cfg, args.cwd),
			sessionModel: null,
			managerModel: claude.manager,
			workerModel: claude.worker,
			plan,
			fanout,
			onProgress: (iter, label) => emitLine({ type: "progress", text: `ledger ${iter}/${cfg.maxIters}: ${label}` }),
			signal: controller.signal,
		});
		const result = {
			...looped,
			managerModel: tally.models.manager ?? looped.managerModel,
			workerModel: tally.models.worker ?? looped.workerModel,
		};
		auditRun(
			cfg,
			{ entry: "tool", harness: "claude", session: args.session, provider: "anthropic", cwd: args.cwd },
			result,
			{
				task,
				durationMs: Date.now() - startedAt,
				classified: null,
				calls: result.calls,
				tokens: result.tokens,
				git: { start: headStart, end: headInfo(args.cwd) },
				roleTokens: tally.tokens,
			},
		);
		emitLine({
			type: "done",
			handoff:
				result.stop === "aborted"
					? "The ledger loop was aborted before completing."
					: [handoffBlock(args.cwd, result), ...modelMismatches(claude, tally)].join("\n"),
		});
		return 0;
	} finally {
		release();
	}
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
