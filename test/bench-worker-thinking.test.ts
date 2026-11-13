import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
	type ArmStats,
	armStats,
	attachSessionFailures,
	classifyRun,
	countLimitEvents,
	type RunClass,
	type RunResult,
	recommend,
	screenChallenger,
	type TranscriptRow,
} from "../bench/worker-thinking/analyze.ts";
import { auditRun } from "../packages/core/src/audit.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import type { LoopResult } from "../packages/core/src/loop.ts";
import { isAlive } from "../packages/core/src/proc.ts";

/**
 * Exercises the worker-thinking A/B harness at its boundaries: audit rows come from the
 * real `auditRun` writer, `finalize.ts` and `run.sh` are driven as CLIs, and every
 * classification, screen, and recommendation state is covered.
 */

const here = dirname(fileURLToPath(import.meta.url));
const bench = resolve(here, "..", "bench", "worker-thinking");

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
	if (!cond) failures++;
};

const root = mkdtempSync(join(tmpdir(), "ledgerpi-bench-test-"));
const configFile = join(root, "config.toml");
const auditLog = join(root, "fixture.jsonl");
writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], stateDir: join(root, "state"), auditLog }));
process.env.LEDGERPI_CONFIG = configFile;
delete process.env.LEDGERPI_STATE_DIR;
delete process.env.LEDGERPI_AUDIT_LOG;
process.env.LEDGERPI_AUDIT_SOURCE = "benchmark-thinking-test";
const cfg = loadConfig();

/** Writes one row through the real writer and returns it parsed. */
const writeRow = (converged: boolean, stop: LoopResult["stop"], detail?: LoopResult["stopDetail"]) => {
	const result: LoopResult = {
		converged,
		stop,
		stopDetail: detail,
		iters: 2,
		calls: 4,
		tokens: 100,
		gate: null,
		notes: "",
		tasks: [],
		managerModel: null,
		workerModel: null,
		planSource: "manager",
		timing: { managerMs: 0, workerMs: 0, gateMs: 0, managerCalls: 0, workerCalls: 0, gateRuns: 0 },
	};
	const meta = { entry: "command" as const, session: "s", provider: "local-router", model: "m", cwd: root };
	auditRun(cfg, meta, result, { task: "t", durationMs: 50, calls: 4, tokens: 100 });
	const rows = readFileSync(auditLog, "utf8").trim().split("\n");
	return JSON.parse(rows[rows.length - 1]);
};

const limitError = "run hit the output token limit before producing any text";
const limitRow: TranscriptRow = { role: "ledger-worker", ok: false, error: limitError };
const okWorker: TranscriptRow = { role: "ledger-worker", ok: true };
const green = { ran: true, passed: true };
const red = { ran: true, passed: false };

// --- Classification: one case per state, plus the ordering between them -----

check("source stamp reaches the row", writeRow(true, "done").source === "benchmark-thinking-test");
check("no row is harness-failed", classifyRun(null, [], green) === "harness-failed");
check(
	"a provider 429 ending the run is harness-failed",
	classifyRun(
		writeRow(false, "spawn-failure", "agent-error"),
		[{ role: "ledger-worker", ok: false, error: "429 rate limited" }],
		null,
	) === "harness-failed",
);
check(
	"a recovered 429 on a converged run does not exclude it",
	classifyRun(writeRow(true, "done"), [{ role: "ledger-manager", ok: false, error: "HTTP 429" }, okWorker], green) ===
		"converged-green",
);
check(
	"a recovered 429 then a budget stop is a real failure",
	classifyRun(writeRow(false, "budget"), [{ role: "ledger-worker", ok: false, error: "429 rate limited" }], red) ===
		"other-failed",
);
check(
	"a recovered 401 then a budget stop is a real failure",
	classifyRun(writeRow(false, "budget"), [{ role: "ledger-worker", ok: false, error: "401 invalid token" }], red) ===
		"other-failed",
);
for (const error of [
	"OpenAI API error (503): 503 upstream connect error or disconnect/reset before headers",
	"504 Gateway Timeout",
	"Stream ended without finish_reason",
	"fetch failed",
	"read ECONNRESET",
	"Aborted after 2 retry attempts",
	"OpenAI API error (401): 401 invalid token",
	"403 Forbidden",
	"Unauthorized",
]) {
	check(
		`a run ended by "${error}" is harness-failed`,
		classifyRun(
			writeRow(false, "spawn-failure", "agent-error"),
			[{ role: "ledger-worker", ok: false, error }],
			null,
		) === "harness-failed",
	);
}
check(
	"a request-queue timeout counts against the arm",
	classifyRun(
		writeRow(false, "spawn-failure", "agent-error"),
		[{ role: "ledger-worker", ok: false, error: '503: {"type":"request_queue_timeout"}' }],
		null,
	) === "other-failed",
);
const workerDeath: TranscriptRow = { t: 100_000, role: "ledger-worker", ok: false, error: null };
const joined = attachSessionFailures(
	[okWorker, workerDeath, { ...workerDeath, t: 300_000 }, limitRow],
	[{ t: 99_900, error: "429 too many tokens" }],
);
check("a worker death takes the error its session closed on", joined[1].error === "429 too many tokens");
check("a failure outside the join window stays blank", joined[2].error === null);
const twoSessions = [
	{ t: 99_000, error: "old session error" },
	{ t: 99_900, error: "nearest session error" },
];
check(
	"a worker death takes the nearest preceding session error whatever the array order",
	attachSessionFailures([workerDeath], twoSessions)[0].error === "nearest session error" &&
		attachSessionFailures([workerDeath], [...twoSessions].reverse())[0].error === "nearest session error",
);
check("a recorded error is left alone", joined[3].error === limitError);
check(
	"a worker death on a provider error is harness-failed once joined",
	classifyRun(writeRow(false, "spawn-failure", "agent-error"), joined.slice(0, 2), null) === "harness-failed",
);
check("stop=aborted is aborted", classifyRun(writeRow(false, "aborted"), [], null) === "aborted");
check(
	"a limit failure stays limit-failed even with a green gate",
	classifyRun(writeRow(false, "spawn-failure", "agent-error"), [okWorker, limitRow, limitRow], green) ===
		"limit-failed",
);
check(
	"a recovered limit event then a budget stop is other-failed",
	classifyRun(
		writeRow(false, "budget"),
		[limitRow, okWorker, { role: "ledger-worker", ok: false, error: "timeout" }],
		red,
	) === "other-failed",
);
check(
	"budget with no failures is other-failed",
	classifyRun(writeRow(false, "budget"), [okWorker], red) === "other-failed",
);
check("converged with no gate is unverified", classifyRun(writeRow(true, "done"), [okWorker], null) === "unverified");
check(
	"converged with a gate that never ran is unverified",
	classifyRun(writeRow(true, "done"), [okWorker], { ran: false, passed: false }) === "unverified",
);
check(
	"converged with a red gate is converged-red",
	classifyRun(writeRow(true, "done"), [okWorker], red) === "converged-red",
);
check(
	"converged with a green gate is converged-green",
	classifyRun(writeRow(true, "done"), [okWorker], green) === "converged-green",
);

const counted = countLimitEvents([limitRow, okWorker, { role: "ledger-manager", ok: false, error: limitError }]);
check(
	"limit events count workers only",
	counted.limitEvents === 1 && counted.workerCalls === 2,
	JSON.stringify(counted),
);

// --- Arm stats and decisions ------------------------------------------------

const result = (runId: string, arm: string, cls: RunClass, limitEvents = 0): RunResult => ({
	runId,
	arm,
	task: "t",
	rep: 1,
	attempts: 1,
	class: cls,
	stop: "done",
	lastFailure: null,
	limitEvents,
	workerCalls: 5,
	tokens: 1000,
	durationMs: 10,
	diffStat: "",
	finalGate: green,
});

