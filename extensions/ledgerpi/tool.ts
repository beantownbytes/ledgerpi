import { type AgentToolResult, defineTool, type EventBus } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { auditRun } from "../../packages/core/src/audit.ts";
import type { LedgerpiConfig } from "../../packages/core/src/config.ts";
import { disabledByEnv, inScope, modelRef, roleModelsFor, scopeReason } from "../../packages/core/src/config.ts";
import { readPlanFile } from "../../packages/core/src/files.ts";
import { detectGate } from "../../packages/core/src/gate.ts";
import { headInfo, isGitRepo } from "../../packages/core/src/git.ts";
import { handoffBlock } from "../../packages/core/src/handoff.ts";
import type { WorkflowMutex } from "./mutex.ts";
import { ensureReady, recordRun, runLedger, type SessionState } from "./runner.ts";
import { sessionSlug } from "./session.ts";

/** How long to wait for the pi-subagents RPC ping reply before treating it as absent. */
const READY_TIMEOUT_MS = 750;

export interface ToolDeps {
	events: EventBus;
	cfg: LedgerpiConfig;
	state: SessionState;
	mutex: WorkflowMutex;
}

/** A plain text tool result. `details` is empty -- there is no structured payload to render. */
function text(t: string): AgentToolResult<Record<string, never>> {
	return { content: [{ type: "text", text: t }], details: {} };
}

/**
 * `ledger_solve`: the model-callable entry point into the same manager-worker
 * loop the `input` hook drives. The hook only fires on a submitted prompt (an
 * `interactive` or `rpc` source), so a slash-command / skill-driven session
 * (`/review-task`, `/drive-*`) never reaches it -- the launching command is
 * escaped and the coding there happens across the agent's own tool turns. This
 * tool lets a skill route its bounded implementation phase through the ledger
 * loop: fresh-context workers plan, decompose, edit the working tree, and gate on
 * the tests, then the tool returns a summary with the edits already applied.
 *
 * Every guard failure resolves to a plain-text result telling the agent to
 * implement the task itself, never an error: the tool must never make a turn
 * worse than not being installed. It shares `state` and the workflow mutex with
 * the hook so the two paths never run concurrently and `/ledgerpi` accounts for
 * both. It is declared `sequential` and claims `state.running` synchronously so
 * two overlapping tool calls cannot both drive a loop over the same tree.
 */
