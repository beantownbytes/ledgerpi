import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Dispatcher, type Engine, type StepTurn } from "../packages/claude/src/dispatch.ts";
import { acquireLock, lockDir, lockHolder } from "../packages/claude/src/lock.ts";
import type { LedgerEvent, StepEvent, StepReply } from "../packages/claude/src/protocol.ts";
import { rendezvous } from "../packages/claude/src/rendezvous.ts";
import {
	CLAUDE_MANAGER_DEFAULT,
	CLAUDE_WORKER_DEFAULT,
	type LedgerpiConfig,
	loadConfig,
} from "../packages/core/src/config.ts";
import { deadPid, TIMING_KEYS } from "./helpers.ts";

const root = join(tmpdir(), `ledgerpi-claude-test-${process.pid}`);
const repo = join(root, "repo");
const stateDir = join(root, "state");
const auditLog = join(root, "runs.jsonl");
const configFile = join(root, "config.toml");
const entry = resolve(import.meta.dirname, "../packages/claude/src/bin/ledgerctl.ts");
const coreDir = resolve(import.meta.dirname, "../packages/core/src");

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
const CONTINUE = "### STATUS\ncontinue\n\n### NEXT\nFix it\n";
const DONE = "### STATUS\ndone\n\n### NEXT\n\n";

const USAGE = {
	model: "claude-sonnet-5-5",
	input_tokens: 10,
	output_tokens: 20,
	cache_read_input_tokens: 30,
	cache_creation_input_tokens: 40,
};

function writeConfig(body: string): void {
	writeFileSync(configFile, `stateDir = "${stateDir}"\nauditLog = "${auditLog}"\nmaxIters = 2\n${body}`);
}

const ROLES = { manager: "m-1", worker: "w-1" };

const CLAUDE_CONFIG = '[claude]\nmanager = "claude-opus-5-5"\nworker = "claude-sonnet-5-5"\n';

function reply(step: StepEvent, body: StepReply): void {
	writeFileSync(step.replyFile, JSON.stringify(body));
}

/** The answer a healthy sub-agent gives to `step`, driven by how far the run has got. */
function scripted(step: StepEvent, manageReply: string): StepReply {
	const text =
		step.role === "manager"
			? step.description.includes("plan")
				? PLAN
				: manageReply
			: step.description.includes("ideate")
				? IDEAS
				: WORKED;
	return { status: "answer", text, usage: { ...USAGE, model: step.model }, durationMs: 5 };
}

interface Played {
	events: LedgerEvent[];
	code: number | null;
	stderr: string;
}

/** Run `ledgerctl solve` and play the mod, calling `onEvent` for every line. */
function solve(
	task: string,
	onEvent: (event: LedgerEvent, child: ChildProcess) => void,
	args: string[] = [],
	env: Record<string, string> = {},
): Promise<Played> {
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", entry, "solve", `--cwd=${repo}`, "--session=s1", ...args],
		{ env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] },
	);
	const events: LedgerEvent[] = [];
	let buffer = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		buffer += String(chunk);
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			const event = JSON.parse(buffer.slice(0, end)) as LedgerEvent;
			buffer = buffer.slice(end + 1);
			events.push(event);
			if (event.type === "stop") writeFileSync(event.stoppedFile, "{}");
			onEvent(event, child);
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	child.stdin.end(task);
	return new Promise((done) => child.on("close", (code) => done({ events, code, stderr })));
}

function ctl(args: string[], input?: string): { code: number; stdout: string } {
	try {
		const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", entry, ...args], {
			encoding: "utf8",
			input,
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 15_000,
		});
		return { code: 0, stdout };
	} catch (err) {
		const failed = err as { status: number; stdout: string };
		return { code: failed.status, stdout: failed.stdout };
	}
}

function lastRow(): Record<string, any> {
	const rows = readFileSync(auditLog, "utf8").trimEnd().split("\n");
	return JSON.parse(rows[rows.length - 1] ?? "{}");
}

function resetRepo(): void {
	execFileSync("git", ["reset", "-q", "--hard"], { cwd: repo });
	execFileSync("git", ["clean", "-qfd"], { cwd: repo });
}

const handoff = (played: Played) =>
	played.events.flatMap((e) => (e.type === "done" ? [e.handoff] : e.type === "refused" ? [e.reason] : []))[0] ?? "";

const steps = (played: Played) => played.events.filter((e): e is StepEvent => e.type === "step");

async function testConverged(): Promise<void> {
	writeConfig(CLAUDE_CONFIG);
	const played = await solve(
		"Create the fixed file.",
		(event) => {
			if (event.type !== "step") return;
			if (event.role === "worker" && !event.description.includes("ideate")) {
				writeFileSync(join(event.cwd, "fixed"), "1");
			}
			reply(event, scripted(event, existsSync(join(event.cwd, "fixed")) ? DONE : CONTINUE));
		},
		["--gate=test -f fixed"],
	);
	const all = steps(played);
	const manager = all.find((s) => s.role === "manager");
	const worker = all.find((s) => s.role === "worker");
	check("solve exits 0 on a converged run", played.code === 0, played);
	check("the manager step names its namespaced agent and model", manager?.agent === "ledgerpi:ledger-manager");
	check("the manager step carries the configured model", manager?.model === "claude-opus-5-5", manager);
	check("the worker step names its namespaced agent", worker?.agent === "ledgerpi:ledger-worker", worker);
	check("the worker step carries the configured model", worker?.model === "claude-sonnet-5-5", worker);
	check("steps run in the requested checkout", realpathSync(worker?.cwd ?? "/") === realpathSync(repo), worker);
	check(
		"progress events are emitted",
		played.events.some((e) => e.type === "progress"),
	);
	check("the hand-off reports the passing gate", handoff(played).includes("Gate: passed"), handoff(played));
	const row = lastRow();
	check("the audit row is marked as a claude tool run", row.harness === "claude" && row.entry === "tool", row);
	check("the audit row has no session model", row.model === null && row.provider === "anthropic", row);
	check("the audit row names the observed models", row.managerModel === "claude-opus-5-5", row);
	check("the audit row records per-role tokens", row.managerTokens > 0 && row.workerTokens > 0, row);
	check("role tokens add up to the run total", row.managerTokens + row.workerTokens === row.tokens, row);
	check(
		"the audit row records per-role timing as numbers",
		TIMING_KEYS.every((k) => typeof row[k] === "number"),
		row,
	);
	check(
		"role call counts add up to the run's calls and the gate ran",
		row.managerCalls + row.workerCalls === row.calls && row.gateRuns >= 1,
		row,
	);
	check("the lock is released", lockHolder(stateDir, realpathSync(repo)) === null);
}

async function testRedGateOverridesDone(): Promise<void> {
	resetRepo();
	let manages = 0;
	const played = await solve(
		"Claim done without doing it.",
		(event) => {
			if (event.type !== "step") return;
			if (event.role === "manager" && !event.description.includes("plan")) manages += 1;
			reply(event, scripted(event, manages > 1 ? DONE : CONTINUE));
		},
		["--gate=false"],
	);
	check("a red gate overrides a done verdict", !lastRow().converged && lastRow().gate.passed === false, lastRow());
	check("the hand-off reports the red gate", handoff(played).includes("Gate: FAILED"), handoff(played));
}

async function testEmptyAnswerAtTurnLimit(): Promise<void> {
	resetRepo();
	await solve(
		"Edit, then run out of turns.",
		(event) => {
			if (event.type !== "step") return;
			if (event.role === "worker" && !event.description.includes("ideate")) {
				writeFileSync(join(event.cwd, "fixed"), "1");
				reply(event, { status: "answer", text: "", usage: USAGE });
				return;
			}
			reply(event, scripted(event, existsSync(join(event.cwd, "fixed")) ? DONE : CONTINUE));
		},
		["--gate=test -f fixed"],
	);
	check("an empty answer at the turn limit still counts its edits", lastRow().converged === true, lastRow());
}

