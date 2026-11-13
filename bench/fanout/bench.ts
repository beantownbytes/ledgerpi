import { parseArgs } from "node:util";
import type { FanoutSetting } from "../../packages/core/src/config.ts";
import { BenchConfigError, malformed, percentile, positiveInt, positiveSeconds } from "../concurrency/bench.ts";

/** Fan-out widths the harness can run; 1 is the `advise` baseline and 8 is opt-in. */
export const ARMS = [1, 2, 4, 8] as const;
export type Arm = (typeof ARMS)[number];
export const DEFAULT_ARMS: readonly Arm[] = [1, 2, 4];

/** Valid runs an arm needs, on both sides of a comparison, before its label can be anything but `insufficient`. */
export const MIN_VALID_RUNS = 20;
/** Share of an arm's valid runs in which fan-out must have run concurrent candidates. */
export const MIN_ENGAGEMENT = 0.3;
/** Share of an arm's valid runs that may latch fan-out off before the arm is `insufficient` (strictly above). */
export const MAX_LATCHED_SHARE = 0.5;
/** Pass-rate gap, in points, that separates `harmful` and `helping` from `neutral`. */
export const PASS_MARGIN_POINTS = 5;
/** Median wall-clock ratio to N=1 above which an arm is `harmful`. */
export const HARMFUL_TIME_RATIO = 1.5;
/** Median wall-clock ratio to N=1 at or below which an arm with an equal pass rate is `helping`. */
export const HELPING_TIME_RATIO = 0.9;
/** The cap and default recommended when no measured arm qualifies. */
export const FALLBACK_FANOUT_MAX = 2;

const POINT_EPSILON = 1e-9;

export interface FanoutArgs {
	/** Ascending, de-duplicated. */
	arms: Arm[];
	reps: number;
	/** Fixture names to run; undefined means every fixture. */
	tasks: string[] | undefined;
	/** Wall-clock limit for one `pi` run, in seconds. */
	timeoutS: number;
	out: string | undefined;
}

export const FANOUT_USAGE = `usage: run.ts [--arms 1,2,4] [--reps 3] [--tasks NAME,NAME] [--timeout-s 1800] [--out DIR]
Arms are fan-out widths from ${ARMS.join(", ")}: 1 runs fanout "advise", the rest fanout "on" with fanoutMax N.`;

const DEFAULTS = { arms: DEFAULT_ARMS.join(","), reps: "3", timeoutS: "1800" };

function nonEmptyItems(flag: string, raw: string): string[] {
	const items = raw.split(",").map((s) => s.trim());
	if (items.some((s) => s === "")) throw malformed(flag, raw, "a non-empty comma-separated list");
	return items;
}

function armList(raw: string): Arm[] {
	const arms = nonEmptyItems("arms", raw).map((item) => {
		const n = positiveInt("arms", item);
		const arm = ARMS.find((a) => a === n);
		if (!arm) throw new BenchConfigError("unknown-arm", `--arms ${n}: expected one of ${ARMS.join(", ")}`);
		return arm;
	});
	return [...new Set(arms)].sort((a, b) => a - b);
}

function taskList(raw: string): string[] {
	const names = nonEmptyItems("tasks", raw);
	for (const name of names) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw malformed("tasks", name, "a fixture directory name");
	}
	return [...new Set(names)];
}

/**
 * Parse and validate the fan-out benchmark command line. No file or network access.
 *
 * @param argv The arguments after the script name.
 * @throws {BenchConfigError} `usage` for an unknown flag, missing value, or positional argument;
 * `malformed-value` for reps that are not a positive integer, an empty or malformed `--arms` or
 * `--tasks` list, or a timeout that is not above 0 with at most 2 decimals; `unknown-arm` for an
 * arm outside {@link ARMS}.
 */
export function parseFanoutArgs(argv: string[]): FanoutArgs {
	let values: Record<string, string | boolean | undefined>;
	try {
		({ values } = parseArgs({
			args: argv,
			strict: true,
			allowPositionals: false,
			options: {
				arms: { type: "string" },
				reps: { type: "string" },
				tasks: { type: "string" },
				"timeout-s": { type: "string" },
				out: { type: "string" },
			},
		}));
	} catch (err) {
		throw new BenchConfigError("usage", (err as Error).message);
	}
	const str = (flag: string): string | undefined => values[flag] as string | undefined;
	const tasks = str("tasks");
	return {
		arms: armList(str("arms") ?? DEFAULTS.arms),
		reps: positiveInt("reps", str("reps") ?? DEFAULTS.reps),
		tasks: tasks === undefined ? undefined : taskList(tasks),
		timeoutS: positiveSeconds("timeout-s", str("timeout-s") ?? DEFAULTS.timeoutS),
		out: str("out"),
	};
}