const stats = armStats(
	"a",
	[
		result("1", "a", "converged-green", 1),
		result("2", "a", "limit-failed", 2),
		result("3", "a", "harness-failed", 9),
		result("4", "b", "converged-green"),
	],
	{ "1": { score: 8, blockers: 0, shouldFix: 0 }, "3": { score: 1, blockers: 0, shouldFix: 0 } },
);
check(
	"excluded runs count toward nothing but excluded",
	stats.runs === 3 &&
		stats.excluded === 1 &&
		stats.classified === 2 &&
		stats.scored === 1 &&
		stats.stops.done === 2 &&
		stats.limitEvents === 3 &&
		stats.meanScore === 8,
	JSON.stringify(stats),
);

const nullScored = armStats(
	"a",
	[result("1", "a", "converged-green"), result("2", "a", "converged-green"), result("3", "a", "converged-green")],
	{
		"1": { score: 8, blockers: 0, shouldFix: 0 },
		"2": { score: null as unknown as number, blockers: 0, shouldFix: 0 },
		"3": { score: "7" as unknown as number, blockers: 0, shouldFix: 0 },
	},
);
check(
	"a null or string score is not counted as scored",
	nullScored.scored === 1 && nullScored.meanScore === 8,
	JSON.stringify(nullScored),
);

const arm = (name: string, over: Partial<ArmStats>): ArmStats => ({
	arm: name,
	runs: 12,
	excluded: 0,
	classified: 12,
	scored: 12,
	green: 10,
	limitEvents: 4,
	workerCalls: 40,
	limitRate: 0.1,
	meanScore: 7,
	tokens: 1000,
	durationMs: 1,
	classes: {},
	stops: {},
	...over,
});
const base = arm("base", {});

check("screen: equal quality goes forward", screenChallenger(base, arm("c", {})) === "forward");
check("screen: one fewer green goes forward", screenChallenger(base, arm("c", { green: 9 })) === "forward");
check("screen: two fewer green is eliminated", screenChallenger(base, arm("c", { green: 8 })) === "eliminated");
check("screen: score 1.4 lower goes forward", screenChallenger(base, arm("c", { meanScore: 5.6 })) === "forward");
check("screen: score 1.5 lower is eliminated", screenChallenger(base, arm("c", { meanScore: 5.5 })) === "eliminated");
check("screen: unscored runs fall back to green", screenChallenger(base, arm("c", { meanScore: null })) === "forward");

const better = { limitEvents: 1, limitRate: 0.025 };
check(
	"recommend: a thin arm is inconclusive",
	recommend(base, [arm("c", { ...better, classified: 9 })]).state === "inconclusive",
);
check(
	"recommend: a baseline with no limit events is inconclusive",
	recommend(arm("base", { limitEvents: 0, limitRate: 0 }), [arm("c", better)]).state === "inconclusive",
);
check(
	"recommend: no quality data is inconclusive",
	recommend(arm("base", { meanScore: null, scored: 0 }), [arm("c", { ...better, meanScore: null, scored: 0 })])
		.state === "inconclusive",
);
check(
	"recommend: a partly scored arm is inconclusive",
	recommend(base, [arm("c", { ...better, scored: 11 })]).state === "inconclusive",
);
const adopted = recommend(base, [arm("c", better)]);
check("recommend: a clean win adopts", adopted.state === "adopt" && adopted.arm === "c", JSON.stringify(adopted));
check("recommend: an equal limit rate keeps baseline", recommend(base, [arm("c", {})]).state === "keep-baseline");
check(
	"recommend: fewer green keeps baseline",
	recommend(base, [arm("c", { ...better, green: 9 })]).state === "keep-baseline",
);
check(
	"recommend: a score 0.6 lower keeps baseline",
	recommend(base, [arm("c", { ...better, meanScore: 6.4 })]).state === "keep-baseline",
);
check(
	"recommend: a score 0.5 lower still adopts",
	recommend(base, [arm("c", { ...better, meanScore: 6.5 })]).state === "adopt",
);
const higher = recommend(base, [arm("c", better), arm("d", { ...better, meanScore: 8 })]);
check("recommend: higher score wins a tie", higher.state === "adopt" && higher.arm === "d", JSON.stringify(higher));
const cheaper = recommend(base, [arm("c", better), arm("d", { ...better, tokens: 500 })]);
check(
	"recommend: fewer tokens breaks an equal score",
	cheaper.state === "adopt" && cheaper.arm === "d",
	JSON.stringify(cheaper),
);

// --- finalize.ts against a real repository ----------------------------------

const repo = join(root, "repo");
mkdirSync(repo);
const git = (...args: string[]) =>
	execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
git("init", "--quiet");
writeFileSync(join(repo, "tracked.txt"), "one\n");
git("add", ".");
git("commit", "--quiet", "-m", "base");
const baseSha = git("rev-parse", "HEAD");

const finalize = (
	name: string,
	gate: string,
	rows: readonly object[],
	transcript: readonly TranscriptRow[],
	...extra: string[]
) => {
	const dir = join(root, name);
	mkdirSync(join(dir, "state", "session", "ledger"), { recursive: true });
	writeFileSync(join(dir, "runs.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
	writeFileSync(
		join(dir, "state", "session", "ledger", "transcript.jsonl"),
		`${transcript.map((r) => JSON.stringify(r)).join("\n")}\n{"truncated`,
	);
	const out = execFileSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			join(bench, "finalize.ts"),
			...["--dir", dir, "--repo", repo, "--base", baseSha, "--gate", gate, "--gate-timeout-ms", "500"],
			...["--run-id", "r", "--arm", "a", "--task", "t", "--rep", "1", "--attempt", "1", ...extra],
		],
		{ encoding: "utf8" },
	).trim();
	return { out, dir, attempt: JSON.parse(readFileSync(join(dir, "attempt.json"), "utf8")) as RunResult };
};

writeFileSync(join(repo, "tracked.txt"), "two\n");
writeFileSync(join(repo, "added.txt"), "new\n");
git("add", "tracked.txt");
git("commit", "--quiet", "-m", "a commit made by the worker");
const passed = finalize("pass", "true", [writeRow(true, "done")], [okWorker, limitRow]);
check("finalize prints the class", passed.out === "converged-green", passed.out);
check(
	"finalize records counts and tokens from a truncated transcript",
	passed.attempt.limitEvents === 1 && passed.attempt.workerCalls === 2 && passed.attempt.tokens === 100,
	JSON.stringify(passed.attempt),
);
const patch = readFileSync(join(passed.dir, "diff.patch"), "utf8");
check(
	"the diff folds worker commits and untracked files onto the base",
	patch.includes("+two") && patch.includes("+new"),
	patch,
);
check("the diff stat comes through", passed.attempt.diffStat.includes("tracked.txt"), passed.attempt.diffStat);

const failed = finalize("fail", "false", [writeRow(true, "done")], [okWorker]);
check("a failing final gate overrides a converged row", failed.attempt.class === "converged-red", failed.attempt.class);
const noRow = finalize("norow", "true", [], []);
check(
	"a run with no audit row finalizes as harness-failed",
	noRow.attempt.class === "harness-failed",
	noRow.attempt.class,
);

const timedOut = finalize("timeout", "sleep 5", [writeRow(true, "done")], [okWorker]);
check("a timed-out final gate is unverified, not red", timedOut.attempt.class === "unverified", timedOut.attempt.class);
const patchBeforeRetry = readFileSync(join(timedOut.dir, "diff.patch"), "utf8");
const retried = finalize("timeout", "true", [writeRow(true, "done")], [okWorker], "--reuse-diff");
check("a gate retry reclassifies the run", retried.attempt.class === "converged-green", retried.attempt.class);
check(
	"a gate retry leaves the diff alone",
	readFileSync(join(timedOut.dir, "diff.patch"), "utf8") === patchBeforeRetry && patchBeforeRetry.includes("+two"),
);
check(
	"a passing gate writes no placeholder text",
	!readFileSync(join(passed.dir, "final-gate.txt"), "utf8").includes("undefined"),
);