async function testStepTimeout(): Promise<void> {
	resetRepo();
	writeConfig(`callTimeoutMs = 300\n${CLAUDE_CONFIG}`);
	const played = await solve("Hang.", () => {}, ["--gate=true"]);
	const first = steps(played)[0];
	check(
		"a silent step gets a stop event",
		played.events.some((e) => e.type === "stop" && e.id === first?.id),
		played.events,
	);
	const row = lastRow();
	check("a silent step is audited as a timeout", row.stop === "spawn-failure" && row.stopDetail === "timeout", row);
	writeConfig(CLAUDE_CONFIG);
}

async function testEmptyManagerAnswer(): Promise<void> {
	resetRepo();
	const played = await solve(
		"Plan nothing.",
		(event) => {
			if (event.type === "step") reply(event, { status: "answer", text: "  \n", usage: USAGE });
		},
		["--gate=true"],
	);
	check("an empty plan starts no worker", steps(played).length === 1, steps(played));
	const row = lastRow();
	check(
		"an empty manager answer is audited as a failed agent",
		row.stop === "spawn-failure" && row.stopDetail === "agent-error",
		row,
	);
}

async function testRefusedSpawn(): Promise<void> {
	resetRepo();
	await solve(
		"Refuse.",
		(event) => {
			if (event.type === "step") reply(event, { status: "refused", error: "spawn refused" });
		},
		["--gate=true"],
	);
	const row = lastRow();
	check("a refused spawn is audited as refused", row.stop === "spawn-failure" && row.stopDetail === "refused", row);
}

async function testAbort(): Promise<void> {
	resetRepo();
	const played = await solve(
		"Run until signaled.",
		(event, child) => {
			if (event.type === "step") child.kill("SIGTERM");
		},
		["--gate=true"],
	);
	check(
		"SIGTERM stops the running step",
		played.events.some((e) => e.type === "stop"),
		played.events,
	);
	check("an aborted run reports it", handoff(played).includes("aborted"), played.events);
	check("an aborted run is audited", lastRow().stop === "aborted", lastRow());
	check("an aborted run releases the lock", lockHolder(stateDir, realpathSync(repo)) === null);
}

async function testStopCommand(): Promise<void> {
	resetRepo();
	let stopped: { code: number; stdout: string } | undefined;
	await solve(
		"Run until stopped.",
		(event) => {
			if (event.type === "step" && stopped === undefined) stopped = ctl(["stop", `--cwd=${repo}`]);
		},
		["--gate=true"],
	);
	check("ledgerctl stop finds the running loop", stopped?.stdout.includes("stopping") === true, stopped);
	check("ledgerctl stop ends the run as aborted", lastRow().stop === "aborted", lastRow());
	check("ledgerctl stop with no run says so", ctl(["stop", `--cwd=${repo}`]).stdout.includes("no ledger loop"));
}

async function testModelMismatch(): Promise<void> {
	resetRepo();
	const played = await solve(
		"Run on the wrong model.",
		(event) => {
			if (event.type !== "step") return;
			if (event.role === "worker" && !event.description.includes("ideate")) {
				writeFileSync(join(event.cwd, "fixed"), "1");
			}
			const answer = scripted(event, existsSync(join(event.cwd, "fixed")) ? DONE : CONTINUE);
			reply(event, event.role === "worker" ? { ...answer, usage: { ...USAGE, model: "claude-other-1" } } : answer);
		},
		["--gate=test -f fixed"],
	);
	check(
		"a model that differs from the config is reported",
		handoff(played).includes("The worker ran on claude-other-1, not the configured claude-sonnet-5-5."),
		handoff(played),
	);
	check("the audit row names the model that ran", lastRow().workerModel === "claude-other-1", lastRow());
}

/** Checks that `played` is a punt: exit 3, the implement-it-yourself hand-off, and `needle` as the reason. */
function refusedWith(label: string, needle: string, played: Played): void {
	const text = handoff(played);
	check(`${label}: exits 3`, played.code === 3, played);
	check(`${label}: tells the model to do the work`, text.includes("Implement the task directly."), text);
	check(`${label}: says why`, text.includes(needle), text);
}

async function testRefusals(): Promise<void> {
	resetRepo();
	const unused = (event: LedgerEvent) => check("a refused run starts no step", event.type !== "step", event);

	writeConfig("");
	refusedWith("no [claude] section", "[claude]", await solve("Task.", unused));
	writeConfig(`enabled = false\n${CLAUDE_CONFIG}`);
	refusedWith("enabled = false", "enabled = false", await solve("Task.", unused));
	writeConfig(CLAUDE_CONFIG);
	refusedWith("LEDGERPI=0", "LEDGERPI=0", await solve("Task.", unused, [], { LEDGERPI: "0" }));
	refusedWith("empty task", "No task", await solve("  \n", unused));
	const outside = join(root, "not-a-repo");
	mkdirSync(outside, { recursive: true });
	refusedWith("not a git repo", "git repository", await solve("Task.", unused, [`--cwd=${outside}`]));

	const release = acquireLock(stateDir, realpathSync(repo));
	const busy = await solve("Task.", unused);
	check("lock held: exits 3", busy.code === 3, busy);
	check("lock held: says to wait or stop", handoff(busy).includes("ledgerctl stop"), handoff(busy));
	const heldTree = realpathSync(repo);
	check(
		"lock held: names a stop command for that tree",
		handoff(busy).includes(`ledgerctl stop --cwd '${heldTree}'`),
		handoff(busy),
	);
	check(
		"lock held: names the status command that reports the lock",
		handoff(busy).includes(`ledgerctl status --json --cwd '${heldTree}'`),
		handoff(busy),
	);
	check(
		"lock held: never invites edits beside the loop",
		!handoff(busy).includes("Implement the task"),
		handoff(busy),
	);
	release?.();

	writeConfig('[claude]\nworker = "sonnet"\n');
	const warned = await solve("  \n", unused);
	check("solve reports config warnings on stderr", warned.stderr.includes("[claude] worker"), warned.stderr);
	writeConfig(CLAUDE_CONFIG);
}

async function testPlanFile(): Promise<void> {
	resetRepo();
	writeConfig(CLAUDE_CONFIG);
	const unused = (event: LedgerEvent) => check("a rejected plan file starts no step", event.type !== "step", event);
	const missing = join(root, "no-such-plan.md");
	refusedWith("a missing plan file", `\`${missing}\``, await solve("Task.", unused, [`--plan-file=${missing}`]));
	const empty = join(root, "empty-plan.md");
	writeFileSync(empty, "  \n\t\n");
	refusedWith("an empty plan file", `\`${empty}\` is empty`, await solve("Task.", unused, [`--plan-file=${empty}`]));
	const release = acquireLock(stateDir, realpathSync(repo));
	const beforeLock = await solve("Task.", unused, [`--plan-file=${missing}`]);
	release?.();
	check(
		"a plan file is checked before the lock: a held lock still yields the plan-file refusal",
		handoff(beforeLock).includes(`\`${missing}\``) && !handoff(beforeLock).includes("Another ledger loop"),
		handoff(beforeLock),
	);

	const planPath = join(root, "plan.md");
	writeFileSync(planPath, "\n## Approved plan\nCreate the fixed file.\n\n");
	const played = await solve(
		"Create the fixed file.",
		(event) => {
			if (event.type !== "step") return;
			if (event.role === "worker") writeFileSync(join(event.cwd, "fixed"), "1");
			reply(event, scripted(event, existsSync(join(event.cwd, "fixed")) ? DONE : CONTINUE));
		},
		["--gate=test -f fixed", `--plan-file=${planPath}`],
	);
	const all = steps(played);
	check("a plan file: solve exits 0", played.code === 0, played);
	check(
		"a plan file: the first step is the manager in phase manage",
		all[0]?.role === "manager" && all[0].description.includes("manage"),
		all[0],
	);
	check(
		"a plan file: no plan or ideate step runs",
		all.every((s) => !s.description.includes("plan") && !s.description.includes("ideate")),
		all.map((s) => s.description),
	);
	check(
		"a plan file: the manager prompt carries the trimmed plan",
		all[0]?.prompt.includes("## Approved plan\nCreate the fixed file.") === true,
		all[0]?.prompt,
	);
	check(
		"a plan file: the audit row names the caller as the plan source",
		lastRow().planSource === "caller",
		lastRow(),
	);
}

