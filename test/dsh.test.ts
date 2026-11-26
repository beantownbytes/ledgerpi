import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type DshConfig, type LedgerpiConfig, loadConfig } from "../packages/core/src/config.ts";
import { acquireLock } from "../packages/core/src/lock.ts";
import { type SolveHost, type SolveOutcome, solveTask } from "../packages/core/src/solve.ts";

const root = join(realpathSync(tmpdir()), `ledgerpi-dsh-test-${process.pid}`);
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

const PROVIDER = 'providers = ["local"]\n';
const UNSET: DshConfig = { manager: null, worker: null, managerEffort: null, workerEffort: null };

function configFrom(body: string): LedgerpiConfig {
	writeFileSync(configFile, body);
	return loadConfig();
}

const dshWarnings = (cfg: LedgerpiConfig): string[] => cfg.warnings.filter((w) => w.includes("dsh"));

const piEnabled = (cfg: LedgerpiConfig): boolean => cfg.enabled && isDeepStrictEqual(cfg.providers, ["local"]);

const piInert = (cfg: LedgerpiConfig): boolean => !cfg.enabled && cfg.providers.length === 0;

function testDshTable(): void {
	const absent = configFrom(PROVIDER);
	check("no [dsh] table leaves dsh inert", absent.dsh === null, absent.dsh);
	check("no [dsh] table leaves pi enabled", piEnabled(absent), absent);
	check("a pi-only config raises no [dsh] warning", dshWarnings(absent).length === 0, absent.warnings);

	for (const value of ['"yes"', "5", "true", "[]", "2026-09-01", "2026-09-01T10:00:00Z"]) {
		const cfg = configFrom(`${PROVIDER}dsh = ${value}\n`);
		check(`dsh = ${value} is inert`, cfg.dsh === null, cfg.dsh);
		check(`dsh = ${value} warns once`, dshWarnings(cfg).length === 1, cfg.warnings);
		check(`dsh = ${value} leaves pi alone`, piEnabled(cfg), cfg);
	}

	const empty = configFrom(`${PROVIDER}[dsh]\n`);
	check("an empty [dsh] table is active with nothing set", isDeepStrictEqual(empty.dsh, UNSET), empty.dsh);
	check("an empty [dsh] table raises no warning", empty.warnings.length === 0, empty.warnings);
	check("an empty [dsh] table leaves pi enabled", piEnabled(empty), empty);
	check("[dsh] does not activate Claude Code", empty.claude === null, empty.claude);

	const full = configFrom(
		`${PROVIDER}[dsh]\nmanager = "example/big"\nworker = "router/vendor/small"\nmanagerEffort = "max"\nworkerEffort = "low"\n`,
	);
	check(
		"every [dsh] key is read",
		isDeepStrictEqual(full.dsh, {
			manager: "example/big",
			worker: "router/vendor/small",
			managerEffort: "max",
			workerEffort: "low",
		}),
		full.dsh,
	);
	check("a valid [dsh] table raises no warning", full.warnings.length === 0, full.warnings);
}

function testDshRoles(): void {
	for (const role of ["manager", "worker"] as const) {
		const valid = configFrom(`${PROVIDER}[dsh]\n${role} = "p/m"\n`);
		check(`[dsh] ${role} takes a valid ref alone`, isDeepStrictEqual(valid.dsh, { ...UNSET, [role]: "p/m" }), valid);
		check(`[dsh] ${role} valid ref raises no warning`, valid.warnings.length === 0, valid.warnings);

		for (const value of ['"bare"', '""', '"/m"', '"p/"', '"p /m"', '" p/m"', "5", "true", '["p/m"]']) {
			const cfg = configFrom(`${PROVIDER}[dsh]\n${role} = ${value}\n`);
			check(`[dsh] ${role} = ${value} is null and stays active`, isDeepStrictEqual(cfg.dsh, UNSET), cfg.dsh);
			check(
				`[dsh] ${role} = ${value} warns`,
				dshWarnings(cfg).length === 1 && cfg.warnings[0].includes(`[dsh] ${role} `),
				cfg.warnings,
			);
		}
	}
}