export function ledgerSolveTool(deps: ToolDeps) {
	return defineTool({
		name: "ledger_solve",
		label: "Ledger solve",
		description:
			"Delegate a bounded, self-contained implementation task to a ledger-based " +
			"manager-worker loop in fresh contexts. The loop plans, " +
			"decomposes the work, edits files in the current repository's working tree, and runs " +
			"the project's test gate as ground truth, then returns a summary of what it did, the " +
			"gate verdict, and the changed files. The edits are ALREADY APPLIED to the working " +
			"tree when it returns -- do not redo them; read the summary, verify, and continue. " +
			"Prefer this over editing inline for a non-trivial implementation; " +
			"for a one-line change, edit directly instead.",
		promptSnippet:
			"ledger_solve: hand a bounded repo implementation task to the ledger manager-worker loop (edits applied on return).",
		promptGuidelines: [
			"For a non-trivial, self-contained implementation task in this repository, prefer `ledger_solve` over editing inline: it decomposes the work across fresh-context workers and gates on the tests, returning with the edits already applied.",
			"After `ledger_solve` returns, do not redo its work -- read the summary and the diff, then verify and continue. If it stopped without a passing gate, finish the remaining tasks it lists.",
		],
		parameters: Type.Object({
			task: Type.String({
				description:
					"The self-contained implementation task to carry out in the current repository, " +
					"phrased as a concrete instruction: what to build or fix and the success criterion.",
			}),
			gate: Type.Optional(
				Type.String({
					description:
						"Optional override for the test command used as the success gate (e.g. " +
						"'pytest tests/foo.py'). Omit to auto-detect (the repo's .ledgerpi-gate file, Makefile test target, " +
						"pytest, npm/bun test, cargo, go).",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Absolute path to the repository or worktree to work in. Defaults to the session " +
						"working directory. Pass the worktree path when the change must land in a carved " +
						"worktree rather than the main checkout.",
				}),
			),
			plan_file: Type.Optional(
				Type.String({
					description:
						"Absolute path to an approved implementation plan. When given, the loop skips its own " +
						"planning and ideation and the manager builds the task list from this plan.",
				}),
			),
			fanout: Type.Optional(
				Type.String({
					description:
						"Optional concurrent-worker setting for this call: 'off', 'advise', 'ask' or 'on'. It can only " +
						"lower the configured `fanout` setting (off < advise < ask < on), never raise it; any other " +
						"value is ignored.",
				}),
			),
		}),
		// Pi runs tool calls concurrently by default; two overlapping ledger loops
		// would edit the same tree. `sequential` keeps this tool from running
		// alongside another tool call, and the synchronous `running` claim below is
		// the second guard against a self-overlap slipping past the check.
		executionMode: "sequential",
		execute: async (
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<Record<string, never>>> => {
			const punt = (why: string) => text(`${why} Implement the task directly.`);
			// The tool is registered only when enabled, so an inert/disabled config
			// advertises no tool at all; this stays as a defensive guard.
			if (!deps.cfg.enabled || disabledByEnv()) return punt("ledgerpi is disabled.");

			const provider = ctx.model?.provider;
			const modelId = ctx.model?.id;
			if (!inScope(deps.cfg, provider, modelId)) {
				const reason = scopeReason(deps.cfg, provider, modelId);
				return punt(
					reason === "not-allowlisted"
						? `ledgerpi: model ${modelId ?? "?"} is not allowlisted for provider ${provider}.`
						: reason === "no-role-entry"
							? modelId === undefined
								? `ledgerpi: the session model has no id, so neither a [roleModel] entry nor its default can apply for provider ${provider ?? "?"}; the model is inactive.`
								: `ledgerpi: no [roleModel] entry and no [roleModel].default for ${provider ?? "?"}/${modelId}; the model is inactive.`
							: reason === "malformed-role-entry"
								? `ledgerpi: the [roleModel] entry for ${provider ?? "?"}/${modelId ?? "?"} is malformed; the model is inactive.`
								: `ledgerpi is not active for provider ${provider ?? "?"}.`,
				);
			}
			const cwd = params.cwd?.trim() || ctx.cwd;
			if (!isGitRepo(cwd)) return punt(`\`${cwd}\` is not a git repository.`);
			const task = params.task?.trim();
			if (!task) return punt("No task was provided.");
			const planPath = params.plan_file?.trim();
			let plan: string | undefined;
			if (planPath) {
				const read = readPlanFile(planPath);
				if ("error" in read) return punt(`${read.error}.`);
				plan = read.plan;
			}

			// Claim the session guard synchronously, before the first await, so a
			// second concurrent call sees it held and punts here rather than racing
			// past the check and rebinding the shared mutex out from under this run.
			if (deps.state.running) return punt("A ledger loop is already running in this session.");
			deps.state.running = true;
			const status = (label: string) => {
				if (ctx.hasUI) ctx.ui.setStatus("ledgerpi", label);
			};
			try {
				if (!(await ensureReady(deps.events, deps.state, READY_TIMEOUT_MS))) {
					return punt("The pi-subagents RPC is unavailable in this session.");
				}
				// Claim the workflow group cooperatively so a concurrent goal/plan-mode
				// run defers; if someone else holds it, hand the task back untouched.
				deps.mutex.bind(ctx.sessionManager);
				if (!deps.mutex.acquire()) return punt("Another workflow holds the group.");
				try {
					const gateCommand = params.gate?.trim() || detectGate(deps.cfg, cwd);
					const startedAt = Date.now();
					const headStart = headInfo(cwd);
					const roles = roleModelsFor(deps.cfg, provider, modelId);
					const result = await runLedger(
						deps.events,
						deps.cfg,
						ctx,
						cwd,
						task,
						gateCommand,
						{
							session: modelRef(provider, modelId),
							manager: roles?.manager ?? null,
							worker: roles?.worker ?? null,
						},
						(iter, label) => status(`ledger ${iter}/${deps.cfg.maxIters}: ${label}`),
						ctx.signal,
						plan,
						params.fanout,
					);
					// The tool path runs no classifier, so there is no extra call/token to fold in.
					const run = recordRun(deps.state, result, 0, 0);
					// Audit before the aborted-run bail so an interrupt after model calls
					// (already counted by recordRun) is still recorded durably.
					auditRun(deps.cfg, { entry: "tool", session: sessionSlug(ctx), provider, model: modelId, cwd }, result, {
						task,
						durationMs: Date.now() - startedAt,
						classified: null,
						calls: run.calls,
						tokens: run.tokens,
						git: { start: headStart, end: headInfo(cwd) },
					});
					if (result.stop === "aborted") return text("The ledger loop was aborted before completing.");
					return text(handoffBlock(cwd, result));
				} finally {
					deps.mutex.release();
				}
			} catch (err) {
				return punt(`The ledger loop failed: ${(err as Error).message}.`);
			} finally {
				deps.state.running = false;
				if (ctx.hasUI) ctx.ui.setStatus("ledgerpi", undefined);
			}
		},
	});
}
