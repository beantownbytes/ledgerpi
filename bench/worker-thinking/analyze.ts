import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Pure run classification and the stage screen and recommendation decisions for the
 * worker-thinking A/B, plus a `summarize <root>` CLI that prints them as JSON.
 */

export type RunClass =
	| "harness-failed"
	| "aborted"
	| "limit-failed"
	| "other-failed"
	| "unverified"
	| "converged-red"
	| "converged-green";

/** States a run is retried from once, and left out of denominators if they repeat. */
export const EXCLUDED_CLASSES: readonly RunClass[] = ["harness-failed", "aborted", "unverified"];

export interface AuditRow {
	converged: boolean;
	stop: string;
	tokens: number;
	durationMs: number;
}

export interface TranscriptRow {
	t?: number;
	role?: string;
	ok?: boolean | null;
	error?: string | null;
}

/** A pi session's closing provider error and when it happened. */
export interface SessionFailure {
	t: number;
	error: string;
}

export interface FinalGate {
	ran: boolean;
	passed: boolean;
}

export interface RunResult {
	runId: string;
	arm: string;
	task: string;
	rep: number;
	attempts: number;
	class: RunClass;
	stop: string | null;
	lastFailure: string | null;
	limitEvents: number;
	workerCalls: number;
	tokens: number;
	durationMs: number;
	diffStat: string;
	finalGate: FinalGate | null;
}

export interface Score {
	score: number;
	blockers: number;
	shouldFix: number;
}

export interface ArmStats {
	arm: string;
	runs: number;
	excluded: number;
	classified: number;
	scored: number;
	green: number;
	limitEvents: number;
	workerCalls: number;
	limitRate: number;
	meanScore: number | null;
	tokens: number;
	durationMs: number;
	classes: Partial<Record<RunClass, number>>;
	stops: Record<string, number>;
}

export type ScreenState = "eliminated" | "forward";

export type Recommendation =
	| { state: "inconclusive"; reason: string }
	| { state: "adopt"; arm: string }
	| { state: "keep-baseline" };

const OUTPUT_LIMIT = "output token limit";
const QUEUE_TIMEOUT = "request_queue_timeout";
const PROVIDER_FAILURE =
	/\b(429|5\d\d)\b|rate.?limit|overloaded|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|upstream connect|Stream ended without finish_reason|after \d+ retry attempts|\b(401|403)\b|authentication_error|invalid (api )?(token|key)|unauthori[sz]ed/i;
const SESSION_JOIN_WINDOW_MS = 10_000;

const isLimitRow = (row: TranscriptRow): boolean => row.ok === false && (row.error ?? "").includes(OUTPUT_LIMIT);
const isWorkerRow = (row: TranscriptRow): boolean => row.role === "ledger-worker";
const isFailedRow = (row: TranscriptRow): boolean => row.ok === false;

/**
 * True for an outage or throttle. A queue timeout is excluded: it is the cost of holding a
 * larger reservation, so it counts against the arm that caused it.
 */
function isProviderFailure(row: TranscriptRow): boolean {
	const error = row.error ?? "";
	return !error.includes(QUEUE_TIMEOUT) && PROVIDER_FAILURE.test(error);
}

/**
 * Fills the error of failed rows that recorded none from the session that closed on a
 * provider error just before the row was written: a worker that dies mid-turn settles with
 * a failed status and no error text.
 */
export function attachSessionFailures(
	transcript: readonly TranscriptRow[],
	failures: readonly SessionFailure[],
): TranscriptRow[] {
	return transcript.map((row) => {
		if (!isFailedRow(row) || row.error || row.t === undefined) return row;
		const t = row.t;
		let match: SessionFailure | undefined;
		for (const f of failures) {
			if (f.t <= t && t - f.t <= SESSION_JOIN_WINDOW_MS && (!match || f.t > match.t)) match = f;
		}
		return match ? { ...row, error: match.error } : row;
	});
}

/** The error text of the last failed call, or null when no call failed or none recorded one. */
export function lastFailureText(transcript: readonly TranscriptRow[]): string | null {
	return transcript.filter(isFailedRow).at(-1)?.error || null;
}

/** Worker calls in one run, and how many of them ended at the output limit. */
export function countLimitEvents(transcript: readonly TranscriptRow[]): { limitEvents: number; workerCalls: number } {
	const workers = transcript.filter(isWorkerRow);
	return { limitEvents: workers.filter(isLimitRow).length, workerCalls: workers.length };
}

/**
 * Classifies one run; the first matching state wins.
 *
 * @param row The run's audit row, or null when the run wrote none.
 * @param transcript The run's per-call ledger rows, in order.
 * @param finalGate The independent final gate verdict, or null when it never ran.
 */
export function classifyRun(
	row: AuditRow | null,
	transcript: readonly TranscriptRow[],
	finalGate: FinalGate | null,
): RunClass {
	if (row === null) return "harness-failed";
	if (row.stop === "spawn-failure") {
		const lastFailure = transcript.filter(isFailedRow).at(-1);
		if (lastFailure && isProviderFailure(lastFailure)) return "harness-failed";
	}
	if (row.stop === "aborted") return "aborted";
	if (!row.converged) {
		const lastWorkerFailure = transcript.filter((r) => isWorkerRow(r) && isFailedRow(r)).at(-1);
		return lastWorkerFailure && isLimitRow(lastWorkerFailure) ? "limit-failed" : "other-failed";
	}
	if (finalGate === null || !finalGate.ran) return "unverified";
	return finalGate.passed ? "converged-green" : "converged-red";
}