/**
 * Run a converging `ledgerctl solve` under `settings` (top-level config) and `--fanout` args; report the manage prompt and audit row.
 * `mode`, when given, is the `### MODE` section the manager's continue replies carry.
 */
async function fanoutRun(settings: string, args: string[], mode = "") {
	resetRepo();
	writeConfig(`${settings}${CLAUDE_CONFIG}`);
	const played = await solve(
		"Create the fixed file.",
		(event) => {
			if (event.type !== "step") return;
			if (event.role === "worker" && !event.description.includes("ideate")) {
				writeFileSync(join(event.cwd, "fixed"), "1");
			}
			reply(event, scripted(event, existsSync(join(event.cwd, "fixed")) ? DONE : `${CONTINUE}${mode}`));
		},
		["--gate=test -f fixed", ...args],
	);
	const manage = steps(played).find((s) => s.role === "manager" && s.description.endsWith(", manage)"));
	return { played, asksMode: manage?.prompt.includes("### MODE") === true, fanout: lastRow().fanout };
}

async function testSolveFanout(): Promise<void> {
	const lowered = await fanoutRun('fanout = "on"\n', ["--fanout=advise"]);
	check(
		"--fanout lowers the configured setting",
		lowered.played.code === 0 && lowered.fanout?.setting === "advise",
		lowered,
	);
	check("a lowered run still asks the manager for a MODE", lowered.asksMode, lowered);

	const off = await fanoutRun('fanout = "advise"\n', ["--fanout=off"]);
	check("--fanout off turns the configured fan-out off", off.played.code === 0 && off.fanout === null, off);
	check("an off run does not ask for a MODE", !off.asksMode, off);

	const raised = await fanoutRun('fanout = "off"\n', ["--fanout=on"]);
	check("--fanout never raises the configured setting", raised.played.code === 0 && raised.fanout === null, raised);
	check("a raise attempt does not ask for a MODE", !raised.asksMode, raised);
	check("a valid --fanout prints no warning", !raised.played.stderr.includes("--fanout"), raised.played.stderr);

	const invalid = await fanoutRun('fanout = "advise"\n', ["--fanout=turbo"]);
	check("an invalid --fanout does not fail the run", invalid.played.code === 0, invalid.played);
	check("an invalid --fanout leaves the configured setting", invalid.fanout?.setting === "advise", invalid);
	const warnings = invalid.played.stderr.split("\n").filter((line) => line.includes("--fanout"));
	check(
		"an invalid --fanout warns once",
		warnings.length === 1 && warnings[0].includes("turbo"),
		invalid.played.stderr,
	);

	const blank = await fanoutRun('fanout = "advise"\n', ["--fanout="]);
	check(
		"a blank --fanout is ignored with a warning",
		blank.played.code === 0 && blank.played.stderr.includes("--fanout"),
		blank,
	);

	const asking = await fanoutRun('fanout = "on"\n', ["--fanout=ask"], "\n### MODE\nbest-of-n: uncertain approach\n");
	check(
		"--fanout ask is accepted without a warning",
		asking.played.code === 0 && !asking.played.stderr.includes("--fanout"),
		asking.played,
	);
	check("--fanout ask lowers configured on to ask", asking.fanout?.setting === "ask", asking.fanout);
	check("an ask run asks the manager for a MODE", asking.asksMode, asking);
	check(
		"ledgerctl cannot ask: a recommended best-of-n round runs serially as no-ui",
		asking.fanout?.rounds === 0 && asking.fanout.asked === 0 && asking.fanout.downgrades.join(",") === "no-ui",
		asking.fanout,
	);

	const askConfigured = await fanoutRun('fanout = "ask"\n', [], "\n### MODE\nserial: shared files\n");
	check(
		"a configured ask with a serial recommendation asks nothing and records no downgrade",
		askConfigured.fanout?.setting === "ask" &&
			askConfigured.fanout.asked === 0 &&
			askConfigured.fanout.downgrades.length === 0,
		askConfigured.fanout,
	);
}

async function testRefusalStopsFromAnotherTree(): Promise<void> {
	writeConfig(CLAUDE_CONFIG);
	resetRepo();
	const worktree = join(root, "wt it's here");
	const shimDir = join(root, "shim");
	execFileSync("git", ["worktree", "add", "-q", "--detach", worktree], { cwd: repo });
	try {
		const treeRoot = realpathSync(worktree);
		mkdirSync(shimDir, { recursive: true });
		const shim = join(shimDir, "ledgerctl");
		writeFileSync(
			shim,
			`#!/bin/sh\nexec '${process.execPath}' --experimental-strip-types --no-warnings '${entry}' "$@"\n`,
		);
		chmodSync(shim, 0o755);

		let acted = false;
		let stopRan = false;
		const played = await solve(
			"Run until stopped from elsewhere.",
			(event, child) => {
				if (event.type !== "step" || acted) return;
				acted = true;
				try {
					const held = JSON.parse(ctl(["status", "--json", `--cwd=${worktree}`]).stdout);
					check("status reports the lock holder's tree", held.lock?.root === treeRoot, held.lock);
					check("status reports the lock holder's pid", typeof held.lock?.pid === "number", held.lock);
					const other = JSON.parse(ctl(["status", "--json", `--cwd=${repo}`]).stdout);
					check("status in another checkout reports no lock", other.lock === null, other.lock);
					const text = ctl(["status", `--cwd=${worktree}`]).stdout;
					check("status text names the lock holder", text.includes("lock: held by pid"), text);

					const second = ctl(["solve", `--cwd=${worktree}`, "--session=s2"], "Second task.");
					const events = second.stdout
						.split("\n")
						.filter((line) => line.startsWith("{"))
						.map((line) => JSON.parse(line) as LedgerEvent);
					const refusal = handoff({ events, code: second.code, stderr: "" });
					check("a second solve on the tree is refused", second.code === 3 && refusal !== "", second);

					const bare = ctl(["stop", `--cwd=${repo}`]);
					check("stop from another checkout finds no loop there", bare.stdout.includes("no ledger loop"), bare);

					const command = /`(ledgerctl stop --cwd [^`]+)`/.exec(refusal)?.[1];
					check("the refusal names a stop command", command !== undefined, refusal);
					if (command === undefined) return;
					const stopped = spawnSync("bash", ["-c", command], {
						cwd: repo,
						env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
						encoding: "utf8",
						timeout: 15_000,
					});
					stopRan = stopped.stdout.includes("stopping");
					check("the refusal's stop command stops the loop from another checkout", stopRan, stopped);
				} catch (err) {
					check("the live-loop assertions ran without throwing", false, String(err));
				} finally {
					if (!stopRan) child.kill("SIGTERM");
				}
			},
			[`--cwd=${worktree}`, "--gate=true"],
		);
		check("the loop on the other tree reached its first step", acted, played.events);
		check("the loop stopped from another checkout ends as aborted", lastRow().stop === "aborted", lastRow());
	} finally {
		execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: repo });
	}
}

/** Plant a claim on work tree `claimRoot` for `pid`, returning its path. */
function plantClaim(claimRoot: string, pid: number): string {
	const dir = lockDir(stateDir, claimRoot);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${pid}.planted`);
	writeFileSync(path, "");
	return path;
}

async function testStaleLock(): Promise<void> {
	resetRepo();
	const held = acquireLock(stateDir, realpathSync(repo));
	check("the lock is exclusive", acquireLock(stateDir, realpathSync(repo)) === null);
	held?.();
	const dead = await deadPid();
	const treeRoot = realpathSync(repo);
	const stale = plantClaim(treeRoot, dead);
	check("a dead holder reads as free", lockHolder(stateDir, treeRoot) === null);
	const taken = acquireLock(stateDir, treeRoot);
	check("a stale lock is taken over", taken !== null);
	check("a stale claim is removed", !existsSync(stale), stale);
	taken?.();

	const deadClaim = plantClaim(treeRoot, dead);
	const live = plantClaim(treeRoot, process.ppid);
	check("a live claim refuses despite a stale one", acquireLock(stateDir, treeRoot) === null);
	check("a live claim is never touched", existsSync(live), live);
	check("a refused process leaves no claim", readdirSync(lockDir(stateDir, treeRoot)).length <= 2);
	check("a live claim names its holder", lockHolder(stateDir, treeRoot)?.pid === process.ppid);
	rmSync(live);
	rmSync(deadClaim, { force: true });
	check("the lock is free once the claims go", lockHolder(stateDir, treeRoot) === null);
}

/**
 * Run `acquireLock` in `count` separate processes, released together once all have
 * started, and count the winners. Each keeps what it won until every process has
 * reported, so a late starter cannot win a lock an earlier winner has given back.
 */
async function raceForLock(count: number): Promise<number> {
	const lockModule = resolve(import.meta.dirname, "../packages/claude/src/lock.ts");
	const script = `
		import { acquireLock } from ${JSON.stringify(lockModule)};
		console.log("ready");
		process.stdin.once("data", () => {
			const release = acquireLock(${JSON.stringify(stateDir)}, "/race");
			console.log(release ? "won" : "lost");
		});
		process.stdin.on("end", () => process.exit(0));
	`;
	const children = Array.from({ length: count }, () =>
		spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], {
			stdio: ["pipe", "pipe", "ignore"],
		}),
	);
	const nextLine = (child: (typeof children)[number]) =>
		new Promise<string>((done) => {
			child.stdout.once("data", (chunk) => done(String(chunk).trim()));
		});
	await Promise.all(children.map(nextLine));
	const reports = children.map(nextLine);
	for (const child of children) child.stdin.write("go\n");
	const results = await Promise.all(reports);
	await Promise.all(
		children.map(
			(child) =>
				new Promise((done) => {
					child.on("close", done);
					child.stdin.end();
				}),
		),
	);
	return results.filter((r) => r === "won").length;
}

