import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BenchConfigError, type BenchErrorKind, percentile } from "../bench/concurrency/bench.ts";
import {
	type Arm,
	type ArmLabel,
	type AuditRunRow,
	armSettings,
	buildVariantConfig,
	classifyOutcome,
	DEFAULT_ARMS,
	isProtectedFixtureFile,
	labelArm,
	labelArms,
	parseFanoutArgs,
	type RunRecord,
	readRunRows,
	recommend,
	recordRun,
	renderSummaryMarkdown,
	summarizeArm,
	summarizeRuns,
} from "../bench/fanout/bench.ts";
import { auditRun } from "../packages/core/src/audit.ts";
import type { LedgerpiConfig } from "../packages/core/src/config.ts";
import type { LoopResult } from "../packages/core/src/loop.ts";

let failures = 0;
const check = (label: string, cond: boolean, detail: unknown = "") => {
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${JSON.stringify(detail)}`}`);
	if (!cond) failures++;
};

function errorKind(fn: () => unknown): BenchErrorKind | "none" | "other" {
	try {
		fn();
		return "none";
	} catch (err) {
		return err instanceof BenchConfigError ? err.kind : "other";
	}
}

function caseArgs() {
	const defaults = parseFanoutArgs([]);
	check(
		"args: defaults are arms 1,2,4, 3 reps, all tasks, no --out",
		defaults.arms.join() === "1,2,4" &&
			defaults.arms.join() === DEFAULT_ARMS.join() &&
			defaults.reps === 3 &&
			defaults.tasks === undefined &&
			defaults.out === undefined &&
			defaults.timeoutS > 0,
		defaults,
	);
	const parsed = parseFanoutArgs([
		"--arms",
		"8, 2,1,2",
		"--reps",
		"5",
		"--tasks",
		"alpha,beta",
		"--timeout-s",
		"90.5",
		"--out",
		"/tmp/x",
	]);
	check(
		"args: explicit values parse, sort and de-duplicate",
		parsed.arms.join() === "1,2,8" &&
			parsed.reps === 5 &&
			parsed.tasks?.join() === "alpha,beta" &&
			parsed.timeoutS === 90.5 &&
			parsed.out === "/tmp/x",
		parsed,
	);

	const cases: [string, string[], BenchErrorKind][] = [
		["an unknown flag", ["--bogus"], "usage"],
		["a flag without a value", ["--arms"], "usage"],
		["a positional argument", ["1,2"], "usage"],
		["reps 0", ["--reps", "0"], "malformed-value"],
		["reps 1.5", ["--reps", "1.5"], "malformed-value"],
		["reps -2", ["--reps=-2"], "malformed-value"],
		["reps abc", ["--reps", "abc"], "malformed-value"],
		["an empty --arms", ["--arms", ""], "malformed-value"],
		["a trailing comma in --arms", ["--arms", "1,"], "malformed-value"],
		["a non-numeric arm", ["--arms", "1,x"], "malformed-value"],
		["arm 0", ["--arms", "0"], "malformed-value"],
		["arm 3", ["--arms", "1,3"], "unknown-arm"],
		["arm 16", ["--arms", "16"], "unknown-arm"],
		["an empty --tasks", ["--tasks", ""], "malformed-value"],
		["a path-like task name", ["--tasks", "../escape"], "malformed-value"],
		["timeout 0", ["--timeout-s", "0"], "malformed-value"],
		["a non-numeric timeout", ["--timeout-s", "soon"], "malformed-value"],
	];
	for (const [label, argv, kind] of cases) {
		const got = errorKind(() => parseFanoutArgs(argv));
		check(`args: ${label} is rejected as ${kind}`, got === kind, got);
	}
}

function caseConfig() {
	check(
		"config: arm 1 is fanout advise with no fanoutMax override",
		JSON.stringify(armSettings(1)) === JSON.stringify({ fanout: "advise" }),
		armSettings(1),
	);
	const live = { fanout: "off", fanoutMax: 6, classifier: true, maxIters: 7, nested: { keep: [1, 2] }, model: "m" };
	const snapshot = JSON.stringify(live);
	const on4 = buildVariantConfig(live, 4);
	check(
		"config: arm 4 sets fanout on, fanoutMax 4 and classifier false",
		on4.fanout === "on" && on4.fanoutMax === 4 && on4.classifier === false,
		on4,
	);
	check(
		"config: every other live key is preserved",
		on4.maxIters === 7 && on4.model === "m" && JSON.stringify(on4.nested) === JSON.stringify({ keep: [1, 2] }),
		on4,
	);
	const adv = buildVariantConfig(live, 1);
	check(
		"config: arm 1 sets advise and classifier false, leaving fanoutMax as live",
		adv.fanout === "advise" && adv.classifier === false && adv.fanoutMax === 6,
		adv,
	);
	check("config: the live object is not modified", JSON.stringify(live) === snapshot, live);
	check(
		"config: an explicit live gate is dropped so the fixture gate decides",
		!("gate" in buildVariantConfig({ gate: "make check", maxIters: 7 }, 2)),
	);
	const bare = buildVariantConfig({}, 2);
	check(
		"config: an empty live config gets exactly the three overrides",
		Object.keys(bare).sort().join() === "classifier,fanout,fanoutMax",
		bare,
	);
}

