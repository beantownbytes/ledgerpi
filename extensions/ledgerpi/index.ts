import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { type AuditMeta, auditPassthrough, auditRun } from "../../packages/core/src/audit.ts";
import {
	disabledByEnv,
	inScope,
	loadConfig,
	modelRef,
	type RolePin,
	type RoleSource,
	redirectSkillAllowed,
	roleModelsFor,
	scopeReason,
} from "../../packages/core/src/config.ts";
import { detectGate } from "../../packages/core/src/gate.ts";
import { headInfo, isGitRepo, isInWorkTree } from "../../packages/core/src/git.ts";
import { handoffBlock } from "../../packages/core/src/handoff.ts";
import type { LoopResult } from "../../packages/core/src/loop.ts";
import { bindUISink, releaseUISink, report, uiSinkBound } from "../../packages/core/src/report.ts";
import { WORKER_SENTINEL } from "../../packages/core/src/spawn.ts";
import { classify } from "./classifier.ts";
import { WorkflowMutex } from "./mutex.ts";
import { mutatingTarget, redirectReason } from "./redirect.ts";
import { ensureReady, HERDR_BLOCKED_EVENT, newState, recordRun, runLedger } from "./runner.ts";
import { sessionSlug } from "./session.ts";
import { ledgerSolveTool } from "./tool.ts";

/** How long to wait for the pi-subagents RPC ping reply before treating it as absent. */
const READY_TIMEOUT_MS = 750;

/** How long session teardown waits for a cancelled loop to unwind and audit before pi disposes the session. */
const SHUTDOWN_GRACE_MS = 5_000;

/** How many inline edits the redirect blocks before relenting, so it is never worse than not installed. */
const MAX_REDIRECTS = 2;

/** How `/ledgerpi` names the config source that pinned the session model's role pair. */
const ROLE_SOURCE_LABEL: Record<RoleSource, string> = {
	roleModel: "[roleModel]",
	roleModelDefault: "[roleModel] default",
	workerModel: "[workerModel] (deprecated)",
	session: "session",
};

/** Render a role pin the way `/ledgerpi` prints it, spelling an unset role as the session model. */
const rolePairText = (pin: RolePin): string =>
	`manager=${pin.manager ?? "session model"}, worker=${pin.worker ?? "session model"}`;

const ASK_RUN = "Run ledger loop";
const ASK_SKIP = "Skip (this prompt)";
const ASK_SKIP_SESSION = "Skip for this session";

/** The outcome of the trigger=ask dialog: the user's choice, or "error" when the dialog itself failed. */
type AskAnswer = "run" | "skip" | "skip-session" | "error";

/** The passthrough audit reason for each way the ask dialog can end without a run. */
const ASK_DECLINE_REASON: Record<Exclude<AskAnswer, "run">, string> = {
	skip: "declined",
	"skip-session": "declined-session",
	error: "ask-error",
};

/** A leading char that marks the input as a command/mention/bash escape, never a task. */
function isEscaped(text: string): boolean {
	return /^[/!@]/.test(text);
}

/**
 * A continuation-only prompt: the entire message is a bare "go on" request. The
 * closed set: an optional single leading "please", one head (continue, resume, go
 * on, keep going, carry on, pick up where we/you left off), for continue/resume
 * only an optional context-only suffix (where we/you left off, from where we/you
 * left off, the previous task, the last task), an optional single trailing
 * "please", an optional terminal "." or "!",
 * and at most one closed-set interruption clause ("i had to close my laptop",
 * "i closed my laptop", "my laptop went to sleep", "i got disconnected", "the
 * connection dropped") after one separator (--, -, comma, colon, semicolon, period)
 * followed by a space. Anchoring the whole normalized message -- not a prefix -- is
 * what keeps standalone coding requests that merely begin with "continue"/"resume"
 * out of the set.
 */
const CONTINUATION_ONLY_RE =
	/^(?:please )?(?:(?:continue|resume)(?: (?:where we left off|where you left off|from where we left off|from where you left off|the previous task|the last task))?|go on|keep going|carry on|pick up where we left off|pick up where you left off)(?: please)?(?:[.!])?(?:(?: )?(?:--|-|,|:|;|\.) (?:i had to close my laptop|i closed my laptop|my laptop went to sleep|i got disconnected|the connection dropped)(?:[.!])?)?$/;

