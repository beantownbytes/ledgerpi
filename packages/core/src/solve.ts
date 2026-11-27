import { randomUUID } from "node:crypto";
import { type AuditMeta, auditRun } from "./audit.ts";
import { asFanoutSetting, type LedgerpiConfig } from "./config.ts";
import { readPlanFile } from "./files.ts";
import { detectGate, type GateRunner } from "./gate.ts";
import { headInfo, pinRepo } from "./git.ts";
import { handoffBlock } from "./handoff.ts";
import { Ledger } from "./ledger.ts";
import { acquireLock, type LockHolder, lockHolder } from "./lock.ts";
import { type LoopDeps, type LoopResult, runLoop } from "./loop.ts";
import { report } from "./report.ts";
import type { SpawnFn } from "./spawn.ts";

/** A harness whose `ledger_solve` runs through `solveTask`. */
export type SolveHarness = "claude" | "dsh";

/** What each harness calls the argument that carries the fan-out setting. */
const FANOUT_ARGUMENT: Record<SolveHarness, string> = { claude: "--fanout", dsh: "fanout" };

/** What a run's steps cost and which models answered, for the audit row and the hand-off. */
export interface RoleTally {
	tokens: { manager: number; worker: number };
	/** The model that last answered each role, or null when none did. */
	models: { manager: string | null; worker: string | null };
}

/** The caller's arguments for one run, as received. */
export interface SolveArgs {
	/** The absolute run directory: the caller resolves it, and nothing here does. */
	cwd: string;
	gate?: string;
	planFile?: string;
	fanout?: string;
	session: string;
	task: string;
}

/** Why a run was turned down before it started. */
export interface SolveRejection {
	/** A stable code for the cause, for callers that branch on it. */
	reason: string;
	/** One sentence saying what is wrong. */
	message: string;
	/** The argument at fault, when one is. */
	field?: string;
}

/** An adapter's own check before the lock: a rejection, or null to go on. */
export type SolveCheck = () => SolveRejection | null | Promise<SolveRejection | null>;

/**
 * What a harness supplies to `solveTask`.
 *
 * The harness owns these checks, before the call or in a hook: whether it is active,
 * whether the call is already aborted, the parent session and nesting, resolving the
 * run directory (`args.cwd` arrives absolute, and a harness that contains it passes
 * its real path), containment, the model refs, their efforts, and the presets.
 * `solveTask` owns the blank task, the git work tree, the plan file, the fan-out
 * warning, the gate command, the lock, the run and its audit row.
 */
export interface SolveHost {
	harness: SolveHarness;
	/** The entry point stamped on the audit row. */
	entry: AuditMeta["entry"];
	/** The provider stamped on the audit row. */
	provider?: string;
	/** The session model stamped on the audit row. */
	model?: string;
	/** The `provider/modelId` the manager role spawns on, or null for the session model. */
	managerModel: string | null;
	/** The `provider/modelId` the worker role spawns on, or null for the session model. */
	workerModel: string | null;
	/** The session's `provider/modelId`, or null when unknown. */
	sessionModel: string | null;
	signal: AbortSignal;
	onProgress: LoopDeps["onProgress"];
	/** Receives this call's argument warnings; they go to `report` when absent. */
	warn?: (message: string) => void;
	/** Builds the run's `SpawnFn` and the tally it accumulates, once the work tree is locked. */
	spawner: (ledger: Ledger) => { spawn: SpawnFn; tally: RoleTally };
	/** Run once the task is known to be non-blank, before the directory is looked at. */
	checkArgs?: SolveCheck;
	/** Run once the work tree is known to be a git repository. */
	checkTree?: SolveCheck;
	/** The harness's last check of the call itself, before the gate command is looked at. */
	beforeLock?: SolveCheck;
	/**
	 * The last check before the lock is taken: whether the run's gate command can be
	 * run. Skipped when the run has no gate.
	 */
	checkGate?: (command: string) => ReturnType<SolveCheck>;
	/** Runs the run's gates; the loop's own runner when absent. */
	runGate?: GateRunner;
}

/** A finished run: the loop's result and what the run cost and used. */
export interface SolveRunResult extends LoopResult {
	roleTokens: RoleTally["tokens"];
	/** A line for each role whose answers came from another model than it was to run on. */
	mismatches: string[];
	ledgerDir: string;
	durationMs: number;
	cwd: string;
}

/**
 * How a call ended. Only `ran` took the lock, started sub-agents and wrote an audit
 * row; its `handoff` is the text the calling model reads.
 */
export type SolveOutcome =
	| ({ kind: "rejected" } & SolveRejection)
	| { kind: "canceled" }
	| { kind: "busy"; root: string; holder: LockHolder | null }
	| { kind: "ran"; result: SolveRunResult; handoff: string };

/** What the calling model reads for a run that was aborted. */
export const ABORTED_HANDOFF = "The ledger loop was aborted before completing.";

/** A line for each role whose answers came from a model other than the one it was to run on. */
function modelMismatches(host: SolveHost, tally: RoleTally): string[] {
	const effective = { manager: host.managerModel, worker: host.workerModel };
	return (["manager", "worker"] as const).flatMap((role) => {
		const ran = tally.models[role];
		const configured = effective[role] ?? host.sessionModel;
		return ran === null || configured === null || ran === configured
			? []
			: [`The ${role} ran on ${ran}, not the configured ${configured}.`];
	});
}