const runRow = (extra: Partial<AuditRunRow> = {}): AuditRunRow => ({
	event: "run",
	converged: true,
	stop: "done",
	iters: 2,
	tokens: 1000,
	gate: { command: "node test.js", ran: true, passed: true },
	fanout: { setting: "on", max: 2, rounds: 1, downgrades: [], escapes: [], advised: { "best-of-n": 1, none: 1 } },
	durationMs: 60_000,
	gateMs: 6_000,
	gateRuns: 2,
	...extra,
});
const line = (row: unknown) => `${JSON.stringify(row)}\n`;

function caseRows() {
	const text = [
		line(runRow()),
		"\n",
		"   \n",
		"{not json\n",
		line({ event: "pass-through", reason: "chat" }),
		line({ nothing: true }),
		"null\n",
		"7\n",
		line(runRow({ iters: 9 })),
	].join("");
	const rows = readRunRows(text);
	check(
		"rows: only run events count; blank, malformed and other-event lines are skipped",
		rows.length === 2 && rows[0].iters === 2 && rows[1].iters === 9,
		rows,
	);
	check("rows: an empty file has no rows", readRunRows("").length === 0);

	const one = [runRow()];
	const two = [runRow(), runRow()];
	const outcomes: [string, boolean, AuditRunRow[], string][] = [
		["killed with no rows", true, [], "timeout"],
		["killed with one row", true, one, "timeout"],
		["killed with two rows", true, two, "timeout"],
		["exited with no rows", false, [], "no-row"],
		["exited with two rows", false, two, "multi-row"],
		["exited with one row", false, one, "valid"],
	];
	for (const [label, killed, runRows, want] of outcomes) {
		const got = classifyOutcome(killed, runRows);
		check(`outcome: ${label} is ${want}`, got === want, got);
	}

	const cell = { task: "t", arm: 2 as Arm, rep: 1 };
	const valid = recordRun(cell, false, line({ event: "pass-through" }) + line(runRow()), []);
	check(
		"outcome: recordRun keeps the cell and the single run row",
		valid.outcome === "valid" && valid.run?.iters === 2 && valid.task === "t" && valid.arm === 2 && valid.rep === 1,
		valid,
	);
	const multi = recordRun(cell, false, line(runRow()) + line(runRow()), []);
	const none = recordRun(cell, false, "", []);
	const killed = recordRun(cell, true, line(runRow()), []);
	check(
		"outcome: excluded records carry no run row",
		multi.outcome === "multi-row" &&
			none.outcome === "no-row" &&
			killed.outcome === "timeout" &&
			[multi, none, killed].every((r) => r.run === null),
		[multi, none, killed],
	);
	const unsorted = recordRun(cell, false, line(runRow()), ["test.mjs", ".ledgerpi-gate"]);
	check(
		"outcome: recordRun stores tamperedFiles sorted",
		unsorted.tamperedFiles.join() === ".ledgerpi-gate,test.mjs",
		unsorted.tamperedFiles,
	);
	check("outcome: recordRun keeps an empty tamperedFiles empty", valid.tamperedFiles.length === 0, valid);

	const protectedCases: [string, boolean][] = [
		[".ledgerpi-gate", true],
		["test.mjs", true],
		["test-extra.mjs", true],
		["a.mjs", false],
		["test.js", false],
		["task.md", false],
		["mytest.mjs", false],
	];
	for (const [name, want] of protectedCases) {
		check(
			`protected: ${name} is ${want ? "" : "not "}a protected fixture file`,
			isProtectedFixtureFile(name) === want,
		);
	}
}

function caseAuditContract() {
	const dir = mkdtempSync(join(tmpdir(), "fanout-bench-audit-"));
	const auditLog = join(dir, "runs.jsonl");
	const cfg = { auditLog, maxIters: 8, callTimeoutMs: 1000 } as LedgerpiConfig;
	const result: LoopResult = {
		converged: true,
		iters: 3,
		calls: 6,
		tokens: 500,
		gate: { ran: true, passed: true, command: "node test.mjs", output: "" },
		stop: "done",
		notes: "",
		tasks: [],
		managerModel: null,
		workerModel: null,
		planSource: "manager",
		timing: { managerMs: 10, workerMs: 20, gateMs: 7, managerCalls: 1, workerCalls: 2, gateRuns: 2 },
		fanout: {
			setting: "on",
			max: 2,
			rounds: 2,
			downgrades: ["latched"],
			escapes: [],
			asked: 0,
			advised: { serial: 1, "best-of-n": 2, fleet: 0, none: 0 },
		},
	};
	auditRun(cfg, { entry: "command", session: "s", cwd: dir }, result, {
		task: "t",
		durationMs: 4321,
		calls: 6,
		tokens: 500,
	});
	const records = [recordRun({ task: "t", arm: 2 as Arm, rep: 1 }, false, readFileSync(auditLog, "utf8"), [])];
	rmSync(dir, { recursive: true, force: true });
	const summary = summarizeArm(2, records);
	check(
		"audit contract: a row written by auditRun reduces to the fields the report reads",
		records[0].outcome === "valid" &&
			summary.engaged === 1 &&
			summary.latched === 1 &&
			summary.gatePassRate === 1 &&
			summary.convergedRate === 1 &&
			summary.durationMsP50 === 4321 &&
			summary.gateRunsP50 === 2 &&
			summary.advised["best-of-n"] === 2,
		summary,
	);
}

