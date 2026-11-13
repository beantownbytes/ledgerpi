import { type FanoutSetting, type LedgerpiConfig, lowerFanout } from "./config.ts";
import { type Candidate, chooseMode, type FanoutAnswer, type RoundMode, runBestOfN } from "./fanout.ts";
import { type GateVerdict, runGate } from "./gate.ts";
import { pruneStaleCandidates, workingDiff } from "./git.ts";
import type { Ledger } from "./ledger.ts";
import {
	briefFor,
	bullets,
	type FanoutMode,
	LIST_CAP,
	manageSections,
	parseBrief,
	parseMode,
	parseTasks,
	sections,
	stripCode,
	type Task,
	type TaskBrief,
} from "./parse.ts";
import {
	finalizePrompt,
	ideatePrompt,
	managePrompt,
	planPrompt,
	SUPPLIED_PLAN_RESULT,
	workerPrompt,
} from "./prompts.ts";
import type { SpawnFailureDetail, SpawnFn, SpawnResult } from "./spawn.ts";

const MANAGER = "ledger-manager";
const WORKER = "ledger-worker";

/**
 * The pass of the loop that spawned a sub-agent, for the sub-agent row label:
 * `plan` (the plan call), `ideate` (the ideation call), `manage` (the first
 * `manageOnce`, after ideation or straight from a supplied plan), `work` (the
 * in-loop iteration call), `review` (the post-gate `manageOnce`), `finalize`
 * (the post-loop finalize call).
 */
type Phase = "plan" | "ideate" | "manage" | "work" | "review" | "finalize";
const MANAGER_TURNS = 8;
const WORKER_TURNS = 30;
/** How often the gate's status label advances while the gate command runs. */
const GATE_TICK_MS = 1000;

export interface LoopResult {
	/** True when the gate passed (or, with no gate, the manager declared done). */
	converged: boolean;
	iters: number;
	calls: number;
	tokens: number;
	gate: GateVerdict | null;
	/** Why the loop stopped, for the hand-off block. */
	stop: "done" | "budget" | "no-progress" | "spawn-failure" | "unconverged" | "aborted";
	/**
	 * For `stop:"spawn-failure"`, which RPC failure branch ended the run: the first
	 * plan failure's or the second consecutive worker failure's category (the first
	 * failure's category is discarded), defaulted to "other" when the spawn result
	 * carries none. Undefined on every other stop -- the audit row writes null there.
	 */
	stopDetail?: SpawnFailureDetail;
	notes: string;
	tasks: Task[];
	/** The model the manager role ran on, or null when it ran on the session model. */
	managerModel: string | null;
	/** The model the worker role ran on, or null when it ran on the session model. */
	workerModel: string | null;
	/** Who wrote the plan: the caller (a supplied approved plan) or the manager's own plan call. */
	planSource: "caller" | "manager";
	/** What fan-out did; null when the effective setting was off. */
	fanout?: FanoutSummary | null;
	/** Where the run's time went, by role. */
	timing: RoleTiming;
}

/**
 * Summed, host-measured busy time and call counts per role over a run. Each spawn
 * (including a failed, timed-out or thrown one) is timed around the `spawn` await and
 * each gate run around the gate; the worker bucket takes `ledger-worker` spawns
 * (ideate, work, finalize, best-of-N candidates) and the manager bucket every other
 * spawn (plan, manage, review). Concurrent best-of-N candidates and an overlapping
 * gate are summed, so the total can exceed the run's wall-clock duration. `RoleTally`
 * in `packages/claude/src/rendezvous.ts` is the harness-side token counterpart.
 */
export interface RoleTiming {
	managerMs: number;
	workerMs: number;
	gateMs: number;
	managerCalls: number;
	workerCalls: number;
	gateRuns: number;
}

/**
 * What fan-out did over a run. `downgrades` lists, once each, why a round that
 * asked for fan-out ran one worker (`no-gate`, `latched`, `fleet-unavailable`,
 * `setup-failed`, and under `ask` `declined`, `no-ui`, `ask-failed`); `escapes`
 * lists the reasons a fan-out round was abandoned with the tree kept and fan-out
 * latched off for the rest of the run.
 */
