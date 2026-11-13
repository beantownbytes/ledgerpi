import { randomUUID } from "node:crypto";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { asFanoutSetting, type LedgerpiConfig } from "../../packages/core/src/config.ts";
import { Ledger } from "../../packages/core/src/ledger.ts";
import { type LoopDeps, type LoopResult, runLoop } from "../../packages/core/src/loop.ts";
import { report } from "../../packages/core/src/report.ts";
import type { SpawnOptions, SpawnResult } from "../../packages/core/src/spawn.ts";
import { ping, spawn } from "./rpc.ts";
import { sessionSlug } from "./session.ts";

/** herdr's blocked-state channel (`{ active, label }`), so a pane waiting on a ledgerpi dialog reads as blocked. */
export const HERDR_BLOCKED_EVENT = "herdr:blocked";

/** Availability of the pi-subagents RPC in this session, probed lazily on first use. */
export type ReadyState = "unknown" | "yes" | "no";

export interface LastRun {
	at: number;
	converged: boolean;
	iters: number;
	calls: number;
	tokens: number;
	stop: string;
}

/**
 * Mutable per-session state shared by both entry points into the loop -- the
 * `input` hook (a directly typed prompt) and the `ledger_solve` tool (a call the
 * model makes mid-run inside a skill). Sharing one object keeps the re-entrancy
 * guard, the RPC readiness probe, and the token accounting consistent no matter
 * which path started a run, so `/ledgerpi` reports the whole session's spend.
 */
export interface SessionState {
	/** True while a loop is running; blocks a second concurrent loop in this session. */
	running: boolean;
	readyState: ReadyState;
	lastRun?: LastRun;
	sessionTotals: { runs: number; calls: number; tokens: number };
	/** autoTrigger=redirect: the edit-redirect is armed for the current agent run. */
	armed: boolean;
	/** Blocked-edit attempts in the current armed window; caps the fallback. */
	redirectAttempts: number;
	/** trigger=ask: the user chose Run at the redirect dialog for the current armed window, so it is not asked again. */
	redirectConsented: boolean;
	/** The most recent before_agent_start prompt, used to hint the ledger_solve task. */
	lastInstruction?: string;
	/** True when the input hook owns this turn, so before_agent_start must not arm. */
	turnOwnedByInputHook: boolean;
	/**
	 * The slash-command name of the most recent `/…` input (without the leading `/`),
	 * or undefined. It is the reliable signal for which skill drove a run -- the input
	 * event carries the raw command before expansion. `before_agent_start` consumes it
	 * (reads then clears), binding redirect eligibility to the one run that command
	 * launched; a follow-on run with no fresh command is fail-closed. Also cleared by a
	 * natural prompt and on session_start.
	 */
	lastSlashCommand?: string;
	/** trigger=ask: the user chose "Skip for this session", so the input hook stops asking until session_start. */
	askSuppressed: boolean;
}

export function newState(): SessionState {
	return {
		running: false,
		readyState: "unknown",
		sessionTotals: { runs: 0, calls: 0, tokens: 0 },
		armed: false,
		redirectAttempts: 0,
		redirectConsented: false,
		turnOwnedByInputHook: false,
		askSuppressed: false,
	};
}

/**
 * Resolve whether the pi-subagents RPC is available, probing once and caching the
 * verdict for the session. Returns true only when the ping was answered.
 */
export async function ensureReady(events: EventBus, state: SessionState, timeoutMs: number): Promise<boolean> {
	if (state.readyState === "unknown") {
		state.readyState = (await ping(events, timeoutMs)) ? "yes" : "no";
	}
	return state.readyState === "yes";
}

/**
 * Fold one loop result into `lastRun` and the running session totals. `extraCalls`
 * and `extraTokens` account for work the loop itself does not count (the input
 * hook's classifier call); the tool path passes zero. Also disarms the
 * edit-redirect: this is the single point, shared by both entry points, that
 * guarantees the loop runs at most once per armed window and that the input hook
 * and the redirect can never double-run.
 */
export function recordRun(state: SessionState, result: LoopResult, extraCalls: number, extraTokens: number): LastRun {
	const calls = result.calls + extraCalls;
	const tokens = result.tokens + extraTokens;
	const lastRun: LastRun = {
		at: Date.now(),
		converged: result.converged,
		iters: result.iters,
		calls,
		tokens,
		stop: result.stop,
	};
	state.lastRun = lastRun;
	state.sessionTotals.runs += 1;
	state.sessionTotals.calls += calls;
	state.sessionTotals.tokens += tokens;
	state.armed = false;
	state.redirectAttempts = 0;
	state.redirectConsented = false;
	return lastRun;
}

/**
 * Wrap the RPC spawn so a call carrying `maxOutputTokens` runs on a copy of its
 * registry model whose `maxTokens` is that cap. The copy is what reaches
 * pi-subagents' `options.model`; the registry's own model and `models.json` are
 * untouched, so only that spawn is capped. The ref is `opts.model`, or the session
 * model when the worker runs on it (`opts.model` null). A ref the registry cannot
 * resolve spawns unchanged, and a cap at or above the context window still applies;
 * each is reported once per run, per ref.
 */
