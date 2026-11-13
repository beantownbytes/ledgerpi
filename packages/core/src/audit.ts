import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LedgerpiConfig } from "./config.ts";
import { appendRegularFile } from "./files.ts";
import type { HeadInfo } from "./git.ts";
import type { LoopResult } from "./loop.ts";
import { report } from "./report.ts";
import type { SpawnFailureDetail } from "./spawn.ts";

/**
 * The durable, cross-session audit log: one JSON row per completed loop run (and
 * per classifier passthrough), appended to a single stable path so a review pass
 * and a persistent host mount both have one fixed target. This is distinct from the
 * per-turn ledger dir, whose `transcript.jsonl` holds per-call rows but is
 * scattered under session/turn subdirs and never records the run's verdict. The
 * run-level outcome (converged, stop reason, tokens, provider/model) otherwise
 * lives only in memory and dies with the session.
 *
 * Every write is best-effort: a failure is logged and swallowed, never allowed to
 * affect the turn. ledgerpi must never make a turn worse than not being installed.
 */

/** Common provenance carried on every audit row. */
export interface AuditMeta {
	/**
	 * "input" (the submitted-prompt hook), "tool" (the ledger_solve call), "command"
	 * (the /ledger command), or "redirect" (a decline at the skill-session edit redirect).
	 */
	entry: "input" | "tool" | "command" | "redirect";
	/** The harness the row came from; "pi" when unset. */
	harness?: "pi" | "claude";
	session: string;
	provider?: string;
	model?: string;
	cwd: string;
}

/**
 * Resolve the provenance label stamped on every row: a trimmed, non-empty
 * `LEDGERPI_AUDIT_SOURCE` is the caller-supplied label (for example
 * `benchmark`); unset, blank, or whitespace-only is `"organic"`. Read per write
 * rather than captured at module load so a long-lived process that changes the
 * env between runs is labeled correctly. The stamp records where the run came
 * from -- a harness sets it, ledgerpi only reads it.
 */
function resolveSource(): string {
	const raw = process.env.LEDGERPI_AUDIT_SOURCE;
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : "organic";
}

function append(path: string, rec: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		// `source` is spread last so a caller's own `rec.source` cannot shadow it.
		appendRegularFile(path, `${JSON.stringify({ t: Date.now(), ...rec, source: resolveSource() })}\n`, 0o600);
	} catch (err) {
		report(`[ledgerpi] audit append failed: ${(err as Error).message}`);
	}
}

/**
 * Record one completed loop run. `cfg` must be the config the loop ran under: its
 * `maxIters` and `callTimeoutMs` are stamped on the row as the budget in force, so a
 * review can segment stop reasons by budget. `task` is truncated to its first 200
 * chars (a shorter prompt is stored whole).
 *
 * `git` is the repository state read before (`start`) and after (`end`) the loop.
 * The row stamps `repoUrl` (end, else start), `branch` (start: the loop never
 * switches branches), `headStart`, and `headEnd`, each null when unavailable or
 * when `git` is absent. `headEnd` is the committed HEAD, not the loop's edits,
 * which stay uncommitted, so it usually equals `headStart`; a run joins to the PR
 * it fed by `repoUrl` + `branch`.
 */
export function auditRun(
	cfg: LedgerpiConfig,
	meta: AuditMeta,
	result: LoopResult,
	extra: {
		task: string;
		durationMs: number;
		classified?: string | null;
		calls: number;
		tokens: number;
		git?: { start: HeadInfo; end: HeadInfo };
		/** Tokens per role, where the harness reports them; null on the row otherwise. */
		roleTokens?: { manager: number; worker: number };
	},
): void {
	// stopDetail is the spawn-failure category on spawn-failure rows and null on
	// every other stop (including aborted) -- never the raw error text, which stays
	// in the per-turn ledger only. A spawn-failure LoopResult constructed without a
	// detail still defaults to "other" so the row always carries a category.
	const stopDetail: SpawnFailureDetail | null =
		result.stop === "spawn-failure" ? (result.stopDetail ?? "other") : null;
	append(cfg.auditLog, {
		event: "run",
		harness: meta.harness ?? "pi",
		entry: meta.entry,
		session: meta.session,
		provider: meta.provider ?? null,
		model: meta.model ?? null,
		managerModel: result.managerModel ?? null,
		workerModel: result.workerModel ?? null,
		planSource: result.planSource,
		classified: extra.classified ?? null,
		converged: result.converged,
		stop: result.stop,
		stopDetail,
		iters: result.iters,
		maxIters: cfg.maxIters,
		callTimeoutMs: cfg.callTimeoutMs,
		calls: extra.calls,
		tokens: extra.tokens,
		managerTokens: extra.roleTokens?.manager ?? null,
		workerTokens: extra.roleTokens?.worker ?? null,
		gate: result.gate ? { command: result.gate.command, ran: result.gate.ran, passed: result.gate.passed } : null,
		fanout: result.fanout
			? {
					setting: result.fanout.setting,
					max: result.fanout.max,
					rounds: result.fanout.rounds,
					downgrades: result.fanout.downgrades,
					escapes: result.fanout.escapes,
					asked: result.fanout.asked,
					advised: result.fanout.advised,
				}
			: null,
		cwd: meta.cwd,
		repoUrl: extra.git?.end.repoUrl ?? extra.git?.start.repoUrl ?? null,
		branch: extra.git?.start.branch ?? null,
		headStart: extra.git?.start.sha ?? null,
		headEnd: extra.git?.end.sha ?? null,
		durationMs: extra.durationMs,
		managerMs: result.timing.managerMs,
		workerMs: result.timing.workerMs,
		gateMs: result.timing.gateMs,
		managerCalls: result.timing.managerCalls,
		workerCalls: result.timing.workerCalls,
		gateRuns: result.timing.gateRuns,
		task: extra.task.slice(0, 200),
	});
}

/**
 * Record an eligible prompt that passed through without a run: one the classifier
 * declined (kind !== "code"), so a review can measure classifier misses, or one
 * the user declined at the trigger=ask dialog. `reason` distinguishes a genuine
 * chat verdict from a safe-default fallback (an outage or an interrupt), which
 * otherwise all read as chat, and from a user decline (`declined` for one prompt,
 * `declined-session` for the rest of the session). `classified` is null when the
 * classifier is off. `calls` is the classifier calls made: 1 by default, 0 for a
 * decline with the classifier off. Logged only past every activation guard, so an
 * inert / out-of-scope / non-git session writes nothing.
 */
export function auditPassthrough(
	cfg: LedgerpiConfig,
	meta: AuditMeta,
	classified: string | null,
	reason: string,
	tokens: number,
	calls = 1,
): void {
	append(cfg.auditLog, {
		event: "passthrough",
		harness: meta.harness ?? "pi",
		entry: meta.entry,
		session: meta.session,
		provider: meta.provider ?? null,
		model: meta.model ?? null,
		classified,
		reason,
		// The classifier call's cost is recorded even though no loop ran -- chat-heavy
		// sessions would otherwise hide their classifier spend from a token-cost review.
		calls,
		tokens,
		cwd: meta.cwd,
	});
}