/** The ledgerpi settings an arm overrides. N=1 leaves `fanoutMax` to the live config because `advise` never runs candidates. */
export function armSettings(arm: Arm): { fanout: FanoutSetting; fanoutMax?: number } {
	return arm === 1 ? { fanout: "advise" } : { fanout: "on", fanoutMax: arm };
}

/**
 * The private config for one arm: the live config with `fanout`, `fanoutMax` and `classifier`
 * overridden and any explicit `gate` dropped, so each fixture's `.ledgerpi-gate` is the verifier.
 * The classifier is off so `/ledger` always enters the loop. The input is not modified.
 */
export function buildVariantConfig(live: Record<string, unknown>, arm: Arm): Record<string, unknown> {
	const { gate: _gate, ...rest } = live;
	return { ...rest, ...armSettings(arm), classifier: false };
}

/** The fields of an audit `run` row that the benchmark reads (see `packages/core/src/audit.ts`). */
export interface AuditRunRow {
	event: "run";
	converged?: boolean;
	stop?: string;
	iters?: number | null;
	tokens?: number | null;
	gate?: { command?: string; ran?: boolean; passed?: boolean } | null;
	fanout?: {
		setting?: string;
		max?: number;
		rounds?: number;
		downgrades?: string[];
		escapes?: string[];
		advised?: Record<string, number>;
	} | null;
	durationMs?: number | null;
	gateMs?: number | null;
	gateRuns?: number | null;
}

/**
 * The `event: "run"` rows of an audit JSONL file, in order. Blank lines, malformed JSON, and rows
 * of other events are skipped.
 */
export function readRunRows(auditText: string): AuditRunRow[] {
	const rows: AuditRunRow[] = [];
	for (const line of auditText.split("\n")) {
		if (line.trim() === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof parsed === "object" && parsed !== null && (parsed as { event?: unknown }).event === "run") {
			rows.push(parsed as AuditRunRow);
		}
	}
	return rows;
}

export type RunOutcome = "timeout" | "no-row" | "multi-row" | "valid";

/**
 * The outcome of one `pi` run, first match wins: the driver killed it (`timeout`), it wrote no run
 * row (`no-row`), it wrote more than one (`multi-row`), else `valid`.
 *
 * @param killed Whether the driver killed the process at the wall-clock limit.
 * @param runRows The run rows from {@link readRunRows}.
 */
export function classifyOutcome(killed: boolean, runRows: AuditRunRow[]): RunOutcome {
	if (killed) return "timeout";
	if (runRows.length === 0) return "no-row";
	if (runRows.length > 1) return "multi-row";
	return "valid";
}

/** True for the fixture files the final gate depends on: `.ledgerpi-gate` and the `test*.mjs` suites. */
export function isProtectedFixtureFile(name: string): boolean {
	return name === ".ledgerpi-gate" || /^test.*\.mjs$/.test(name);
}

/**
 * One line of `runs.jsonl`: a (task, arm, rep) cell, its outcome, and the audit row when the outcome
 * is `valid`. `tamperedFiles` names the protected fixture files whose final content differs from the
 * original (including deleted ones); empty means every protected file is intact.
 */
export interface RunRecord {
	task: string;
	arm: Arm;
	rep: number;
	outcome: RunOutcome;
	run: AuditRunRow | null;
	tamperedFiles: string[];
}