export interface FanoutSummary {
	/** The effective setting: the lower of the config and the per-call override. */
	setting: FanoutSetting;
	max: number;
	/** Rounds that ran concurrent candidates. */
	rounds: number;
	downgrades: string[];
	escapes: string[];
	/** Times the user was asked to confirm a best-of-n round under `ask`; remembered answers are not counted. */
	asked: number;
	/** Rounds by the manager's MODE recommendation; `none` when it gave none, its call failed, or the gate override replaced the brief. */
	advised: Record<AdvisedMode, number>;
}

/** What the manager recommended for a round: a mode, or `none`. */
export type AdvisedMode = FanoutMode | "none";

/** A loop result before the run-wide role models, plan source, fan-out summary and timing are stamped on. */
type RoundsResult = Omit<LoopResult, "managerModel" | "workerModel" | "planSource" | "fanout" | "timing">;

export interface LoopDeps {
	spawn: SpawnFn;
	cfg: LedgerpiConfig;
	ledger: Ledger;
	cwd: string;
	task: string;
	/** The detected gate command, or undefined to run without a verifier. */
	gateCommand?: string;
	/** The session's `provider/modelId`, which an unpinned role inherits; null when unknown. Labels only. */
	sessionModel: string | null;
	/** The `provider/modelId` the manager role spawns on, or null for the session model. */
	managerModel: string | null;
	/** The `provider/modelId` the worker role spawns on, or null for the session model. */
	workerModel: string | null;
	/**
	 * An approved implementation plan from the caller. When non-blank, the loop skips
	 * its own plan and ideation calls and the manager builds the task list from it.
	 */
	plan?: string;
	/**
	 * A per-call fan-out setting. It can only lower the configured one: the effective
	 * setting is `lowerFanout(cfg.fanout, deps.fanout ?? cfg.fanout)`.
	 */
	fanout?: FanoutSetting;
	/**
	 * Asks the user whether to run a best-of-n round the manager recommended under the
	 * `ask` setting. `n` is the candidate count and `reason` the manager's stated
	 * reason. Dismissing the dialog means "no"; a rejected promise counts as `error`.
	 * Absent when there is no one to ask, and `ask` rounds then run one worker.
	 */
	confirmFanout?: (
		ask: { iter: number; n: number; reason: string | null },
		signal?: AbortSignal,
	) => Promise<FanoutAnswer>;
	onProgress: (iter: number, label: string) => void;
	signal?: AbortSignal;
}

/**
 * The manager-worker loop, the host-side port of the reference scaffold's
 * `multiagent_solve`. Every role is a fresh sub-agent: the manager on
 * `deps.managerModel` and the worker on `deps.workerModel`, a null pin meaning the
 * session model. The host owns the ledger files and runs the gate. Ground truth is
 * the gate: a failing run overrides a "done".
 *
 * With a supplied `deps.plan` the plan and ideation calls are skipped and the first
 * manage pass builds the task list from the plan. A first manage pass that yields no
 * task (including a failed manage spawn) goes straight to finalize.
 */
export async function runLoop(deps: LoopDeps): Promise<LoopResult> {
	const plan = deps.plan?.trim() || undefined;
	const setting = lowerFanout(deps.cfg.fanout, deps.fanout ?? deps.cfg.fanout);
	const fanout: FanoutSummary | null =
		setting === "off"
			? null
			: {
					setting,
					max: deps.cfg.fanoutMax,
					rounds: 0,
					downgrades: [],
					escapes: [],
					asked: 0,
					advised: { serial: 0, "best-of-n": 0, fleet: 0, none: 0 },
				};
	const timing: RoleTiming = { managerMs: 0, workerMs: 0, gateMs: 0, managerCalls: 0, workerCalls: 0, gateRuns: 0 };
	return {
		...(await runRounds({ ...deps, plan }, setting, fanout, timing)),
		managerModel: deps.managerModel,
		workerModel: deps.workerModel,
		planSource: plan ? "caller" : "manager",
		fanout,
		timing,
	};
}