function testDshEfforts(): void {
	for (const key of ["managerEffort", "workerEffort"] as const) {
		for (const effort of ["high", "off", "adapter-specific", "High", " "]) {
			const cfg = configFrom(`${PROVIDER}[dsh]\n${key} = "${effort}"\n`);
			check(`[dsh] ${key} = "${effort}" is kept unchanged`, cfg.dsh?.[key] === effort, cfg.dsh);
			check(`[dsh] ${key} = "${effort}" raises no warning`, cfg.warnings.length === 0, cfg.warnings);
		}

		for (const value of ['""', "5", "false", '["high"]']) {
			const cfg = configFrom(`${PROVIDER}[dsh]\n${key} = ${value}\n`);
			check(`[dsh] ${key} = ${value} is unset and stays active`, isDeepStrictEqual(cfg.dsh, UNSET), cfg.dsh);
			check(
				`[dsh] ${key} = ${value} warns`,
				dshWarnings(cfg).length === 1 && cfg.warnings[0].includes(`[dsh] ${key} `),
				cfg.warnings,
			);
		}
	}

	const separate = configFrom(`${PROVIDER}managerThinking = "low"\nworkerThinking = "minimal"\n[dsh]\n`);
	check("the pi thinking levels do not set dsh efforts", isDeepStrictEqual(separate.dsh, UNSET), separate.dsh);
}

function testDshUnknownKeys(): void {
	const cfg = configFrom(`${PROVIDER}[dsh]\nworker = "p/m"\nmodel = "p/x"\nworkerThinking = "low"\n`);
	check("unknown [dsh] sub-keys leave the table active", cfg.dsh?.worker === "p/m", cfg.dsh);
	check(
		"each unknown [dsh] sub-key warns",
		cfg.warnings.length === 2 &&
			cfg.warnings[0].includes('"model" in [dsh]') &&
			cfg.warnings[1].includes('"workerThinking" in [dsh]'),
		cfg.warnings,
	);
}

function testDshOnly(): void {
	const only = configFrom('maxIters = 4\ngate = "make check"\n[dsh]\n');
	check("a dsh-only file activates dsh", only.dsh !== null, only.dsh);
	check("a dsh-only file keeps pi inert", piInert(only), only);
	check("a dsh-only file leaves Claude Code inert", only.claude === null, only.claude);
	check("a dsh-only file keeps its knobs", only.maxIters === 4 && only.gate === "make check", only);
	check("a dsh-only file raises no warning", only.warnings.length === 0, only.warnings);

	const audit = configFrom('auditLog = "/custom/runs.jsonl"\n[dsh]\n');
	check("a dsh-only file honors its audit path", audit.auditLog === "/custom/runs.jsonl", audit.auditLog);
	const state = configFrom('stateDir = "/custom/state"\n[dsh]\n');
	check("a dsh-only audit log follows its state dir", state.auditLog === "/custom/state/runs.jsonl", state.auditLog);

	const malformed = configFrom('maxIters = 4\ndsh = "yes"\n');
	check("a malformed [dsh] alone stays inert", piInert(malformed) && malformed.dsh === null, malformed);
	check("a malformed [dsh] alone ignores its knobs", malformed.maxIters !== 4, malformed.maxIters);

	const neither = configFrom("maxIters = 4\n");
	check("no providers and no table stays inert", piInert(neither) && neither.dsh === null, neither);
}

function testSwitchedOff(): void {
	for (const [label, body] of [
		["with providers", `enabled = false\n${PROVIDER}[claude]\n[dsh]\n`],
		["in a dsh-only file", "enabled = false\n[dsh]\n"],
		["over a retired [blocklist]", `enabled = false\n${PROVIDER}[blocklist]\nx = []\n[dsh]\n`],
		["over a malformed [allowlist]", `enabled = false\n${PROVIDER}allowlist = "no"\n[dsh]\n`],
	]) {
		const cfg = configFrom(body);
		check(`enabled = false nulls dsh ${label}`, cfg.dsh === null && !cfg.enabled && cfg.claude === null, cfg);
		check(`enabled = false is recorded ${label}`, cfg.switchedOff, cfg);
	}
}