async function testConcurrentLock(): Promise<void> {
	const results: number[] = [];
	for (let round = 0; round < 6; round++) {
		rmSync(join(stateDir, "locks"), { recursive: true, force: true });
		if (round % 2 === 0) plantClaim("/race", await deadPid());
		results.push(await raceForLock(8));
	}
	check(
		"no two racing processes both take the lock",
		results.every((n) => n <= 1),
		results,
	);
	const after = acquireLock(stateDir, "/race");
	check("a lock is free once the racers have exited", after !== null);
	after?.();
	rmSync(join(stateDir, "locks"), { recursive: true, force: true });
}

function testLockReleaseIsOwned(): void {
	const release = acquireLock(stateDir, "/owned");
	const other = plantClaim("/owned", process.ppid);
	release?.();
	check("a release leaves another process's claim", lockHolder(stateDir, "/owned")?.pid === process.ppid);
	rmSync(other);
}

async function testToolFailureExit(): Promise<void> {
	resetRepo();
	const notADir = join(root, "plain-file");
	writeFileSync(notADir, "");
	writeFileSync(configFile, `stateDir = "${notADir}/state"\nauditLog = "${auditLog}"\n${CLAUDE_CONFIG}`);
	const played = await solve("Task.", () => {}, ["--gate=true"]);
	check("an unwritable state dir exits 2", played.code === 2, played);
	check("a tool failure prints no stack trace", !played.stderr.includes("    at "), played.stderr);

	const unreadable = ctl(["status", "--json", `--cwd=${repo}`]);
	check("status survives an unreadable lock", unreadable.code === 0, unreadable);
	const report = unreadable.code === 0 ? JSON.parse(unreadable.stdout) : {};
	check("an unreadable lock leaves the tool active", report.active === true, report);
	check("status names the lock failure", report.lock?.error?.includes("ENOTDIR") === true, report.lock);
	const text = ctl(["status", `--cwd=${repo}`]).stdout;
	check("status text says the lock is unreadable", text.includes("lock: unreadable ("), text);
	const stopped = ctl(["stop", `--cwd=${repo}`]);
	check("stop refuses to guess on an unreadable lock", stopped.code === 2, stopped);
	check("stop never reports no loop on an unreadable lock", !stopped.stdout.includes("no ledger loop"), stopped);
	writeConfig(CLAUDE_CONFIG);
}

async function testLateReply(): Promise<void> {
	const dir = join(root, "late");
	const events: LedgerEvent[] = [];
	const { spawn: spawnStep, tally } = rendezvous(dir, ROLES, (e) => events.push(e), 50);
	const result = await spawnStep({ type: "ledger-worker", prompt: "p", description: "d", timeoutMs: 50 });
	check("a step past its time resolves as a timeout", !result.ok && result.detail === "timeout", result);
	const step = events.find((e): e is StepEvent => e.type === "step");
	writeFileSync(step?.replyFile ?? join(dir, "x"), JSON.stringify({ status: "answer", text: "late", usage: USAGE }));
	await new Promise((done) => setTimeout(done, 300));
	check("a late reply is not counted", tally.tokens.worker === 0, tally);
}

async function testAbortedReply(): Promise<void> {
	const dir = join(root, "stopped");
	const events: LedgerEvent[] = [];
	const { spawn: spawnStep } = rendezvous(dir, ROLES, (e) => events.push(e));
	const pending = spawnStep({ type: "ledger-worker", prompt: "p", description: "d", timeoutMs: 2000 });
	const step = events.find((e): e is StepEvent => e.type === "step");
	writeFileSync(step?.replyFile ?? join(dir, "x"), JSON.stringify({ status: "aborted", error: "aborted" }));
	const result = await pending;
	check("a stopped sub-agent reads as aborted", !result.ok && result.detail === "aborted", result);
}

async function testPartialReplyRetried(): Promise<void> {
	const dir = join(root, "partial");
	const events: LedgerEvent[] = [];
	const { spawn: spawnStep } = rendezvous(dir, ROLES, (e) => events.push(e));
	const pending = spawnStep({ type: "ledger-manager", prompt: "p", description: "d", timeoutMs: 2000 });
	const step = events.find((e): e is StepEvent => e.type === "step");
	const file = step?.replyFile ?? join(dir, "x");
	writeFileSync(file, '{"status":"ans');
	await new Promise((done) => setTimeout(done, 300));
	writeFileSync(file, JSON.stringify({ status: "answer", text: "whole" }));
	const result = await pending;
	check("a partly written reply is retried", result.ok && result.text === "whole", result);
}