const forced = finalize("forced", "false", [writeRow(true, "done")], [okWorker], "--harness-failure", "setup failed");
check(
	"--harness-failure records the reason and skips the gate",
	forced.attempt.class === "harness-failed" &&
		forced.attempt.lastFailure === "setup failed" &&
		forced.attempt.finalGate === null &&
		!existsSync(join(forced.dir, "final-gate.txt")),
	JSON.stringify(forced.attempt),
);

const sessionsRoot = join(root, "sessions");
const sessionDir = join(sessionsRoot, `--${repo.slice(1).replaceAll("/", "-")}--`);
mkdirSync(sessionDir, { recursive: true });
const failedAt = Date.now();
writeFileSync(
	join(sessionDir, "worker.jsonl"),
	[
		{ type: "message", message: { role: "assistant", stopReason: "toolUse", timestamp: failedAt - 2000 } },
		{
			type: "message",
			message: { role: "assistant", stopReason: "error", errorMessage: "503 overloaded", timestamp: failedAt },
		},
	]
		.map((e) => JSON.stringify(e))
		.join("\n"),
);
const died = finalize(
	"died",
	"false",
	[writeRow(false, "spawn-failure", "agent-error")],
	[{ t: failedAt + 100, role: "ledger-worker", ok: false, error: null }],
	"--sessions",
	sessionsRoot,
);
check(
	"finalize reads a blank worker failure from its session",
	died.attempt.class === "harness-failed" && died.attempt.lastFailure === "503 overloaded",
	JSON.stringify(died.attempt),
);

// --- run.sh argument handling and ordering, with no pi launch ---------------

const runSh = (...args: string[]) =>
	spawnSync("bash", [join(bench, "run.sh"), ...args], { encoding: "utf8", env: { ...process.env, AB_ROOT: root } });

for (const [label, args] of [
	["no args", []],
	["an unknown flag", ["--stage", "1", "--nope"]],
	["an invalid stage", ["--stage", "3"]],
	["a flag missing its value", ["--stage"]],
	["a non-numeric seed", ["--stage", "1", "--seed", "x"]],
	["zero reps", ["--stage", "1", "--reps", "0"]],
	["an unknown arm", ["--stage", "1", "--arms", "nope", "--dry-run"]],
	["an unknown task", ["--stage", "1", "--tasks", "nope", "--dry-run"]],
] as const) {
	const r = runSh(...args);
	check(`run.sh rejects ${label}`, r.status === 2 && r.stderr.includes("usage:"), `${r.status} ${r.stderr}`);
}

for (const [label, concurrency, args] of [
	["a zero concurrency", "0", ["--stage", "2", "--dry-run"]],
	["a non-numeric concurrency", "x", ["--stage", "2", "--dry-run"]],
	["a concurrency above 1 with cerebras arms", "2", ["--stage", "1", "--dry-run"]],
] as const) {
	const r = spawnSync("bash", [join(bench, "run.sh"), ...args], {
		encoding: "utf8",
		env: { ...process.env, AB_ROOT: root, AB_CONCURRENCY: concurrency },
	});
	check(`run.sh rejects ${label}`, r.status === 2 && r.stderr.includes("usage:"), `${r.status} ${r.stderr}`);
}
for (const [label, name, value] of [
	["a non-numeric cerebras token limit", "AB_CEREBRAS_TOKEN_LIMIT", "23M"],
	["a non-numeric harness-failure streak", "AB_MAX_HARNESS_FAILURES", "three"],
	["a zero harness-failure streak", "AB_MAX_HARNESS_FAILURES", "0"],
] as const) {
	const r = spawnSync("bash", [join(bench, "run.sh"), "--stage", "2", "--dry-run"], {
		encoding: "utf8",
		env: { ...process.env, AB_ROOT: root, [name]: value },
	});
	check(`run.sh rejects ${label}`, r.status === 2 && r.stderr.includes("usage:"), `${r.status} ${r.stderr}`);
}
const serialCerebras = spawnSync("bash", [join(bench, "run.sh"), "--stage", "1", "--dry-run"], {
	encoding: "utf8",
	env: { ...process.env, AB_ROOT: root, AB_CONCURRENCY: "1" },
});
check("a concurrency of 1 still accepts cerebras arms", serialCerebras.status === 0, serialCerebras.stderr);

const stage1 = runSh("--stage", "1", "--dry-run");
const lines = stage1.stdout.trim().split("\n");
check("stage 1 is 3 arms x 4 incident tasks x 1 rep", stage1.status === 0 && lines.length === 12, stage1.stdout);
check(
	"stage 1 uses cerebras arms only",
	lines.every((l) => l.startsWith("c-")),
	stage1.stdout,
);
check("stage 1 leaves out control tasks", !stage1.stdout.includes("control-1"), stage1.stdout);
check("the order is reproducible for a seed", runSh("--stage", "1", "--dry-run").stdout === stage1.stdout);
check("the seed changes the order", runSh("--stage", "1", "--seed", "27", "--dry-run").stdout !== stage1.stdout);

const stage2 = runSh("--stage", "2", "--arms", "b-high-32k,b-high-65k", "--dry-run");
const stage2Lines = stage2.stdout.trim().split("\n");
check("stage 2 with one challenger is 24 runs", stage2.status === 0 && stage2Lines.length === 24, stage2.stdout);
check(
	"each rep is one complete block",
	stage2Lines.slice(0, 12).every((l) => l.endsWith(" 1")) && stage2Lines.slice(12).every((l) => l.endsWith(" 2")),
	stage2.stdout,
);

// --- The cerebras budget counts billed tokens, cached input included ----------

const budgetRoot = join(root, "budget");
const sessions = join(budgetRoot, "agents", "c-high-32k", "sessions", "attempt");
mkdirSync(sessions, { recursive: true });
mkdirSync(join(budgetRoot, "runs"), { recursive: true });
writeFileSync(
	join(sessions, "s.jsonl"),
	[
		'{"message":{"provider":"cerebras","usage":{"input":100,"cacheRead":800,"output":100}}}',
		'{"message":{"provider":"ollama-cloud","usage":{"input":100000,"cacheRead":100000,"output":100000}}}',
		'{"message":{"role":"user"}}',
		'{"message":{"provider":"cerebras","usage":{"inp',
	].join("\n"),
);
const stubBin = join(root, "bin");
mkdirSync(stubBin);
writeFileSync(
	join(stubBin, "pi"),
	[
		"#!/bin/sh",
		'echo launched >>"$STUB_PI_LOG"',
		'[ -z "$STUB_PI_SCRIPT" ] || . "$STUB_PI_SCRIPT"',
		"echo change >worker-change.txt",
		'echo \'{"event":"run","converged":true,"stop":"done","tokens":10,"durationMs":5}\' >>"$LEDGERPI_AUDIT_LOG"',
	].join("\n"),
	{ mode: 0o755 },
);
writeFileSync(join(stubBin, "claude"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });

const liveDir = join(root, "live-agent");
const fixtureModels = [
	{ id: "qwen3.8-27b", maxTokens: 32768 },
	{ id: "qwen3.8-27b-other", maxTokens: 32768 },
];
const models = {
	providers: {
		"local-router": { models: fixtureModels },
		cerebras: { models: [{ id: "qwen-3.8-27b", maxTokens: 32768 }] },
	},
};
mkdirSync(liveDir);
writeFileSync(join(liveDir, "models.json"), JSON.stringify(models));
writeFileSync(join(liveDir, "settings.json"), JSON.stringify({ packages: [] }));
const budgetRun = (limit: string, ...args: string[]) =>
	spawnSync("bash", [join(bench, "run.sh"), ...(args.length > 0 ? args : ["--stage", "1"])], {
		encoding: "utf8",
		env: {
			...process.env,
			AB_ROOT: budgetRoot,
			AB_CEREBRAS_TOKEN_LIMIT: limit,
			AB_CODE_DIR: join(root, "no-such-code-dir"),
			AB_LIVE_AGENT_DIR: liveDir,
			STUB_PI_LOG: join(root, "budget-pi.log"),
			CEREBRAS_API_KEY: "test",
			PATH: `${stubBin}:${process.env.PATH}`,
		},
	});
const stopped = budgetRun("1000");
check(
	"run.sh refuses a cerebras run once billed tokens, cached input included, reach the limit",
	stopped.status === 3 && stopped.stderr.includes("1000 >= 1000"),
	`${stopped.status} ${stopped.stderr}`,
);
const underLimit = budgetRun("1001");
check(
	"other providers do not count toward the cerebras limit",
	underLimit.status === 4,
	`${underLimit.status} ${underLimit.stderr}`,
);

const routerArm = budgetRun("1", "--stage", "2", "--arms", "b-high-32k");
check(
	"the cerebras limit does not block local-router arms",
	routerArm.status === 4,
	`${routerArm.status} ${routerArm.stderr}`,
);

// --- run.sh driving a stub pi against a real clone ----------------------------

const codeDir = join(root, "code");
mkdirSync(codeDir);
execFileSync("git", ["clone", "--quiet", repo, join(codeDir, "fixture")]);
const fixtureTask = (id: string, over: object = {}) => ({
	id,
	kind: "incident",
	repo: "fixture",
	base: baseSha,
	branch: "bench-branch",
	originalCwd: "/original/cwd",
	ledgerDir: "stored",
	gate: "true",
	...over,
});
mkdirSync(join(liveDir, "ledgerpi", "stored"), { recursive: true });
writeFileSync(join(liveDir, "ledgerpi", "stored", "task.md"), "work in /original/cwd\n");
mkdirSync(join(liveDir, "ledgerpi", "blank"));
writeFileSync(join(liveDir, "ledgerpi", "blank", "task.md"), "");
const gateMarker = join(root, "gate-ran-once");
const tasksFile = join(root, "tasks.json");
writeFileSync(
	tasksFile,
	JSON.stringify({
		tasks: [
			fixtureTask("ok"),
			fixtureTask("slow-gate", { gate: `[ -f ${gateMarker} ] || { touch ${gateMarker}; sleep 5; }` }),
			fixtureTask("bad-setup", { setup: "exit 1" }),
			fixtureTask("bad-base", { base: "0000000000000000000000000000000000000000" }),
			fixtureTask("no-task-md", { ledgerDir: "missing" }),
			fixtureTask("empty-task-md", { ledgerDir: "blank" }),
			fixtureTask("after-failures"),
			fixtureTask("auth-a"),
			fixtureTask("auth-b"),
		],
	}),
);
const armsFile = join(root, "arms.json");
const fixtureArm = (id: string, worker: string) => ({
	id,
	stage: 2,
	worker,
	thinking: "high",
	maxTokens: 65536,
});
writeFileSync(
	armsFile,
	JSON.stringify({
		manager: "stub/manager",
		callTimeoutMs: 1000,
		gateTimeoutMs: 500,
		arms: [fixtureArm("b-test", "local-router/qwen3.8-27b"), fixtureArm("b-unknown", "local-router/no-such-model")],
	}),
);
const piLog = join(root, "stub-pi.log");
const piLaunches = () => (existsSync(piLog) ? readFileSync(piLog, "utf8").trim().split("\n").length : 0);
const stubArgs = (tasks: string, armId: string) => [
	join(bench, "run.sh"),
	"--stage",
	"2",
	"--arms",
	armId,
	"--tasks",
	tasks,
	"--reps",
	"1",
];
const stubEnv = (abRoot: string, env: Record<string, string>) => ({
	...process.env,
	AB_ROOT: abRoot,
	AB_CODE_DIR: codeDir,
	AB_LIVE_AGENT_DIR: liveDir,
	AB_ARMS_FILE: armsFile,
	AB_TASKS_FILE: tasksFile,
	STUB_PI_LOG: piLog,
	PATH: `${stubBin}:${process.env.PATH}`,
	AB_INSTALL_DIR: "",
	AB_EXTRA_AGENT_ENTRIES: "",
	...env,
});
const stubRun = (name: string, tasks: string, env: Record<string, string> = {}, armId = "b-test") => {
	rmSync(piLog, { force: true });
	const abRoot = join(root, name);
	const r = spawnSync("bash", stubArgs(tasks, armId), { encoding: "utf8", env: stubEnv(abRoot, env) });
	const resultPath = (task: string) => join(abRoot, "runs", `${armId}__${task}__r1`, "result.json");
	const resultOf = (task: string) => JSON.parse(readFileSync(resultPath(task), "utf8")) as RunResult;
	return { r, abRoot, resultPath, resultOf };
};

const okRun = stubRun("stub-ok", "ok");
check(
	"a stub run finishes green",
	okRun.r.status === 0 && okRun.resultOf("ok").class === "converged-green",
	okRun.r.stderr,
);
check(
	"the arm's cap reaches its agent dir",
	JSON.parse(readFileSync(join(okRun.abRoot, "agents", "b-test", "models.json"), "utf8")).providers["local-router"]
		.models[0].maxTokens === 65536,
);
const generatedConfig = (run: { abRoot: string }) =>
	parseToml(readFileSync(join(run.abRoot, "runs", "b-test__ok__r1", "attempt-1", "config.toml"), "utf8")) as {
		providers: string[];
		allowlist: Record<string, string[]>;
	};
const armsWithManager = (name: string, manager: string, worker: string) => {
	const file = join(root, `${name}-arms.json`);
	writeFileSync(
		file,
		JSON.stringify({ manager, callTimeoutMs: 1000, gateTimeoutMs: 500, arms: [fixtureArm("b-test", worker)] }),
	);
	return file;
};
const okConfig = generatedConfig(okRun);
check(
	"the generated config's providers follow the manager and worker in the arms file",
	JSON.stringify(okConfig.providers) === JSON.stringify(["stub", "local-router"]) &&
		JSON.stringify(okConfig.allowlist) === JSON.stringify({ stub: ["manager"] }),
	JSON.stringify(okConfig),
);
const otherRun = stubRun("stub-other-providers", "ok", {
	AB_ARMS_FILE: armsWithManager("other", "ollama-cloud/vendor-model:tag/1", "local-router/qwen3.8-27b"),
});
const otherConfig = generatedConfig(otherRun);
check(
	"a different manager provider and model reach the providers and allowlist",
	otherRun.r.status === 0 &&
		JSON.stringify(otherConfig.providers) === JSON.stringify(["ollama-cloud", "local-router"]) &&
		JSON.stringify(otherConfig.allowlist) === JSON.stringify({ "ollama-cloud": ["vendor-model:tag/1"] }),
	`${otherRun.r.stderr} ${JSON.stringify(otherConfig)}`,
);
const sameRun = stubRun("stub-same-provider", "ok", {
	AB_ARMS_FILE: armsWithManager("same", "local-router/manager-model", "local-router/qwen3.8-27b"),
});
const sameConfig = generatedConfig(sameRun);
check(
	"a manager and worker on one provider list it once",
	sameRun.r.status === 0 &&
		JSON.stringify(sameConfig.providers) === JSON.stringify(["local-router"]) &&
		JSON.stringify(sameConfig.allowlist) === JSON.stringify({ "local-router": ["manager-model"] }),
	`${sameRun.r.stderr} ${JSON.stringify(sameConfig)}`,
);
for (const [label, manager] of [
	["a missing manager", ""],
	["a manager with no provider prefix", "just-a-model"],
	["a manager with no model", "provider/"],
] as const) {
	const bad = stubRun(`stub-bad-manager-${label.replaceAll(" ", "-")}`, "ok", {
		AB_ARMS_FILE: armsWithManager(`bad-${label.replaceAll(" ", "-")}`, manager, "local-router/qwen3.8-27b"),
	});
	check(
		`${label} in the arms file exits 2 before any run`,
		bad.r.status === 2 && bad.r.stderr.includes("manager") && !existsSync(join(bad.abRoot, "runs")),
		`${bad.r.status} ${bad.r.stderr}`,
	);
}
check(
	"task paths are rewritten to the clone",
	readFileSync(join(okRun.abRoot, "runs", "b-test__ok__r1", "attempt-1", "task.md"), "utf8").includes(
		"attempt-1/repo",
	),
);