function testFailedPiPolicy(): void {
	const policies = [
		["a retired [blocklist]", "", "[blocklist]\nx = []\n"],
		["a malformed [allowlist]", 'allowlist = "no"\n', ""],
	];
	for (const [label, topLevel, table] of policies) {
		for (const claude of ["", "[claude]\n"]) {
			const suffix = claude === "" ? "without [claude]" : "with [claude]";
			const cfg = configFrom(`gate = "make check"\n${PROVIDER}${topLevel}${table}${claude}[dsh]\nworker = "p/m"\n`);
			check(`${label} keeps pi inert ${suffix}`, piInert(cfg), cfg);
			check(`${label} leaves dsh active ${suffix}`, cfg.dsh?.worker === "p/m", cfg.dsh);
			check(`${label} keeps Claude Code as configured ${suffix}`, (cfg.claude !== null) === (claude !== ""), cfg);
			check(`${label} keeps the knobs ${suffix}`, cfg.gate === "make check", cfg.gate);
		}

		const alone = configFrom(`gate = "make check"\n${PROVIDER}${topLevel}${table}`);
		check(`${label} with neither table stays inert`, piInert(alone) && alone.dsh === null, alone);
		check(`${label} with neither table ignores the knobs`, alone.gate === null, alone.gate);
	}
}

function testUnusableFile(): void {
	const broken = configFrom("[dsh]\nworker = \n");
	check("bad TOML leaves dsh inert", broken.dsh === null && piInert(broken), broken);

	rmSync(configFile);
	const missing = loadConfig();
	check("a missing file leaves dsh inert", missing.dsh === null && piInert(missing), missing);

	mkdirSync(configFile);
	const directory = loadConfig();
	check("an unreadable path leaves dsh inert", directory.dsh === null && piInert(directory), directory);
	rmSync(configFile, { recursive: true });
}

const repo = join(root, "repo");

/** Call `solveTask` on the scratch repo, with a spawn that is always refused. */
async function solve(
	overrides: Partial<SolveHost> = {},
	args: { task?: string; cwd?: string; planFile?: string; fanout?: string } = {},
): Promise<{ outcome: SolveOutcome; spawned: number }> {
	let spawned = 0;
	const cfg = configFrom(`stateDir = "${join(root, "state")}"\nfanout = "on"\n[dsh]\n`);
	const outcome = await solveTask(
		cfg,
		{ cwd: repo, task: "Do it.", session: "s1", gate: "true", ...args },
		{
			harness: "dsh",
			entry: "service",
			provider: "example",
			model: "big",
			managerModel: null,
			workerModel: null,
			sessionModel: "example/big",
			signal: new AbortController().signal,
			onProgress: () => {},
			spawner: () => ({
				spawn: () => {
					spawned++;
					return Promise.resolve({ ok: false, detail: "refused", error: "no such model" });
				},
				tally: { tokens: { manager: 0, worker: 0 }, models: { manager: null, worker: null } },
			}),
			...overrides,
		},
	);
	return { outcome, spawned };
}