function testStatus(): void {
	writeConfig(CLAUDE_CONFIG);
	const defaults = JSON.parse(ctl(["status", "--json", `--cwd=${repo}`]).stdout);
	check(
		"status reports fanout off with the default max",
		defaults.fanout === "off" && defaults.fanoutMax === 2,
		defaults,
	);
	check(
		"status text prints the fanout line",
		ctl(["status", `--cwd=${repo}`]).stdout.includes("\nfanout: off (max 2)\n"),
	);
	writeConfig(`fanout = "advise"\nfanoutMax = 3\n${CLAUDE_CONFIG}`);
	const advising = JSON.parse(ctl(["status", "--json", `--cwd=${repo}`]).stdout);
	check("status reports a configured fanout", advising.fanout === "advise" && advising.fanoutMax === 3, advising);
	check(
		"status text prints the configured fanout",
		ctl(["status", `--cwd=${repo}`]).stdout.includes("\nfanout: advise (max 3)\n"),
	);
	writeConfig(CLAUDE_CONFIG);
	const active = JSON.parse(ctl(["status", "--json", `--cwd=${repo}`]).stdout);
	check("status reports active with the role models", active.active && active.manager === "claude-opus-5-5", active);
	check("status reports the last claude run", active.lastRun?.harness === "claude", active.lastRun);
	check("status reports no lock on a free repo", active.lock === null, active.lock);
	const elsewhere = join(root, "not-a-repo");
	mkdirSync(elsewhere, { recursive: true });
	const outsideTree = JSON.parse(ctl(["status", "--json", `--cwd=${elsewhere}`]).stdout);
	check("status reports no lock outside a git tree", outsideTree.lock === null, outsideTree.lock);
	const freeText = ctl(["status", `--cwd=${repo}`]).stdout;
	check("status text says the lock is free", freeText.includes("lock: free"), freeText);
	writeConfig('[claude]\nworker = "claude-haiku-5-5"\n');
	const partly = JSON.parse(ctl(["status", "--json", `--cwd=${repo}`]).stdout);
	check("status names a configured role's source", partly.workerSource === "config", partly);
	check("status names a defaulted role's source", partly.managerSource === "default", partly);
	check(
		"status text shows where each model came from",
		ctl(["status", `--cwd=${repo}`]).stdout.includes("worker: claude-haiku-5-5 (config)"),
	);
	writeConfig('[claude]\nworker = "sonnet"\n');
	const rejected = JSON.parse(ctl(["status", "--json", `--cwd=${repo}`]).stdout);
	check("a rejected role reads as the default", rejected.workerSource === "default", rejected);
	writeConfig(`enabled = false\n${CLAUDE_CONFIG}`);
	const switchedOff = JSON.parse(ctl(["status", "--json", `--cwd=${repo}`]).stdout);
	check("status names the master switch", switchedOff.reason?.includes("enabled = false") === true, switchedOff);
	writeConfig("");
	const inactive = JSON.parse(ctl(["status", "--json", `--cwd=${repo}`]).stdout);
	check("an inactive status reads as defaults", inactive.managerSource === "default", inactive);
	check("status says why it is inactive", !inactive.active && inactive.reason.includes("[claude]"), inactive);
	check("status prints readable text", ctl(["status", `--cwd=${repo}`]).stdout.includes("ledgerpi: inactive"));
	writeConfig("claude = 5\n");
	const notTable = JSON.parse(ctl(["status", "--json", `--cwd=${repo}`]).stdout);
	check("a section that exists is not reported missing", !notTable.reason.includes("no [claude] section"), notTable);

	const fifo = join(root, "audit.fifo");
	execFileSync("mkfifo", [fifo]);
	writeFileSync(configFile, `stateDir = "${stateDir}"\nauditLog = "${fifo}"\n${CLAUDE_CONFIG}`);
	const blocked = ctl(["status", "--json", `--cwd=${repo}`]);
	check("status does not block on a FIFO audit log", blocked.code === 0, blocked);
	rmSync(fifo);
	writeConfig(CLAUDE_CONFIG);
	check("an unknown command exits 2", ctl(["nonsense"]).code === 2);
	check("an unknown flag exits 2", ctl(["status", "--nonsense"]).code === 2);
}

type Chunk = { stream: "stdout" | "stderr"; text: string };

const out = (event: LedgerEvent): Chunk => ({ stream: "stdout", text: `${JSON.stringify(event)}\n` });

const stepEvent = (id: number): StepEvent => ({
	type: "step",
	id,
	role: "worker",
	agent: "ledgerpi:ledger-worker",
	model: "claude-sonnet-5-5",
	cwd: "/repo",
	prompt: "do it",
	description: "worker",
	replyFile: `/replies/${id}`,
	stoppedFile: `/stopped/${id}`,
});

const TURN: StepTurn = { answer: "did it", reason: "answer", durationMs: 7, usage: USAGE };

interface FakeEngine extends Engine {
	spawned: StepEvent[];
	stopped: string[];
	order: string[];
	replies: Record<string, StepReply>;
	statuses: Record<string, string>;
	statusLine: (string | undefined)[];
	onSpawn: Engine["spawn"];
}

/** A scripted Claude Code: records what the dispatcher asks of it. */
function fakeEngine(script: (engine: FakeEngine) => AsyncIterable<Chunk>): FakeEngine {
	const engine: FakeEngine = {
		spawned: [],
		stopped: [],
		order: [],
		replies: {},
		statuses: {},
		statusLine: [],
		onSpawn: () => Promise.resolve({ agentId: `agent-${engine.spawned.length}` }),
		sessionId: () => Promise.resolve("s1"),
		spawn(step) {
			engine.spawned.push(step);
			return engine.onSpawn(step);
		},
		async stop(agentId) {
			engine.stopped.push(agentId);
			engine.order.push(`stop ${agentId}`);
		},
		status: async (agentId) => engine.statuses[agentId] ?? "completed",
		async write(path, text) {
			engine.replies[path] = JSON.parse(text);
			engine.order.push(`reply ${path}`);
		},
		async setStatus(text) {
			engine.statusLine.push(text);
		},
		stream: () => script(engine),
	};
	return engine;
}

const never = new AbortController().signal;

async function testStopIsConfirmed(): Promise<void> {
	const dir = join(root, "steps-confirm");
	const events: LedgerEvent[] = [];
	const { spawn: run } = rendezvous(dir, ROLES, (e) => events.push(e));
	let settled = false;
	const pending = run({ type: "ledger-worker", prompt: "p", description: "d", timeoutMs: 20 }).then((r) => {
		settled = true;
		return r;
	});
	await new Promise((done) => setTimeout(done, 500));
	const stop = events.find((e) => e.type === "stop");
	check("a timed-out step emits its stop", stop !== undefined, events);
	check("a timed-out step waits for the stop to land", !settled);
	if (stop?.type === "stop") writeFileSync(stop.stoppedFile, "{}");
	const result = await pending;
	check("a confirmed stop ends the step as a timeout", !result.ok && result.detail === "timeout", result);

	const silentDir = join(root, "steps-unconfirmed");
	const { spawn: runSilent } = rendezvous(silentDir, ROLES, () => {}, 300);
	const warnings: string[] = [];
	const realError = console.error;
	console.error = (...args: unknown[]) => warnings.push(args.join(" "));
	const unconfirmed = await runSilent({ type: "ledger-worker", prompt: "p", description: "d", timeoutMs: 20 });
	console.error = realError;
	check("an unconfirmed stop still ends the step", !unconfirmed.ok && unconfirmed.detail === "timeout", unconfirmed);
	check("an unconfirmed stop is reported", warnings.join().includes("did not confirm"), warnings);
}