function record(
	arm: Arm,
	rep: number,
	row: AuditRunRow | null,
	outcome: RunRecord["outcome"] = "valid",
	tamperedFiles: string[] = [],
): RunRecord {
	return { task: "t", arm, rep, outcome, run: row, tamperedFiles };
}

function caseSummary() {
	const records: RunRecord[] = [
		record(2, 1, runRow()),
		record(
			2,
			2,
			runRow({
				converged: false,
				stop: "unconverged",
				gate: { passed: false },
				iters: 4,
				durationMs: 120_000,
				gateMs: 24_000,
				gateRuns: 4,
				tokens: 3000,
				fanout: {
					rounds: 0,
					downgrades: ["latched", "no-gate"],
					escapes: ["boom"],
					advised: { serial: 2 },
				},
			}),
		),
		record(2, 3, runRow({ stop: "spawn-failure", converged: false, gate: null, fanout: null, durationMs: 30_000 })),
		record(2, 4, null, "no-row"),
		record(2, 5, null, "timeout"),
		record(2, 6, null, "multi-row"),
		record(1, 1, runRow({ fanout: { setting: "advise", rounds: 0, advised: { "best-of-n": 1 } } })),
	];
	const s = summarizeArm(2, records);
	check(
		"summary: counts valid and each excluded outcome, and ignores other arms",
		s.runs === 6 && s.valid === 3 && s.timeouts === 1 && s.noRows === 1 && s.multiRows === 1,
		s,
	);
	check("summary: errored runs are counted within valid", s.errored === 1, s);
	check(
		"summary: gate pass and converged rates are over valid runs",
		s.gatePassRate === 1 / 3 && s.convergedRate === 1 / 3,
		s,
	);
	check(
		"summary: medians use percentile(values, 50) over the valid runs",
		s.durationMsP50 === percentile([60_000, 120_000, 30_000], 50) &&
			s.itersP50 === percentile([2, 4, 2], 50) &&
			s.tokensP50 === percentile([1000, 3000, 1000], 50) &&
			s.gateMsP50 === percentile([6_000, 24_000, 6_000], 50) &&
			s.gateRunsP50 === percentile([2, 4, 2], 50),
		s,
	);
	check(
		"summary: gate share is total gate time over total wall-clock",
		s.gateShare === (6_000 + 24_000 + 6_000) / (60_000 + 120_000 + 30_000),
		s.gateShare,
	);
	check(
		"summary: engagement counts runs with rounds > 0; a latched run stays valid and counted",
		s.engaged === 1 && s.engagementRate === 1 / 3 && s.latched === 1,
		s,
	);
	check(
		"summary: advised, downgrades and escapes are totals",
		s.advised["best-of-n"] === 1 &&
			s.advised.none === 1 &&
			s.advised.serial === 2 &&
			s.downgrades === 2 &&
			s.escapes === 1,
		s,
	);
	check("summary: an untampered arm reports tampered === 0", s.tampered === 0, s);
	const tamperedArm = summarizeArm(2, [
		record(2, 1, runRow(), "valid", [".ledgerpi-gate"]),
		record(2, 2, runRow({ converged: false, stop: "unconverged", gate: { passed: false } }), "valid", ["test.mjs"]),
		record(2, 3, runRow()),
		record(2, 4, null, "timeout", ["test.mjs"]),
		record(2, 5, null, "no-row", [".ledgerpi-gate"]),
		record(1, 1, runRow(), "valid", ["test.mjs"]),
	]);
	check(
		"summary: a tampered pass is left out of gatePassRate and counted as tampered",
		tamperedArm.valid === 3 && tamperedArm.gatePassRate === 1 / 3 && tamperedArm.tampered === 2,
		tamperedArm,
	);
	check(
		"summary: a tampered run with a failing gate counts as tampered; converged stays unadjusted",
		tamperedArm.convergedRate === 2 / 3,
		tamperedArm,
	);
	const onlyTampered = summarizeArm(2, [record(2, 1, runRow(), "valid", ["test.mjs"])]);
	check(
		"summary: an arm whose only pass is tampered has a zero pass rate",
		onlyTampered.gatePassRate === 0 && onlyTampered.tampered === 1,
		onlyTampered,
	);
	const missingFanout = summarizeArm(2, [record(2, 1, runRow({ fanout: null }))]);
	check(
		"summary: a row without fanout is not engaged or latched",
		missingFanout.engaged === 0 && missingFanout.latched === 0,
	);

	const empty = summarizeArm(4, records);
	check(
		"summary: an arm with no runs has null rates and medians",
		empty.runs === 0 &&
			empty.gatePassRate === null &&
			empty.durationMsP50 === null &&
			empty.gateShare === null &&
			empty.engagementRate === null,
		empty,
	);
	check(
		"summary: summarizeRuns lists only present arms, ascending",
		summarizeRuns(records)
			.map((x) => x.arm)
			.join() === "1,2",
	);
}