/** True when the whole message is a bare continuation request; never rewrites the input. */
function isContinuationOnly(text: string): boolean {
	const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
	if (!normalized) return false;
	return CONTINUATION_ONLY_RE.test(normalized);
}

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();
	const mutex = new WorkflowMutex(pi.events);

	/**
	 * Per-session loop state, shared with the `ledger_solve` tool so the two entry
	 * points never run concurrently and `/ledgerpi` accounts for both. pi's own
	 * session counter does NOT include the RPC-spawned manager/worker (they are
	 * top-level agents, not children folded into the parent), so `sessionTotals` is
	 * the authoritative tally of what ledgerpi cost; `calls`/`tokens` include the
	 * input hook's classifier call.
	 */
	const state = newState();

	/**
	 * The running `input`-hook or `/ledger` loop, or undefined: its cancel handle and a
	 * promise that resolves once the run has audited and released the session. Those
	 * runs start only while the session is idle, when pi offers no abort signal, so
	 * they carry their own; Escape, `/ledger-stop`, and session teardown abort it. A
	 * `ledger_solve` run never sets it: it runs inside a streaming turn and uses pi's
	 * signal.
	 */
	let activeRun: { controller: AbortController; settled: Promise<void> } | undefined;

	/** Set once `session_shutdown` cancels a run, so its entry point does not notify a session being torn down. */
	let tearingDown = false;

	/** This instance's identity as holder of the process-wide UI sink (see report.ts). */
	const sinkOwner = {};

	/** Set once `cfg.warnings` has been reported, so a repeated `session_start` on this instance does not repeat them. */
	let warningsReported = false;

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		// A resumed/forked/new session re-binds the mutex identity and re-probes readiness.
		state.readyState = "unknown";
		state.armed = false;
		state.redirectAttempts = 0;
		state.redirectConsented = false;
		state.turnOwnedByInputHook = false;
		state.lastInstruction = undefined;
		state.lastSlashCommand = undefined;
		state.askSuppressed = false;
		tearingDown = false;
		if (ctx.hasUI) bindUISink(sinkOwner, ctx);
		if (warningsReported) return;
		warningsReported = true;
		// A headless session while a UI session in this process holds the sink is an
		// in-process sub-agent sharing that terminal; the UI session already reported
		// the same config, so its copy is dropped rather than written over the TUI.
		if (ctx.hasUI || !uiSinkBound()) for (const w of cfg.warnings) sayTo(ctx, w);
	});

	const dbg = (msg: string) => {
		if (process.env.LEDGERPI_DEBUG) console.error(`[ledgerpi:dbg] ${msg}`);
	};

	/** Notify the user: a UI notice when there is a UI, else stderr (print mode keeps stdout for pi). */
	const sayTo = (ctx: ExtensionContext, msg: string, type: "info" | "warning" | "error" = "warning") => {
		if (ctx.hasUI) ctx.ui.notify(msg, type);
		else console.error(msg);
	};

	/**
	 * Ask whether to run the loop on this prompt (trigger=ask). Escape or a dismissed
	 * dialog counts as "skip"; a dialog that throws is "error". Either way the turn
	 * passes through. Reports the wait on herdr's blocked channel for as long as the
	 * dialog is open.
	 */
	const askToRun = async (ctx: ExtensionContext): Promise<AskAnswer> => {
		pi.events.emit(HERDR_BLOCKED_EVENT, { active: true, label: "question: ledgerpi" });
		try {
			const choice = await ctx.ui.select(
				"ledgerpi: run the manager-worker loop on this prompt?",
				[ASK_RUN, ASK_SKIP, ASK_SKIP_SESSION],
				{ signal: ctx.signal },
			);
			if (choice === ASK_RUN) return "run";
			return choice === ASK_SKIP_SESSION ? "skip-session" : "skip";
		} catch (err) {
			report(`[ledgerpi] ask dialog failed: ${(err as Error).message}`);
			return "error";
		} finally {
			pi.events.emit(HERDR_BLOCKED_EVENT, { active: false });
		}
	};

	/**
	 * Ask whether to run the loop (trigger=ask) and record a decline, shared by the
	 * input hook and the skill-session redirect. A session skip suppresses the dialog on
	 * both paths until session_start; every answer but Run is audited as a passthrough
	 * row with `meta` and the caller's classifier spend in `decline`.
	 */
	const askOrDecline = async (
		ctx: ExtensionContext,
		meta: AuditMeta,
		decline: { classified: string | null; tokens: number; calls: number },
	): Promise<AskAnswer> => {
		const answer = await askToRun(ctx);
		if (answer === "run") return answer;
		if (answer === "skip-session") {
			state.askSuppressed = true;
			ctx.ui.notify("ledgerpi: not asking again this session; run /ledger <task> to start the loop.", "info");
		}
		auditPassthrough(cfg, meta, decline.classified, ASK_DECLINE_REASON[answer], decline.tokens, decline.calls);
		return answer;
	};

	/**
	 * Claim the session run guard and the workflow mutex, run the loop on `task` in
	 * the session cwd, fold it into the session totals, and append its audit row.
	 * Shared by the `input` hook and the `/ledger` command. Returns undefined with
	 * nothing run when a loop or another workflow already holds the session. The
	 * guard check and claim happen before the first await, so a raced run is never
	 * double-started. `model` is the provider/model the caller snapshotted before
	 * its awaits, so the audit row names the model that was in scope. `extra` carries
	 * the classifier call the loop itself does not count. The run is cancellable: it
	 * publishes its own controller as `activeRun` and, with a UI, consumes Escape to
	 * abort it; a cancelled run returns `stop: "aborted"` and is audited as such.
	 * Errors propagate to the caller after the guard, mutex, and Escape listener are
	 * released.
	 */
	const runAndAudit = async (
		ctx: ExtensionContext,
		entry: "input" | "command",
		task: string,
		gateCommand: string | undefined,
		model: { provider?: string; model?: string },
		extra: { calls: number; tokens: number; classified: string | null },
	): Promise<LoopResult | undefined> => {
		if (state.running) return undefined;
		// Cooperatively claim the workflow group so a concurrent goal or plan-mode
		// run defers. If someone else holds it, nothing runs.
		mutex.bind(ctx.sessionManager);
		if (!mutex.acquire()) return undefined;
		state.running = true;
		// Read the audit provenance now, while the context is certainly live: a run
		// cancelled by session teardown may finish after pi has invalidated it.
		const where = { session: sessionSlug(ctx), cwd: ctx.cwd };
		const controller = new AbortController();
		let settle = () => {};
		const active = {
			controller,
			settled: new Promise<void>((resolve) => {
				settle = resolve;
			}),
		};
		activeRun = active;
		let stopListening: (() => void) | undefined;
		let fanoutDialogOpen = false;
		try {
			const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
			// Consume Escape while the loop runs: the session is idle, so pi would otherwise
			// treat it as the first half of a double-escape rather than an interrupt. While the
			// fan-out dialog is open, Escape belongs to the dialog (it means "no"), so it passes.
			if (ctx.hasUI) {
				stopListening = ctx.ui.onTerminalInput((data) => {
					if (fanoutDialogOpen || isKeyRelease(data) || !matchesKey(data, "escape")) return undefined;
					controller.abort();
					return { consume: true };
				});
			}
			const startedAt = Date.now();
			const headStart = headInfo(where.cwd);
			const roles = roleModelsFor(cfg, model.provider, model.model);
			const result = await runLedger(
				pi.events,
				cfg,
				ctx,
				ctx.cwd,
				task,
				gateCommand,
				{
					session: modelRef(model.provider, model.model),
					manager: roles?.manager ?? null,
					worker: roles?.worker ?? null,
				},
				(iter, label) => {
					if (ctx.hasUI) ctx.ui.setStatus("ledgerpi", `ledger ${iter}/${cfg.maxIters}: ${label} (esc to stop)`);
				},
				signal,
				undefined,
				undefined,
				(open) => {
					fanoutDialogOpen = open;
					if (open && ctx.hasUI) ctx.ui.setStatus("ledgerpi", "ledgerpi: confirm fan-out (esc = no)");
				},
			);
			const run = recordRun(state, result, extra.calls, extra.tokens);
			// Audit before any aborted-run bail in the caller: an interrupt after some
			// model calls still consumed tokens, and recordRun already folded them into
			// the session totals, so the durable log must record them too.
			auditRun(cfg, { entry, session: where.session, ...model, cwd: where.cwd }, result, {
				task,
				durationMs: Date.now() - startedAt,
				classified: extra.classified,
				calls: run.calls,
				tokens: run.tokens,
				git: { start: headStart, end: headInfo(where.cwd) },
			});
			return result;
		} finally {
			stopListening?.();
			if (activeRun === active) activeRun = undefined;
			state.running = false;
			mutex.release();
			settle();
			if (!tearingDown && ctx.hasUI) ctx.ui.setStatus("ledgerpi", undefined);
		}
	};

	/**
	 * Cancel a running `input`-hook or `/ledger` loop and wait, bounded by
	 * `SHUTDOWN_GRACE_MS`, for it to stop its workers and write its audit row: pi
	 * invalidates the session context once shutdown handlers return.
	 * Then give up the UI sink, if this instance holds it.
	 */
	pi.on("session_shutdown", async () => {
		const run = activeRun;
		if (run) {
			tearingDown = true;
			run.controller.abort();
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				run.settled,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
				}),
			]);
			clearTimeout(timer);
		}
		// Released after the run settles so its last failures still reach the UI.
		releaseUISink(sinkOwner);
	});

	pi.on("input", async (event: InputEvent, ctx: ExtensionContext) => {
		dbg(
			`input fired: source=${event.source} streaming=${event.streamingBehavior} provider=${ctx.model?.provider} cwd=${ctx.cwd}`,
		);
		state.lastSlashCommand = undefined;
		if (!cfg.enabled || disabledByEnv() || state.running) return dbg("bail: enabled/env/running");
		if (event.source !== "interactive" && event.source !== "rpc") return dbg(`bail: source ${event.source}`);
		if (event.streamingBehavior) return dbg("bail: streaming"); // steering / follow-up
		if (!ctx.isIdle()) return dbg("bail: not idle");

		const text = event.text ?? "";
		const trimmed = text.trim();
		if (trimmed.startsWith("/")) {
			const cmd = trimmed.slice(1).split(/\s+/)[0];
			if (cmd) state.lastSlashCommand = cmd;
		}
		if (!trimmed || isEscaped(trimmed)) return dbg("bail: empty/escaped");
		if (trimmed.includes(WORKER_SENTINEL)) return dbg("bail: ledger sub-agent session");
		// A bare "continue" has no standalone task: the parent session keeps the turn,
		// so it passes through untouched -- no scope/readiness/classifier work, no run,
		// no ledger state. Guard is unconditional (classifier on or off) and applies to
		// interactive and RPC input alike; an explicit ledger_solve call never reaches
		// this hook, so delegation with a concrete task + cwd is unaffected.
		if (isContinuationOnly(trimmed)) return dbg("bail: continuation-only prompt (passthrough)");

		const provider = ctx.model?.provider;
		const modelId = ctx.model?.id;
		if (!inScope(cfg, provider, modelId)) return dbg(`bail: ${provider}/${modelId} not in scope`);
		if (!isGitRepo(ctx.cwd)) return dbg("bail: not a git repo");
		// A prompt the trigger keeps out of the loop still claims the turn, as the chat
		// and decline paths do, so before_agent_start never arms the edit redirect and
		// pulls it into the loop anyway.
		const holdTurn = (why: string) => {
			state.turnOwnedByInputHook = true;
			dbg(`bail: ${why}`);
		};
		if (cfg.trigger === "manual") return holdTurn("trigger=manual (use /ledger)");
		if (cfg.trigger === "ask" && state.askSuppressed) return holdTurn("trigger=ask suppressed this session");
		if (cfg.trigger === "ask" && !ctx.hasUI) return holdTurn("trigger=ask with no UI to ask");

		if (!(await ensureReady(pi.events, state, READY_TIMEOUT_MS))) return dbg("bail: subagents not ready");
		dbg(`ready=${state.readyState}`);

		state.turnOwnedByInputHook = true;

		const gateCommand = detectGate(cfg, ctx.cwd);

		let classifierTokens = 0;
		if (cfg.classifier) {
			const c = await classify(ctx, trimmed, ctx.signal);
			classifierTokens = c.tokens;
			dbg(`classified: ${c.kind}`);
			if (c.kind !== "code") {
				auditPassthrough(
					cfg,
					{ entry: "input", session: sessionSlug(ctx), provider, model: modelId, cwd: ctx.cwd },
					c.kind,
					c.outcome,
					c.tokens,
				);
				return;
			}
		}

		if (cfg.trigger === "ask") {
			const answer = await askOrDecline(
				ctx,
				{ entry: "input", session: sessionSlug(ctx), provider, model: modelId, cwd: ctx.cwd },
				{ classified: cfg.classifier ? "code" : null, tokens: classifierTokens, calls: cfg.classifier ? 1 : 0 },
			);
			if (answer !== "run") return dbg(`bail: ${answer} at the ask dialog`);
		}

		try {
			// runAndAudit re-checks the run guard after the awaits above: the
			// `ledger_solve` tool shares `state` and could have claimed a run while this
			// handler was in readiness, classification, or the ask dialog.
			const result = await runAndAudit(
				ctx,
				"input",
				trimmed,
				gateCommand,
				{ provider, model: modelId },
				{
					calls: cfg.classifier ? 1 : 0,
					tokens: classifierTokens,
					classified: cfg.classifier ? "code" : null,
				},
			);
			if (!result) return dbg("bail: run already claimed");

			// The user cancelled the loop, so drop the turn: re-running the prompt
			// inline would restart the work they just stopped. A dropped turn never
			// reaches before_agent_start, so release the turn claim here; otherwise the
			// next, unrelated run would read as owned by this hook and skip its redirect.
			if (result.stop === "aborted") {
				state.turnOwnedByInputHook = false;
				if (!tearingDown) sayTo(ctx, "ledgerpi: the ledger loop was cancelled; the prompt was not run.", "info");
				return { action: "handled" as const };
			}

			return { action: "transform" as const, text: text + handoffBlock(ctx.cwd, result) };
		} catch (err) {
			// Any unexpected failure falls back to a normal turn. ledgerpi must never
			// make a turn worse than not being installed.
			report(`[ledgerpi] loop failed: ${(err as Error).message}`);
			return;
		}
	});

	/**
	 * Arm the edit-redirect for an agent run the `input` hook did not own -- i.e. a
	 * skill/slash-driven run (`/review-task`, `/drive-*`), whose launching command is
	 * escaped and so never reaches the hook. Arming holds no task: the concrete task is
	 * derived mid-run, so the first inline edit (below) is where the loop takes over. It
	 * refuses to arm a spawned ledger sub-agent (marked by `WORKER_SENTINEL` in its
	 * prompt), so a worker never blocks its own edits, and only arms for a run whose
	 * launching slash command is in the `redirectSkills` allowlist. The command is
	 * consumed here (read then cleared), so eligibility binds to this one run and a
	 * follow-on run with no fresh command is fail-closed. Only active under
	 * `autoTrigger=redirect`; every other case leaves the run untouched.
	 */
	pi.on("before_agent_start", (event, ctx) => {
		const owned = state.turnOwnedByInputHook;
		state.turnOwnedByInputHook = false;
		const command = state.lastSlashCommand;
		state.lastSlashCommand = undefined;
		state.armed = false;
		state.redirectAttempts = 0;
		state.redirectConsented = false;
		if (!cfg.enabled || disabledByEnv() || cfg.autoTrigger !== "redirect") return;
		if (owned) return dbg("arm: skip, input hook owns this turn");
		if (event.prompt?.includes(WORKER_SENTINEL)) return dbg("arm: skip, ledger sub-agent session");
		// A continuation-only turn passes through the input hook without owning the
		// turn, so `owned` is false here; without this check a wildcard redirectSkills
		// would arm an edit redirect for a bare "continue". Never arm for it.
		if (isContinuationOnly(event.prompt ?? "")) return dbg("arm: skip, continuation-only turn");
		state.lastInstruction = event.prompt;
		if (!inScope(cfg, ctx.model?.provider, ctx.model?.id) || !isGitRepo(ctx.cwd)) {
			return dbg("arm: skip, out of scope / not a git repo");
		}
		if (!redirectSkillAllowed(cfg, command)) {
			return dbg(`arm: skip, skill "${command ?? "?"}" not in redirectSkills`);
		}
		state.armed = true;
		dbg(`armed redirect for /${command ?? "?"}: ${(event.prompt ?? "").slice(0, 60)}`);
	});

	/**
	 * When armed, block the first inline `edit`/`write` and steer the model to
	 * `ledger_solve` instead, so a skill session routes its implementation through the
	 * loop without the model having to choose the tool. Under `trigger = "ask"` with a
	 * UI, the first block of an armed run asks the same Run / Skip / Skip-for-session
	 * question as the input hook: Run blocks as below, anything else disarms and lets
	 * the edit through inline, and a session skip (from either path) stops both paths
	 * from asking. An edit outside any git work tree (a scratch file) passes without
	 * asking and leaves the run armed for the first in-repo edit. Fails open on every
	 * guard (out of scope, RPC absent, a failed dialog) and relents after
	 * `MAX_REDIRECTS` blocks, so the redirect is never worse than not being installed. `recordRun` disarms once the loop runs,
	 * and the `state.running` guard keeps the loop's own follow-up edits from being
	 * blocked. Eligibility is bound at arm time (the launching command is consumed
	 * there), so `state.armed` alone gates blocking.
	 */
	pi.on("tool_call", async (event, ctx) => {
		if (!cfg.enabled || disabledByEnv() || cfg.autoTrigger !== "redirect") return;
		if (!state.armed || state.running) return;
		const target = mutatingTarget(event);
		if (!target) return;
		if (!inScope(cfg, ctx.model?.provider, ctx.model?.id)) return;
		if (!isInWorkTree(ctx.cwd, target)) return dbg(`redirect: skip, ${target} is outside a git work tree`);
		if (!(await ensureReady(pi.events, state, READY_TIMEOUT_MS))) return dbg("redirect: skip, subagents not ready");
		if (cfg.trigger === "ask" && ctx.hasUI && !state.redirectConsented) {
			if (state.askSuppressed) {
				state.armed = false;
				return dbg("redirect: skip, trigger=ask suppressed this session");
			}
			const answer = await askOrDecline(
				ctx,
				{
					entry: "redirect",
					session: sessionSlug(ctx),
					provider: ctx.model?.provider,
					model: ctx.model?.id,
					cwd: ctx.cwd,
				},
				{ classified: null, tokens: 0, calls: 0 },
			);
			if (answer !== "run") {
				state.armed = false;
				return dbg(`redirect: ${answer} at the ask dialog, allowing edit of ${target}`);
			}
			state.redirectConsented = true;
		}
		if (state.redirectAttempts >= MAX_REDIRECTS) {
			state.armed = false;
			return dbg(`redirect: cap reached, allowing edit of ${target}`);
		}
		state.redirectAttempts += 1;
		dbg(`redirecting edit of ${target} (attempt ${state.redirectAttempts}/${MAX_REDIRECTS})`);
		return { block: true, reason: redirectReason(target, state.lastInstruction) };
	});

	/**
	 * Disarm at the end of every agent run, so an armed run that finished without
	 * triggering the loop (no edit, no `ledger_solve`) cannot leave `armed` set for a
	 * later run started without a `before_agent_start` (e.g. a `sendMessage` continuation).
	 * Eligibility is thus strictly scoped to the run that armed it.
	 */
	pi.on("agent_end", () => {
		state.armed = false;
		state.redirectAttempts = 0;
		state.redirectConsented = false;
		state.lastSlashCommand = undefined;
	});

	// The model-callable entry point. Registered only when ledgerpi is active, so a
	// disabled extension (or the LEDGERPI=0 A/B switch) advertises no tool.
	if (cfg.enabled && !disabledByEnv()) {
		pi.registerTool(ledgerSolveTool({ events: pi.events, cfg, state, mutex }));

		/**
		 * `/ledger <task>`: run the loop on an explicit task, with no classifier and no
		 * ask dialog -- invoking it is the consent. With a UI, the finished run's
		 * hand-off is sent as a user message (task plus result block), so the main
		 * model verifies and answers exactly as after an input-hook run; that message
		 * re-enters `input` with source "extension", which the hook ignores. With no UI
		 * (print mode) the hand-off block is written to stderr instead, because print
		 * mode disposes the runtime once the command returns and would cut off a
		 * hand-off turn; stderr is where pi routes extension output there, keeping
		 * stdout for its own text or JSON stream. A turn that started while the loop ran (an RPC prompt, or
		 * input typed meanwhile) is waited out first, so the hand-off is never
		 * rejected as "already processing". Every guard failure notifies and runs
		 * nothing.
		 */
		pi.registerCommand("ledger", {
			description: "Run the ledger manager-worker loop on a task, then hand the result to the session",
			handler: async (args, ctx) => {
				const say = (msg: string, type?: "info" | "warning" | "error") => sayTo(ctx, msg, type);
				const task = args.trim();
				if (!task) return say("usage: /ledger <task>");
				if (!ctx.isIdle()) return say("ledgerpi: wait for the current turn to finish, then run /ledger again.");
				const provider = ctx.model?.provider;
				const modelId = ctx.model?.id;
				if (!inScope(cfg, provider, modelId)) {
					return say(`ledgerpi: not active for ${provider ?? "?"}/${modelId ?? "?"} (see /ledgerpi).`);
				}
				if (!isGitRepo(ctx.cwd)) return say(`ledgerpi: ${ctx.cwd} is not a git repository.`);
				if (!(await ensureReady(pi.events, state, READY_TIMEOUT_MS))) {
					return say("ledgerpi: the pi-subagents RPC is unavailable in this session.");
				}
				try {
					const gateCommand = detectGate(cfg, ctx.cwd);
					const result = await runAndAudit(
						ctx,
						"command",
						task,
						gateCommand,
						{ provider, model: modelId },
						{
							calls: 0,
							tokens: 0,
							classified: null,
						},
					);
					if (!result) return say("ledgerpi: a ledger loop or another workflow is already running.");
					if (result.stop === "aborted") {
						if (tearingDown) return;
						return say("ledgerpi: the ledger loop was aborted before completing.");
					}
					if (!ctx.hasUI) {
						console.error(handoffBlock(ctx.cwd, result).trimStart());
						return;
					}
					await ctx.waitForIdle();
					// The hand-off turn is this run's own follow-up, so claim it as the input
					// hook's transform does; otherwise a wildcard redirect would arm on it and
					// push the verifying model back into ledger_solve. Claimed only once idle,
					// so the flag cannot be consumed by a turn that was already running.
					state.turnOwnedByInputHook = true;
					pi.sendUserMessage(task + handoffBlock(ctx.cwd, result));
				} catch (err) {
					say(`ledgerpi: the ledger loop failed: ${(err as Error).message}`, "error");
				}
			},
		});

		/**
		 * `/ledger-stop`: cancel the running `input`-hook or `/ledger` loop. Its workers
		 * are stopped, the run is audited `stop: "aborted"`, and no hand-off is sent. It
		 * runs immediately for an RPC client; in interactive mode a typed command waits
		 * behind the running loop, so Escape is the interactive cancel. A `ledger_solve`
		 * run is part of the agent turn and is cancelled with Escape instead.
		 */
		pi.registerCommand("ledger-stop", {
			description: "Cancel the running ledger loop started from a prompt or /ledger",
			handler: async (_args, ctx) => {
				if (activeRun) {
					activeRun.controller.abort();
					return sayTo(ctx, "ledgerpi: stopping the ledger loop.", "info");
				}
				if (state.running) {
					return sayTo(
						ctx,
						"ledgerpi: the running ledger_solve loop is part of the agent turn; press Escape to stop it.",
					);
				}
				sayTo(ctx, "ledgerpi: no ledger loop is running.", "info");
			},
		});
	}

	pi.registerCommand("ledgerpi", {
		description: "Show ledgerpi status (config and last run)",
		handler: async (_args, ctx) => {
			const provider = ctx.model?.provider;
			const modelId = ctx.model?.id;
			// An inert config (missing/broken/provider-less file) is fail-closed: disabled with no providers.
			const inert = !cfg.enabled && cfg.providers.length === 0;
			// Registration tracks enablement only; scope (provider + allowlist) additionally gates activity.
			const registered = cfg.enabled && !disabledByEnv();
			const active = registered && inScope(cfg, provider, modelId);
			const reason = scopeReason(cfg, provider, modelId);
			const gate = (detectGate(cfg, ctx.cwd) ?? "(none detected)").trim();
			const gateField = gate.includes("\n") ? `gate:\n${gate.replace(/^/gm, "  ")}` : `gate: ${gate}`;
			const lastRun = state.lastRun;
			const statusWord = disabledByEnv()
				? "disabled (LEDGERPI=0)"
				: inert
					? "inert (no config)"
					: cfg.enabled
						? "enabled"
						: "disabled";
			const allowlistKeys = Object.keys(cfg.allowlist);
			const roles = roleModelsFor(cfg, provider, modelId);
			const rolesLine =
				roles === null
					? "roles: (inactive)"
					: `roles: ${rolePairText(roles)} (via ${ROLE_SOURCE_LABEL[roles.source]})`;
			const roleModelLine =
				cfg.roleModel === null
					? "roleModel: (no table -- every allowlisted model is in scope)"
					: `roleModel: ${Object.keys(cfg.roleModel).join(", ") || "(none)"}; [workerModel] (deprecated): ${Object.keys(cfg.workerModel).join(", ") || "(none)"}; malformed: ${cfg.roleModelMalformed.join(", ") || "(none)"}; default: ${cfg.roleModelDefault === null ? "(none)" : rolePairText(cfg.roleModelDefault)}`;
			const scopeNote = active
				? "in scope"
				: reason === "not-allowlisted"
					? "model not allowlisted (passes through)"
					: reason === "no-role-entry"
						? modelId === undefined
							? "session model has no id, so neither a [roleModel] entry nor its default can apply (passes through)"
							: "no [roleModel] entry and no [roleModel].default for this model (passes through)"
						: reason === "malformed-role-entry"
							? "malformed [roleModel] entry (passes through)"
							: "out of scope (passes through)";
			const lines = [
				`ledgerpi: ${statusWord}`,
				`model: ${provider ?? "?"}/${modelId ?? "?"} -- ${scopeNote}`,
				`providers: ${cfg.providers.length ? cfg.providers.join(", ") : "(none)"}`,
				`allowlist: ${allowlistKeys.length ? allowlistKeys.map((p) => `${p}=[${cfg.allowlist[p].join(", ")}]`).join("; ") : "(none)"}`,
				gateField,
				`maxIters: ${cfg.maxIters}; classifier: ${cfg.classifier}`,
				rolesLine,
				roleModelLine,
				`audit log: ${cfg.auditLog}`,
				`trigger: ${cfg.trigger}${cfg.trigger === "ask" && state.askSuppressed ? " (suppressed this session)" : ""}; /ledger and /ledger-stop commands ${registered ? "registered" : "not registered"}`,
				`tool: ledger_solve ${registered ? "registered" : "not registered"}${registered && !active ? " (out of scope for this model)" : ""}`,
				`auto-trigger: ${cfg.autoTrigger}${cfg.autoTrigger !== "off" ? ` (skills: ${cfg.redirectSkills.length ? cfg.redirectSkills.join(", ") : "none -- inert"}; armed=${state.armed}, redirects=${state.redirectAttempts}/${MAX_REDIRECTS})` : ""}`,
				`fanout: ${cfg.fanout} (max ${cfg.fanoutMax})`,
				`subagents RPC: ${state.readyState}`,
				lastRun
					? `last run: ${new Date(lastRun.at).toISOString()} -- ${lastRun.converged ? "converged" : "unconverged"} (${lastRun.stop}), ${lastRun.iters} rounds, ${lastRun.calls} calls, ${lastRun.tokens} tokens`
					: "last run: none this session",
				`session total: ${state.sessionTotals.runs} runs, ${state.sessionTotals.calls} calls, ${state.sessionTotals.tokens} tokens (includes the classifier; separate from pi's own session counter, which excludes RPC sub-agents)`,
			];
			const text = lines.join("\n");
			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else console.log(text);
		},
	});
}