async function testDispatcherReplies(): Promise<void> {
	const dispatcher = new Dispatcher();
	const engine = fakeEngine(async function* (e) {
		yield out(stepEvent(1));
		await dispatcher.turnComplete(e, "agent-1", TURN);
		yield out(stepEvent(2));
		await dispatcher.turnComplete(e, "agent-2", { ...TURN, answer: "", reason: "refusal" });
		yield out(stepEvent(3));
		await dispatcher.turnComplete(e, "agent-3", { ...TURN, answer: "", reason: "something-new" });
		yield out({ type: "progress", text: "ledger 1/2" });
		yield out({ type: "done", handoff: "all done" });
	});
	const result = await dispatcher.run(engine, { task: "t", cwd: " /wt ", gate: "" }, never);
	check("the hand-off is the tool result", result === "all done", result);
	const first = engine.replies["/replies/1"];
	check("an answer is written with its text", first?.status === "answer" && first.text === "did it", first);
	check("usage and timing reach the reply", first?.usage?.model === USAGE.model && first.durationMs === 7, first);
	check("a refusal maps to refused", engine.replies["/replies/2"]?.status === "refused", engine.replies);
	check("an unknown end maps to error", engine.replies["/replies/3"]?.error === "something-new", engine.replies);
	check("progress reaches the status line", engine.statusLine.includes("ledger 1/2"), engine.statusLine);
	check("the status line is cleared", engine.statusLine.at(-1) === undefined, engine.statusLine);
	check("a finished run stops nothing", engine.stopped.length === 0, engine.stopped);
	check("role agents are remembered for their hand-backs", dispatcher.isOwnAgent("agent-2"));
	check("other agents are not", !dispatcher.isOwnAgent("agent-9"));
}

async function testDispatcherArguments(): Promise<void> {
	let request: { argv: string[]; input: string } | undefined;
	const engine = fakeEngine(async function* () {
		yield out({ type: "done", handoff: "ok" });
	});
	const stream = engine.stream;
	engine.stream = (r) => {
		request = r;
		return stream(r);
	};
	await new Dispatcher().run(engine, { task: "fix", cwd: " /wt ", gate: 5 }, never);
	check(
		"arguments are trimmed and a non-string is dropped",
		request?.argv.join(" ") === "ledgerctl solve --session=s1 --cwd=/wt" && request.input === "fix",
		request,
	);
	await new Dispatcher().run(engine, { task: "fix", cwd: "/wt", gate: "make", plan_file: " /p " }, never);
	check(
		"plan_file follows --cwd and --gate",
		request?.argv.join(" ") === "ledgerctl solve --session=s1 --cwd=/wt --gate=make --plan-file=/p",
		request,
	);
	await new Dispatcher().run(engine, { task: "fix", plan_file: "  " }, never);
	check("a blank plan_file adds nothing", request?.argv.join(" ") === "ledgerctl solve --session=s1", request);
	await new Dispatcher().run(
		engine,
		{ task: "fix", cwd: "/wt", gate: "make", plan_file: "/p", fanout: " off " },
		never,
	);
	check(
		"fanout follows --plan-file, trimmed",
		request?.argv.join(" ") === "ledgerctl solve --session=s1 --cwd=/wt --gate=make --plan-file=/p --fanout=off",
		request,
	);
	await new Dispatcher().run(engine, { task: "fix", fanout: "  " }, never);
	check("a blank fanout adds nothing", request?.argv.join(" ") === "ledgerctl solve --session=s1", request);
	await new Dispatcher().run(engine, { task: "fix", fanout: 3 }, never);
	check("a non-string fanout adds nothing", request?.argv.join(" ") === "ledgerctl solve --session=s1", request);
}

async function testDispatcherConcurrentSteps(): Promise<void> {
	const dispatcher = new Dispatcher();
	const engine = fakeEngine(async function* (e) {
		yield out(stepEvent(1));
		yield out(stepEvent(2));
		await dispatcher.turnComplete(e, "agent-2", { ...TURN, answer: "second" });
		await dispatcher.turnComplete(e, "agent-1", { ...TURN, answer: "first" });
		yield out({ type: "done", handoff: "ok" });
	});
	const result = await dispatcher.run(engine, { task: "t" }, never);
	check("two concurrent steps finish the run", result === "ok", result);
	check(
		"an answer out of order reaches its own step (1)",
		engine.replies["/replies/1"]?.text === "first",
		engine.replies,
	);
	check(
		"an answer out of order reaches its own step (2)",
		engine.replies["/replies/2"]?.text === "second",
		engine.replies,
	);
	check(
		"replies are written in answer order",
		engine.order.join() === "reply /replies/2,reply /replies/1",
		engine.order,
	);
	check("concurrent steps leave nothing to stop", engine.stopped.length === 0, engine.stopped);
}

async function testDispatcherSpawnState(): Promise<void> {
	const dispatcher = new Dispatcher();
	let during: StepEvent | null = null;
	const engine = fakeEngine(async function* () {
		yield out(stepEvent(1));
		yield out({ type: "done", handoff: "ok" });
	});
	engine.onSpawn = (step) => {
		during = dispatcher.spawning;
		return Promise.resolve({ agentId: step.id === 1 ? "agent-1" : "other" });
	};
	await dispatcher.run(engine, { task: "t" }, never);
	check("the step is visible to the spawn hooks", (during as StepEvent | null)?.model === "claude-sonnet-5-5", during);
	check("nothing reads as spawning afterward", dispatcher.spawning === null);
}

async function testDispatcherWaiting(): Promise<void> {
	const dispatcher = new Dispatcher();
	const engine = fakeEngine(async function* (e) {
		yield out(stepEvent(1));
		e.statuses["agent-1"] = "waiting";
		await dispatcher.turnComplete(e, "agent-1", TURN);
		yield out({ type: "done", handoff: "ok" });
	});
	await dispatcher.run(engine, { task: "t" }, never);
	check(
		"a waiting worker is stopped before its reply",
		engine.order.join() === "stop agent-1,reply /replies/1",
		engine.order,
	);
}

async function testDispatcherEarlyTurn(): Promise<void> {
	const dispatcher = new Dispatcher();
	const engine = fakeEngine(async function* () {
		yield out(stepEvent(1));
		yield out({ type: "done", handoff: "ok" });
	});
	engine.onSpawn = async () => {
		await dispatcher.turnComplete(engine, "agent-1", TURN);
		engine.statuses["agent-1"] = "waiting";
		return { agentId: "agent-1" };
	};
	await dispatcher.run(engine, { task: "t" }, never);
	check("a turn that beats its spawn is delivered", engine.replies["/replies/1"]?.text === "did it", engine.replies);
	check(
		"a turn that beats its spawn still stops a waiting worker",
		engine.order.join() === "stop agent-1,reply /replies/1",
		engine.order,
	);
}

async function testDispatcherStopEvent(): Promise<void> {
	const dispatcher = new Dispatcher();
	const engine = fakeEngine(async function* (e) {
		yield out(stepEvent(1));
		yield out({ type: "stop", id: 1, stoppedFile: "/stopped/1" });
		yield out({ type: "stop", id: 99, stoppedFile: "/stopped/99" });
		await dispatcher.turnComplete(e, "agent-1", { ...TURN, answer: "", reason: "aborted" });
		yield out({ type: "done", handoff: "ok" });
	});
	await dispatcher.run(engine, { task: "t" }, never);
	check("a stop event stops that step's agent", engine.stopped.join() === "agent-1", engine.stopped);
}

async function testDispatcherUnconfirmedStop(): Promise<void> {
	let confirmedWhileLive = false;
	const engine = fakeEngine(async function* (e) {
		yield out(stepEvent(1));
		e.statuses["agent-1"] = "running";
		yield out({ type: "stop", id: 1, stoppedFile: "/stopped/1" });
		yield { stream: "stderr", text: "" };
		confirmedWhileLive = e.replies["/stopped/1"] !== undefined;
		e.statuses["agent-1"] = "killed";
		yield out({ type: "stop", id: 1, stoppedFile: "/stopped/2" });
	});
	await new Dispatcher().run(engine, { task: "t" }, never);
	check("a stop that did not land is not confirmed", !confirmedWhileLive, engine.replies);
	check("a stop that landed is confirmed", engine.replies["/stopped/2"] !== undefined, engine.replies);
}

