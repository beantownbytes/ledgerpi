import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { configPath, loadConfig } from "../../packages/core/src/config.ts";
import { appendRegularFile, readRegularFile, writeRegularFile } from "../../packages/core/src/files.ts";
import { BenchConfigError, malformed } from "../concurrency/bench.ts";
import {
	type Arm,
	buildVariantConfig,
	FANOUT_USAGE,
	isProtectedFixtureFile,
	labelArms,
	parseFanoutArgs,
	type RunRecord,
	recommend,
	recordRun,
	renderSummaryMarkdown,
	summarizeRuns,
} from "./bench.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE_MODE = 0o644;
const STDERR_TAIL_CHARS = 2_000;
const GIT_IDENTITY = [
	"-c",
	"user.name=ledgerpi-bench",
	"-c",
	"user.email=bench@localhost",
	"-c",
	"commit.gpgsign=false",
];

/** Overrides the `pi` executable; the test seam for a stub. */
export const PI_ENV = "LEDGERPI_BENCH_PI";
/** Overrides the fixture corpus directory; the test seam for a tiny corpus. */
export const TASKS_ENV = "LEDGERPI_BENCH_TASKS";

let inFlightPid: number | undefined;
let inFlightWorkDir: string | undefined;

/** Kill the running `pi` process group and remove the run directory; used when the driver is interrupted. */
function abortInFlight(): void {
	if (inFlightPid !== undefined) {
		try {
			process.kill(-inFlightPid, "SIGKILL");
		} catch {
			// The group already exited.
		}
	}
	if (inFlightWorkDir !== undefined) rmSync(inFlightWorkDir, { recursive: true, force: true });
}

/** The default output directory: a UTC-timestamped folder under the user's state directory, never the repo. */
function defaultOutDir(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(homedir(), ".local", "state", "ledgerpi-bench", "fanout", stamp);
}

function fixtureNames(tasksDir: string): string[] {
	if (!existsSync(tasksDir)) return [];
	return readdirSync(tasksDir)
		.filter((name) => statSync(join(tasksDir, name)).isDirectory())
		.sort();
}

/**
 * The fixtures to run, in order.
 *
 * @throws {BenchConfigError} `malformed-value` for a requested fixture that does not exist;
 * `usage` when the corpus is empty.
 */
function resolveTasks(tasksDir: string, requested: string[] | undefined): string[] {
	const available = fixtureNames(tasksDir);
	for (const name of requested ?? []) {
		if (!available.includes(name)) throw malformed("tasks", name, `a fixture under ${tasksDir}`);
	}
	const tasks = requested ?? available;
	if (tasks.length === 0) throw new BenchConfigError("usage", `no fixtures found under ${tasksDir}`);
	return tasks;
}

/** The live ledgerpi config as a plain table. @throws {BenchConfigError} `usage` when it is missing, not TOML, or leaves pi inert. */
function loadLiveConfig(): Record<string, unknown> {
	const path = configPath();
	const text = readRegularFile(path);
	if (text === undefined) throw new BenchConfigError("usage", `live ledgerpi config ${path} cannot be read`);
	let table: Record<string, unknown>;
	try {
		table = parseToml(text) as Record<string, unknown>;
	} catch (err) {
		throw new BenchConfigError("usage", `live ledgerpi config ${path} is not valid TOML: ${(err as Error).message}`);
	}
	if (!loadConfig().enabled) {
		throw new BenchConfigError(
			"usage",
			`live ledgerpi config ${path} would leave pi inert (disabled, or no usable providers)`,
		);
	}
	return table;
}

/** Copy a fixture to `repoDir` as a single-commit git repo so `.ledgerpi-gate` reaches candidate worktrees. */
function seedRepo(fixture: string, repoDir: string): void {
	cpSync(fixture, repoDir, { recursive: true });
	const git = (...args: string[]) =>
		execFileSync("git", [...GIT_IDENTITY, ...args], { cwd: repoDir, stdio: "ignore" });
	git("init", "-q");
	git("add", "-A");
	git("commit", "-q", "-m", "fixture");
}

/**
 * The original content of every protected fixture file, keyed by name. `.ledgerpi-gate` is always
 * present as a key (undefined when the fixture has none) so a worker-created gate counts as tampering.
 */
function snapshotProtectedFiles(fixture: string): Map<string, string | undefined> {
	const names = new Set([".ledgerpi-gate", ...readdirSync(fixture).filter(isProtectedFixtureFile)]);
	return new Map([...names].map((name) => [name, readRegularFile(join(fixture, name))]));
}

/** Names of the snapshotted files whose content in `repoDir` now differs; a deleted file differs. */
function tamperedFiles(original: Map<string, string | undefined>, repoDir: string): string[] {
	return [...original].filter(([name, text]) => readRegularFile(join(repoDir, name)) !== text).map(([name]) => name);
}

interface PiResult {
	killed: boolean;
	stderrTail: string;
}

/**
 * Run `pi -p prompt` in `cwd` and wait for it. The process leads its own group so the wall-clock
 * timeout kills the whole tree, as `runGate` does. Never rejects: a spawn failure resolves as an
 * unkilled run and surfaces as `no-row`.
 */