const slowGate = stubRun("stub-slow-gate", "slow-gate");
check(
	"a timed-out final gate retries and can still go green",
	slowGate.r.status === 0 && slowGate.resultOf("slow-gate").class === "converged-green" && piLaunches() === 1,
	slowGate.r.stderr,
);

const resumeRoot = join(root, "stub-resume");
const resumedResult = join(resumeRoot, "runs", "b-test__ok__r1", "result.json");
mkdirSync(join(resumeRoot, "runs", "b-test__ok__r1"), { recursive: true });
writeFileSync(resumedResult, JSON.stringify({ class: "converged-green", attempts: 1, marker: "kept" }));
rmSync(piLog, { force: true });
const resumed = spawnSync("bash", stubArgs("ok,slow-gate", "b-test"), {
	encoding: "utf8",
	env: stubEnv(resumeRoot, {}),
});
check(
	"a rerun skips a run that already has a result.json and finishes the rest",
	resumed.status === 0 &&
		resumed.stdout.includes("skip  b-test__ok__r1") &&
		JSON.parse(readFileSync(resumedResult, "utf8")).marker === "kept" &&
		existsSync(join(resumeRoot, "runs", "b-test__slow-gate__r1", "result.json")) &&
		piLaunches() === 1,
	`${resumed.status} ${resumed.stdout} ${resumed.stderr} ${piLaunches()}`,
);

const orphanRoot = join(root, "stub-orphan");
const orphanDir = join(orphanRoot, "runs", "b-test__ok__r1", "attempt-1");
const orphan = spawn("bash", ["-c", "sleep 300; :", orphanDir], { stdio: "ignore", detached: true });
await new Promise((r) => setTimeout(r, 300));
rmSync(piLog, { force: true });
const blocked = spawnSync("bash", stubArgs("ok", "b-test"), { encoding: "utf8", env: stubEnv(orphanRoot, {}) });
const blockedResult = existsSync(join(orphanRoot, "runs", "b-test__ok__r1", "result.json"));
process.kill(-(orphan.pid as number), "SIGKILL");
const unblocked = spawnSync("bash", stubArgs("ok", "b-test"), { encoding: "utf8", env: stubEnv(orphanRoot, {}) });
check(
	"a rerun refuses to start while a process from an earlier job still references the run",
	blocked.status === 5 &&
		blocked.stderr.includes("still references") &&
		!blockedResult &&
		unblocked.status === 0 &&
		existsSync(join(orphanRoot, "runs", "b-test__ok__r1", "result.json")),
	`${blocked.status} ${blocked.stderr} ${unblocked.status} ${unblocked.stderr}`,
);

for (const task of ["bad-setup", "bad-base", "no-task-md", "empty-task-md"]) {
	const run = stubRun(`stub-${task}`, task);
	const attempt = run.resultOf(task);
	check(
		`${task} is harness-failed after one rerun and never launches pi`,
		run.r.status === 0 && attempt.class === "harness-failed" && attempt.attempts === 2 && piLaunches() === 0,
		`${run.r.status} ${JSON.stringify(attempt)} ${run.r.stderr}`,
	);
	check(`${task} records why`, attempt.lastFailure === "setup failed", JSON.stringify(attempt));
}

const crashScript = join(root, "drop-git.sh");
writeFileSync(crashScript, "rm -rf .git\n");
const crashed = stubRun("stub-crash", "ok,after-failures", { STUB_PI_SCRIPT: crashScript });
check(
	"a finalize crash is recorded and the queue continues",
	crashed.r.status === 0 &&
		crashed.resultOf("ok").class === "harness-failed" &&
		crashed.resultOf("ok").lastFailure === "finalize crashed" &&
		crashed.resultOf("after-failures").class === "harness-failed",
	`${crashed.r.status} ${crashed.r.stderr}`,
);

const outage = stubRun("stub-outage", "bad-setup,bad-base,no-task-md,after-failures");
const outageResults = ["bad-setup", "bad-base", "no-task-md", "after-failures"].filter((t) =>
	existsSync(outage.resultPath(t)),
);
check(
	"three harness failures in a row stop the job and stay resumable",
	outage.r.status === 4 && piLaunches() <= 1 && outageResults.length <= 1 && outage.r.stderr.includes("in a row"),
	`${outage.r.status} ${outageResults} ${outage.r.stderr}`,
);

const authScript = join(root, "auth-outage.sh");
writeFileSync(
	authScript,
	[
		'mkdir -p "$LEDGERPI_STATE_DIR/session/ledger"',
		`echo '{"t":1,"role":"ledger-worker","ok":false,"error":"OpenAI API error (401): 401 invalid token"}' >"$LEDGERPI_STATE_DIR/session/ledger/transcript.jsonl"`,
		`echo '{"event":"run","converged":false,"stop":"spawn-failure","tokens":0,"durationMs":5}' >>"$LEDGERPI_AUDIT_LOG"`,
		"exit 0",
	].join("\n"),
);
const authTasks = ["ok", "after-failures", "auth-a", "auth-b"];
const authOutage = stubRun("stub-auth-outage", authTasks.join(","), { STUB_PI_SCRIPT: authScript });
const authResults = authTasks.filter((t) => existsSync(authOutage.resultPath(t)));
check(
	"an authentication outage is harness-failed and stops the job without a streak result",
	authOutage.r.status === 4 && authResults.length === 0 && authOutage.r.stderr.includes("in a row"),
	`${authOutage.r.status} ${authResults} ${authOutage.r.stdout} ${authOutage.r.stderr}`,
);

const vanishScript = join(root, "vanish.sh");
writeFileSync(vanishScript, ['rm -rf "$(dirname "$LEDGERPI_STATE_DIR")"', "exit 0"].join("\n"));
const vanishTasks = ["ok", "after-failures", "auth-a"];
const vanished = stubRun("stub-vanished", vanishTasks.join(","), { STUB_PI_SCRIPT: vanishScript });
const vanishedResults = vanishTasks.filter((t) => existsSync(vanished.resultPath(t)));
check(
	"a run that dies without a result.json counts as harness-failed and joins the streak",
	vanished.r.status === 4 &&
		vanishedResults.length === 0 &&
		vanished.r.stdout.split("attempts=unknown").length === 4 &&
		vanished.r.stderr.includes("in a row"),
	`${vanished.r.status} ${vanishedResults} ${vanished.r.stdout} ${vanished.r.stderr}`,
);

check(
	"order.log records a concurrency of 1 by default",
	readFileSync(join(okRun.abRoot, "order.log"), "utf8").split("\n")[0].includes(" concurrency=1 "),
);
const installRun = (installDir?: string) =>
	stubRun(
		`stub-install-${installDir ? "override" : "default"}`,
		"ok",
		installDir ? { AB_INSTALL_DIR: installDir } : {},
	);