async function testDispatcherAbnormalExit(): Promise<void> {
	const exits = new Dispatcher();
	const exiting = fakeEngine(async function* () {
		yield out(stepEvent(1));
		yield { stream: "stderr", text: "ledgerctl: boom\n" };
	});
	const exited = await exits.run(exiting, { task: "t" }, never);
	check("a CLI exit stops the running worker", exiting.stopped.join() === "agent-1", exiting.stopped);
	check("a CLI exit reports partial edits", exited.includes("partial edits"), exited);
	check("a CLI exit names its error", exited.includes("ledgerctl: boom"), exited);

	const throws = new Dispatcher();
	const throwing = fakeEngine(async function* () {
		yield out(stepEvent(1));
		throw new Error("stream broke");
	});
	const thrown = await throws.run(throwing, { task: "t" }, never);
	check("a broken stream stops the running worker", throwing.stopped.join() === "agent-1", throwing.stopped);
	check("a broken stream after a step is not a punt", thrown.includes("partial edits"), thrown);

	const garbled = new Dispatcher();
	const garbling = fakeEngine(async function* () {
		yield out(stepEvent(1));
		yield { stream: "stdout", text: "not json\n" };
	});
	const parsed = await garbled.run(garbling, { task: "t" }, never);
	check("an unreadable line stops the running worker", garbling.stopped.join() === "agent-1", garbling.stopped);
	check("an unreadable line after a step is not a punt", parsed.includes("partial edits"), parsed);

	const silent = fakeEngine(async function* () {
		yield { stream: "stderr", text: "ledgerctl: no state dir\n" };
	});
	const before = await new Dispatcher().run(silent, { task: "t" }, never);
	check("a failure before any step tells the model to do the work", before.includes("Implement the task"), before);
	check("a failure before any step names its error", before.includes("no state dir"), before);
	check("a failure before any step mentions no edits", !before.includes("partial edits"), before);

	const noisy = fakeEngine(async function* () {
		yield { stream: "stderr", text: "[ledgerpi] audit log write failed\n" };
		yield out({ type: "done", handoff: "HANDOFF" });
	});
	const finished = await new Dispatcher().run(noisy, { task: "t" }, never);
	check("a finished run keeps its result", finished.startsWith("HANDOFF"), finished);
	check("a finished run keeps its diagnostics", finished.includes("audit log write failed"), finished);

	const quiet = fakeEngine(async function* () {
		yield out({ type: "done", handoff: "HANDOFF" });
	});
	const clean = await new Dispatcher().run(quiet, { task: "t" }, never);
	check("a quiet run returns its result alone", clean === "HANDOFF", clean);
}

async function testDispatcherAbort(): Promise<void> {
	const running = new AbortController();
	const dispatcher = new Dispatcher();
	let stoppedByAbort = false;
	const engine = fakeEngine(async function* (e) {
		yield out(stepEvent(1));
		running.abort();
		stoppedByAbort = e.stopped.join() === "agent-1";
	});
	const aborted = await dispatcher.run(engine, { task: "t" }, running.signal);
	check("an abort stops the running worker at once", stoppedByAbort, engine.stopped);
	check("an abort is reported", aborted.includes("aborted"), aborted);
	check("an agent is stopped once", engine.stopped.length === 1, engine.stopped);

	const spawning = new AbortController();
	const racing = fakeEngine(async function* () {
		yield out(stepEvent(1));
	});
	racing.onSpawn = async () => {
		spawning.abort();
		return { agentId: "agent-late" };
	};
	await new Dispatcher().run(racing, { task: "t" }, spawning.signal);
	check("an abort during a spawn stops the new agent", racing.stopped.join() === "agent-late", racing.stopped);

	const delayed = new AbortController();
	const slowDispatcher = new Dispatcher();
	let finishStop = () => {};
	const slow = fakeEngine(async function* () {
		yield out(stepEvent(1));
		delayed.abort();
	});
	slow.stop = () =>
		new Promise((done) => {
			finishStop = done;
		});
	let settled = false;
	const stopping = slowDispatcher.run(slow, { task: "t" }, delayed.signal).then((text) => {
		settled = true;
		return text;
	});
	await new Promise((done) => setTimeout(done, 20));
	check("an aborted run waits for its stop", !settled);
	const during = await slowDispatcher.run(slow, { task: "t" }, never);
	check("a run still stopping refuses another", during.includes("already running"), during);
	finishStop();
	check("an aborted run ends once its stop lands", (await stopping).includes("aborted"));
	check("an abort confirms the stop", slow.replies["/stopped/1"] !== undefined, slow.replies);
}

async function testDispatcherStepAfterAbort(): Promise<void> {
	const aborting = new AbortController();
	const engine = fakeEngine(async function* () {
		aborting.abort();
		yield out(stepEvent(1));
	});
	await new Dispatcher().run(engine, { task: "t" }, aborting.signal);
	check("a step read after an abort starts nothing", engine.spawned.length === 0, engine.spawned);
	check("a step read after an abort is answered", engine.replies["/replies/1"]?.status === "aborted", engine.replies);
}

async function testDispatcherStatusFailure(): Promise<void> {
	const dispatcher = new Dispatcher();
	const engine = fakeEngine(async function* () {
		yield out({ type: "progress", text: "ledger 1/2" });
		yield out({ type: "done", handoff: "finished" });
	});
	engine.setStatus = () => Promise.reject(new Error("no status line"));
	const result = await dispatcher.run(engine, { task: "t" }, never);
	check("a failed status write does not end the run", result === "finished", result);
	const again = await dispatcher.run(engine, { task: "t" }, never);
	check("a failed status write releases the session guard", again === "finished", again);
}

async function testDispatcherEngineFailures(): Promise<void> {
	const dispatcher = new Dispatcher();
	const engine = fakeEngine(async function* (e) {
		yield out(stepEvent(1));
		await dispatcher.turnComplete(e, "agent-1", TURN);
		yield out({ type: "done", handoff: "ok" });
	});
	engine.status = () => Promise.reject(new Error("no agent list"));
	await dispatcher.run(engine, { task: "t" }, never);
	check(
		"a failed status read still delivers the reply",
		engine.replies["/replies/1"]?.text === "did it",
		engine.replies,
	);

	const writes = new Dispatcher();
	const broken = fakeEngine(async function* (e) {
		yield out(stepEvent(1));
		await writes.turnComplete(e, "agent-1", TURN);
		yield out({ type: "done", handoff: "finished" });
	});
	broken.write = () => Promise.reject(new Error("disk full"));
	const result = await writes.run(broken, { task: "t" }, never);
	check("an unwritable reply does not end the run", result === "finished", result);
}

async function testDispatcherGuard(): Promise<void> {
	const dispatcher = new Dispatcher();
	let release = () => {};
	const held = new Promise<void>((done) => {
		release = done;
	});
	const slow = fakeEngine(async function* () {
		await held;
		yield out({ type: "done", handoff: "first" });
	});
	const first = dispatcher.run(slow, { task: "t" }, never);
	const second = await dispatcher.run(slow, { task: "t" }, never);
	check("a second call in a session is refused", second.includes("already running"), second);
	check("a second call never invites edits beside the loop", !second.includes("Implement the task"), second);
	release();
	check("the first call finishes", (await first) === "first");

	const failing = fakeEngine(async function* () {
		yield out({ type: "done", handoff: "unused" });
	});
	failing.sessionId = () => Promise.reject(new Error("no session"));
	const failed = await dispatcher.run(failing, { task: "t" }, never);
	check("a failure before ledgerctl starts is reported", failed.includes("no session"), failed);
	const again = await dispatcher.run(slow, { task: "t" }, never);
	check("a failed start does not hold the session guard", again === "first", again);
}

function configFrom(body: string): LedgerpiConfig {
	writeFileSync(configFile, body);
	return loadConfig();
}