/** An arm of `valid` runs at `durationMs`; the first `passes` pass and the first `engaged` ran best-of-n. */
function arm(
	n: Arm,
	opts: { valid?: number; passes: number; durationMs?: number; engaged?: number; latched?: number },
): RunRecord[] {
	const valid = opts.valid ?? 24;
	return Array.from({ length: valid }, (_, i) =>
		record(
			n,
			i,
			runRow({
				gate: { passed: i < opts.passes },
				durationMs: opts.durationMs ?? 100_000,
				fanout: {
					rounds: i < (opts.engaged ?? valid) ? 1 : 0,
					downgrades: i < (opts.latched ?? 0) ? ["latched"] : [],
					escapes: [],
					advised: {},
				},
			}),
		),
	);
}

function labelOf(base: RunRecord[], candidate: RunRecord[]): ArmLabel {
	return labelArm(summarizeArm(1, base), summarizeArm(2, candidate)).label;
}

function caseLabels() {
	const base = arm(1, { passes: 12 });
	const cases: [string, RunRecord[], RunRecord[], ArmLabel][] = [
		["fewer than 20 candidate runs", base, arm(2, { valid: 19, passes: 19 }), "insufficient"],
		["fewer than 20 baseline runs", arm(1, { valid: 19, passes: 10 }), arm(2, { passes: 24 }), "insufficient"],
		["engagement below 30%", base, arm(2, { passes: 24, engaged: 7 }), "insufficient"],
		["more than half latched", base, arm(2, { passes: 24, latched: 13 }), "insufficient"],
		["insufficient wins over harmful", base, arm(2, { passes: 0, engaged: 0 }), "insufficient"],
		[
			"a third engaged and exactly half latched are not insufficient",
			base,
			arm(2, { passes: 12, engaged: 8, latched: 12 }),
			"neutral",
		],
		["a pass rate more than 5 points below", base, arm(2, { passes: 10 }), "harmful"],
		["a median above 1.5x", base, arm(2, { passes: 12, durationMs: 160_000 }), "harmful"],
		["harmful wins over a pass-rate gain", base, arm(2, { passes: 24, durationMs: 160_000 }), "harmful"],
		[
			"a pass rate exactly 5 points below is within the margin",
			arm(1, { valid: 20, passes: 10 }),
			arm(2, { valid: 20, passes: 9 }),
			"neutral",
		],
		["a pass rate more than 5 points above", base, arm(2, { passes: 14 }), "helping"],
		["a pass rate 4 points above is within the margin", base, arm(2, { passes: 13 }), "neutral"],
		[
			"a pass rate exactly 5 points above",
			arm(1, { valid: 20, passes: 10 }),
			arm(2, { valid: 20, passes: 11 }),
			"helping",
		],
		["an equal pass rate with median at most 0.9x", base, arm(2, { passes: 12, durationMs: 90_000 }), "helping"],
		["an equal pass rate with median exactly 1.5x", base, arm(2, { passes: 12, durationMs: 150_000 }), "neutral"],
		["an equal pass rate and a similar median", base, arm(2, { passes: 12 }), "neutral"],
		["a median between 0.9x and 1.5x", base, arm(2, { passes: 12, durationMs: 120_000 }), "neutral"],
	];
	for (const [label, b, c, want] of cases) {
		const got = labelOf(b, c);
		check(`label: ${label} is ${want}`, got === want, got);
	}

	const sweep = [...base, ...arm(2, { passes: 15 }), ...arm(4, { passes: 12 })];
	const labeled = labelArms(summarizeRuns(sweep));
	check(
		"label: labelArms labels every non-baseline arm in order",
		labeled.map((l) => `${l.arm}:${l.label}`).join() === "2:helping,4:neutral",
		labeled,
	);
	const noBaseline = labelArms(summarizeRuns(arm(2, { passes: 24 })));
	check(
		"label: without an N=1 summary every arm is insufficient",
		noBaseline.length === 1 && noBaseline[0].label === "insufficient",
		noBaseline,
	);
	const partial = labelArms(summarizeRuns([...base, ...arm(2, { valid: 3, passes: 3 })]));
	check("label: a partial sweep is insufficient", partial[0].label === "insufficient", partial);
}

