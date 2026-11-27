import { realpathSync } from "node:fs";
import { join, relative } from "node:path";
import type { FanoutSetting } from "./config.ts";
import type { GateVerdict } from "./gate.ts";
import {
	addCandidateWorktree,
	applyPatch,
	candidatePatch,
	type RepoPin,
	removeCandidateWorktree,
	revertPatch,
	snapshotTree,
	trackedTreeId,
	treeId,
} from "./git.ts";
import type { FanoutMode } from "./parse.ts";
import { report } from "./report.ts";
import type { SpawnResult } from "./spawn.ts";

/**
 * Why a round that asked for fan-out ran one worker instead. `declined`: the user said no
 * under `ask`. `no-ui`: under `ask` there was no way to ask. `ask-failed`: the question
 * could not be shown.
 */
export type FanoutDowngrade = "no-gate" | "latched" | "fleet-unavailable" | "declined" | "no-ui" | "ask-failed";

/**
 * The user's answer to an `ask` fan-out question. `yes`/`no` apply to this round,
 * `yes-run`/`no-run` are remembered for the rest of the run, and `error` means the
 * question could not be shown.
 */
export type FanoutAnswer = "yes" | "no" | "yes-run" | "no-run" | "error";

/** How a round's worker step runs. */
export type RoundMode = { mode: "best-of-n" } | { mode: "serial"; downgrade: FanoutDowngrade | null };

/**
 * Picks how one round's worker step runs. `off` and `advise` always run one worker
 * (no downgrade: nothing was asked of the round). Under `ask` and `on`, a missing gate
 * or a run-wide latch forces serial, and otherwise the manager's recommendation decides:
 * best-of-n fans out, fleet is not built yet and runs serially, anything else is serial.
 * Under `ask` a best-of-n result is still only a proposal: the caller must get the
 * user's consent before running it.
 */
export function chooseMode(args: {
	setting: FanoutSetting;
	hasGate: boolean;
	latched: boolean;
	advised: FanoutMode | null;
}): RoundMode {
	if (args.setting !== "on" && args.setting !== "ask") return { mode: "serial", downgrade: null };
	if (!args.hasGate) return { mode: "serial", downgrade: "no-gate" };
	if (args.latched) return { mode: "serial", downgrade: "latched" };
	if (args.advised === "best-of-n") return { mode: "best-of-n" };
	if (args.advised === "fleet") return { mode: "serial", downgrade: "fleet-unavailable" };
	return { mode: "serial", downgrade: null };
}

/**
 * What became of one candidate: `kept` (its patch is in the tree and the gate passed),
 * `kept-red` (nothing passed, so the first finished candidate was re-applied), `gate-red`
 * (applied, gated red, reverted), `worker-failed`, `apply-failed` (its patch could not be
 * built or applied), or `canceled` (not examined: the round ended first).
 */
export type AttemptOutcome = "kept" | "kept-red" | "gate-red" | "worker-failed" | "apply-failed" | "canceled";

export interface Attempt {
	/** 1-based candidate number. */
	index: number;
	outcome: AttemptOutcome;
}

/** One candidate worker's private copy of the repository. */
export interface Candidate {
	/** 1-based candidate number. */
	index: number;
	/** The candidate's pinned worktree; its root is the only place this candidate may edit. */
	repo: RepoPin;
	/** The directory the worker spawns in: the worktree path matching the real cwd. */
	cwd: string;
}

/**
 * The outcome of a best-of-N round. Every kind leaves the candidate worktrees removed.
 * - `unavailable`: the snapshot or a worktree could not be made; the real tree is untouched, run serially.
 * - `aborted`: the signal fired; any unkept patch was reverted.
 * - `failed`: no candidate produced an applicable result; the real tree is untouched.
 * - `kept`: a candidate's patch is in the real tree and `gate` is its already-recorded verdict.
 * - `escaped`: a worker edited the real tree or a revert failed; the tree is kept as it is
 *   and the caller must latch fan-out off and gate the tree itself.
 */
export type BestOfNResult =
	| { kind: "unavailable"; reason: string }
	| { kind: "aborted"; attempts: Attempt[] }
	| { kind: "failed"; worker: SpawnResult | null; attempts: Attempt[] }
	| { kind: "kept"; worker: SpawnResult; gate: GateVerdict; attempts: Attempt[] }
	| { kind: "escaped"; reason: string; worker: SpawnResult | null; attempts: Attempt[] };

export interface BestOfNArgs {
	/** The real working directory. */
	cwd: string;
	/** The pinned repository holding `cwd`. */
	repo: RepoPin;
	/** The ledger directory; candidates live under `<ledgerDir>/candidates`. */
	ledgerDir: string;
	/** The loop iteration, which names the candidate directories. */
	iter: number;
	/** How many candidates run concurrently. */
	n: number;
	/** Runs one candidate worker; must resolve, not reject, and stop when `signal` fires. */
	runWorker: (candidate: Candidate, signal: AbortSignal) => Promise<SpawnResult>;
	/** Runs and records the gate on the real tree; null when the run was aborted meanwhile. */
	runGate: () => Promise<GateVerdict | null>;
	signal?: AbortSignal;
}

