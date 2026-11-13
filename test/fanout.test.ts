import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditRun } from "../packages/core/src/audit.ts";
import { type FanoutSetting, type LedgerpiConfig, loadConfig, lowerFanout } from "../packages/core/src/config.ts";
import type { FanoutAnswer } from "../packages/core/src/fanout.ts";
import { addCandidateWorktree, pruneStaleCandidates, snapshotTree, treeId } from "../packages/core/src/git.ts";
import { handoffBlock } from "../packages/core/src/handoff.ts";
import { Ledger } from "../packages/core/src/ledger.ts";
import { type LoopDeps, type LoopResult, type RoleTiming, runLoop } from "../packages/core/src/loop.ts";
import type { SpawnFn, SpawnResult } from "../packages/core/src/spawn.ts";
import { deadPid, TIMING_KEYS } from "./helpers.ts";

const root = join(tmpdir(), `ledgerpi-fanout-test-${process.pid}`);
const stateDir = join(root, "state");
const configFile = join(root, "config.toml");

process.env.LEDGERPI_CONFIG = configFile;
process.env.PI_CODING_AGENT_DIR = join(root, "agentdir");
delete process.env.LEDGERPI;
delete process.env.LEDGERPI_STATE_DIR;
delete process.env.LEDGERPI_AUDIT_LOG;
delete process.env.LEDGERPI_AUDIT_SOURCE;

let failures = 0;
const check = (label: string, cond: boolean, detail: unknown = "") => {
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${JSON.stringify(detail)}`}`);
	if (!cond) failures++;
};

const PLAN = "### PLAN\nFix it.\n\n### TASKS\n- [todo] Fix it\n";
const IDEAS = "### NOTES\nOne obvious approach.\n\n### NEXT\n- Fix it\n";
const WORKED = "### NOTES\nDid the task.\n\n### NEXT\nnone\n\n### STATUS\nsolved\n";

/** A manager reply; `mode` adds a `### MODE` section as the recommendation. */
function managerReply(status: "continue" | "done", next: string, mode?: string): string {
	if (status === "done") return "### STATUS\ndone\n\n### NEXT\n\n";
	return `### STATUS\ncontinue\n\n### NEXT\n- ${next}\n\n${mode ? `### MODE\n- ${mode}\n\n` : ""}### TASKS\n- [todo] ${next}\n`;
}

const ok = (text: string): SpawnResult => ({ ok: true, text });
const failed = (): SpawnResult => ({ ok: false, error: "boom", detail: "agent-error" });
const after = <T>(ms: number, value: T): Promise<T> => new Promise((done) => setTimeout(() => done(value), ms));
/** A timer can fire a millisecond or so early against two `Date.now()` readings, so lower bounds on a delay allow this much slack per call. */
const TIMER_SLACK_MS = 5;

/** A worker that hangs until it is told to stop, then fails as an aborted spawn does. */
function untilAborted(signal: AbortSignal | undefined): Promise<SpawnResult> {
	return new Promise((done) => {
		const stop = () => done({ ok: false, error: "aborted", detail: "aborted" });
		if (!signal || signal.aborted) return stop();
		signal.addEventListener("abort", stop, { once: true });
	});
}

/** One stub sub-agent call as the loop issued it. */
interface Call {
	type: string;
	/** The sub-agent row label: `plan`, `ideate`, `manage`, `work`, `work 2/3`, `review`, `finalize`. */
	label: string;
	cwd: string;
	prompt: string;
	signal: AbortSignal | undefined;
}