function caseRecommend() {
	const entry = (n: Arm, label: ArmLabel, gatePassRate: number | null) => ({
		arm: n,
		label,
		gatePassRate,
		passDeltaPoints: null,
		durationRatio: null,
	});
	const none = recommend([]);
	check("recommend: nothing measured falls back to default 2 and cap 2", none.default === 2 && none.cap === 2, none);

	const allBad = recommend([entry(2, "harmful", 0.5), entry(4, "insufficient", 0.9)]);
	check(
		"recommend: no usable arm falls back to default 2 and cap 2",
		allBad.default === 2 && allBad.cap === 2,
		allBad,
	);

	const mixed = recommend([entry(2, "neutral", 0.5), entry(4, "helping", 0.7), entry(8, "harmful", 0.9)]);
	check(
		"recommend: cap is the largest non-harmful non-insufficient arm; default is the helping arm",
		mixed.cap === 4 && mixed.default === 4,
		mixed,
	);
	const capOver = recommend([entry(2, "helping", 0.6), entry(4, "harmful", 0.5), entry(8, "neutral", 0.4)]);
	check(
		"recommend: a harmful middle arm does not lower the cap below a usable larger arm",
		capOver.cap === 8 && capOver.default === 2,
		capOver,
	);
	const best = recommend([entry(2, "helping", 0.6), entry(4, "helping", 0.8)]);
	check("recommend: default is the helping arm with the best pass rate", best.default === 4 && best.cap === 4, best);
	const tie = recommend([entry(4, "helping", 0.7), entry(2, "helping", 0.7)]);
	check("recommend: ties go to the smaller N", tie.default === 2 && tie.cap === 4, tie);
	check(
		"recommend: the line is marked advisory and names the values",
		best.line.startsWith("Advisory only") && best.line.includes("default 4") && best.line.includes("cap 4"),
		best.line,
	);
	const input = [entry(4, "helping", 0.7), entry(2, "helping", 0.7)];
	recommend(input);
	check("recommend: the input order is unchanged", input[0].arm === 4 && input[1].arm === 2, input);
}