function runPi(
	piBin: string,
	prompt: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
): Promise<PiResult> {
	return new Promise((resolvePi) => {
		let killed = false;
		let done = false;
		let stderrTail = "";
		const finish = () => {
			if (done) return;
			done = true;
			inFlightPid = undefined;
			clearTimeout(timer);
			resolvePi({ killed, stderrTail });
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(piBin, ["-p", prompt], { cwd, env, stdio: ["ignore", "ignore", "pipe"], detached: true });
		} catch (err) {
			stderrTail = (err as Error).message;
			resolvePi({ killed, stderrTail });
			return;
		}
		inFlightPid = child.pid;
		const killTree = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			killed = true;
			killTree();
		}, timeoutMs);
		child.stderr?.on("data", (d: Buffer) => {
			stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL_CHARS);
		});
		child.on("error", (err) => {
			stderrTail = err.message;
			finish();
		});
		child.on("close", finish);
	});
}

interface Cell {
	task: string;
	arm: Arm;
	rep: number;
}

/**
 * One (task, arm, rep) run in a throwaway directory holding the seeded repo, the private config,
 * the state directory and the per-run audit file. The directory is removed afterwards.
 */
async function runCell(
	cell: Cell,
	fixture: string,
	live: Record<string, unknown>,
	piBin: string,
	timeoutMs: number,
): Promise<{ record: RunRecord; stderrTail: string }> {
	const workDir = mkdtempSync(join(tmpdir(), "ledgerpi-fanout-"));
	inFlightWorkDir = workDir;
	try {
		const repoDir = join(workDir, "repo");
		const configFile = join(workDir, "config.toml");
		const auditFile = join(workDir, "audit.jsonl");
		const protectedOriginals = snapshotProtectedFiles(fixture);
		seedRepo(fixture, repoDir);
		writeRegularFile(configFile, stringifyToml(buildVariantConfig(live, cell.arm)), FILE_MODE);
		const prompt = `/ledger ${(readRegularFile(join(fixture, "task.md")) ?? "").trim()}`;
		const env: NodeJS.ProcessEnv = {
			...process.env,
			LEDGERPI_CONFIG: configFile,
			LEDGERPI_STATE_DIR: join(workDir, "state"),
			LEDGERPI_AUDIT_LOG: auditFile,
			LEDGERPI_AUDIT_SOURCE: "benchmark",
		};
		const { killed, stderrTail } = await runPi(piBin, prompt, repoDir, env, timeoutMs);
		const tampered = tamperedFiles(protectedOriginals, repoDir);
		return { record: recordRun(cell, killed, readRegularFile(auditFile) ?? "", tampered), stderrTail };
	} finally {
		inFlightWorkDir = undefined;
		rmSync(workDir, { recursive: true, force: true });
	}
}

/**
 * Run the benchmark. Every configuration problem is raised as a {@link BenchConfigError} before the
 * output directory is created or `pi` is spawned; afterwards a failed run is recorded as data.
 * Cells run serially, task by task and repetition by repetition with the arms adjacent.
 *
 * @returns The directory that received `runs.jsonl`, `summary.json` and `summary.md`.
 */
export async function main(argv: string[]): Promise<string> {
	const args = parseFanoutArgs(argv);
	const outDir = resolve(args.out ?? defaultOutDir());
	if (existsSync(outDir)) throw new BenchConfigError("out-exists", `--out ${outDir} already exists`);
	const tasksDir = resolve(process.env[TASKS_ENV] ?? join(HERE, "tasks"));
	const tasks = resolveTasks(tasksDir, args.tasks);
	const live = loadLiveConfig();
	const piBin = process.env[PI_ENV] || "pi";

	const onSignal = (signal: NodeJS.Signals) => {
		abortInFlight();
		process.exit(signal === "SIGINT" ? 130 : 143);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	mkdirSync(outDir, { recursive: true });
	const runsPath = join(outDir, "runs.jsonl");
	const records: RunRecord[] = [];
	for (const task of tasks) {
		for (let rep = 1; rep <= args.reps; rep++) {
			for (const arm of args.arms) {
				const { record, stderrTail } = await runCell(
					{ task, arm, rep },
					join(tasksDir, task),
					live,
					piBin,
					args.timeoutS * 1000,
				);
				appendRegularFile(runsPath, `${JSON.stringify(record)}\n`, FILE_MODE);
				records.push(record);
				console.error(`${task} N=${arm} rep=${rep}: ${record.outcome}`);
				if (record.outcome !== "valid" && stderrTail.trim() !== "") console.error(stderrTail.trimEnd());
			}
		}
	}

	const summaries = summarizeRuns(records);
	const labeled = labelArms(summaries);
	const recommendation = recommend(labeled);
	const summary = { args, arms: summaries, labels: labeled, recommendation };
	writeRegularFile(join(outDir, "summary.json"), `${JSON.stringify(summary, null, "\t")}\n`, FILE_MODE);
	writeRegularFile(join(outDir, "summary.md"), renderSummaryMarkdown(summaries, labeled, recommendation), FILE_MODE);
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
	return outDir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(outDir) => {
			console.log(outDir);
		},
		(err: unknown) => {
			if (err instanceof BenchConfigError) {
				console.error(`${err.message}\n${FANOUT_USAGE}`);
				process.exitCode = 2;
			} else {
				console.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
}