const isManage = (c: Call) => c.label === "manage" || c.label === "review";
const isCandidate = (c: Call) => /^work \d+\/\d+$/.test(c.label);
const isWork = (c: Call) => c.label === "work" || isCandidate(c);
const candidateIndex = (c: Call) => Number(/^work (\d+)\//.exec(c.label)?.[1]);

interface Script {
	/** The reply to the nth (1-based) manage or review call. */
	manage: (n: number) => string;
	/** The reply to a worker in the work phase, serial or candidate. */
	work?: (c: Call) => SpawnResult | Promise<SpawnResult>;
	/** Milliseconds every manager-type and worker-type spawn waits before it replies. */
	latency?: { manager?: number; worker?: number };
}

function stubSpawn(script: Script, calls: Call[]): SpawnFn {
	let manages = 0;
	return async (o) => {
		const label = /\(([^)]*)\)$/.exec(o.description)?.[1] ?? "";
		const call: Call = { type: o.type, label, cwd: o.cwd ?? "", prompt: o.prompt, signal: o.signal };
		calls.push(call);
		await after(o.type === "ledger-worker" ? (script.latency?.worker ?? 0) : (script.latency?.manager ?? 0), null);
		if (label === "plan") return ok(PLAN);
		if (label === "ideate") return ok(IDEAS);
		if (isManage(call)) return ok(script.manage(++manages));
		if (isWork(call)) return script.work ? script.work(call) : ok(WORKED);
		return ok(WORKED);
	};
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function newRepo(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	writeFileSync(join(dir, "seed"), "1");
	writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
	git(dir, "add", ".");
	git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
	return dir;
}

const worktreeCount = (repo: string) => git(repo, "worktree", "list", "--porcelain").split("\n\n").length;
const gateLog = (name: string) => join(root, `${name}.gate.log`);
const gateFor = (name: string) => `echo x >> "${gateLog(name)}"; echo missing-pass-txt; test -f pass.txt`;
const gateExecutions = (name: string) =>
	existsSync(gateLog(name)) ? readFileSync(gateLog(name), "utf8").split("\n").filter(Boolean).length : 0;

function candidateDirs(ledger: Ledger): string[] {
	try {
		return readdirSync(join(ledger.dir, "candidates"));
	} catch {
		return [];
	}
}

type Row = Record<string, unknown>;

function transcript(ledger: Ledger): Row[] {
	return readFileSync(join(ledger.dir, "transcript.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Row);
}

interface RunSpec {
	name: string;
	repo: string;
	script: Script;
	/** The configured setting. */
	config: FanoutSetting;
	/** The per-call override. */
	override?: FanoutSetting;
	n?: number;
	maxIters?: number;
	/** The gate command; defaults to `gateFor(name)`, null runs without a gate. */
	gate?: string | null;
	signal?: AbortSignal;
	/** The `ask` consent callback; absent means there is no way to ask. */
	confirm?: LoopDeps["confirmFanout"];
}

interface Run {
	result: LoopResult;
	calls: Call[];
	ledger: Ledger;
	rows: Row[];
	progress: string[];
	cfg: LedgerpiConfig;
}

let runCounter = 0;

async function runCase(spec: RunSpec): Promise<Run> {
	const cfg: LedgerpiConfig = {
		...loadConfig(),
		stateDir,
		fanout: spec.config,
		fanoutMax: spec.n ?? 2,
		maxIters: spec.maxIters ?? 4,
		callTimeoutMs: 20_000,
		gateTimeoutMs: 20_000,
	};
	const ledger = new Ledger(cfg, "sess", `turn-${++runCounter}`);
	const calls: Call[] = [];
	const progress: string[] = [];
	const result = await runLoop({
		spawn: stubSpawn(spec.script, calls),
		cfg,
		ledger,
		cwd: spec.repo,
		task: "Make the gate pass.",
		gateCommand: spec.gate === null ? undefined : (spec.gate ?? gateFor(spec.name)),
		sessionModel: null,
		managerModel: null,
		workerModel: null,
		fanout: spec.override,
		confirmFanout: spec.confirm,
		onProgress: (_iter, label) => progress.push(label),
		signal: spec.signal,
	});
	return { result, calls, ledger, rows: transcript(ledger), progress, cfg };
}

/** A serial worker that makes the gate pass, in whatever tree it was spawned in. */
function passingWorker(c: Call): SpawnResult {
	writeFileSync(join(c.cwd, "pass.txt"), "");
	return ok(WORKED);
}

async function case1Off(): Promise<void> {
	const repo = newRepo("c1");
	const run = await runCase({
		name: "c1",
		repo,
		config: "off",
		script: {
			manage: (n) =>
				n < 3 ? managerReply("continue", `step ${n}`, "best-of-n: ignored") : managerReply("done", ""),
			work: passingWorker,
		},
	});
	const work = run.calls.filter(isWork);
	const brief = run.rows.filter((r) => r.role === "brief");
	check("1 off: converged in two rounds", run.result.converged && run.result.iters === 2, run.result);
	check(
		"1 off: no manage prompt asks for a MODE",
		run.calls.filter(isManage).length === 3 &&
			run.calls.filter(isManage).every((c) => !c.prompt.includes("### MODE")),
	);
	check(
		"1 off: one worker spawn per round, at the real cwd",
		work.length === 2 && work.every((c) => c.cwd === repo && c.label === "work"),
		work.map((c) => [c.label, c.cwd]),
	);
	check(
		"1 off: no extra worktrees and no candidates directory",
		worktreeCount(repo) === 1 && !existsSync(join(run.ledger.dir, "candidates")),
	);
	check("1 off: the hand-off has no Fan-out line", !handoffBlock(repo, run.result).includes("Fan-out:"));
	check(
		"1 off: no fan-out summary, no advice on the brief rows, no fan-out rows",
		run.result.fanout === null &&
			brief.length === 2 &&
			brief.every((r) => r.mode === "serial" && !("advised" in r) && !("downgrade" in r)) &&
			!run.rows.some((r) => r.role === "fanout"),
		brief,
	);
}

async function case2Advise(): Promise<void> {
	const repo = newRepo("c2");
	const run = await runCase({
		name: "c2",
		repo,
		config: "advise",
		n: 3,
		script: {
			manage: (n) =>
				n === 1
					? managerReply("continue", "make it pass", "best-of-n: uncertain approach")
					: managerReply("done", ""),
			work: passingWorker,
		},
	});
	const work = run.calls.filter(isWork);
	const brief = run.rows.filter((r) => r.role === "brief");
	check(
		"2 advise: every manage prompt asks for a MODE",
		run.calls.filter(isManage).length === 2 && run.calls.filter(isManage).every((c) => c.prompt.includes("### MODE")),
	);
	check(
		"2 advise: still one worker spawn at the real cwd",
		work.length === 1 && work[0].cwd === repo && work[0].label === "work" && worktreeCount(repo) === 1,
		work.map((c) => [c.label, c.cwd]),
	);
	check(
		"2 advise: the transcript brief row records the recommendation and runs serially",
		brief.length === 1 &&
			brief[0].mode === "serial" &&
			brief[0].advised === "best-of-n" &&
			brief[0].reason === "uncertain approach" &&
			brief[0].downgrade === null,
		brief,
	);
	check(
		"2 advise: the loop result carries the summary and the run converged",
		run.result.converged &&
			JSON.stringify(run.result.fanout) ===
				JSON.stringify({
					setting: "advise",
					max: 3,
					rounds: 0,
					downgrades: [],
					escapes: [],
					asked: 0,
					advised: { serial: 0, "best-of-n": 1, fleet: 0, none: 0 },
				}),
		run.result.fanout,
	);
	const auditLog = join(root, "c2.audit.jsonl");
	auditRun({ ...run.cfg, auditLog }, { entry: "tool", session: "sess", cwd: repo }, run.result, {
		task: "Make the gate pass.",
		durationMs: 1,
		calls: run.result.calls,
		tokens: run.result.tokens,
	});
	const audited = JSON.parse(readFileSync(auditLog, "utf8").trim()) as { fanout: unknown } & RoleTiming;
	check(
		"2 advise: the audit row carries the summary with the advised counts",
		JSON.stringify(audited.fanout) === JSON.stringify(run.result.fanout),
		audited.fanout,
	);
	const t = run.result.timing;
	check(
		"2 advise: the audit row carries the six timing fields, equal to the loop result's timing",
		TIMING_KEYS.every((k) => typeof audited[k] === "number" && audited[k] === t[k]),
		[audited, t],
	);
	const handoff = handoffBlock(repo, run.result);
	check(
		"2 advise: the hand-off has exactly one Fan-out line with the recommendation",
		handoff.split("\n").filter((l) => l.startsWith("Fan-out:")).length === 1 &&
			handoff.includes(
				"Fan-out: advise (max 3). Best-of-N rounds: 0. Recommended: serial 0, best-of-n 1, fleet 0, none 0.",
			),
		handoff,
	);
	check("2 advise: no fan-out rows", !run.rows.some((r) => r.role === "fanout"));
}

async function case3OnCandidateTwoPasses(): Promise<void> {
	const repo = newRepo("c3");
	const run = await runCase({
		name: "c3",
		repo,
		config: "on",
		n: 3,
		script: {
			manage: (n) =>
				n === 1
					? managerReply("continue", "make it pass", "best-of-n: uncertain approach")
					: managerReply("done", ""),
			work: async (c) => {
				const i = candidateIndex(c);
				writeFileSync(join(c.cwd, `cand${i}.txt`), `${i}`);
				if (i === 1) return ok(WORKED);
				if (i === 2) {
					await after(150, null);
					writeFileSync(join(c.cwd, "pass.txt"), "");
					return ok(WORKED);
				}
				return untilAborted(c.signal);
			},
		},
	});
	const work = run.calls.filter(isWork);
	const fanRow = run.rows.find((r) => r.role === "fanout");
	check("3 on: converged on the kept candidate", run.result.converged && run.result.stop === "done", run.result);
	check(
		"3 on: only candidate 2's files landed in the real tree",
		existsSync(join(repo, "cand2.txt")) &&
			existsSync(join(repo, "pass.txt")) &&
			!existsSync(join(repo, "cand1.txt")) &&
			!existsSync(join(repo, "cand3.txt")),
		git(repo, "status", "--porcelain"),
	);
	check(
		"3 on: the candidate worktrees are gone",
		worktreeCount(repo) === 1 && candidateDirs(run.ledger).length === 0,
		candidateDirs(run.ledger),
	);
	check(
		"3 on: three candidate spawns in their own worktrees, labeled work i/3",
		work.length === 3 &&
			work.every((c) => c.cwd.startsWith(join(run.ledger.dir, "candidates"))) &&
			work
				.map((c) => c.label)
				.sort()
				.join() === "work 1/3,work 2/3,work 3/3",
		work.map((c) => [c.label, c.cwd]),
	);
	check(
		"3 on: three work rows plus the ideation row in the transcript, and calls = 7",
		run.rows.filter((r) => r.role === "ledger-worker").length === 4 && run.result.calls === 7,
		[run.rows.filter((r) => r.role === "ledger-worker").length, run.result.calls],
	);
	check(
		"3 on: the gate ran once per examined candidate, not again in the loop",
		gateExecutions("c3") === 2 && run.rows.filter((r) => r.role === "gate").length === 2,
		[gateExecutions("c3"), run.rows.filter((r) => r.role === "gate").length],
	);
	check(
		"3 on: the fan-out row records the attempts, the summary one fan-out round",
		JSON.stringify((fanRow?.attempts as { outcome: string }[] | undefined)?.map((a) => a.outcome)) ===
			JSON.stringify(["gate-red", "kept", "canceled"]) &&
			run.result.fanout?.rounds === 1 &&
			run.result.fanout.downgrades.length === 0,
		fanRow,
	);
	check("3 on: the progress label names the fan-out", run.progress.includes("working (best-of-3)"), run.progress);
}

async function case4NonePass(): Promise<void> {
	const repo = newRepo("c4");
	const run = await runCase({
		name: "c4",
		repo,
		config: "on",
		n: 2,
		maxIters: 1,
		script: {
			manage: (n) =>
				managerReply(
					"continue",
					n === 1 ? "make it pass" : "try something else",
					n === 1 ? "best-of-n: retry" : undefined,
				),
			work: async (c) => {
				const i = candidateIndex(c);
				if (i === 2) await after(100, null);
				writeFileSync(join(c.cwd, `cand${i}.txt`), `${i}`);
				return ok(WORKED);
			},
		},
	});
	const review = run.calls.find((c) => c.label === "review");
	const fanRow = run.rows.find((r) => r.role === "fanout");
	check(
		"4 none pass: the first finished candidate is kept in the real tree, the other is not",
		existsSync(join(repo, "cand1.txt")) && !existsSync(join(repo, "cand2.txt")),
		git(repo, "status", "--porcelain"),
	);
	check(
		"4 none pass: its gate failure reaches the next manage prompt",
		review?.prompt.includes("GATE FAILED") === true && review.prompt.includes("missing-pass-txt"),
		review?.prompt.slice(-600),
	);
	check(
		"4 none pass: attempts are kept-red then gate-red, and the loop did not gate the round again",
		JSON.stringify((fanRow?.attempts as { outcome: string }[] | undefined)?.map((a) => a.outcome)) ===
			JSON.stringify(["kept-red", "gate-red"]) && gateExecutions("c4") === 3,
		[fanRow, gateExecutions("c4")],
	);
	check("4 none pass: worktrees are gone", worktreeCount(repo) === 1 && candidateDirs(run.ledger).length === 0);
}

async function case5AllFail(): Promise<void> {
	const repo = newRepo("c5");
	const before = treeId(repo);
	const run = await runCase({
		name: "c5",
		repo,
		config: "on",
		n: 2,
		script: {
			manage: () => managerReply("continue", "make it pass", "best-of-n: retry"),
			work: () => failed(),
		},
	});
	check(
		"5 all fail: two rounds stop with spawn-failure",
		run.result.stop === "spawn-failure" && run.result.iters === 2 && run.result.stopDetail === "agent-error",
		run.result,
	);
	check(
		"5 all fail: both rounds fanned out to two candidates each",
		run.calls.filter(isCandidate).length === 4 && run.result.fanout?.rounds === 2,
		[run.calls.filter(isCandidate).length, run.result.fanout],
	);
	check(
		"5 all fail: the real tree is untouched and the worktrees are gone",
		treeId(repo) === before && worktreeCount(repo) === 1 && candidateDirs(run.ledger).length === 0,
	);
	check(
		"5 all fail: the spawn-failure stop re-runs the gate and reports its verdict",
		gateExecutions("c5") === 1 && run.result.gate?.ran === true && run.result.gate.passed === false,
		[gateExecutions("c5"), run.result.gate],
	);
}

async function case6NoGate(): Promise<void> {
	const repo = newRepo("c6");
	const run = await runCase({
		name: "c6",
		repo,
		config: "on",
		n: 3,
		gate: null,
		script: {
			manage: (n) =>
				n === 1 ? managerReply("continue", "make it pass", "best-of-n: uncertain") : managerReply("done", ""),
			work: passingWorker,
		},
	});
	const work = run.calls.filter(isWork);
	const brief = run.rows.find((r) => r.role === "brief");
	check(
		"6 no gate: one serial worker at the real cwd",
		work.length === 1 && work[0].cwd === repo && work[0].label === "work",
		work.map((c) => [c.label, c.cwd]),
	);
	check(
		"6 no gate: the brief row records the no-gate downgrade and the summary lists it",
		brief?.mode === "serial" &&
			brief.advised === "best-of-n" &&
			brief.downgrade === "no-gate" &&
			JSON.stringify(run.result.fanout?.downgrades) === JSON.stringify(["no-gate"]) &&
			run.result.fanout?.rounds === 0,
		[brief, run.result.fanout],
	);
	check("6 no gate: converged without worktrees", run.result.converged && worktreeCount(repo) === 1);
}

async function case12FleetUnavailable(): Promise<void> {
	const repo = newRepo("c12");
	const run = await runCase({
		name: "c12",
		repo,
		config: "on",
		n: 3,
		script: {
			manage: (n) =>
				n === 1
					? managerReply("continue", "make it pass", "fleet: two independent parts")
					: managerReply("done", ""),
			work: passingWorker,
		},
	});
	const work = run.calls.filter(isWork);
	const brief = run.rows.find((r) => r.role === "brief");
	check(
		"12 fleet recommended under on: one serial worker at the real cwd, no candidate worktrees",
		work.length === 1 && work[0].cwd === repo && work[0].label === "work" && candidateDirs(run.ledger).length === 0,
		work.map((c) => [c.label, c.cwd]),
	);
	check(
		"12 fleet recommended under on: the brief row and summary record the fleet-unavailable downgrade",
		brief?.mode === "serial" &&
			brief.advised === "fleet" &&
			brief.downgrade === "fleet-unavailable" &&
			JSON.stringify(run.result.fanout?.downgrades) === JSON.stringify(["fleet-unavailable"]) &&
			run.result.fanout?.rounds === 0 &&
			run.result.fanout?.advised.fleet === 1 &&
			run.result.converged,
		[brief, run.result.fanout],
	);
}

async function case13SetupFailed(): Promise<void> {
	const repo = newRepo("c13");
	const turnDir = join(stateDir, "sess", `turn-${runCounter + 1}`);
	mkdirSync(turnDir, { recursive: true });
	writeFileSync(join(turnDir, "candidates"), "a regular file where the candidates directory goes");
	const run = await runCase({
		name: "c13",
		repo,
		config: "on",
		n: 2,
		script: {
			manage: (n) =>
				n === 3 ? managerReply("done", "") : managerReply("continue", `task ${n}`, "best-of-n: uncertain"),
			work: passingWorker,
		},
	});
	const work = run.calls.filter(isWork);
	const brief = run.rows.filter((r) => r.role === "brief");
	const fanRows = run.rows.filter((r) => r.role === "fanout");
	check(
		"13 setup failure: the round falls back to one serial worker at the real cwd and no worktree is left",
		work.length >= 1 && work[0].label === "work" && work[0].cwd === repo && worktreeCount(repo) === 1,
		work.map((c) => [c.label, c.cwd]),
	);
	check(
		"13 setup failure: the unavailable outcome is recorded, setup-failed is a downgrade, and later rounds are latched",
		fanRows.length === 1 &&
			fanRows[0].outcome === "unavailable" &&
			JSON.stringify(run.result.fanout?.downgrades) === JSON.stringify(["setup-failed", "latched"]) &&
			brief.length === 2 &&
			brief[1].downgrade === "latched" &&
			run.result.converged,
		[run.result.fanout, fanRows, brief],
	);
}

async function case7OverrideLowers(): Promise<void> {
	check(
		"7 override: lowerFanout takes the less permissive of two settings",
		lowerFanout("on", "off") === "off" &&
			lowerFanout("off", "on") === "off" &&
			lowerFanout("on", "advise") === "advise" &&
			lowerFanout("advise", "on") === "advise" &&
			lowerFanout("on", "on") === "on",
	);
	const script: Script = {
		manage: (n) =>
			n === 1 ? managerReply("continue", "make it pass", "best-of-n: uncertain") : managerReply("done", ""),
		work: passingWorker,
	};
	const sub = async (name: string, config: FanoutSetting, override: FanoutSetting) => {
		const repo = newRepo(name);
		return { repo, run: await runCase({ name, repo, config, override, n: 3, script }) };
	};

	const lowered = await sub("c7a", "on", "off");
	check(
		"7 override: config on + override off asks for no MODE and runs one worker",
		lowered.run.result.fanout === null &&
			lowered.run.calls.filter(isManage).every((c) => !c.prompt.includes("### MODE")) &&
			lowered.run.calls.filter(isWork).length === 1 &&
			lowered.run.calls.filter(isWork)[0].cwd === lowered.repo,
	);
	const raised = await sub("c7b", "off", "on");
	check(
		"7 override: config off + override on stays off",
		raised.run.result.fanout === null &&
			raised.run.calls.filter(isManage).every((c) => !c.prompt.includes("### MODE")) &&
			raised.run.calls.filter(isWork).length === 1 &&
			worktreeCount(raised.repo) === 1,
	);
	const toAdvise = await sub("c7c", "on", "advise");
	check(
		"7 override: config on + override advise asks for a MODE but never fans out",
		toAdvise.run.result.fanout?.setting === "advise" &&
			toAdvise.run.calls.filter(isManage).every((c) => c.prompt.includes("### MODE")) &&
			toAdvise.run.calls.filter(isWork).length === 1 &&
			toAdvise.run.calls.filter(isWork)[0].cwd === toAdvise.repo,
	);
	const stillAdvise = await sub("c7d", "advise", "on");
	check(
		"7 override: config advise + override on stays advise",
		stillAdvise.run.result.fanout?.setting === "advise" && stillAdvise.run.calls.filter(isCandidate).length === 0,
	);
}

async function case8Escape(): Promise<void> {
	const repo = newRepo("c8");
	const run = await runCase({
		name: "c8",
		repo,
		config: "on",
		n: 2,
		script: {
			manage: (n) =>
				n === 3 ? managerReply("done", "") : managerReply("continue", `task ${n}`, "best-of-n: uncertain"),
			work: (c) => {
				if (!isCandidate(c)) return passingWorker(c);
				if (candidateIndex(c) === 1) {
					writeFileSync(join(repo, "escape.txt"), "wrote outside the worktree");
					return ok(WORKED);
				}
				return untilAborted(c.signal);
			},
		},
	});
	const brief = run.rows.filter((r) => r.role === "brief");
	const fanRows = run.rows.filter((r) => r.role === "fanout");
	const serialWork = run.calls.filter((c) => c.label === "work");
	check(
		"8 escape: the escape reason is recorded in the summary and the fan-out row",
		JSON.stringify(run.result.fanout?.escapes) === JSON.stringify(["tree-changed"]) &&
			fanRows.length === 1 &&
			fanRows[0].outcome === "escaped" &&
			fanRows[0].reason === "tree-changed",
		[run.result.fanout, fanRows],
	);
	check(
		"8 escape: the tree is kept as the worker left it and the worktrees are gone",
		existsSync(join(repo, "escape.txt")) && worktreeCount(repo) === 1 && candidateDirs(run.ledger).length === 0,
	);
	check(
		"8 escape: the next round runs serially at the real cwd with the latched downgrade",
		brief.length === 2 &&
			brief[1].mode === "serial" &&
			brief[1].downgrade === "latched" &&
			serialWork.length === 1 &&
			serialWork[0].cwd === repo &&
			JSON.stringify(run.result.fanout?.downgrades) === JSON.stringify(["latched"]),
		[brief, serialWork.length],
	);
	check(
		"8 escape: the run still converges",
		run.result.converged && run.calls.filter(isCandidate).length === 2,
		run.result,
	);
}

async function case8GateEscape(): Promise<void> {
	const repo = newRepo("c8g");
	const run = await runCase({
		name: "c8g",
		repo,
		config: "on",
		n: 2,
		gate: `echo x >> "${gateLog("c8g")}"; sleep 1; test -f pass.txt`,
		script: {
			manage: (n) =>
				n === 3 ? managerReply("done", "") : managerReply("continue", `task ${n}`, "best-of-n: uncertain"),
			work: async (c) => {
				if (!isCandidate(c)) return passingWorker(c);
				if (candidateIndex(c) === 1) return passingWorker(c);
				await new Promise((done) => setTimeout(done, 500));
				writeFileSync(join(repo, "seed"), "stray write while the first candidate's gate runs");
				return untilAborted(c.signal);
			},
		},
	});
	const fanRows = run.rows.filter((r) => r.role === "fanout");
	check(
		"8 gate escape: a tracked file changed in the real tree while a candidate's gate ran is an escape, even though the gate passed",
		JSON.stringify(run.result.fanout?.escapes) === JSON.stringify(["tree-changed"]) &&
			fanRows.length === 1 &&
			fanRows[0].outcome === "escaped",
		[run.result.fanout, fanRows],
	);
	check(
		"8 gate escape: the stray write is kept as left, the worktrees are gone, and the run still converges",
		readFileSync(join(repo, "seed"), "utf8").startsWith("stray write") &&
			worktreeCount(repo) === 1 &&
			candidateDirs(run.ledger).length === 0 &&
			run.result.converged,
		run.result,
	);
}

async function case9Abort(): Promise<void> {
	const repoA = newRepo("c9a");
	writeFileSync(join(repoA, "seed"), "1-dirty");
	writeFileSync(join(repoA, "dirty.txt"), "untracked");
	const baseA = treeId(repoA);
	const abortA = new AbortController();
	let started = 0;
	const during = await runCase({
		name: "c9a",
		repo: repoA,
		config: "on",
		n: 2,
		signal: abortA.signal,
		script: {
			manage: () => managerReply("continue", "make it pass", "best-of-n: uncertain"),
			work: (c) => {
				if (++started === 2) setTimeout(() => abortA.abort(), 20);
				return untilAborted(c.signal);
			},
		},
	});
	check("9 abort: aborting while the workers run stops the run", during.result.stop === "aborted", during.result);
	check(
		"9 abort: the worktrees are removed and the real tree is still the base",
		treeId(repoA) === baseA && worktreeCount(repoA) === 1 && candidateDirs(during.ledger).length === 0,
	);

	const repoB = newRepo("c9b");
	writeFileSync(join(repoB, "dirty.txt"), "untracked");
	const baseB = treeId(repoB);
	const abortB = new AbortController();
	const marker = join(root, "c9b.gate-started");
	const poll = setInterval(() => {
		if (!existsSync(marker)) return;
		clearInterval(poll);
		abortB.abort();
	}, 20);
	const gating = await runCase({
		name: "c9b",
		repo: repoB,
		config: "on",
		n: 2,
		signal: abortB.signal,
		gate: `touch "${marker}"; sleep 30`,
		script: {
			manage: () => managerReply("continue", "make it pass", "best-of-n: uncertain"),
			work: (c) => {
				if (candidateIndex(c) !== 1) return untilAborted(c.signal);
				writeFileSync(join(c.cwd, "cand1.txt"), "1");
				return ok(WORKED);
			},
		},
	});
	clearInterval(poll);
	check("9 abort: aborting during a candidate's gate stops the run", gating.result.stop === "aborted", gating.result);
	check(
		"9 abort: the applied patch is reverted, the worktrees are removed, the real tree is still the base",
		treeId(repoB) === baseB &&
			!existsSync(join(repoB, "cand1.txt")) &&
			worktreeCount(repoB) === 1 &&
			candidateDirs(gating.ledger).length === 0,
		git(repoB, "status", "--porcelain"),
	);
}

async function case10DirtyState(): Promise<void> {
	const repo = newRepo("c10");
	writeFileSync(join(repo, "seed"), "1-dirty");
	writeFileSync(join(repo, "staged.txt"), "staged");
	git(repo, "add", "staged.txt");
	writeFileSync(join(repo, "untracked.txt"), "untracked");
	writeFileSync(join(repo, "ignored.log"), "ignored");
	const cachedBefore = git(repo, "diff", "--cached");
	const seen = new Map<number, Record<string, string | boolean>>();
	const run = await runCase({
		name: "c10",
		repo,
		config: "on",
		n: 2,
		script: {
			manage: (n) =>
				n === 1 ? managerReply("continue", "make it pass", "best-of-n: uncertain") : managerReply("done", ""),
			work: (c) => {
				const i = candidateIndex(c);
				seen.set(i, {
					seed: readFileSync(join(c.cwd, "seed"), "utf8"),
					staged: readFileSync(join(c.cwd, "staged.txt"), "utf8"),
					untracked: readFileSync(join(c.cwd, "untracked.txt"), "utf8"),
					ignored: existsSync(join(c.cwd, "ignored.log")),
					named: c.prompt.includes(c.cwd),
				});
				if (i !== 1) return untilAborted(c.signal);
				writeFileSync(join(c.cwd, "pass.txt"), "");
				return ok(WORKED);
			},
		},
	});
	const view = (i: number) => JSON.stringify(seen.get(i));
	const expected = JSON.stringify({
		seed: "1-dirty",
		staged: "staged",
		untracked: "untracked",
		ignored: false,
		named: true,
	});
	check(
		"10 dirty: unstaged, staged and untracked state reaches every candidate and ignored files do not",
		seen.size === 2 && view(1) === expected && view(2) === expected,
		[...seen],
	);
	check("10 dirty: the run converged on the kept candidate", run.result.converged, run.result);
	check(
		"10 dirty: `git diff --cached` in the real repo is unchanged and the dirty state is intact",
		git(repo, "diff", "--cached") === cachedBefore &&
			git(repo, "diff", "--cached", "--name-only") === "staged.txt" &&
			readFileSync(join(repo, "seed"), "utf8") === "1-dirty" &&
			readFileSync(join(repo, "untracked.txt"), "utf8") === "untracked" &&
			existsSync(join(repo, "pass.txt")),
		[git(repo, "diff", "--cached"), cachedBefore],
	);
}

async function case11StaleWorktrees(): Promise<void> {
	const repo = newRepo("c11");
	const base = snapshotTree(repo);
	const oldTurn = (turn: string) => join(stateDir, "old-sess", turn);
	const stale = addCandidateWorktree(repo, oldTurn("turn-dead"), 1, 1, base);
	const live = addCandidateWorktree(repo, oldTurn("turn-live"), 1, 1, base);
	git(repo, "worktree", "unlock", stale);
	git(repo, "worktree", "lock", "--reason", `ledgerpi:${await deadPid()}`, stale);

	const run = await runCase({
		name: "c11",
		repo,
		config: "advise",
		gate: null,
		script: { manage: () => managerReply("done", "") },
	});
	const listing = git(repo, "worktree", "list", "--porcelain");
	check(
		"11 prune: loop start removes a dead-pid candidate worktree under another session/turn in the state dir",
		!existsSync(stale) && !listing.includes(stale),
		listing,
	);
	check(
		"11 prune: a candidate worktree locked by a live pid is kept",
		existsSync(live) && listing.includes(live) && run.result.converged,
		listing,
	);

	git(repo, "worktree", "unlock", live);
	git(repo, "worktree", "lock", "--reason", `ledgerpi:${await deadPid()}`, live);
	const pruned = pruneStaleCandidates(repo, stateDir);
	check(
		"11 prune: once its owner is dead, pruneStaleCandidates removes it too",
		pruned.length === 1 && pruned[0] === live && !existsSync(live) && worktreeCount(repo) === 1,
		pruned,
	);
}

async function case14SerialTiming(): Promise<void> {
	const repo = newRepo("c14");
	const startedAt = Date.now();
	const run = await runCase({
		name: "c14",
		repo,
		config: "off",
		gate: `echo x >> "${gateLog("c14")}"; sleep 0.2; test -f pass.txt`,
		script: {
			manage: (n) => (n === 1 ? managerReply("continue", "make it pass") : managerReply("done", "")),
			work: passingWorker,
			latency: { manager: 50, worker: 150 },
		},
	});
	const wall = Date.now() - startedAt;
	const t = run.result.timing;
	const gateRows = run.rows.filter((r) => r.role === "gate").length;
	check(
		"14 timing: a serial run converged with the expected spawn mix",
		run.result.converged && t.managerCalls === 3 && t.workerCalls === 2 && t.gateRuns === 1,
		[run.result, t],
	);
	check(
		"14 timing: each worker spawn took at least its delay and each manager spawn at least its",
		t.workerMs >= (150 - TIMER_SLACK_MS) * t.workerCalls && t.managerMs >= (50 - TIMER_SLACK_MS) * t.managerCalls,
		t,
	);
	check("14 timing: each gate run took at least the gate's sleep", t.gateMs >= 200 * t.gateRuns, t);
	check(
		"14 timing: manager and worker counts add up to calls, and the gate count matches the gate rows and runs",
		t.managerCalls + t.workerCalls === run.result.calls &&
			t.gateRuns === gateRows &&
			t.gateRuns === gateExecutions("c14"),
		[t, run.result.calls, gateRows, gateExecutions("c14")],
	);
	check("14 timing: serial busy time fits inside the wall time", t.managerMs + t.workerMs + t.gateMs <= wall, [
		t,
		wall,
	]);
}

async function case15BestOfNTiming(): Promise<void> {
	const repo = newRepo("c15");
	const run = await runCase({
		name: "c15",
		repo,
		config: "on",
		n: 3,
		script: {
			manage: (n) =>
				n === 1 ? managerReply("continue", "make it pass", "best-of-n: uncertain") : managerReply("done", ""),
			work: async (c) => {
				const i = candidateIndex(c);
				if (i === 1) return ok(WORKED);
				if (i === 2) {
					await after(150, null);
					return passingWorker(c);
				}
				return untilAborted(c.signal);
			},
		},
	});
	const t = run.result.timing;
	check(
		"15 timing: workerCalls counts the ideation worker and every best-of-N candidate, canceled ones included",
		run.result.converged && run.calls.filter(isCandidate).length === 3 && t.workerCalls === 4,
		t,
	);
	check(
		"15 timing: the counts add up to calls and the gate ran once per examined candidate",
		t.managerCalls === 3 &&
			t.managerCalls + t.workerCalls === run.result.calls &&
			t.gateRuns === 2 &&
			t.gateRuns === gateExecutions("c15"),
		[t, run.result.calls, gateExecutions("c15")],
	);
	check("15 timing: the kept candidate's delay is in workerMs", t.workerMs >= 150 - TIMER_SLACK_MS, t);
}

async function case16AbortTiming(): Promise<void> {
	const repo = newRepo("c16");
	const abort = new AbortController();
	const run = await runCase({
		name: "c16",
		repo,
		config: "off",
		signal: abort.signal,
		script: {
			manage: () => managerReply("continue", "make it pass"),
			work: (c) => {
				setTimeout(() => abort.abort(), 30);
				return untilAborted(c.signal);
			},
		},
	});
	const t = run.result.timing;
	check(
		"16 abort: the aborted run still carries its timing, the aborted spawn included",
		run.result.stop === "aborted" &&
			t.managerCalls === 2 &&
			t.workerCalls === 2 &&
			t.managerCalls + t.workerCalls === run.result.calls &&
			t.workerMs > 0,
		[run.result.stop, t],
	);

	const gateRepo = newRepo("c16g");
	const gateAbort = new AbortController();
	const marker = join(root, "c16g.gate-started");
	const poll = setInterval(() => {
		if (!existsSync(marker)) return;
		clearInterval(poll);
		gateAbort.abort();
	}, 20);
	const gating = await runCase({
		name: "c16g",
		repo: gateRepo,
		config: "off",
		signal: gateAbort.signal,
		gate: `touch "${marker}"; sleep 30`,
		script: { manage: () => managerReply("continue", "make it pass"), work: passingWorker },
	});
	clearInterval(poll);
	check(
		"16 abort: a gate aborted mid-run is timed and counted",
		gating.result.stop === "aborted" && gating.result.timing.gateRuns === 1 && gating.result.timing.gateMs > 0,
		[gating.result.stop, gating.result.timing],
	);
}

async function case17SpawnFailureTiming(): Promise<void> {
	const repo = newRepo("c17");
	const run = await runCase({
		name: "c17",
		repo,
		config: "off",
		script: { manage: () => managerReply("continue", "make it pass"), work: () => failed() },
	});
	const t = run.result.timing;
	check(
		"17 spawn failure: two failed workers stop the run and every spawn, failed ones included, is counted",
		run.result.stop === "spawn-failure" &&
			t.managerCalls === 2 &&
			t.workerCalls === 3 &&
			t.managerCalls + t.workerCalls === run.result.calls &&
			t.gateRuns === 1 &&
			t.gateRuns === gateExecutions("c17"),
		[run.result.stop, t, gateExecutions("c17")],
	);
}

/** Replies from `answers` in order, counting every question put to it. */
function scriptedConfirm(answers: (FanoutAnswer | "throw")[]): {
	confirm: NonNullable<LoopDeps["confirmFanout"]>;
	asks: { iter: number; n: number; reason: string | null }[];
} {
	const asks: { iter: number; n: number; reason: string | null }[] = [];
	const confirm: NonNullable<LoopDeps["confirmFanout"]> = async (ask) => {
		asks.push(ask);
		const answer = answers[asks.length - 1] ?? answers[answers.length - 1];
		if (answer === "throw") throw new Error("no dialog");
		return answer;
	};
	return { confirm, asks };
}

/** Two best-of-n recommendations in a row, with workers that fail, so the run stops after the second round. */
const twoRoundScript: Script = {
	manage: () => managerReply("continue", "make it pass", "best-of-n: uncertain approach"),
	work: () => failed(),
};

const briefDowngrades = (run: Run) => run.rows.filter((r) => r.role === "brief").map((r) => r.downgrade);
const fanoutRows = (run: Run) => run.rows.filter((r) => r.role === "fanout").length;

async function case18AskAccept(): Promise<void> {
	const repo = newRepo("c18");
	const { confirm, asks } = scriptedConfirm(["yes"]);
	const run = await runCase({
		name: "c18",
		repo,
		config: "ask",
		n: 3,
		confirm,
		script: {
			manage: (n) =>
				n === 1
					? managerReply("continue", "make it pass", "best-of-n: uncertain approach")
					: managerReply("done", ""),
			work: passingWorker,
		},
	});
	const brief = run.rows.find((r) => r.role === "brief");
	check(
		"18 ask accept: the manager prompt asks for a MODE",
		run.calls.filter(isManage).length === 2 && run.calls.filter(isManage).every((c) => c.prompt.includes("### MODE")),
	);
	check(
		"18 ask accept: asked once with the round, the candidate count and the manager's reason",
		JSON.stringify(asks) === JSON.stringify([{ iter: 1, n: 3, reason: "uncertain approach" }]),
		asks,
	);
	check(
		"18 ask accept: the round ran as best-of-N with a fanout row and three candidate spawns",
		run.result.converged &&
			brief?.mode === "best-of-n" &&
			fanoutRows(run) === 1 &&
			run.calls.filter(isCandidate).length === 3 &&
			run.result.fanout?.rounds === 1 &&
			run.result.fanout.downgrades.length === 0,
		[brief, run.result.fanout],
	);
	check("18 ask accept: the summary counts one question", run.result.fanout?.asked === 1, run.result.fanout);
	const handoff = handoffBlock(repo, run.result);
	check("18 ask accept: the hand-off says Asked: 1.", handoff.includes(" Asked: 1."), handoff);
	const auditLog = join(root, "c18.audit.jsonl");
	auditRun({ ...run.cfg, auditLog }, { entry: "tool", session: "sess", cwd: repo }, run.result, {
		task: "Make the gate pass.",
		durationMs: 1,
		calls: run.result.calls,
		tokens: run.result.tokens,
	});
	const audited = JSON.parse(readFileSync(auditLog, "utf8").trim()) as { fanout: { asked: number; setting: string } };
	check(
		"18 ask accept: the audit row carries the asked count",
		audited.fanout.asked === 1 && audited.fanout.setting === "ask",
		audited.fanout,
	);
}

async function case19AskDecline(): Promise<void> {
	const repo = newRepo("c19");
	const { confirm, asks } = scriptedConfirm(["no"]);
	const run = await runCase({ name: "c19", repo, config: "ask", confirm, script: twoRoundScript });
	check(
		"19 ask decline: both rounds ran serially as declined",
		run.calls.filter(isCandidate).length === 0 &&
			run.calls.filter(isWork).length === 2 &&
			JSON.stringify(briefDowngrades(run)) === JSON.stringify(["declined", "declined"]) &&
			JSON.stringify(run.result.fanout?.downgrades) === JSON.stringify(["declined"]) &&
			run.result.fanout?.rounds === 0 &&
			fanoutRows(run) === 0,
		[briefDowngrades(run), run.result.fanout],
	);
	check(
		"19 ask decline: a plain no is asked again on the next best-of-n round",
		asks.length === 2 && run.result.fanout?.asked === 2,
		[asks, run.result.fanout],
	);
	check(
		"19 ask decline: the hand-off says Asked: 2. and lists the downgrade",
		handoffBlock(repo, run.result).includes("Downgrades: declined. Asked: 2."),
		handoffBlock(repo, run.result),
	);
	const single = scriptedConfirm(["no"]);
	const serialAfterNo = await runCase({
		name: "c19b",
		repo: newRepo("c19b"),
		config: "ask",
		confirm: single.confirm,
		script: {
			manage: (n) =>
				n === 1 ? managerReply("continue", "make it pass", "best-of-n: retry") : managerReply("done", ""),
			work: passingWorker,
		},
	});
	check(
		"19 ask decline: a declined round still converges on the serial worker",
		serialAfterNo.result.converged &&
			serialAfterNo.calls.filter(isWork).length === 1 &&
			serialAfterNo.calls.filter(isWork)[0].label === "work",
		serialAfterNo.result,
	);
}

async function case20AskRemember(): Promise<void> {
	const yes = scriptedConfirm(["yes-run"]);
	const yesRun = await runCase({
		name: "c20a",
		repo: newRepo("c20a"),
		config: "ask",
		confirm: yes.confirm,
		script: twoRoundScript,
	});
	check(
		"20 yes-run: asked once across two best-of-n rounds, both fanned out",
		yes.asks.length === 1 &&
			yesRun.result.fanout?.asked === 1 &&
			yesRun.result.fanout.rounds === 2 &&
			fanoutRows(yesRun) === 2 &&
			yesRun.calls.filter(isCandidate).length === 4,
		[yes.asks.length, yesRun.result.fanout],
	);

	const no = scriptedConfirm(["no-run"]);
	const noRun = await runCase({
		name: "c20b",
		repo: newRepo("c20b"),
		config: "ask",
		confirm: no.confirm,
		script: twoRoundScript,
	});
	check(
		"20 no-run: asked once, both rounds ran serially as declined",
		no.asks.length === 1 &&
			noRun.result.fanout?.asked === 1 &&
			noRun.calls.filter(isCandidate).length === 0 &&
			noRun.calls.filter(isWork).length === 2 &&
			JSON.stringify(briefDowngrades(noRun)) === JSON.stringify(["declined", "declined"]),
		[no.asks.length, noRun.result.fanout, briefDowngrades(noRun)],
	);
}

async function case21AskNoUi(): Promise<void> {
	const repo = newRepo("c21");
	const run = await runCase({ name: "c21", repo, config: "ask", script: twoRoundScript });
	check(
		"21 ask no-ui: best-of-n recommendations run serially as no-ui without blocking",
		run.calls.filter(isCandidate).length === 0 &&
			run.calls.filter(isWork).length === 2 &&
			JSON.stringify(briefDowngrades(run)) === JSON.stringify(["no-ui", "no-ui"]) &&
			JSON.stringify(run.result.fanout?.downgrades) === JSON.stringify(["no-ui"]),
		[briefDowngrades(run), run.result.fanout],
	);
	check("21 ask no-ui: nothing was asked", run.result.fanout?.asked === 0, run.result.fanout);
	check(
		"21 ask no-ui: the hand-off says Asked: 0.",
		handoffBlock(repo, run.result).includes("Downgrades: no-ui. Asked: 0."),
		handoffBlock(repo, run.result),
	);
}

async function case22AskFailed(): Promise<void> {
	const thrown = scriptedConfirm(["throw", "error"]);
	const run = await runCase({
		name: "c22",
		repo: newRepo("c22"),
		config: "ask",
		confirm: thrown.confirm,
		script: twoRoundScript,
	});
	check(
		"22 ask-failed: a throwing callback and an error answer both run serially as ask-failed",
		run.calls.filter(isCandidate).length === 0 &&
			run.calls.filter(isWork).length === 2 &&
			JSON.stringify(briefDowngrades(run)) === JSON.stringify(["ask-failed", "ask-failed"]) &&
			JSON.stringify(run.result.fanout?.downgrades) === JSON.stringify(["ask-failed"]),
		[briefDowngrades(run), run.result.fanout],
	);
	check(
		"22 ask-failed: the failure is not remembered, so the next round asks again",
		thrown.asks.length === 2 && run.result.fanout?.asked === 2,
		[thrown.asks.length, run.result.fanout],
	);
}

async function case23AskNoDialog(): Promise<void> {
	const never = scriptedConfirm(["yes"]);
	const serial = await runCase({
		name: "c23a",
		repo: newRepo("c23a"),
		config: "ask",
		confirm: never.confirm,
		script: {
			manage: (n) =>
				n === 1 ? managerReply("continue", "make it pass", "serial: simple") : managerReply("done", ""),
			work: passingWorker,
		},
	});
	check(
		"23 no dialog: a serial recommendation runs one worker with no question",
		never.asks.length === 0 &&
			serial.result.converged &&
			serial.calls.filter(isWork).length === 1 &&
			briefDowngrades(serial)[0] === null &&
			serial.result.fanout?.asked === 0,
		[never.asks, briefDowngrades(serial)],
	);

	const fleetConfirm = scriptedConfirm(["yes"]);
	const fleet = await runCase({
		name: "c23b",
		repo: newRepo("c23b"),
		config: "ask",
		confirm: fleetConfirm.confirm,
		script: {
			manage: (n) =>
				n === 1 ? managerReply("continue", "make it pass", "fleet: two parts") : managerReply("done", ""),
			work: passingWorker,
		},
	});
	check(
		"23 no dialog: a fleet recommendation is fleet-unavailable with no question",
		fleetConfirm.asks.length === 0 &&
			fleet.calls.filter(isCandidate).length === 0 &&
			briefDowngrades(fleet)[0] === "fleet-unavailable" &&
			fleet.result.fanout?.asked === 0,
		[fleetConfirm.asks, briefDowngrades(fleet)],
	);

	const gateConfirm = scriptedConfirm(["yes"]);
	const noGate = await runCase({
		name: "c23c",
		repo: newRepo("c23c"),
		config: "ask",
		gate: null,
		confirm: gateConfirm.confirm,
		script: {
			manage: (n) =>
				n === 1 ? managerReply("continue", "make it pass", "best-of-n: uncertain") : managerReply("done", ""),
			work: passingWorker,
		},
	});
	check(
		"23 no dialog: a round with no gate is no-gate with no question",
		gateConfirm.asks.length === 0 &&
			noGate.calls.filter(isCandidate).length === 0 &&
			briefDowngrades(noGate)[0] === "no-gate" &&
			noGate.result.fanout?.asked === 0,
		[gateConfirm.asks, briefDowngrades(noGate)],
	);
}

async function case24AskAbort(): Promise<void> {
	const repo = newRepo("c24");
	const abort = new AbortController();
	let asked = 0;
	let dialogSignal: AbortSignal | undefined;
	const run = await runCase({
		name: "c24",
		repo,
		config: "ask",
		signal: abort.signal,
		confirm: async (_ask, signal) => {
			asked++;
			dialogSignal = signal;
			abort.abort();
			return "yes";
		},
		script: twoRoundScript,
	});
	check(
		"24 ask abort: aborting while the dialog is open stops the run and spawns no worker",
		asked === 1 && run.result.stop === "aborted" && !run.result.converged && run.calls.filter(isWork).length === 0,
		[asked, run.result.stop, run.calls.map((c) => c.label)],
	);
	check("24 ask abort: the dialog receives the run's abort signal", dialogSignal === abort.signal);
	check(
		"24 ask abort: no worktrees and no fanout row are left behind",
		worktreeCount(repo) === 1 && fanoutRows(run) === 0 && candidateDirs(run.ledger).length === 0,
	);
}

function case25LowerAsk(): void {
	check("25 lowerFanout: an override of ask lowers on", lowerFanout("on", "ask") === "ask");
	check("25 lowerFanout: advise lowers ask", lowerFanout("ask", "advise") === "advise");
	check("25 lowerFanout: on cannot raise ask", lowerFanout("ask", "on") === "ask");
	check("25 lowerFanout: ask holds ask", lowerFanout("ask", "ask") === "ask");
	check("25 lowerFanout: ask cannot raise off", lowerFanout("off", "ask") === "off");
}

async function case26AskLatchAndUnknownAnswer(): Promise<void> {
	const repo = newRepo("c26a");
	const turnDir = join(stateDir, "sess", `turn-${runCounter + 1}`);
	mkdirSync(turnDir, { recursive: true });
	writeFileSync(join(turnDir, "candidates"), "a regular file where the candidates directory goes");
	const yes = scriptedConfirm(["yes-run"]);
	const latched = await runCase({
		name: "c26a",
		repo,
		config: "ask",
		n: 2,
		confirm: yes.confirm,
		script: {
			manage: (n) =>
				n === 3 ? managerReply("done", "") : managerReply("continue", `task ${n}`, "best-of-n: uncertain"),
			work: passingWorker,
		},
	});
	check(
		"26 latch under ask: a remembered yes-run does not bypass the latch, so the second round is serial and not asked",
		yes.asks.length === 1 &&
			JSON.stringify(latched.result.fanout?.downgrades) === JSON.stringify(["setup-failed", "latched"]) &&
			briefDowngrades(latched).includes("latched"),
		[yes.asks.length, latched.result.fanout, briefDowngrades(latched)],
	);

	const unknown = scriptedConfirm(["maybe" as FanoutAnswer]);
	const run = await runCase({
		name: "c26b",
		repo: newRepo("c26b"),
		config: "ask",
		confirm: unknown.confirm,
		script: twoRoundScript,
	});
	check(
		"26 unknown answer: a consent answer the loop does not know never fans out",
		fanoutRows(run) === 0 &&
			run.calls.filter(isCandidate).length === 0 &&
			JSON.stringify(briefDowngrades(run)) === JSON.stringify(["declined", "declined"]),
		[run.result.fanout, briefDowngrades(run)],
	);
}

async function main(): Promise<void> {
	mkdirSync(root, { recursive: true });
	writeFileSync(configFile, `stateDir = "${stateDir}"\nproviders = ["test"]\n`);

	await case1Off();
	await case2Advise();
	await case3OnCandidateTwoPasses();
	await case4NonePass();
	await case5AllFail();
	await case6NoGate();
	await case7OverrideLowers();
	await case8Escape();
	await case8GateEscape();
	await case9Abort();
	await case10DirtyState();
	await case11StaleWorktrees();
	await case12FleetUnavailable();
	await case13SetupFailed();
	await case14SerialTiming();
	await case15BestOfNTiming();
	await case16AbortTiming();
	await case17SpawnFailureTiming();
	await case18AskAccept();
	await case19AskDecline();
	await case20AskRemember();
	await case21AskNoUi();
	await case22AskFailed();
	await case23AskNoDialog();
	await case24AskAbort();
	case25LowerAsk();
	await case26AskLatchAndUnknownAnswer();

	rmSync(root, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