const CORPUS_SIZE = 8;
const CORPUS_NAMES = [
	"cron-next",
	"csv-parse",
	"expr-eval",
	"glob-match",
	"interval-ops",
	"lru-ttl",
	"semver-range",
	"text-wrap",
];
const FIXTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function caseCorpus() {
	const corpusDir = fileURLToPath(new URL("../bench/fanout/tasks", import.meta.url));
	const solutionsDir = fileURLToPath(new URL("../bench/fanout/solutions", import.meta.url));
	const names = readdirSync(corpusDir)
		.filter((name) => statSync(join(corpusDir, name)).isDirectory())
		.sort();
	check(`corpus: exactly ${CORPUS_SIZE} fixtures`, names.length === CORPUS_SIZE, names);
	check(
		"corpus: the fixture names are the expected set",
		JSON.stringify(names) === JSON.stringify(CORPUS_NAMES),
		names,
	);
	check(
		"corpus: every fixture name is accepted by --tasks",
		names.every((name) => FIXTURE_NAME.test(name)),
		names,
	);
	const scratch = mkdtempSync(join(tmpdir(), "ledgerpi-fanout-corpus-"));
	try {
		for (const name of names) {
			const dir = join(corpusDir, name);
			const files = readdirSync(dir);
			const read = (file: string) => (files.includes(file) ? readFileSync(join(dir, file), "utf8").trim() : "");
			const sources = files.filter((file) => file.endsWith(".mjs") && !/^test/.test(file));
			const tests = files.filter((file) => file.endsWith(".mjs") && isProtectedFixtureFile(file));
			check(
				`corpus: ${name} has task.md, .ledgerpi-gate, a source file and a test file`,
				read("task.md") !== "" && read(".ledgerpi-gate") !== "" && sources.length > 0 && tests.length > 0,
				files,
			);
			check(
				`corpus: ${name} task.md does not hint at fan-out`,
				!/fan.?out|best.of|parallel|concurren/i.test(read("task.md")),
				read("task.md"),
			);
			const copy = join(scratch, name);
			cpSync(dir, copy, { recursive: true });
			const gate = spawnSync("/bin/sh", ["-c", read(".ledgerpi-gate")], {
				cwd: copy,
				encoding: "utf8",
				timeout: 30_000,
			});
			check(`corpus: ${name} gate fails on the unmodified fixture`, gate.status !== null && gate.status !== 0, {
				status: gate.status,
				signal: gate.signal,
			});
			const solutionDir = join(solutionsDir, name);
			const solutionFiles = existsSync(solutionDir) ? readdirSync(solutionDir) : [];
			check(
				`corpus: ${name} has a non-empty solutions dir whose files are all fixture sources`,
				solutionFiles.length > 0 && solutionFiles.every((file) => sources.includes(file)),
				{ solutionFiles, sources },
			);
			const solved = join(scratch, `${name}-solved`);
			cpSync(dir, solved, { recursive: true });
			for (const file of solutionFiles) cpSync(join(solutionDir, file), join(solved, file));
			const solvedGate = spawnSync("/bin/sh", ["-c", read(".ledgerpi-gate")], {
				cwd: solved,
				encoding: "utf8",
				timeout: 30_000,
			});
			check(`corpus: ${name} gate passes with the reference solution overlaid`, solvedGate.status === 0, {
				status: solvedGate.status,
				signal: solvedGate.signal,
				stderr: solvedGate.stderr,
			});
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function caseRender() {
	const row = (durationMs: number): AuditRunRow => ({
		event: "run",
		converged: true,
		durationMs,
		gate: { passed: true },
	});
	const summaries = summarizeRuns([
		record(1, 1, row(2000)),
		record(1, 2, row(2000)),
		record(2, 1, row(1000)),
		record(2, 2, row(1000)),
	]);
	const labeled = labelArms(summaries);
	const md = renderSummaryMarkdown(summaries, labeled, recommend(labeled));
	check(
		"render: names every arm, the labels, the advisory line and the caveats",
		md.includes("N=1") &&
			md.includes("N=2") &&
			md.includes("insufficient") &&
			md.includes("Advisory only") &&
			md.includes("N=8 was not measured") &&
			md.includes("nearest-rank"),
		md,
	);
	const empty = renderSummaryMarkdown([], [], recommend([]));
	check("render: empty input still renders", empty.includes("Fan-out benchmark"), empty);
}

const root = join(tmpdir(), `ledgerpi-fanout-bench-test-${process.pid}`);
const runEntry = fileURLToPath(new URL("../bench/fanout/run.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sentinel = join(root, "pi-called.txt");
const stubLog = join(root, "pi-stub.log");
const liveConfig = join(root, "live-config.toml");
const inertConfig = join(root, "inert-config.toml");
const disabledConfig = join(root, "disabled-config.toml");
const brokenConfig = join(root, "broken-config.toml");
const tasksDir = join(root, "tasks");
const stubPi = join(root, "stub-pi.sh");

const STUB_PI = `#!/bin/sh
echo "$@" >> "$LEDGERPI_STUB_SENTINEL"
case "$2" in
*SLEEP*) echo "$$ $PWD" >> "\${LEDGERPI_STUB_PIDS:-/dev/null}"; sleep 30; exit 0 ;;
*NOROW*) exit 0 ;;
*TAMPERGATE*) echo "exit 0" > .ledgerpi-gate ;;
*TAMPERTEST*) rm -f test.mjs ;;
*EXTRATEST*) echo "process.exit(1);" > test-extra.mjs ;;
esac
printf '%s|%s|%s|%s|%s|%s\\n' "$PWD" "$LEDGERPI_AUDIT_SOURCE" "$(git rev-list --count HEAD)" \\
	"$(test -f .ledgerpi-gate && echo gate)" "$(grep -E '^(fanout|fanoutMax|classifier|foo) ' "$LEDGERPI_CONFIG" | tr '\\n' ,)" \\
	"$(dirname "$LEDGERPI_AUDIT_LOG")" >> "$LEDGERPI_STUB_LOG"
printf '%s\\n' '{"event":"run","converged":true,"stop":"done","iters":2,"tokens":100,"gate":{"ran":true,"passed":true},"fanout":{"rounds":1},"durationMs":1000,"gateMs":200,"gateRuns":1}' >> "$LEDGERPI_AUDIT_LOG"
`;

function writeFixture(name: string, task: string) {
	const dir = join(tasksDir, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "task.md"), `${task}\n`);
	writeFileSync(join(dir, ".ledgerpi-gate"), "true\n");
	writeFileSync(join(dir, "a.txt"), "content\n");
	writeFileSync(join(dir, "test.mjs"), "process.exit(0);\n");
}

function setupBoundary() {
	mkdirSync(root, { recursive: true });
	writeFileSync(stubPi, STUB_PI);
	chmodSync(stubPi, 0o755);
	writeFileSync(liveConfig, 'enabled = true\nproviders = ["x"]\nfanoutMax = 6\nfoo = "bar"\n');
	writeFileSync(inertConfig, "enabled = true\nfanoutMax = 6\n");
	writeFileSync(disabledConfig, 'enabled = false\nproviders = ["x"]\n');
	writeFileSync(brokenConfig, "providers = [\n");
	writeFixture("alpha", "make alpha pass");
	writeFixture("beta", "SLEEP forever");
	writeFixture("gamma", "NOROW");
	writeFixture("tgate", "TAMPERGATE rewrite the gate");
	writeFixture("ttest", "TAMPERTEST delete the test");
	writeFixture("textra", "EXTRATEST add a test file");
	writeFixture("tcreate", "TAMPERGATE create a gate the fixture lacks");
	rmSync(join(tasksDir, "tcreate", ".ledgerpi-gate"));
	writeFixture("tnogate", "leave the gate-less fixture alone");
	rmSync(join(tasksDir, "tnogate", ".ledgerpi-gate"));
}

interface ChildResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runDriver(args: string[], extraEnv: Record<string, string> = {}): Promise<ChildResult> {
	return new Promise((done) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", runEntry, ...args], {
			env: {
				...process.env,
				LEDGERPI_BENCH_PI: stubPi,
				LEDGERPI_BENCH_TASKS: tasksDir,
				LEDGERPI_CONFIG: liveConfig,
				LEDGERPI_STUB_SENTINEL: sentinel,
				LEDGERPI_STUB_LOG: stubLog,
				...extraEnv,
			},
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 60_000,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("close", (code) => done({ code, stdout, stderr }));
	});
}

const readJsonl = (path: string): Record<string, unknown>[] =>
	readFileSync(path, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);

async function caseBoundaryRejections() {
	const out = join(root, "out-rejected");
	const cases: [string, string[], Record<string, string>?][] = [
		["an unknown flag", ["--bogus"]],
		["a malformed --arms", ["--arms", "1,x"]],
		["an unknown arm", ["--arms", "1,3"]],
		["a zero --reps", ["--reps", "0"]],
		["a missing fixture", ["--tasks", "nope"]],
		["a missing live config", [], { LEDGERPI_CONFIG: join(root, "no-such-config.toml") }],
		["a live config naming no providers", [], { LEDGERPI_CONFIG: inertConfig }],
		["a disabled live config", [], { LEDGERPI_CONFIG: disabledConfig }],
		["a live config that is not valid TOML", [], { LEDGERPI_CONFIG: brokenConfig }],
	];
	for (const [label, args, env] of cases) {
		const result = await runDriver([...args, "--out", out], env);
		check(`boundary: ${label} exits 2`, result.code === 2, result);
		check(`boundary: ${label} creates no out dir`, !existsSync(out), readdirSync(root));
		check(`boundary: ${label} spawns no pi`, !existsSync(sentinel), result);
	}
}

async function caseBoundaryRefusal() {
	const existing = join(root, "out-existing");
	mkdirSync(existing, { recursive: true });
	writeFileSync(join(existing, "sentinel.txt"), "keep me");
	const result = await runDriver(["--tasks", "alpha", "--arms", "1", "--reps", "1", "--out", existing]);
	check("boundary: an existing --out exits 2", result.code === 2, result);
	check("boundary: an existing --out spawns no pi", !existsSync(sentinel));
	check(
		"boundary: an existing --out is left untouched",
		readdirSync(existing).join() === "sentinel.txt" &&
			readFileSync(join(existing, "sentinel.txt"), "utf8") === "keep me",
		readdirSync(existing),
	);
}

async function caseBoundarySweep() {
	const status = () => spawnStatus();
	const before = await status();
	const out = join(root, "out-happy");
	const result = await runDriver(["--tasks", "alpha", "--arms", "1,2", "--reps", "1", "--out", out]);
	check("boundary: a sweep exits 0 and prints the out dir", result.code === 0 && result.stdout.trim() === out, result);
	const runs = readJsonl(join(out, "runs.jsonl"));
	check(
		"boundary: runs.jsonl has one valid record per cell",
		runs.length === 2 &&
			runs.every((r) => r.outcome === "valid" && r.task === "alpha" && r.rep === 1) &&
			runs.map((r) => r.arm).join() === "1,2",
		runs,
	);
	check(
		"boundary: an untouched fixture records no tampered files",
		runs.every((r) => Array.isArray(r.tamperedFiles) && r.tamperedFiles.length === 0),
		runs,
	);
	const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8")) as {
		arms: { arm: number; valid: number }[];
	};
	check(
		"boundary: summary.json covers both arms",
		summary.arms.map((a) => `${a.arm}:${a.valid}`).join() === "1:1,2:1",
		summary,
	);
	check(
		"boundary: summary.md is written",
		readFileSync(join(out, "summary.md"), "utf8").includes("Fan-out benchmark"),
	);
	check(
		"boundary: the out dir holds only the three result files",
		readdirSync(out).sort().join() === "runs.jsonl,summary.json,summary.md",
		readdirSync(out),
	);

	const calls = readFileSync(stubLog, "utf8").trimEnd().split("\n");
	const [armOne, armTwo] = calls.map((line) => line.split("|"));
	check(
		"boundary: pi runs in a one-commit repo with the gate file, labeled as benchmark",
		calls.length === 2 &&
			calls.every((_, i) => ["benchmark", "1", "gate"].join() === [armOne, armTwo][i].slice(1, 4).join()),
		calls,
	);
	check(
		"boundary: arm 1 is advise and keeps the other live keys",
		armOne[4].includes('fanout = "advise"') &&
			armOne[4].includes("fanoutMax = 6") &&
			armOne[4].includes('foo = "bar"') &&
			armOne[4].includes("classifier = false"),
		armOne[4],
	);
	check(
		"boundary: arm 2 is on with fanoutMax 2",
		armTwo[4].includes('fanout = "on"') &&
			armTwo[4].includes("fanoutMax = 2") &&
			!armTwo[4].includes("fanoutMax = 6"),
		armTwo[4],
	);
	check(
		"boundary: the temp work dirs are removed",
		calls.every((_, i) => !existsSync([armOne, armTwo][i][5])),
		calls,
	);
	check("boundary: the repo checkout is unchanged", (await status()) === before, await status());
}

function spawnStatus(): Promise<string> {
	return new Promise((done) => {
		const child = spawn("git", ["status", "--porcelain"], { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] });
		let text = "";
		child.stdout.on("data", (chunk) => {
			text += String(chunk);
		});
		child.on("close", () => done(text));
	});
}

async function caseBoundaryOutcomes() {
	const out = join(root, "out-outcomes");
	const result = await runDriver([
		"--tasks",
		"beta,gamma",
		"--arms",
		"1",
		"--reps",
		"1",
		"--timeout-s",
		"1",
		"--out",
		out,
	]);
	check("boundary: failed runs do not fail the sweep", result.code === 0, result);
	const runs = readJsonl(join(out, "runs.jsonl"));
	check(
		"boundary: a stub that outlives --timeout-s is killed and recorded as timeout",
		runs.find((r) => r.task === "beta")?.outcome === "timeout",
		runs,
	);
	check(
		"boundary: a stub that writes no row is recorded as no-row",
		runs.find((r) => r.task === "gamma")?.outcome === "no-row" && runs.every((r) => r.run === null),
		runs,
	);
	const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8")) as {
		arms: { timeouts: number; noRows: number; valid: number }[];
	};
	check(
		"boundary: the summary counts them as excluded",
		summary.arms[0].timeouts === 1 && summary.arms[0].noRows === 1 && summary.arms[0].valid === 0,
		summary,
	);
}