const orderHeader = (run: { abRoot: string }) => readFileSync(join(run.abRoot, "order.log"), "utf8").split("\n")[0];
const repoRootHead = (() => {
	try {
		return execFileSync("git", ["-C", resolve(bench, "..", ".."), "rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "unknown";
	}
})();
check(
	"order.log records the install revision of the repo containing run.sh by default",
	orderHeader(installRun()).includes(` ledgerpi=${repoRootHead} `),
);
check("AB_INSTALL_DIR overrides the install revision", orderHeader(installRun(repo)).includes(` ledgerpi=${baseSha} `));

writeFileSync(join(liveDir, "extra-entry"), "extra");
const extraRun = stubRun("stub-extra-entries", "ok", { AB_EXTRA_AGENT_ENTRIES: "extra-entry missing-entry" });
const extraAgentDir = join(extraRun.abRoot, "agents", "b-test");
check(
	"AB_EXTRA_AGENT_ENTRIES links each listed entry that exists in the live agent dir",
	extraRun.r.status === 0 && readFileSync(join(extraAgentDir, "extra-entry"), "utf8") === "extra",
	extraRun.r.stderr,
);
check(
	"AB_EXTRA_AGENT_ENTRIES skips a listed entry the live agent dir lacks",
	!existsSync(join(extraAgentDir, "missing-entry")),
);
check(
	"an agent dir has no extra entry when AB_EXTRA_AGENT_ENTRIES is unset",
	!existsSync(join(stubRun("stub-no-extra-entries", "ok").abRoot, "agents", "b-test", "extra-entry")),
);
const liveModels = readFileSync(join(liveDir, "models.json"), "utf8");
for (const entry of ["models.json", "settings.json", "sessions", "..", "nested/entry"]) {
	const reserved = stubRun(`stub-reserved-extra-${entry.replace(/\W/g, "-")}`, "ok", {
		AB_EXTRA_AGENT_ENTRIES: entry,
	});
	check(
		`AB_EXTRA_AGENT_ENTRIES refuses ${entry} with exit 2 before any run`,
		reserved.r.status === 2 &&
			reserved.r.stderr.includes("AB_EXTRA_AGENT_ENTRIES") &&
			!existsSync(join(reserved.abRoot, "runs")),
		`${reserved.r.status} ${reserved.r.stderr}`,
	);
}
check(
	"a refused extra entry leaves the live models.json untouched",
	readFileSync(join(liveDir, "models.json"), "utf8") === liveModels,
);

const barrierScript = join(root, "barrier.sh");
writeFileSync(
	barrierScript,
	[
		'mkdir -p "$STUB_BARRIER_DIR/arrived" "$STUB_BARRIER_DIR/live"',
		'touch "$STUB_BARRIER_DIR/arrived/$$" "$STUB_BARRIER_DIR/live/$$"',
		`trap 'rm -f "$STUB_BARRIER_DIR/live/$$"' EXIT`,
		'ls "$STUB_BARRIER_DIR/live" | wc -l >>"$STUB_BARRIER_DIR/highwater.log"',
		"waited=0",
		'while [ "$(ls "$STUB_BARRIER_DIR/arrived" | wc -l)" -lt 2 ] && [ "$waited" -lt 100 ]; do',
		"\tsleep 0.1",
		"\twaited=$((waited + 1))",
		"done",
		'sleep "$STUB_HOLD"',
	].join("\n"),
);
const highWater = (dir: string) =>
	existsSync(join(dir, "highwater.log"))
		? Math.max(0, ...readFileSync(join(dir, "highwater.log"), "utf8").trim().split("\n").map(Number))
		: 0;

const barrierDir = join(root, "barrier-a");
const parallel = stubRun("stub-parallel", "ok,after-failures,auth-a", {
	AB_CONCURRENCY: "2",
	STUB_PI_SCRIPT: barrierScript,
	STUB_BARRIER_DIR: barrierDir,
	STUB_HOLD: "1",
});
const parallelTasks = ["ok", "after-failures", "auth-a"];
check(
	"two runs overlap and no more than two",
	parallel.r.status === 0 && highWater(barrierDir) === 2,
	`${parallel.r.status} ${highWater(barrierDir)} ${parallel.r.stderr}`,
);
check(
	"a parallel job gives every task a green result",
	parallelTasks.every((t) => existsSync(parallel.resultPath(t)) && parallel.resultOf(t).class === "converged-green"),
	parallel.r.stdout,
);
check(
	"order.log records the concurrency",
	readFileSync(join(parallel.abRoot, "order.log"), "utf8").split("\n")[0].includes(" concurrency=2 "),
);

const parallelAuthScript = join(root, "parallel-auth-outage.sh");
writeFileSync(parallelAuthScript, `. ${barrierScript}\n. ${authScript}\n`);
const parallelOutageDir = join(root, "barrier-b");
const parallelOutage = stubRun("stub-parallel-outage", authTasks.join(","), {
	AB_CONCURRENCY: "2",
	STUB_PI_SCRIPT: parallelAuthScript,
	STUB_BARRIER_DIR: parallelOutageDir,
	STUB_HOLD: "0",
});
const parallelResults = authTasks.filter((t) => existsSync(parallelOutage.resultPath(t)));
check(
	"a parallel outage stops the job, drains in-flight runs, and leaves no streak result",
	parallelOutage.r.status === 4 &&
		parallelResults.length === 0 &&
		parallelOutage.r.stderr.includes("in a row") &&
		highWater(parallelOutageDir) === 2,
	`${parallelOutage.r.status} ${parallelResults} ${parallelOutage.r.stdout} ${parallelOutage.r.stderr}`,
);

/** A zombie still answers kill(pid, 0), but it runs nothing, so it counts as stopped here. */
const isRunning = (pid: number): boolean => {
	if (!isAlive(pid)) return false;
	try {
		return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return false;
	}
};

const holdScript = join(root, "hold.sh");
writeFileSync(
	holdScript,
	[
		'mkdir -p "$STUB_PID_DIR"',
		'echo "$$" >>"$STUB_PID_DIR/pids"',
		"sleep 300 &",
		'echo "$!" >>"$STUB_PID_DIR/pids"',
		"wait",
	].join("\n"),
);
const pidDir = join(root, "hold-pids");
const interruptedRoot = join(root, "stub-interrupted");
const pidList = () =>
	existsSync(join(pidDir, "pids")) ? readFileSync(join(pidDir, "pids"), "utf8").trim().split("\n") : [];
const interrupted = spawn("bash", stubArgs("ok,after-failures,auth-a", "b-test"), {
	env: stubEnv(interruptedRoot, { AB_CONCURRENCY: "2", STUB_PI_SCRIPT: holdScript, STUB_PID_DIR: pidDir }),
	stdio: "ignore",
});
const interruptedExit = new Promise<number | null>((done) => interrupted.on("close", (code) => done(code)));
for (let waited = 0; pidList().length < 4 && waited < 200; waited++) await new Promise((r) => setTimeout(r, 100));
const heldPids = pidList().map(Number);
interrupted.kill("SIGTERM");
const interruptedCode = await interruptedExit;
const interruptedResults = ["ok", "after-failures", "auth-a"].filter((t) =>
	existsSync(join(interruptedRoot, "runs", `b-test__${t}__r1`, "result.json")),
);
check(
	"a TERM to run.sh exits 143, leaves no stub process, and leaves no result.json",
	heldPids.length === 4 &&
		interruptedCode === 143 &&
		heldPids.every((pid) => !isRunning(pid)) &&
		interruptedResults.length === 0 &&
		pidList().length === 4,
	`${interruptedCode} ${heldPids} ${heldPids.map(isRunning)} ${interruptedResults}`,
);

const noModel = stubRun("stub-no-model", "ok", {}, "b-unknown");
check(
	"a cap that matches no model stops before any launch",
	noModel.r.status !== 0 && piLaunches() === 0 && noModel.r.stderr.includes("did not reach"),
	`${noModel.r.status} ${noModel.r.stderr}`,
);

// --- score.sh, with no review launch --------------------------------------------

const scoreSh = (...args: string[]) =>
	spawnSync("bash", [join(bench, "score.sh"), ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			AB_ROOT: okRun.abRoot,
			AB_LIVE_AGENT_DIR: liveDir,
			PATH: `${stubBin}:${process.env.PATH}`,
		},
	});
const badScore = scoreSh("--nope");
check("score.sh rejects an unknown flag", badScore.status === 2 && badScore.stderr.includes("usage:"), badScore.stderr);
const dryScore = scoreSh("--dry-run");
check(
	"score.sh --dry-run lists pending runs and writes nothing",
	dryScore.status === 0 &&
		dryScore.stdout.trim() === "b-test__ok__r1" &&
		!existsSync(join(okRun.abRoot, "scores.json")),
	`${dryScore.status} ${dryScore.stdout} ${dryScore.stderr}`,
);

const scoreTask = (
	JSON.parse(readFileSync(join(bench, "tasks.json"), "utf8")) as {
		tasks: { id: string; ledgerDir: string }[];
	}
).tasks[0];
const scoreRoot = join(root, "score-root");
const scoreRunId = `b-test__${scoreTask.id}__r1`;
const scoreAttempt = join(scoreRoot, "runs", scoreRunId, "attempt-1");
mkdirSync(join(scoreAttempt, "repo"), { recursive: true });
writeFileSync(join(scoreAttempt, "diff.patch"), "diff --git a/x b/x\n");
writeFileSync(
	join(scoreRoot, "runs", scoreRunId, "result.json"),
	JSON.stringify({ runId: scoreRunId, task: scoreTask.id, attempts: 1 }),
);
mkdirSync(join(liveDir, "ledgerpi", scoreTask.ledgerDir), { recursive: true });
writeFileSync(join(liveDir, "ledgerpi", scoreTask.ledgerDir, "task.md"), "task\n");
const noScoreBin = join(root, "no-score-bin");
mkdirSync(noScoreBin);
const scoreTmp = join(root, "score-tmp");
mkdirSync(scoreTmp);
writeFileSync(join(noScoreBin, "claude"), `#!/bin/sh\necho '{"result":"no structured output"}'\n`, { mode: 0o755 });
const noScore = spawnSync("bash", [join(bench, "score.sh")], {
	encoding: "utf8",
	env: {
		...process.env,
		AB_ROOT: scoreRoot,
		AB_LIVE_AGENT_DIR: liveDir,
		TMPDIR: scoreTmp,
		PATH: `${noScoreBin}:${process.env.PATH}`,
	},
});
const recorded = existsSync(join(scoreRoot, "scores.json"))
	? (JSON.parse(readFileSync(join(scoreRoot, "scores.json"), "utf8")) as Record<string, unknown>)
	: {};
check(
	"score.sh fails, records nothing and leaves no blind copy when a review has no structured score",
	noScore.status === 1 &&
		noScore.stderr.includes("no structured score") &&
		recorded[scoreRunId] === undefined &&
		readdirSync(scoreTmp).length === 0 &&
		!existsSync(join(scoreRoot, "blind")),
	`${noScore.status} ${noScore.stderr} ${JSON.stringify(recorded)} ${readdirSync(scoreTmp)}`,
);

const dryPending = (entry: unknown) => {
	writeFileSync(join(scoreRoot, "scores.json"), JSON.stringify(entry === undefined ? {} : { [scoreRunId]: entry }));
	return spawnSync("bash", [join(bench, "score.sh"), "--dry-run"], {
		encoding: "utf8",
		env: { ...process.env, AB_ROOT: scoreRoot, AB_LIVE_AGENT_DIR: liveDir, PATH: `${stubBin}:${process.env.PATH}` },
	}).stdout.trim();
};
check(
	"score.sh treats a null score as pending and an object with a numeric score as done",
	dryPending({ score: null }) === scoreRunId &&
		dryPending({ score: "7" }) === scoreRunId &&
		dryPending("7") === scoreRunId &&
		dryPending(7) === scoreRunId &&
		dryPending({ score: 0, blockers: 0, shouldFix: 0 }) === "" &&
		dryPending(undefined) === scoreRunId,
	"pending predicate",
);

const runScore = (abRoot: string, ...args: string[]) =>
	spawnSync("bash", [join(bench, "score.sh"), ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			AB_ROOT: abRoot,
			AB_LIVE_AGENT_DIR: liveDir,
			TMPDIR: scoreTmp,
			PATH: `${stubBin}:${process.env.PATH}`,
		},
	});