/** Aggregates one arm's finished runs; excluded classes count toward nothing but `excluded`. */
export function armStats(
	arm: string,
	results: readonly RunResult[],
	scores: Readonly<Record<string, Score>>,
): ArmStats {
	const own = results.filter((r) => r.arm === arm);
	const counted = own.filter((r) => !EXCLUDED_CLASSES.includes(r.class));
	const scored = counted.flatMap((r) => {
		const value = scores[r.runId]?.score;
		return typeof value === "number" && Number.isFinite(value) ? [value] : [];
	});
	const limitEvents = counted.reduce((n, r) => n + r.limitEvents, 0);
	const workerCalls = counted.reduce((n, r) => n + r.workerCalls, 0);
	const classes: Partial<Record<RunClass, number>> = {};
	const stops: Record<string, number> = {};
	for (const r of own) classes[r.class] = (classes[r.class] ?? 0) + 1;
	for (const r of counted) stops[r.stop ?? "none"] = (stops[r.stop ?? "none"] ?? 0) + 1;
	return {
		arm,
		runs: own.length,
		excluded: own.length - counted.length,
		classified: counted.length,
		scored: scored.length,
		green: counted.filter((r) => r.class === "converged-green").length,
		limitEvents,
		workerCalls,
		limitRate: workerCalls === 0 ? 0 : limitEvents / workerCalls,
		meanScore: scored.length === 0 ? null : scored.reduce((a, b) => a + b, 0) / scored.length,
		tokens: counted.reduce((n, r) => n + r.tokens, 0),
		durationMs: counted.reduce((n, r) => n + r.durationMs, 0),
		classes,
		stops,
	};
}

/** Stage 1: a challenger is dropped only on a clear quality loss against the baseline. */
export function screenChallenger(baseline: ArmStats, challenger: ArmStats): ScreenState {
	if (challenger.green <= baseline.green - 2) return "eliminated";
	if (baseline.meanScore === null || challenger.meanScore === null) return "forward";
	return challenger.meanScore <= baseline.meanScore - 1.5 ? "eliminated" : "forward";
}

/**
 * Stage 2: picks the arm to recommend. Inconclusive takes precedence over adopt.
 *
 * @param minClassified Classified runs every arm needs before the result counts.
 */
export function recommend(baseline: ArmStats, challengers: readonly ArmStats[], minClassified = 10): Recommendation {
	const thin = [baseline, ...challengers].find((a) => a.classified < minClassified);
	if (thin) return { state: "inconclusive", reason: `${thin.arm} has ${thin.classified} classified runs` };
	const unscored = [baseline, ...challengers].find((a) => a.scored < a.classified);
	if (unscored)
		return {
			state: "inconclusive",
			reason: `${unscored.arm} has ${unscored.scored} of ${unscored.classified} runs scored`,
		};
	if (baseline.limitEvents === 0) return { state: "inconclusive", reason: "baseline hit no output-limit events" };
	const base = baseline.meanScore ?? 0;
	const qualified = challengers
		.filter((c) => c.limitRate < baseline.limitRate && c.green >= baseline.green && (c.meanScore ?? 0) >= base - 0.5)
		.sort((a, b) => (b.meanScore ?? 0) - (a.meanScore ?? 0) || a.tokens - b.tokens || a.arm.localeCompare(b.arm));
	return qualified.length > 0 ? { state: "adopt", arm: qualified[0].arm } : { state: "keep-baseline" };
}

/** Reads every finished run and the blind scores under an A/B result root. */
export function loadRoot(root: string): { results: RunResult[]; scores: Record<string, Score> } {
	const runs = join(root, "runs");
	const results: RunResult[] = [];
	for (const id of readdirSync(runs)) {
		try {
			results.push(JSON.parse(readFileSync(join(runs, id, "result.json"), "utf8")) as RunResult);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
	let scores: Record<string, Score> = {};
	try {
		scores = JSON.parse(readFileSync(join(root, "scores.json"), "utf8")) as Record<string, Score>;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	return { results, scores };
}

function summarize(root: string, baselineArm: string, challengerArms: readonly string[]): string {
	const { results, scores } = loadRoot(root);
	const baseline = armStats(baselineArm, results, scores);
	const challengers = challengerArms.map((arm) => armStats(arm, results, scores));
	return JSON.stringify(
		{
			arms: [baseline, ...challengers],
			screen: Object.fromEntries(challengers.map((c) => [c.arm, screenChallenger(baseline, c)])),
			recommendation: recommend(baseline, challengers),
		},
		null,
		2,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [command, root, baselineArm, ...challengerArms] = process.argv.slice(2);
	if (command !== "summarize" || !root || !baselineArm) {
		console.error("usage: analyze.ts summarize <root> <baseline-arm> [challenger-arm...]");
		process.exit(2);
	}
	if (!existsSync(join(root, "runs"))) {
		console.error(`analyze.ts: no runs directory under ${root}`);
		process.exit(2);
	}
	console.log(summarize(root, baselineArm, challengerArms));
}