async function caseBoundaryTamper() {
	const out = join(root, "out-tamper");
	const result = await runDriver([
		"--tasks",
		"tgate,ttest,textra,tcreate,tnogate",
		"--arms",
		"1",
		"--reps",
		"1",
		"--out",
		out,
	]);
	check("boundary: a tampering sweep still exits 0", result.code === 0, result);
	const runs = readJsonl(join(out, "runs.jsonl"));
	const tamperedOf = (task: string) =>
		(runs.find((r) => r.task === task)?.tamperedFiles as string[] | undefined)?.join();
	check(
		"boundary: every tamper cell is a valid run",
		runs.length === 5 && runs.every((r) => r.outcome === "valid"),
		runs,
	);
	check("boundary: a rewritten .ledgerpi-gate is recorded", tamperedOf("tgate") === ".ledgerpi-gate", runs);
	check("boundary: a deleted test.mjs is recorded", tamperedOf("ttest") === "test.mjs", runs);
	check("boundary: a new extra test file is not flagged", tamperedOf("textra") === "", runs);
	check(
		"boundary: a .ledgerpi-gate created where the fixture had none is recorded",
		tamperedOf("tcreate") === ".ledgerpi-gate",
		runs,
	);
	check("boundary: a gate-less fixture left alone is not flagged", tamperedOf("tnogate") === "", runs);
	const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8")) as {
		arms: { valid: number; tampered: number; gatePassRate: number | null }[];
	};
	check(
		"boundary: summary.json excludes tampered passes from gatePassRate and counts them",
		summary.arms[0].valid === 5 && summary.arms[0].tampered === 3 && summary.arms[0].gatePassRate === 2 / 5,
		summary,
	);
}