/** The live holder of the lock on work tree `root`, or null when there is none or it cannot be read. */
function readableHolder(stateDir: string, root: string): LockHolder | null {
	try {
		return lockHolder(stateDir, root);
	} catch {
		return null;
	}
}

/**
 * Run one `ledger_solve` call: check the task, work tree, plan file and fan-out
 * setting, running the harness's hooks between them, then lock the work tree, run the
 * loop and write its audit row. `SolveHost` says which checks are the harness's. An
 * unrecognized fan-out setting is passed to the host's `warn` and ignored.
 *
 * An abort seen after a hook returns, or at the last look before the lock, ends the
 * call as `canceled`, whatever the hook found. A rejection from one of the checks made
 * here can come first. The lock is released before this returns or throws.
 *
 * @returns how the call ended.
 * @throws when a check, the lock or the run itself fails unexpectedly.
 */
export async function solveTask(cfg: LedgerpiConfig, args: SolveArgs, host: SolveHost): Promise<SolveOutcome> {
	const reject = (reason: string, message: string, field?: string): SolveOutcome => ({
		kind: "rejected",
		reason,
		message,
		field,
	});
	const task = args.task.trim();
	if (!task) return reject("blank-task", "No task was provided.", "task");
	if (host.checkArgs) {
		const problem = await host.checkArgs();
		if (host.signal.aborted) return { kind: "canceled" };
		if (problem !== null) return { kind: "rejected", ...problem };
	}
	const repo = pinRepo(args.cwd);
	if (repo === null) return reject("not-git", `\`${args.cwd}\` is not a git repository.`, "cwd");
	if (host.checkTree) {
		const problem = await host.checkTree();
		if (host.signal.aborted) return { kind: "canceled" };
		if (problem !== null) return { kind: "rejected", ...problem };
	}
	const planPath = args.planFile?.trim();
	let plan: string | undefined;
	if (planPath) {
		const read = readPlanFile(planPath);
		if ("error" in read) return reject("bad-plan-file", `${read.error}.`, "planFile");
		plan = read.plan;
	}
	const fanout = asFanoutSetting(args.fanout);
	if (args.fanout !== undefined && fanout === undefined) {
		(host.warn ?? report)(
			`[ledgerpi] ignoring ${FANOUT_ARGUMENT[host.harness]} ${JSON.stringify(args.fanout)}: expected off, advise, ask or on`,
		);
	}
	if (host.beforeLock) {
		const problem = await host.beforeLock();
		if (host.signal.aborted) return { kind: "canceled" };
		if (problem !== null) return { kind: "rejected", ...problem };
	}
	const gateCommand = args.gate?.trim() || detectGate(cfg, args.cwd);
	if (gateCommand && host.checkGate) {
		const problem = await host.checkGate(gateCommand);
		if (host.signal.aborted) return { kind: "canceled" };
		if (problem !== null) return { kind: "rejected", ...problem };
	}
	if (host.signal.aborted) return { kind: "canceled" };
	// A dsh run lives inside the dsh server, so stopping it must not signal that process.
	const root = repo.workTree;
	const release = acquireLock(cfg.stateDir, root, { sharedProcess: host.harness === "dsh" });
	if (release === null) return { kind: "busy", root, holder: readableHolder(cfg.stateDir, root) };

	try {
		const ledger = new Ledger(cfg, args.session, `${Date.now()}-${randomUUID().slice(0, 8)}`);
		const { spawn, tally } = host.spawner(ledger);
		const startedAt = Date.now();
		const headStart = headInfo(repo);
		const looped = await runLoop({
			spawn,
			cfg,
			ledger,
			cwd: args.cwd,
			repo,
			task,
			gateCommand,
			runGate: host.runGate,
			sessionModel: host.sessionModel,
			managerModel: host.managerModel,
			workerModel: host.workerModel,
			plan,
			fanout,
			onProgress: host.onProgress,
			signal: host.signal,
		});
		const durationMs = Date.now() - startedAt;
		const result: SolveRunResult = {
			...looped,
			managerModel: tally.models.manager ?? looped.managerModel,
			workerModel: tally.models.worker ?? looped.workerModel,
			roleTokens: tally.tokens,
			mismatches: modelMismatches(host, tally),
			ledgerDir: ledger.dir,
			durationMs,
			cwd: args.cwd,
		};
		auditRun(
			cfg,
			{
				entry: host.entry,
				harness: host.harness,
				session: args.session,
				provider: host.provider,
				model: host.model,
				cwd: args.cwd,
			},
			result,
			{
				task,
				durationMs,
				classified: null,
				calls: result.calls,
				tokens: result.tokens,
				git: { start: headStart, end: headInfo(repo) },
				roleTokens: tally.tokens,
			},
		);
		return {
			kind: "ran",
			result,
			handoff:
				result.stop === "aborted" ? ABORTED_HANDOFF : [handoffBlock(repo, result), ...result.mismatches].join("\n"),
		};
	} finally {
		release();
	}
}