/** Per-call overrides of `call`'s defaults, for a fan-out candidate. */
interface CallOverride {
	cwd?: string;
	signal?: AbortSignal;
	/** The sub-agent row label, in place of the phase. */
	label?: string;
}

/** Runs the rounds, adding each spawn's and gate run's time and count into `timing`. */
async function runRounds(
	deps: LoopDeps,
	fanout: FanoutSetting,
	fan: FanoutSummary | null,
	timing: RoleTiming,
): Promise<RoundsResult> {
	const { spawn, cfg, ledger, cwd, task, gateCommand, sessionModel, managerModel, workerModel, onProgress, signal } =
		deps;
	let calls = 0;
	let tokens = 0;

	const call = async (
		type: string,
		prompt: string,
		thinkingLevel: string,
		maxTurns: number,
		phase: Phase,
		over: CallOverride = {},
	) => {
		const label = over.label ?? phase;
		const workerRef = workerModel ?? sessionModel;
		const maxOutputTokens = type === WORKER && workerRef !== null ? cfg.workerMaxTokens[workerRef] : undefined;
		const startedAt = Date.now();
		let r: SpawnResult;
		try {
			r = await spawn({
				type,
				prompt,
				model: type === WORKER ? workerModel : managerModel,
				thinkingLevel,
				maxTurns,
				cwd: over.cwd ?? cwd,
				...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
				description:
					type === MANAGER
						? describe("ledger manager", managerModel ?? sessionModel, label)
						: describe("ledger worker", workerRef, label),
				signal: over.signal ?? signal,
				timeoutMs: cfg.callTimeoutMs,
			});
		} finally {
			const elapsed = Date.now() - startedAt;
			if (type === WORKER) {
				timing.workerMs += elapsed;
				timing.workerCalls += 1;
			} else {
				timing.managerMs += elapsed;
				timing.managerCalls += 1;
			}
		}
		calls += 1;
		tokens += r.tokens?.total ?? 0;
		ledger.record({ role: type, ok: r.ok, tokens: r.tokens, durationMs: r.durationMs, error: r.error });
		return r;
	};

	/**
	 * Runs the gate while advancing a `testing (gate Ns / Ls)` status label every
	 * `GATE_TICK_MS`, so the status line moves during a long gate instead of sitting
	 * still for up to `gateTimeoutMs`. The ticker is cleared in `finally`, covering
	 * pass, failure, timeout, abort, and spawn error alike, so no tick can land after
	 * the gate resolves and overwrite the next status label. The elapsed seconds are
	 * rounded rather than floored so a tick that fires just under a whole second
	 * cannot repeat the previous label.
	 */
	const gateWithProgress = async (iters: number, command: string): Promise<GateVerdict> => {
		const limitSec = Math.round(cfg.gateTimeoutMs / 1000);
		const label = (elapsedSec: number) => `testing (gate ${elapsedSec}s / ${limitSec}s)`;
		const startedAt = Date.now();
		onProgress(iters, label(0));
		const ticker = setInterval(() => {
			try {
				onProgress(iters, label(Math.min(limitSec, Math.round((Date.now() - startedAt) / 1000))));
			} catch {
				// A display-only status write must never take the loop down: a throw from a
				// timer callback has no promise chain to reject into.
				clearInterval(ticker);
			}
		}, GATE_TICK_MS);
		ticker.unref();
		try {
			return await runGate(command, cwd, cfg.gateTimeoutMs, signal);
		} finally {
			clearInterval(ticker);
			timing.gateMs += Date.now() - startedAt;
			timing.gateRuns += 1;
		}
	};

	/**
	 * Gate: ground truth. Runs the gate command at iteration `at` and records its
	 * verdict in the ledger.
	 *
	 * @returns the verdict, or the aborted run result when the signal fired while
	 * the gate ran (nothing is recorded then).
	 */
	const runAndRecordGate = async (
		command: string,
		at: number,
	): Promise<{ verdict: GateVerdict } | { aborted: RoundsResult }> => {
		const verdict = await gateWithProgress(at, command);
		if (signal?.aborted) return { aborted: abort(calls, tokens, at, verdict) };
		ledger.record({ role: "gate", command: verdict.command, ran: verdict.ran, passed: verdict.passed });
		return { verdict };
	};

	if (fanout !== "off") pruneStaleCandidates(cwd, cfg.stateDir);
	ledger.setTask(task);

	let tasks: Task[] = [];
	let firstResult: string;
	const suppliedPlan = deps.plan;
	if (suppliedPlan) {
		ledger.setSuppliedPlan(suppliedPlan);
		ledger.setTasksJson(tasks);
		firstResult = SUPPLIED_PLAN_RESULT;
	} else {
		// 1. Manager plan.
		onProgress(0, "planning");
		const planReply = await call(MANAGER, planPrompt(task), cfg.managerThinking, MANAGER_TURNS, "plan");
		if (signal?.aborted) return abort(calls, tokens);
		if (!planReply.ok) return spawnFailure(calls, tokens, ledger, planReply.detail);
		const planSec = sections(planReply.text ?? "");
		ledger.setPlan(planSec.PLAN ?? planReply.text ?? "");
		tasks = parseTasks(planSec.TASKS ?? "", LIST_CAP);
		ledger.setTasksJson(tasks);

		// 2. Ideation worker (no edits).
		onProgress(0, "ideating");
		const ideaReply = await call(
			WORKER,
			ideatePrompt(task, ledger.plan()),
			cfg.workerThinking,
			WORKER_TURNS,
			"ideate",
		);
		if (signal?.aborted) return abort(calls, tokens);
		if (ideaReply.ok) {
			const ideaSec = sections(ideaReply.text ?? "");
			if (ideaSec.NOTES) ledger.appendNotes(`## ideation\n${stripCode(ideaSec.NOTES)}`);
		}
		firstResult = "ideation complete";
	}

	// 3. First manage pass off the ideation or the supplied plan.
	let gate: GateVerdict | null = null;
	let manage = await manageOnce(call, cfg, ledger, cwd, task, tasks, firstResult, gate, gateCommand, "manage", fanout);
	if (signal?.aborted) return abort(calls, tokens);
	tasks = manage.tasks;
	ledger.setTasksJson(tasks);

	if (gateCommand && manage.status === "done") {
		const ran = await runAndRecordGate(gateCommand, 0);
		if ("aborted" in ran) return ran.aborted;
		gate = ran.verdict;
		manage = overrideRedDone(manage, gate);
	}

	let iters = 0;
	let prevNext: string | null = null;
	let consecutiveFailures = 0;
	let fanoutLatched = false;
	let remembered: "yes-run" | "no-run" | null = null;

	while (manage.status === "continue" && manage.brief.task && iters < cfg.maxIters) {
		if (prevNext !== null && manage.brief.task.trim().toLowerCase() === prevNext.trim().toLowerCase()) {
			return finish(false, iters, calls, tokens, gate, "no-progress", ledger, tasks);
		}
		prevNext = manage.brief.task;
		iters += 1;
		let round: RoundMode = chooseMode({
			setting: fanout,
			hasGate: gateCommand !== undefined,
			latched: fanoutLatched,
			advised: manage.advice.mode,
		});
		if (round.mode === "best-of-n" && fanout === "ask" && fan) {
			if (remembered === "no-run") {
				round = { mode: "serial", downgrade: "declined" };
			} else if (remembered === null) {
				if (!deps.confirmFanout) {
					round = { mode: "serial", downgrade: "no-ui" };
				} else {
					fan.asked += 1;
					let answer: FanoutAnswer;
					try {
						answer = await deps.confirmFanout(
							{ iter: iters, n: cfg.fanoutMax, reason: manage.advice.reason },
							signal,
						);
					} catch {
						answer = "error";
					}
					if (signal?.aborted) return abort(calls, tokens, iters, gate);
					switch (answer) {
						case "yes":
							break;
						case "yes-run":
							remembered = "yes-run";
							break;
						case "no-run":
							remembered = "no-run";
							round = { mode: "serial", downgrade: "declined" };
							break;
						case "error":
							round = { mode: "serial", downgrade: "ask-failed" };
							break;
						default:
							// "no", and any answer this switch does not know, must not fan out.
							round = { mode: "serial", downgrade: "declined" };
					}
				}
			}
		}
		if (fan) {
			fan.advised[manage.advice.mode ?? "none"] += 1;
			if (round.mode === "serial" && round.downgrade) addOnce(fan.downgrades, round.downgrade);
		}
		ledger.record({
			...manage.brief,
			role: "brief",
			iter: iters,
			taskSource: manage.taskSource,
			mode: round.mode,
			...(fanout === "off"
				? {}
				: {
						advised: manage.advice.mode,
						reason: manage.advice.reason,
						downgrade: round.mode === "serial" ? round.downgrade : null,
					}),
		});

		const workerArgs = {
			task,
			plan: ledger.plan(),
			notes: ledger.notes(),
			diff: workingDiff(cwd),
			brief: manage.brief,
			gateHint: gateCommand,
		};
		const serialWorker = () => {
			onProgress(iters, "working");
			return call(WORKER, workerPrompt(workerArgs), cfg.workerThinking, WORKER_TURNS, "work");
		};

		let worker: WorkerReply;
		let roundGate: GateVerdict | null = null;
		if (round.mode === "best-of-n" && fan && gateCommand) {
			const n = cfg.fanoutMax;
			onProgress(iters, `working (best-of-${n})`);
			const fanGate = async (): Promise<GateVerdict | null> => {
				const ran = await runAndRecordGate(gateCommand, iters);
				return "aborted" in ran ? null : ran.verdict;
			};
			const outcome = await runBestOfN({
				cwd,
				ledgerDir: ledger.dir,
				iter: iters,
				n,
				runWorker: (c: Candidate, childSignal) =>
					call(
						WORKER,
						workerPrompt({ ...workerArgs, worktree: c.worktree }),
						cfg.workerThinking,
						WORKER_TURNS,
						"work",
						{ cwd: c.cwd, signal: childSignal, label: `work ${c.index}/${n}` },
					),
				runGate: fanGate,
				signal,
			});
			if (signal?.aborted || outcome.kind === "aborted") return abort(calls, tokens, iters, gate);
			ledger.record({
				role: "fanout",
				iter: iters,
				outcome: outcome.kind,
				...(outcome.kind === "unavailable" ? {} : { attempts: outcome.attempts }),
				...(outcome.kind === "unavailable" || outcome.kind === "escaped" ? { reason: outcome.reason } : {}),
			});
			switch (outcome.kind) {
				case "unavailable":
					fanoutLatched = true;
					addOnce(fan.downgrades, "setup-failed");
					worker = await serialWorker();
					break;
				case "kept":
					fan.rounds += 1;
					worker = outcome.worker;
					roundGate = outcome.gate;
					break;
				case "failed":
					fan.rounds += 1;
					worker = outcome.worker ?? { ok: false };
					break;
				case "escaped":
					fan.rounds += 1;
					fanoutLatched = true;
					addOnce(fan.escapes, outcome.reason);
					worker = outcome.worker ?? { ok: true };
					break;
			}
		} else {
			worker = await serialWorker();
		}
		if (signal?.aborted) return abort(calls, tokens, iters, gate);
		if (!worker.ok) {
			consecutiveFailures += 1;
			if (consecutiveFailures >= 2) {
				if (gateCommand) {
					const ran = await runAndRecordGate(gateCommand, iters);
					if ("aborted" in ran) return ran.aborted;
					gate = ran.verdict;
				}
				return finish(false, iters, calls, tokens, gate, "spawn-failure", ledger, tasks, worker.detail);
			}
			// Reissue the same task next iteration. Clear prevNext so the identical
			// task does not read as no-progress -- a transient spawn failure is not
			// the manager stalling on the same instruction.
			prevNext = null;
			continue;
		}
		consecutiveFailures = 0;
		const wSec = sections(worker.text ?? "");
		if (wSec.NOTES) ledger.setNotes(wSec.NOTES);
		const workerSummary = summarize(worker.text ?? "", wSec);

		if (roundGate) {
			gate = roundGate;
		} else if (gateCommand) {
			const ran = await runAndRecordGate(gateCommand, iters);
			if ("aborted" in ran) return ran.aborted;
			gate = ran.verdict;
		}

		onProgress(iters, "reviewing");
		manage = await manageOnce(
			call,
			cfg,
			ledger,
			cwd,
			task,
			tasks,
			workerSummary,
			gate,
			gateCommand,
			"review",
			fanout,
		);
		if (signal?.aborted) return abort(calls, tokens, iters, gate);
		tasks = manage.tasks;
		ledger.setTasksJson(tasks);
		manage = overrideRedDone(manage, gate);
	}

	const gatePassed = gate ? gate.ran && gate.passed : manage.status === "done";
	if (manage.status === "done" && gatePassed) {
		return finish(true, iters, calls, tokens, gate, "done", ledger, tasks);
	}

	// 4. Finalize: one definitive pass when the loop ended unconverged.
	onProgress(iters, "finalizing");
	const fin = await call(
		WORKER,
		finalizePrompt({
			task,
			plan: ledger.plan(),
			notes: ledger.notes(),
			diff: workingDiff(cwd),
			gateHint: gateCommand,
		}),
		cfg.workerThinking,
		WORKER_TURNS,
		"finalize",
	);
	if (signal?.aborted) return abort(calls, tokens, iters, gate);
	if (fin.ok) {
		const fSec = sections(fin.text ?? "");
		if (fSec.NOTES) ledger.setNotes(fSec.NOTES);
	}
	if (gateCommand) {
		const ran = await runAndRecordGate(gateCommand, iters);
		if ("aborted" in ran) return ran.aborted;
		gate = ran.verdict;
	}
	const converged = gate ? gate.ran && gate.passed : manage.status === "done";
	return finish(
		converged,
		iters,
		calls,
		tokens,
		gate,
		converged ? "done" : iters >= cfg.maxIters ? "budget" : "unconverged",
		ledger,
		tasks,
	);
}