async function caseBoundaryInterrupt() {
	const out = join(root, "out-interrupt");
	const pids = join(root, "stub-pids");
	const child = spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			runEntry,
			"--tasks",
			"beta",
			"--arms",
			"1",
			"--reps",
			"1",
			"--out",
			out,
		],
		{
			env: {
				...process.env,
				LEDGERPI_BENCH_PI: stubPi,
				LEDGERPI_BENCH_TASKS: tasksDir,
				LEDGERPI_CONFIG: liveConfig,
				LEDGERPI_STUB_SENTINEL: sentinel,
				LEDGERPI_STUB_LOG: stubLog,
				LEDGERPI_STUB_PIDS: pids,
			},
			stdio: "ignore",
		},
	);
	const closed = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
	for (let waited = 0; !existsSync(pids) && waited < 15_000; waited += 100) {
		await new Promise((resume) => setTimeout(resume, 100));
	}
	const [stubPid, stubDir] = existsSync(pids) ? readFileSync(pids, "utf8").trim().split(" ") : ["0", ""];
	child.kill("SIGTERM");
	const code = await closed;
	await new Promise((resume) => setTimeout(resume, 300));
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
		} catch {
			return false;
		}
		try {
			return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
		} catch {
			return true;
		}
	};
	check("boundary: an interrupted sweep exits 143 on SIGTERM", code === 143, code);
	check(
		"boundary: an interrupted sweep kills the running pi",
		Number(stubPid) > 0 && !alive(Number(stubPid)),
		stubPid,
	);
	check(
		"boundary: an interrupted sweep removes the run directory",
		stubDir !== "" && !existsSync(join(stubDir, "..")),
		stubDir,
	);
}

caseArgs();
caseConfig();
caseRows();
caseAuditContract();
caseSummary();
caseLabels();
caseRecommend();
caseRender();
caseCorpus();

setupBoundary();
try {
	await caseBoundaryRejections();
	await caseBoundaryRefusal();
	await caseBoundarySweep();
	await caseBoundaryOutcomes();
	await caseBoundaryTamper();
	await caseBoundaryInterrupt();
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