function cappedSpawn(
	events: EventBus,
	ctx: ExtensionContext,
	sessionModel: string | null,
): (opts: SpawnOptions) => Promise<SpawnResult> {
	const warned = new Set<string>();
	const warnOnce = (key: string, msg: string) => {
		if (warned.has(key)) return;
		warned.add(key);
		if (ctx.hasUI) ctx.ui.notify(msg, "warning");
		else console.error(msg);
	};
	return (opts) => {
		const { maxOutputTokens: cap, ...rest } = opts;
		if (cap === undefined) return spawn(events, rest);
		const ref = opts.model ?? sessionModel;
		const slash = ref?.indexOf("/") ?? -1;
		const found =
			ref !== null && slash > 0 ? ctx.modelRegistry?.find?.(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
		if (found === undefined) {
			warnOnce(
				`unknown:${ref}`,
				`[ledgerpi] [workerMaxTokens] entry for "${ref}" ignored: the model registry does not know that model; the worker keeps its default cap`,
			);
			return spawn(events, rest);
		}
		if (cap >= found.contextWindow) {
			warnOnce(
				`window:${ref}`,
				`[ledgerpi] [workerMaxTokens] entry for "${ref}" is ${cap}, at or above its context window (${found.contextWindow}); the cap still applies but cannot be reached`,
			);
		}
		return spawn(events, { ...rest, model: { ...found, maxTokens: cap } });
	};
}

const FANOUT_YES = "Yes (this round)";
const FANOUT_NO = "No, run serially";
const FANOUT_YES_RUN = "Yes for the rest of this run";
const FANOUT_NO_RUN = "No for the rest of this run";

/**
 * Build the `confirmFanout` dependency for `fanout = "ask"`: a select dialog offering
 * the best-of-n round the manager recommended. Returns undefined without a UI, so the
 * loop runs the round serially as `no-ui`. A dismissed dialog counts as "no"; a dialog
 * that throws is reported and counts as "error". Reports the wait on herdr's blocked
 * channel and through `onDialog` for as long as the dialog is open, so the caller can
 * keep its own Escape handling out of the dialog's way.
 */
export function fanoutAsker(
	events: EventBus,
	ctx: ExtensionContext,
	onDialog?: (open: boolean) => void,
): LoopDeps["confirmFanout"] {
	if (!ctx.hasUI) return undefined;
	return async (ask, signal) => {
		try {
			events.emit(HERDR_BLOCKED_EVENT, { active: true, label: "question: ledgerpi" });
			onDialog?.(true);
			const why = ask.reason ? ` Manager's reason: ${ask.reason}` : "";
			const choice = await ctx.ui.select(
				`ledgerpi: run this round as ${ask.n} concurrent workers (best-of-n)?${why}`,
				[FANOUT_YES, FANOUT_NO, FANOUT_YES_RUN, FANOUT_NO_RUN],
				{ signal },
			);
			if (choice === FANOUT_YES) return "yes";
			if (choice === FANOUT_YES_RUN) return "yes-run";
			return choice === FANOUT_NO_RUN ? "no-run" : "no";
		} catch (err) {
			report(`[ledgerpi] fan-out dialog failed: ${(err as Error).message}`);
			return "error";
		} finally {
			events.emit(HERDR_BLOCKED_EVENT, { active: false });
			onDialog?.(false);
		}
	};
}

/**
 * Build a fresh ledger for this turn and run the manager-worker loop against it.
 * `cwd` is passed explicitly rather than read from `ctx`: the input hook uses the
 * session cwd, but the `ledger_solve` tool may target a carved worktree whose path
 * is not the session cwd. `signal` is likewise explicit: pi's `ctx.signal` exists
 * only while the agent streams, so the idle-started entry points supply their own.
 * `models` holds the caller's snapshot, taken before its awaits, of the session's
 * `provider/modelId` (`session`) and its `roleModelsFor` result (`manager` and
 * `worker`, null for the session model), so the roles run on the models the audit
 * row names even if the session model changes mid-turn. `plan`, when given, is an
 * approved implementation plan the loop builds its task list from instead of
 * planning itself. `fanout`, when it names a setting, lowers the configured fan-out
 * for this run (the loop never lets it raise it); any other value is ignored.
 * `onDialog` is told when the `ask` fan-out dialog opens and closes.
 */
export function runLedger(
	events: EventBus,
	cfg: LedgerpiConfig,
	ctx: ExtensionContext,
	cwd: string,
	task: string,
	gateCommand: string | undefined,
	models: { session: string | null; manager: string | null; worker: string | null },
	onProgress: (iter: number, label: string) => void,
	signal: AbortSignal | undefined,
	plan?: string,
	fanout?: string,
	onDialog?: (open: boolean) => void,
): Promise<LoopResult> {
	const ledger = new Ledger(cfg, sessionSlug(ctx), `${Date.now()}-${randomUUID().slice(0, 8)}`);
	return runLoop({
		spawn: cappedSpawn(events, ctx, models.session),
		cfg,
		ledger,
		cwd,
		task,
		gateCommand,
		sessionModel: models.session,
		managerModel: models.manager,
		workerModel: models.worker,
		plan,
		fanout: asFanoutSetting(fanout),
		confirmFanout: fanoutAsker(events, ctx, onDialog),
		signal,
		onProgress,
	});
}