writeFileSync(join(scoreRoot, "scores.json"), "{not json");
const corrupt = runScore(scoreRoot, "--dry-run");
check(
	"score.sh refuses a corrupt scores.json instead of reporting nothing pending",
	corrupt.status === 2 && corrupt.stderr.includes("not a JSON object"),
	`${corrupt.status} ${corrupt.stderr}`,
);
const noRuns = runScore(join(root, "no-such-root"), "--dry-run");
check(
	"score.sh refuses a root without result.json files",
	noRuns.status === 2 && noRuns.stderr.includes("no result.json"),
	`${noRuns.status} ${noRuns.stderr}`,
);
const lostRoot = join(root, "score-lost-attempt");
mkdirSync(join(lostRoot, "runs", "b-test__lost__r1"), { recursive: true });
writeFileSync(
	join(lostRoot, "runs", "b-test__lost__r1", "result.json"),
	JSON.stringify({ runId: "b-test__lost__r1", task: scoreTask.id, attempts: 1 }),
);
const lost = runScore(lostRoot);
check(
	"score.sh does not score a run whose attempt directory is missing",
	lost.status === 1 &&
		lost.stderr.includes("no attempt-1/repo directory") &&
		!readFileSync(join(lostRoot, "scores.json"), "utf8").includes("lost"),
	`${lost.status} ${lost.stderr}`,
);
const okScoreBin = join(root, "ok-score-bin");
mkdirSync(okScoreBin);
writeFileSync(
	join(okScoreBin, "claude"),
	`#!/bin/sh\nprintf '%s\\n' "$PWD" >"$STUB_REVIEW_CWD"\nls -A >"$STUB_REVIEW_CWD.ls"\necho '{"structured_output":{"score":7,"blockers":0,"shouldFix":1,"summary":"fine"}}'\n`,
	{ mode: 0o755 },
);
const okScoreRoot = join(root, "score-ok-root");
const okScoreId = `b-test__${scoreTask.id}__r1`;
mkdirSync(join(okScoreRoot, "runs", okScoreId, "attempt-1", "repo"), { recursive: true });
writeFileSync(join(okScoreRoot, "runs", okScoreId, "attempt-1", "diff.patch"), "diff --git a/x b/x\n");
writeFileSync(
	join(okScoreRoot, "runs", okScoreId, "result.json"),
	JSON.stringify({ runId: okScoreId, task: scoreTask.id, attempts: 1 }),
);
const scored = spawnSync("bash", [join(bench, "score.sh")], {
	encoding: "utf8",
	env: {
		...process.env,
		AB_ROOT: okScoreRoot,
		AB_LIVE_AGENT_DIR: liveDir,
		TMPDIR: scoreTmp,
		STUB_REVIEW_CWD: join(root, "review-cwd.txt"),
		PATH: `${okScoreBin}:${process.env.PATH}`,
	},
});
const okScores = JSON.parse(readFileSync(join(okScoreRoot, "scores.json"), "utf8")) as Record<string, unknown>;
check(
	"score.sh records the structured score of a successful review and cleans up",
	scored.status === 0 &&
		JSON.stringify(okScores[okScoreId]) ===
			JSON.stringify({ score: 7, blockers: 0, shouldFix: 1, summary: "fine" }) &&
		readdirSync(scoreTmp).length === 0 &&
		runScore(okScoreRoot, "--dry-run").stdout.trim() === "" &&
		!readFileSync(join(root, "review-cwd.txt"), "utf8").trim().startsWith(okScoreRoot) &&
		readFileSync(join(root, "review-cwd.txt.ls"), "utf8").includes(".review-task.md") &&
		readFileSync(join(root, "review-cwd.txt.ls"), "utf8").includes(".review-diff.patch"),
	`${scored.status} ${scored.stderr} ${JSON.stringify(okScores)}`,
);