function testConfig(): void {
	const provider = 'providers = ["local"]\n';
	const absent = configFrom(provider);
	check("no [claude] table leaves claude inert", absent.claude === null, absent.claude);
	check("no [claude] table leaves pi enabled", absent.enabled && absent.providers.length === 1, absent);

	const empty = configFrom(`${provider}[claude]\n`);
	check(
		"an empty [claude] table gets the defaults",
		empty.claude?.manager === CLAUDE_MANAGER_DEFAULT && empty.claude?.worker === CLAUDE_WORKER_DEFAULT,
		empty.claude,
	);
	check("the defaults are Opus 5.5 and Sonnet 5.5", CLAUDE_MANAGER_DEFAULT === "claude-opus-5-5");
	check("the worker default is Sonnet 5.5", CLAUDE_WORKER_DEFAULT === "claude-sonnet-5-5");

	const overridden = configFrom(`${provider}[claude]\nworker = "claude-haiku-5-5"\n`);
	check(
		"one role can be overridden alone",
		overridden.claude?.worker === "claude-haiku-5-5" && overridden.claude?.manager === CLAUDE_MANAGER_DEFAULT,
		overridden.claude,
	);

	const alias = configFrom(`${provider}[claude]\nworker = "sonnet"\n`);
	check("an alias falls back to the default", alias.claude?.worker === CLAUDE_WORKER_DEFAULT, alias.claude);
	check("an alias warns", alias.warnings.join().includes("[claude] worker"), alias.warnings);

	const wrongType = configFrom(`${provider}[claude]\nmanager = 5\n`);
	check("a non-string role falls back", wrongType.claude?.manager === CLAUDE_MANAGER_DEFAULT, wrongType.claude);

	const notTable = configFrom(`${provider}claude = "yes"\n`);
	check("a [claude] that is not a table is inert", notTable.claude === null, notTable.claude);
	check("a [claude] that is not a table warns", notTable.warnings.join().includes("[claude]"), notTable.warnings);
	check("a bad [claude] leaves pi alone", notTable.enabled && notTable.providers.length === 1, notTable);

	const dated = configFrom(`${provider}claude = 2026-09-01\n`);
	check("a TOML date in place of [claude] stays inert", dated.claude === null, dated.claude);
	const datedTime = configFrom(`${provider}claude = 2026-09-01T10:00:00Z\n`);
	check("a TOML datetime in place of [claude] stays inert", datedTime.claude === null, datedTime.claude);

	const unknown = configFrom(`${provider}[claude]\nmodel = "claude-x-1"\n`);
	check("an unknown [claude] key warns", unknown.warnings.join().includes('"model"'), unknown.warnings);

	const claudeOnly = configFrom('maxIters = 4\ngate = "make check"\n[claude]\n');
	check("a claude-only file keeps pi inert", !claudeOnly.enabled && claudeOnly.providers.length === 0, claudeOnly);
	check("a claude-only file activates claude", claudeOnly.claude !== null, claudeOnly.claude);
	check("a claude-only file keeps its knobs", claudeOnly.maxIters === 4, claudeOnly.maxIters);
	const claudeAudit = configFrom('auditLog = "/custom/runs.jsonl"\n[claude]\n');
	check(
		"a claude-only file honors its audit path",
		claudeAudit.auditLog === "/custom/runs.jsonl",
		claudeAudit.auditLog,
	);
	const claudeState = configFrom('stateDir = "/custom/state"\n[claude]\n');
	check(
		"a claude-only audit log follows its state dir",
		claudeState.auditLog === "/custom/state/runs.jsonl",
		claudeState.auditLog,
	);

	const disabled = configFrom(`enabled = false\n${provider}[claude]\n`);
	check("enabled = false disables both", !disabled.enabled && disabled.claude === null, disabled);

	const retired = configFrom(`gate = "make check"\n${provider}[blocklist]\nx = []\n[claude]\n`);
	check("a retired [blocklist] keeps pi inert", !retired.enabled && retired.providers.length === 0, retired);
	check("a retired [blocklist] leaves claude active", retired.claude !== null, retired.claude);
	check("a retired [blocklist] keeps claude's knobs", retired.gate === "make check", retired.gate);
	const retiredPath = configFrom(`auditLog = "/custom/runs.jsonl"\n${provider}[blocklist]\nx = []\n[claude]\n`);
	check("a retired [blocklist] keeps claude's audit path", retiredPath.auditLog === "/custom/runs.jsonl");

	const badAllow = configFrom(`${provider}allowlist = "no"\n[claude]\n`);
	check("a malformed [allowlist] keeps pi inert", !badAllow.enabled && badAllow.providers.length === 0, badAllow);
	check("a malformed [allowlist] leaves claude active", badAllow.claude !== null, badAllow.claude);

	const retiredOnly = configFrom(`${provider}[blocklist]\nx = []\n`);
	check("a retired [blocklist] alone stays inert", !retiredOnly.enabled && retiredOnly.claude === null, retiredOnly);
	const offRetired = configFrom(`enabled = false\n[blocklist]\nx = []\n[claude]\n`);
	check("enabled = false wins over a retired [blocklist]", offRetired.claude === null, offRetired.claude);

	const noProviders = configFrom("maxIters = 4\n");
	check("no providers and no [claude] stays inert", !noProviders.enabled && noProviders.claude === null, noProviders);
	check("an inert config ignores its knobs", noProviders.maxIters !== 4, noProviders.maxIters);
	check("a pi-only config raises no [claude] warning", !absent.warnings.join().includes("[claude]"), absent.warnings);
}

function testCoreBoundary(): void {
	const files = readdirSync(coreDir, { recursive: true, encoding: "utf8" }).map((f) => join(coreDir, f));
	const sources = files.filter((f) => statSync(f).isFile() && f.endsWith(".ts"));
	check("the core has sources to check", sources.length > 5, sources);
	const leaks = sources.filter((f) =>
		/from "(@earendil-works|\.\.\/\.\.\/\.\.\/extensions)/.test(readFileSync(f, "utf8")),
	);
	check("the core imports nothing from pi", leaks.length === 0, leaks);

	const pluginDir = resolve(coreDir, "../../claude");
	const valueImports = (file: string) =>
		[...readFileSync(join(pluginDir, file), "utf8").matchAll(/^import (?!type )[^;]*?from "([^"]+)"/gm)].map(
			(m) => m[1],
		);
	check(
		"the mod reaches only its dispatcher at run time",
		valueImports("hooks/register.ts").join() === "../src/dispatch.ts",
		valueImports("hooks/register.ts"),
	);
	check("the dispatcher imports nothing at run time", valueImports("src/dispatch.ts").length === 0);
}

async function run(): Promise<void> {
	mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: repo });
	writeFileSync(join(repo, "seed"), "1");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed"], { cwd: repo });
	mkdirSync(dirname(auditLog), { recursive: true });

	testConfig();
	testCoreBoundary();
	await testConverged();
	await testRedGateOverridesDone();
	await testEmptyAnswerAtTurnLimit();
	await testStepTimeout();
	await testEmptyManagerAnswer();
	await testRefusedSpawn();
	await testAbort();
	await testStopCommand();
	await testModelMismatch();
	await testRefusals();
	await testPlanFile();
	await testSolveFanout();
	await testRefusalStopsFromAnotherTree();
	await testStaleLock();
	await testConcurrentLock();
	testLockReleaseIsOwned();
	await testToolFailureExit();
	await testLateReply();
	await testPartialReplyRetried();
	await testAbortedReply();
	await testStopIsConfirmed();
	await testDispatcherReplies();
	await testDispatcherArguments();
	await testDispatcherConcurrentSteps();
	await testDispatcherSpawnState();
	await testDispatcherWaiting();
	await testDispatcherEarlyTurn();
	await testDispatcherStopEvent();
	await testDispatcherUnconfirmedStop();
	await testDispatcherAbnormalExit();
	await testDispatcherAbort();
	await testDispatcherStepAfterAbort();
	await testDispatcherStatusFailure();
	await testDispatcherEngineFailures();
	await testDispatcherGuard();
	testStatus();

	rmSync(root, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