const auditRows = (): Record<string, unknown>[] => {
	try {
		return readFileSync(join(root, "state", "runs.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
};

const reasonOf = (outcome: SolveOutcome): string => (outcome.kind === "rejected" ? outcome.reason : outcome.kind);

async function testSolveRefusals(): Promise<void> {
	const never = () => {
		throw new Error("check ran out of order");
	};
	const blank = await solve({ checkArgs: never, checkTree: never, beforeLock: never }, { task: "  " });
	check("a blank task is rejected first", reasonOf(blank.outcome) === "blank-task", blank.outcome);

	const argument = await solve({ checkArgs: () => ({ reason: "args", message: "No." }) }, { cwd: root });
	check("the argument check runs before the git check", reasonOf(argument.outcome) === "args", argument.outcome);

	const outside = await solve({ checkTree: never }, { cwd: root });
	check("a directory outside git is rejected before the tree check", reasonOf(outside.outcome) === "not-git", outside);

	const missing = join(root, "no-plan.md");
	const tree = await solve({ checkTree: () => ({ reason: "tree", message: "No." }) }, { planFile: missing });
	check("the tree check runs before the plan file", reasonOf(tree.outcome) === "tree", tree.outcome);

	const plan = await solve({ beforeLock: never }, { planFile: missing });
	check("a bad plan file is rejected before the last check", reasonOf(plan.outcome) === "bad-plan-file", plan.outcome);

	const last = await solve({ beforeLock: async () => ({ reason: "model", message: "No." }) });
	check("the last check can reject", reasonOf(last.outcome) === "model", last.outcome);

	for (const hook of ["checkArgs", "checkTree", "beforeLock"] as const) {
		for (const problem of [null, { reason: "late", message: "No." }]) {
			const controller = new AbortController();
			const aborted = await solve({
				signal: controller.signal,
				[hook]: async () => {
					controller.abort();
					return problem;
				},
			});
			check(`an abort during ${hook} cancels the call`, aborted.outcome.kind === "canceled", aborted.outcome);
			check(`an abort during ${hook} starts nothing`, aborted.spawned === 0, aborted.spawned);
		}
	}

	const early = new AbortController();
	early.abort();
	const canceled = await solve({ signal: early.signal });
	check("an aborted signal never takes the lock", canceled.outcome.kind === "canceled", canceled.outcome);

	const release = acquireLock(join(root, "state"), repo);
	const busy = await solve();
	release?.();
	check(
		"a held lock is busy and names the holder",
		busy.outcome.kind === "busy" && busy.outcome.root === repo && busy.outcome.holder?.pid === process.pid,
		busy.outcome,
	);
	check("no call that ran nothing wrote an audit row", auditRows().length === 0, auditRows());
}

async function testSolveRan(): Promise<void> {
	const { outcome, spawned } = await solve();
	check("a refused spawn still ends as ran", outcome.kind === "ran" && spawned > 0, outcome);
	if (outcome.kind !== "ran") return;
	const row = auditRows().at(-1) ?? {};
	check(
		"the audit row carries the harness, entry and session model",
		row.harness === "dsh" && row.entry === "service" && row.provider === "example" && row.model === "big",
		row,
	);
	check("the run reports its directory and ledger", outcome.result.cwd === repo && outcome.result.ledgerDir !== "");
	check(
		"an uncapped run keeps the configured fan-out",
		outcome.result.fanout?.setting === "on",
		outcome.result.fanout,
	);

	for (const [fanout, expected] of [
		[undefined, "advise"],
		["on", "advise"],
		["off", undefined],
	] as const) {
		const capped = await solve({ fanoutCap: "advise" }, { fanout });
		const setting = capped.outcome.kind === "ran" ? capped.outcome.result.fanout?.setting : "not run";
		check(`a fan-out cap over ${fanout ?? "the configured setting"} only lowers it`, setting === expected, setting);
	}
}

async function testSolveWarnings(): Promise<void> {
	const warnings: string[] = [];
	const { outcome } = await solve({ warn: (message) => warnings.push(message) }, { fanout: "lots" });
	check(
		"an invalid fan-out setting is handed to the host and ignored",
		outcome.kind === "ran" &&
			outcome.result.fanout?.setting === "on" &&
			warnings.length === 1 &&
			warnings[0].includes('ignoring fanout "lots"'),
		{ outcome, warnings },
	);
}

async function testSolveMismatches(): Promise<void> {
	const tally = () => ({
		spawn: () => Promise.resolve({ ok: false, detail: "refused" as const, error: "no such model" }),
		tally: { tokens: { manager: 0, worker: 0 }, models: { manager: null, worker: "other/m" } },
	});
	const line = (expected: string) => `The worker ran on other/m, not the configured ${expected}.`;
	for (const [label, host, expected] of [
		["a worker off the session model", {}, [line("example/big")]],
		["a worker off its pinned model", { workerModel: "example/small" }, [line("example/small")]],
		["a worker on its pinned model", { workerModel: "other/m" }, []],
		["no known model to compare", { sessionModel: null }, []],
	] as const) {
		const { outcome } = await solve({ spawner: tally, ...host });
		const found = outcome.kind === "ran" ? outcome.result.mismatches : outcome.kind;
		check(`mismatch lines for ${label}`, isDeepStrictEqual(found, expected), found);
		check(
			`the hand-off carries the mismatch lines for ${label}`,
			outcome.kind === "ran" && expected.every((text) => outcome.handoff.includes(text)),
			outcome,
		);
	}
}

async function run(): Promise<void> {
	mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "-q", repo]);

	testDshTable();
	testDshRoles();
	testDshEfforts();
	testDshUnknownKeys();
	testDshOnly();
	testSwitchedOff();
	testFailedPiPolicy();
	testUnusableFile();
	await testSolveRefusals();
	await testSolveRan();
	await testSolveWarnings();
	await testSolveMismatches();

	rmSync(root, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

await run();