/**
 * Where a brief's task came from: the manager's NEXT, the first open task-list
 * entry when the reply had no NEXT (`task-list`) or the manage call failed
 * (`manage-failed`), or the red-gate override.
 */
type TaskSource = "next" | "task-list" | "manage-failed" | "gate-override";

/** The manager's `### MODE` recommendation; `mode` is null when it gave none or fan-out was not asked for. */
interface Advice {
	mode: FanoutMode | null;
	reason: string;
}

const NO_ADVICE: Advice = { mode: null, reason: "" };

interface ManageOut {
	status: "done" | "continue";
	/** The next worker round's brief; its task is empty when there is none. */
	brief: TaskBrief;
	taskSource: TaskSource;
	tasks: Task[];
	advice: Advice;
}

/** What the loop reads from a worker call: a spawn result, or its stand-in for a fan-out round. */
type WorkerReply = Pick<SpawnResult, "ok" | "text" | "detail">;

function addOnce(list: string[], item: string): void {
	if (!list.includes(item)) list.push(item);
}

type CallFn = (
	type: string,
	prompt: string,
	thinkingLevel: string,
	maxTurns: number,
	phase: Phase,
) => Promise<{ ok: boolean; text?: string }>;

async function manageOnce(
	call: CallFn,
	cfg: LedgerpiConfig,
	ledger: Ledger,
	cwd: string,
	task: string,
	tasks: Task[],
	lastResult: string,
	gate: GateVerdict | null,
	gateCommand: string | undefined,
	phase: Phase,
	fanout: FanoutSetting,
): Promise<ManageOut> {
	const reply = await call(
		MANAGER,
		managePrompt({
			task,
			plan: ledger.plan(),
			notes: ledger.notes(),
			diff: workingDiff(cwd),
			tasks,
			lastResult,
			gate,
			gateHint: gateCommand,
			fanout: fanout === "off" ? undefined : fanout,
		}),
		cfg.managerThinking,
		MANAGER_TURNS,
		phase,
	);
	if (!reply.ok)
		return {
			status: "continue",
			brief: briefFor(tasks.find((t) => t.status !== "done")?.desc ?? ""),
			taskSource: "manage-failed",
			tasks,
			advice: NO_ADVICE,
		};
	const sec = manageSections(reply.text ?? "");
	const curated = parseTasks(sec.TASKS ?? "", LIST_CAP);
	const status = (sec.STATUS ?? "").trim().toLowerCase().startsWith("done") ? "done" : "continue";
	let brief = parseBrief(sec);
	let taskSource: TaskSource = "next";
	if (status === "continue" && !brief.task) {
		brief = { ...brief, task: (curated.length ? curated : tasks).find((t) => t.status !== "done")?.desc ?? "" };
		taskSource = "task-list";
	}
	return {
		status,
		brief,
		taskSource,
		tasks: curated.length ? curated : tasks,
		advice: fanout === "off" ? NO_ADVICE : parseMode(sec),
	};
}