const emptyDiffRoot = join(root, "score-empty-root");
const emptyDiffId = `b-test__${scoreTask.id}__r2`;
mkdirSync(join(emptyDiffRoot, "runs", emptyDiffId, "attempt-1", "repo"), { recursive: true });
writeFileSync(join(emptyDiffRoot, "runs", emptyDiffId, "attempt-1", "diff.patch"), "");
writeFileSync(
	join(emptyDiffRoot, "runs", emptyDiffId, "result.json"),
	JSON.stringify({ runId: emptyDiffId, task: scoreTask.id, attempts: 1 }),
);
const emptyReviewCwd = join(root, "empty-review-cwd.txt");
const emptyScored = spawnSync("bash", [join(bench, "score.sh")], {
	encoding: "utf8",
	env: {
		...process.env,
		AB_ROOT: emptyDiffRoot,
		AB_LIVE_AGENT_DIR: liveDir,
		TMPDIR: scoreTmp,
		STUB_REVIEW_CWD: emptyReviewCwd,
		PATH: `${okScoreBin}:${process.env.PATH}`,
	},
});
const emptyScores = JSON.parse(readFileSync(join(emptyDiffRoot, "scores.json"), "utf8")) as Record<
	string,
	{ score?: number }
>;
check(
	"score.sh records score 0 for an empty diff without launching a review",
	emptyScored.status === 0 &&
		emptyScores[emptyDiffId]?.score === 0 &&
		!existsSync(emptyReviewCwd) &&
		runScore(emptyDiffRoot, "--dry-run").stdout.trim() === "",
	`${emptyScored.status} ${emptyScored.stderr} ${JSON.stringify(emptyScores)}`,
);

const preflightTasks = join(root, "preflight-tasks.json");
writeFileSync(
	preflightTasks,
	JSON.stringify({ tasks: [fixtureTask("pf-ok"), fixtureTask("pf-bad", { gate: "echo boom; false" })] }),
);
const preflight = (tasks: string) =>
	spawnSync("bash", [join(bench, "run.sh"), "--preflight", "--tasks", tasks], {
		encoding: "utf8",
		env: stubEnv(join(root, "preflight-root"), { AB_TASKS_FILE: preflightTasks, TMPDIR: scoreTmp }),
	});
const pfOk = preflight("pf-ok");
const pfBad = preflight("pf-bad");
check(
	"run.sh --preflight passes a task whose gates pass and fails one whose gate fails",
	pfOk.status === 0 &&
		pfOk.stdout.includes("PASS  pf-ok") &&
		pfBad.status === 1 &&
		pfBad.stdout.includes("FAIL  pf-bad") &&
		pfBad.stdout.includes("boom") &&
		readdirSync(scoreTmp).length === 0,
	`${pfOk.status} ${pfOk.stdout} ${pfOk.stderr} | ${pfBad.status} ${pfBad.stdout} ${pfBad.stderr}`,
);

const crashBin = join(root, "crash-score-bin");
mkdirSync(crashBin);
writeFileSync(join(crashBin, "claude"), "#!/bin/sh\necho partial >&2\nexit 3\n", { mode: 0o755 });
const crashRoot = join(root, "score-crash-root");
const crashId = `b-test__${scoreTask.id}__r1`;
mkdirSync(join(crashRoot, "runs", crashId, "attempt-1", "repo"), { recursive: true });
writeFileSync(join(crashRoot, "runs", crashId, "attempt-1", "diff.patch"), "diff --git a/x b/x\n");
writeFileSync(
	join(crashRoot, "runs", crashId, "result.json"),
	JSON.stringify({ runId: crashId, task: scoreTask.id, attempts: 1 }),
);
const reviewCrash = spawnSync("bash", [join(bench, "score.sh")], {
	encoding: "utf8",
	env: {
		...process.env,
		AB_ROOT: crashRoot,
		AB_LIVE_AGENT_DIR: liveDir,
		TMPDIR: scoreTmp,
		PATH: `${crashBin}:${process.env.PATH}`,
	},
});
check(
	"score.sh names the run when the review command crashes and leaves no blind copy",
	reviewCrash.status === 1 &&
		reviewCrash.stderr.includes(`the review of ${crashId} failed`) &&
		readdirSync(scoreTmp).length === 0,
	`${reviewCrash.status} ${reviewCrash.stderr}`,
);
const noTaskRoot = join(root, "score-no-task");
const noTaskId = "b-test__no-such-task__r1";
mkdirSync(join(noTaskRoot, "runs", noTaskId, "attempt-1", "repo"), { recursive: true });
writeFileSync(join(noTaskRoot, "runs", noTaskId, "attempt-1", "diff.patch"), "diff --git a/x b/x\n");
writeFileSync(
	join(noTaskRoot, "runs", noTaskId, "result.json"),
	JSON.stringify({ runId: noTaskId, task: "no-such-task", attempts: 1 }),
);
const noTask = runScore(noTaskRoot);
check(
	"score.sh names the run when its task has no stored task.md",
	noTask.status === 1 &&
		noTask.stderr.includes(`${noTaskId}: no stored task.md`) &&
		readdirSync(scoreTmp).length === 0,
	`${noTask.status} ${noTask.stderr}`,
);
const badResultRoot = join(root, "score-bad-result");
mkdirSync(join(badResultRoot, "runs", "b-test__x__r1"), { recursive: true });
writeFileSync(join(badResultRoot, "runs", "b-test__x__r1", "result.json"), "{truncated");
const badResult = runScore(badResultRoot, "--dry-run");
check(
	"score.sh refuses a result.json that is not valid JSON",
	badResult.status === 2 && badResult.stderr.includes("is not valid JSON"),
	`${badResult.status} ${badResult.stderr}`,
);
const excludedRoot = join(root, "score-excluded");
const excludedId = "b-test__excluded__r1";
mkdirSync(join(excludedRoot, "runs", excludedId), { recursive: true });
writeFileSync(
	join(excludedRoot, "runs", excludedId, "result.json"),
	JSON.stringify({ runId: excludedId, task: scoreTask.id, attempts: 1, class: "harness-failed" }),
);
const excludedScore = runScore(excludedRoot);
check(
	"score.sh skips an excluded-class run instead of stopping on its missing attempt directory",
	excludedScore.status === 0 && runScore(excludedRoot, "--dry-run").stdout.trim() === "",
	`${excludedScore.status} ${excludedScore.stderr}`,
);
const analyzeBadRoot = spawnSync(
	"node",
	["--experimental-strip-types", join(bench, "analyze.ts"), "summarize", join(root, "no-such-root"), "a"],
	{ encoding: "utf8" },
);
check(
	"analyze.ts summarize reports a missing runs directory without a stack trace",
	analyzeBadRoot.status === 2 &&
		analyzeBadRoot.stderr.includes("no runs directory") &&
		!analyzeBadRoot.stderr.includes(" at "),
	`${analyzeBadRoot.status} ${analyzeBadRoot.stderr}`,
);

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nall bench checks passed" : `\n${failures} bench check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