interface Finished {
	candidate: Candidate;
	reply: SpawnResult;
}

interface Gated {
	index: number;
	reply: SpawnResult;
	patch: Buffer;
	verdict: GateVerdict;
}

/**
 * Best-of-N for one round. The real tree is snapshotted as base B; N workers run
 * concurrently, each in its own detached worktree at B. As each finishes ok, its
 * changes are applied to the real tree and the gate runs there (gates are
 * serialized on the real tree, which has the dependencies and the ports). The first
 * to pass is kept and the rest are aborted; a red one is reverted and the next is
 * tried. When none passes, the first finished candidate is re-applied so the manager
 * sees a real failure. The worktrees are removed on every path.
 */
export async function runBestOfN(a: BestOfNArgs): Promise<BestOfNResult> {
	const stop = new AbortController();
	const relay = () => stop.abort();
	if (a.signal?.aborted) stop.abort();
	else a.signal?.addEventListener("abort", relay, { once: true });

	const created: RepoPin[] = [];
	const running: Promise<Finished>[] = [];
	const outcomes = new Map<number, AttemptOutcome>();
	const attempts = (): Attempt[] =>
		Array.from({ length: a.n }, (_, i) => ({ index: i + 1, outcome: outcomes.get(i + 1) ?? "canceled" }));

	try {
		let base: string;
		let baseTree: string;
		const candidates: Candidate[] = [];
		try {
			const subdir = relative(a.repo.workTree, realpathSync(a.cwd));
			base = snapshotTree(a.repo);
			baseTree = treeId(a.repo, base);
			for (let index = 1; index <= a.n; index++) {
				const repo = addCandidateWorktree(a.repo, a.ledgerDir, a.iter, index, base);
				created.push(repo);
				candidates.push({ index, repo, cwd: join(repo.workTree, subdir) });
			}
		} catch (err) {
			return { kind: "unavailable", reason: (err as Error).message };
		}

		const live = new Map<number, Promise<Finished>>();
		for (const candidate of candidates) {
			const p = a.runWorker(candidate, stop.signal).then((reply) => ({ candidate, reply }));
			running.push(p);
			live.set(candidate.index, p);
		}

		const gated: Gated[] = [];
		let firstFailure: SpawnResult | null = null;
		const escaped = (reason: string, worker: SpawnResult | null): BestOfNResult => ({
			kind: "escaped",
			reason,
			worker,
			attempts: attempts(),
		});
		const revertOnAbort = (patch: Buffer) => {
			try {
				revertPatch(a.repo, patch);
			} catch (err) {
				report(`[ledgerpi] could not undo a candidate's changes after the abort: ${(err as Error).message}`);
			}
		};

		try {
			while (live.size > 0) {
				const { candidate, reply } = await Promise.race(live.values());
				live.delete(candidate.index);
				if (a.signal?.aborted) return { kind: "aborted", attempts: attempts() };
				if (!reply.ok) {
					outcomes.set(candidate.index, "worker-failed");
					firstFailure ??= reply;
					continue;
				}
				if (treeId(a.repo) !== baseTree) return escaped("tree-changed", reply);

				let patch: Buffer;
				try {
					patch = candidatePatch(candidate.repo, base);
					applyPatch(a.repo, patch);
				} catch {
					outcomes.set(candidate.index, "apply-failed");
					continue;
				}
				const applied = trackedTreeId(a.repo);
				const verdict = await a.runGate();
				if (verdict === null) {
					revertOnAbort(patch);
					return { kind: "aborted", attempts: attempts() };
				}
				if (trackedTreeId(a.repo) !== applied) return escaped("tree-changed", reply);
				if (verdict.ran && verdict.passed) {
					outcomes.set(candidate.index, "kept");
					return { kind: "kept", worker: reply, gate: verdict, attempts: attempts() };
				}
				outcomes.set(candidate.index, "gate-red");
				gated.push({ index: candidate.index, reply, patch, verdict });
				try {
					revertPatch(a.repo, patch);
				} catch {
					return escaped("revert-failed", reply);
				}
			}

			if (treeId(a.repo) !== baseTree) return escaped("tree-changed", null);
			const first = gated[0];
			if (first === undefined) return { kind: "failed", worker: firstFailure, attempts: attempts() };
			try {
				applyPatch(a.repo, first.patch);
			} catch {
				return escaped("reapply-failed", null);
			}
			outcomes.set(first.index, "kept-red");
			return { kind: "kept", worker: first.reply, gate: first.verdict, attempts: attempts() };
		} catch (err) {
			return escaped(`git-error: ${(err as Error).message}`, null);
		}
	} finally {
		a.signal?.removeEventListener("abort", relay);
		stop.abort();
		await Promise.allSettled(running);
		for (const candidate of created) removeCandidateWorktree(a.repo, candidate);
	}
}