function summarize(text: string, sec: Record<string, string>): string {
	const status = (sec.STATUS ?? "continue").trim().toLowerCase();
	const next = bullets(sec.NEXT ?? "").filter((b) => b.toLowerCase() !== "none");
	return `worker reported '${status}', ${next.length} next steps. ${(sec.NOTES ?? text).slice(0, 200)}`;
}

/**
 * The sub-agent row label: the role, the model it runs on when known, and the
 * pass phase the spawn belongs to.
 */
function describe(role: string, model: string | null, label: string): string {
	return model ? `${role} (${model}, ${label})` : `${role} (${label})`;
}

function finish(
	converged: boolean,
	iters: number,
	calls: number,
	tokens: number,
	gate: GateVerdict | null,
	stop: LoopResult["stop"],
	ledger: Ledger,
	tasks: Task[],
	stopDetail?: SpawnFailureDetail,
): RoundsResult {
	// Only a spawn-failure stop carries a category; unclassified failures default
	// to "other" here so the audit row always has a concrete value.
	const detail = stop === "spawn-failure" ? (stopDetail ?? "other") : undefined;
	return { converged, iters, calls, tokens, gate, stop, stopDetail: detail, notes: ledger.notes(), tasks };
}

/**
 * A "done" while the gate is red is overridden -- ground truth wins. The done
 * reply's brief fields described finished work, so only its task carries over.
 * Any other status, a green gate, or a gate that never ran leaves `manage` as is.
 */
function overrideRedDone(manage: ManageOut, gate: GateVerdict | null): ManageOut {
	if (!(gate?.ran && !gate.passed && manage.status === "done")) return manage;
	return {
		...manage,
		status: "continue",
		brief: briefFor(manage.brief.task || "The gate is still failing; fix it or try a different approach."),
		taskSource: "gate-override",
		advice: NO_ADVICE,
	};
}

function abort(calls: number, tokens: number, iters = 0, gate: GateVerdict | null = null): RoundsResult {
	return { converged: false, iters, calls, tokens, gate, stop: "aborted", notes: "", tasks: [] };
}

function spawnFailure(calls: number, tokens: number, ledger: Ledger, detail?: SpawnFailureDetail): RoundsResult {
	return {
		converged: false,
		iters: 0,
		calls,
		tokens,
		gate: null,
		stop: "spawn-failure",
		stopDetail: detail ?? "other",
		notes: ledger.notes(),
		tasks: [],
	};
}