/** Reduce a finished `pi` run's per-run audit file and its tampered protected files to a {@link RunRecord}. */
export function recordRun(
	cell: Pick<RunRecord, "task" | "arm" | "rep">,
	killed: boolean,
	auditText: string,
	tamperedFiles: string[],
): RunRecord {
	const rows = readRunRows(auditText);
	const outcome = classifyOutcome(killed, rows);
	return { ...cell, outcome, run: outcome === "valid" ? rows[0] : null, tamperedFiles: [...tamperedFiles].sort() };
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

function numbers(rows: AuditRunRow[], pick: (row: AuditRunRow) => number | null | undefined): number[] {
	return rows.map(pick).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function rate(count: number, of: number): number | null {
	return of === 0 ? null : count / of;
}

/** True when fan-out latched off during the run: a candidate-setup failure or an abandoned fan-out round. */
export function didLatch(row: AuditRunRow): boolean {
	const fan = row.fanout;
	if (!fan) return false;
	return (fan.escapes?.length ?? 0) > 0 || (fan.downgrades ?? []).some((d) => d === "latched" || d === "setup-failed");
}

/** True when the loop ended on `spawn-failure` or `aborted` rather than a verdict about the task. */
export function isErrored(row: AuditRunRow): boolean {
	return row.stop === "spawn-failure" || row.stop === "aborted";
}

/**
 * Per-arm results. Only `valid` runs enter rates and medians; `errored` counts valid runs whose
 * loop stopped on `spawn-failure` or `aborted` and is a subset of `valid`. Rates and medians are
 * null when there is nothing to take them over.
 */
export interface ArmSummary {
	arm: Arm;
	/** Cells recorded for this arm, valid or not. */
	runs: number;
	valid: number;
	timeouts: number;
	noRows: number;
	multiRows: number;
	errored: number;
	durationMsP50: number | null;
	/** Share of valid runs whose final gate passed with every protected fixture file intact. */
	gatePassRate: number | null;
	/** Valid runs whose worker changed a protected fixture file, whatever the gate said. */
	tampered: number;
	/** Share of valid runs that ended `converged`, by the loop's own verdict and unadjusted for tampering. */
	convergedRate: number | null;
	itersP50: number | null;
	tokensP50: number | null;
	gateMsP50: number | null;
	gateRunsP50: number | null;
	/** Total gate time over total wall-clock across valid runs. */
	gateShare: number | null;
	/** Valid runs with at least one best-of-n round. */
	engaged: number;
	engagementRate: number | null;
	latched: number;
	advised: Record<string, number>;
	downgrades: number;
	escapes: number;
}

/** Summarize one arm's records; records of other arms are ignored. */
export function summarizeArm(arm: Arm, records: RunRecord[]): ArmSummary {
	const mine = records.filter((r) => r.arm === arm);
	const validRecords = mine.filter((r) => r.outcome === "valid" && r.run);
	const rows = validRecords.flatMap((r) => (r.run ? [r.run] : []));
	const count = (outcome: RunOutcome) => mine.filter((r) => r.outcome === outcome).length;
	const durations = numbers(rows, (r) => r.durationMs);
	const gateMs = numbers(rows, (r) => r.gateMs);
	const advised: Record<string, number> = {};
	for (const row of rows) {
		for (const [mode, n] of Object.entries(row.fanout?.advised ?? {})) advised[mode] = (advised[mode] ?? 0) + n;
	}
	const engaged = rows.filter((r) => (r.fanout?.rounds ?? 0) > 0).length;
	return {
		arm,
		runs: mine.length,
		valid: rows.length,
		timeouts: count("timeout"),
		noRows: count("no-row"),
		multiRows: count("multi-row"),
		errored: rows.filter(isErrored).length,
		durationMsP50: percentile(durations, 50),
		gatePassRate: rate(
			validRecords.filter((r) => r.run?.gate?.passed === true && r.tamperedFiles.length === 0).length,
			rows.length,
		),
		tampered: validRecords.filter((r) => r.tamperedFiles.length > 0).length,
		convergedRate: rate(rows.filter((r) => r.converged === true).length, rows.length),
		itersP50: percentile(
			numbers(rows, (r) => r.iters),
			50,
		),
		tokensP50: percentile(
			numbers(rows, (r) => r.tokens),
			50,
		),
		gateMsP50: percentile(gateMs, 50),
		gateRunsP50: percentile(
			numbers(rows, (r) => r.gateRuns),
			50,
		),
		gateShare: sum(durations) > 0 ? sum(gateMs) / sum(durations) : null,
		engaged,
		engagementRate: rate(engaged, rows.length),
		latched: rows.filter(didLatch).length,
		advised,
		downgrades: sum(rows.map((r) => r.fanout?.downgrades?.length ?? 0)),
		escapes: sum(rows.map((r) => r.fanout?.escapes?.length ?? 0)),
	};
}

/** Summaries for the arms present in `records`, ascending by arm. */
export function summarizeRuns(records: RunRecord[]): ArmSummary[] {
	return ARMS.filter((arm) => records.some((r) => r.arm === arm)).map((arm) => summarizeArm(arm, records));
}

export type ArmLabel = "insufficient" | "harmful" | "helping" | "neutral";

/** An arm's advisory label against N=1, with the numbers behind it. */
export interface LabeledArm {
	arm: Arm;
	label: ArmLabel;
	gatePassRate: number | null;
	/** Pass-rate difference to N=1 in points; null when either rate is undefined. */
	passDeltaPoints: number | null;
	/** Median wall-clock over N=1's; null when either median is undefined or N=1's is 0. */
	durationRatio: number | null;
}

/**
 * Label one fan-out arm against the N=1 baseline over the same tasks and reps. First match wins:
 * `insufficient` (either arm under {@link MIN_VALID_RUNS} valid runs, engagement under
 * {@link MIN_ENGAGEMENT}, or more than {@link MAX_LATCHED_SHARE} of runs latched);
 * `harmful` (pass rate more than {@link PASS_MARGIN_POINTS} below, or median above
 * {@link HARMFUL_TIME_RATIO}x); `helping` (pass rate at least the margin above, or within it with a
 * median at most {@link HELPING_TIME_RATIO}x); otherwise `neutral`.
 */
export function labelArm(baseline: ArmSummary, candidate: ArmSummary): LabeledArm {
	const passDeltaPoints =
		baseline.gatePassRate === null || candidate.gatePassRate === null
			? null
			: (candidate.gatePassRate - baseline.gatePassRate) * 100;
	const durationRatio =
		baseline.durationMsP50 === null || candidate.durationMsP50 === null || baseline.durationMsP50 === 0
			? null
			: candidate.durationMsP50 / baseline.durationMsP50;
	const result = (label: ArmLabel): LabeledArm => ({
		arm: candidate.arm,
		label,
		gatePassRate: candidate.gatePassRate,
		passDeltaPoints,
		durationRatio,
	});

	const thin = baseline.valid < MIN_VALID_RUNS || candidate.valid < MIN_VALID_RUNS;
	const disengaged = (candidate.engagementRate ?? 0) < MIN_ENGAGEMENT;
	const mostlyLatched = candidate.latched > MAX_LATCHED_SHARE * candidate.valid;
	if (thin || disengaged || mostlyLatched || passDeltaPoints === null) return result("insufficient");

	if (passDeltaPoints < -PASS_MARGIN_POINTS - POINT_EPSILON) return result("harmful");
	if (durationRatio !== null && durationRatio > HARMFUL_TIME_RATIO) return result("harmful");

	if (passDeltaPoints >= PASS_MARGIN_POINTS - POINT_EPSILON) return result("helping");
	if (durationRatio !== null && durationRatio <= HELPING_TIME_RATIO) return result("helping");
	return result("neutral");
}

/**
 * Label every fan-out arm in `summaries` against N=1. Without an N=1 summary every arm is
 * `insufficient`.
 */
export function labelArms(summaries: ArmSummary[]): LabeledArm[] {
	const baseline = summaries.find((s) => s.arm === 1);
	return summaries
		.filter((s) => s.arm !== 1)
		.map((s) =>
			baseline
				? labelArm(baseline, s)
				: {
						arm: s.arm,
						label: "insufficient",
						gatePassRate: s.gatePassRate,
						passDeltaPoints: null,
						durationRatio: null,
					},
		);
}

export interface Recommendation {
	/** Advisory `fanoutMax` cap. */
	cap: number;
	/** Advisory `fanoutMax` default. */
	default: number;
	line: string;
}

/**
 * The advisory recommendation: the cap is the largest labeled arm that is neither `harmful` nor
 * `insufficient`; the default is the `helping` arm with the best pass rate, ties to the smaller N.
 * Either falls back to {@link FALLBACK_FANOUT_MAX}. Printed only; never applied to code.
 */
export function recommend(labeled: LabeledArm[]): Recommendation {
	const usable = labeled.filter((l) => l.label === "neutral" || l.label === "helping");
	const cap = Math.max(FALLBACK_FANOUT_MAX, ...usable.map((l) => l.arm));
	const helping = labeled
		.filter((l) => l.label === "helping")
		.sort((a, b) => (b.gatePassRate ?? 0) - (a.gatePassRate ?? 0) || a.arm - b.arm);
	const fanoutDefault = helping[0]?.arm ?? FALLBACK_FANOUT_MAX;
	return {
		cap,
		default: fanoutDefault,
		line: `Advisory only: fanoutMax default ${fanoutDefault}, cap ${cap}. Margins of ${PASS_MARGIN_POINTS} points are near noise at this sample size; the choice is the user's.`,
	};
}

const pct = (v: number | null): string => (v === null ? "-" : `${(v * 100).toFixed(0)}%`);
const num = (v: number | null): string => (v === null ? "-" : String(Math.round(v)));
const secs = (ms: number | null): string => (ms === null ? "-" : (ms / 1000).toFixed(1));
const points = (v: number | null): string => (v === null ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`);

function table(header: string[], rows: string[][]): string[] {
	const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
	return [line(header), line(header.map(() => "---")), ...rows.map(line)];
}

/**
 * The human-readable `summary.md`: per-arm outcome counts, metrics, engagement, advisory labels,
 * the recommendation line and the caveats. Pure; the same data is in `summary.json`.
 */
export function renderSummaryMarkdown(
	summaries: ArmSummary[],
	labeled: LabeledArm[],
	recommendation: Recommendation,
): string {
	const outcomes = table(
		["Arm", "Runs", "Valid", "Timeout", "No row", "Multi row", "Errored", "Tampered"],
		summaries.map((s) => [
			`N=${s.arm}`,
			String(s.runs),
			String(s.valid),
			String(s.timeouts),
			String(s.noRows),
			String(s.multiRows),
			String(s.errored),
			String(s.tampered),
		]),
	);
	const metrics = table(
		[
			"Arm",
			"p50 s",
			"Gate pass",
			"Converged",
			"p50 iters",
			"p50 tokens",
			"p50 gate ms",
			"p50 gate runs",
			"Gate share",
		],
		summaries.map((s) => [
			`N=${s.arm}`,
			secs(s.durationMsP50),
			pct(s.gatePassRate),
			pct(s.convergedRate),
			num(s.itersP50),
			num(s.tokensP50),
			num(s.gateMsP50),
			num(s.gateRunsP50),
			pct(s.gateShare),
		]),
	);
	const engagement = table(
		["Arm", "Engaged", "Engagement", "Latched", "Advised", "Downgrades", "Escapes"],
		summaries.map((s) => [
			`N=${s.arm}`,
			String(s.engaged),
			pct(s.engagementRate),
			String(s.latched),
			Object.entries(s.advised)
				.map(([mode, n]) => `${mode}:${n}`)
				.join(" ") || "-",
			String(s.downgrades),
			String(s.escapes),
		]),
	);
	const labels = table(
		["Arm", "Label", "Pass rate", "Pass delta (points)", "Wall-clock vs N=1"],
		labeled.map((l) => [
			`N=${l.arm}`,
			l.label,
			pct(l.gatePassRate),
			points(l.passDeltaPoints),
			l.durationRatio === null ? "-" : `${l.durationRatio.toFixed(2)}x`,
		]),
	);
	const caveats = [
		"Local worker model only; cloud and Claude Code workers were not measured.",
		"Medians are nearest-rank p50 over valid runs.",
		`One run moves a pass rate by roughly ${(100 / Math.max(1, ...summaries.map((s) => s.valid))).toFixed(1)} points, so the ${PASS_MARGIN_POINTS}-point margins are near noise.`,
	];
	if (!summaries.some((s) => s.arm === 8)) caveats.push("N=8 was not measured.");
	return [
		"# Fan-out benchmark",
		"",
		"## Outcomes",
		"",
		...outcomes,
		"",
		"## Metrics (valid runs)",
		"",
		...metrics,
		"",
		"## Engagement",
		"",
		...engagement,
		"",
		"## Advisory labels against N=1",
		"",
		...labels,
		"",
		recommendation.line,
		"",
		"## Caveats",
		"",
		...caveats.map((c) => `- ${c}`),
		"",
	].join("\n");
}
