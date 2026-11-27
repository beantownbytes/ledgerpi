import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs, { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { mock } from "node:test";
import { setTimeout as sleep, setImmediate as turn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { type DshConfig, type LedgerpiConfig, loadConfig } from "../packages/core/src/config.ts";
import type { GateVerdict } from "../packages/core/src/gate.ts";
import { acquireLock, type LockHolder, lockDir, lockHolder } from "../packages/core/src/lock.ts";
import type { FanoutSummary, LoopDeps, RoleTiming } from "../packages/core/src/loop.ts";
import type { Task } from "../packages/core/src/parse.ts";
import {
	ABORTED_HANDOFF,
	type SolveHost,
	type SolveOutcome,
	type SolveRejection,
	type SolveRunResult,
	solveTask,
} from "../packages/core/src/solve.ts";
import { type SpawnOptions, type SpawnResult, WORKER_SENTINEL } from "../packages/core/src/spawn.ts";
import type {
	DshFanoutSummary,
	DshGateVerdict,
	DshLockHolder,
	DshRoleTiming,
	DshRunResult,
	DshSolveOutcome,
	DshSolveRejection,
	DshSolveRequest,
	DshTask,
	LedgerpiService,
} from "../packages/dsh/api.d.ts";
import { agentBodies, personaBody, renderPatch } from "../packages/dsh/build-patch.ts";
import {
	type DshAgent,
	type DshCreatedAgent,
	type DshExecutionPolicy,
	type DshLlm,
	type DshPluginContext,
	type DshRole,
	type DshSandboxPolicy,
	type DshServices,
	type DshSessionEvent,
	type DshShell,
	type DshShellExecution,
	type DshShellResult,
	type DshShellSpec,
	type DshSpawnSpec,
	type DshSubagentActivation,
	type DshSubagentResult,
	type DshToolDefinition,
	type DshToolOptions,
	type DshToolRestriction,
	type DshToolRunContext,
	type DshTools,
	LEDGER_PRESETS,
	parentRoute,
} from "../packages/dsh/src/dsh.ts";
import { dshGateRunner, gateCheck } from "../packages/dsh/src/gate.ts";
import plugin, { restrictLedgerChildren } from "../packages/dsh/src/service.ts";
import { createDshSpawner, type DshRolesOptions, dshRoles } from "../packages/dsh/src/spawn.ts";
import toolPlugin from "../packages/dsh/src/tool.ts";

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
		"a run with no fan-out argument keeps the configured fan-out",
		outcome.result.fanout?.setting === "on",
		outcome.result.fanout,
	);
}

async function testSolveMarksSharedLock(): Promise<void> {
	let holder: ReturnType<typeof lockHolder> = null;
	await solve({
		spawner: () => ({
			spawn: async () => {
				holder = lockHolder(join(root, "state"), repo);
				return { ok: false, detail: "refused", error: "no", durationMs: 0 };
			},
			tally: { tokens: { manager: 0, worker: 0 }, models: { manager: null, worker: null } },
		}),
	});
	const held = holder as ReturnType<typeof lockHolder>;
	check("a dsh run marks its lock as held by a shared process", held?.shared === true, held);
}

/** Run `body` while every listing of `dir` after the first fails with `EACCES`. */
async function withOneListingOf<T>(dir: string, body: () => Promise<T>): Promise<T> {
	const original = fs.readdirSync;
	let listings = 0;
	fs.readdirSync = ((path: string, options?: never) => {
		if (path === dir && ++listings > 1) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
		return original(path, options);
	}) as typeof fs.readdirSync;
	syncBuiltinESMExports();
	try {
		return await body();
	} finally {
		fs.readdirSync = original;
		syncBuiltinESMExports();
	}
}

async function testSolveUnreadableHolder(): Promise<void> {
	const state = join(root, "state");
	const release = acquireLock(state, repo);
	try {
		await withOneListingOf(lockDir(state, repo), async () => {
			const { outcome, spawned } = await solve();
			check(
				"a held lock with an unreadable holder is busy with no holder",
				isDeepStrictEqual(outcome, { kind: "busy", root: repo, holder: null }) && spawned === 0,
				{ outcome, spawned },
			);
			let thrown: unknown;
			try {
				lockHolder(state, repo);
			} catch (err) {
				thrown = (err as NodeJS.ErrnoException).code;
			}
			check("reading an unreadable lock holder still throws", thrown === "EACCES", thrown);
		});
	} finally {
		release?.();
	}
}

async function testSolveThrown(): Promise<void> {
	const rows = auditRows().length;
	for (const [label, host] of [
		["the spawner", { spawner: () => assert.fail("boom") }],
		[
			"a spawn",
			{
				spawner: () => ({
					spawn: () => Promise.reject(new Error("boom")),
					tally: { tokens: { manager: 0, worker: 0 }, models: { manager: null, worker: null } },
				}),
			},
		],
	] as const) {
		let message = "did not throw";
		try {
			await solve(host);
		} catch (err) {
			message = (err as Error).message;
		}
		check(`a throw from ${label} reaches the caller`, message === "boom", message);
		const release = acquireLock(join(root, "state"), repo);
		check(`a throw from ${label} releases the lock`, release !== null);
		release?.();
	}
	check("a thrown run writes no audit row", auditRows().length === rows, auditRows());
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

const ledgerDir = join(root, "ledger");

const parentAgent = (route?: { provider: string; model: string }): DshAgent => ({
	id: "parent",
	session: { id: "parent", header: { cwd: repo }, requestHeader: () => route && { config: route } },
	options: { provider: "example", model: "created" },
});

const rejection = (message: string, code?: string): Error => Object.assign(new Error(message), code && { code });

const UNSUPPORTED = "UNSUPPORTED_REASONING_EFFORT";

/** A fake `llm` that records each check and fails the ones `refuse` returns an error for. */
function fakeLlm(refuse: (config: Parameters<DshLlm["resolveCallConfig"]>[0]) => Error | undefined = () => undefined) {
	const calls: Parameters<DshLlm["resolveCallConfig"]>[0][] = [];
	const llm: DshLlm = {
		resolveCallConfig: async (config) => {
			calls.push(config);
			const err = refuse(config);
			if (err) throw err;
			return config;
		},
	};
	return { llm, calls };
}

const roles = (options: Partial<DshRolesOptions> = {}) =>
	dshRoles({
		parent: parentAgent({ provider: "example", model: "big" }),
		llm: undefined,
		dsh: UNSET,
		requested: {},
		...options,
	});

const completed = (...texts: string[]): DshSubagentResult => ({
	stopReason: "completed",
	output: texts.map((text) => ({ type: "text", text })),
});

const never = <T>(): Promise<T> => new Promise<T>(() => {});

const message = (
	model: string,
	usage?: { inputTokens: number; outputTokens: number; totalTokens?: number },
): DshSessionEvent => ({
	type: "assistant/message",
	data: { message: { source: { provider: "example", model } }, usage },
});

const turnError = (text: string): DshSessionEvent => ({
	type: "turn/end",
	data: { reason: { kind: "error", error: { message: text } } },
});

type Start = (
	spec: DshSpawnSpec,
	emit: (event: DshSessionEvent, id?: string) => void,
) => Promise<DshSubagentActivation>;

/** A spawner on fake services, with what its children and listeners did. */
function harness(start?: Start, options: Partial<Parameters<typeof createDshSpawner>[0]> = {}) {
	const listeners = new Set<(session: { id: string }, event: DshSessionEvent) => void>();
	const children = new Map<string, DshRole>();
	const specs: DshSpawnSpec[] = [];
	const seen = { disposed: 0 };
	const activation = (
		result: Promise<DshSubagentResult> = Promise.resolve(completed("done")),
		dispose: () => Promise<void> = async () => {},
	): DshSubagentActivation => ({
		result,
		dispose: () => {
			seen.disposed++;
			return dispose();
		},
	});
	const spawner = createDshSpawner({
		parent: parentAgent(),
		roles: roles(),
		runPath: repo,
		ledgerDir,
		children,
		events: {
			on: (_name, listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		subagents: {
			startActivation: (spec) => {
				specs.push(spec);
				const emit = (event: DshSessionEvent, id = spec.childId) => {
					for (const listener of listeners) listener({ id }, event);
				};
				return start ? start(spec, emit) : Promise.resolve(activation());
			},
		},
		...options,
	});
	const spawn = (over: Partial<SpawnOptions> = {}): Promise<SpawnResult> =>
		spawner.spawn({
			type: "ledger-worker",
			prompt: "Do it.",
			description: "ledger worker: work",
			cwd: repo,
			timeoutMs: 5000,
			...over,
		});
	const clean = () => children.size === 0 && listeners.size === 0;
	return { spawn, tally: spawner.tally, specs, seen, children, listeners, activation, clean };
}

const failedWith = (result: SpawnResult, detail: string, error?: string): boolean =>
	!result.ok && result.detail === detail && (error === undefined || result.error === error);

async function testSpawnRefusedEarly(): Promise<void> {
	const unknown = harness();
	for (const type of ["ledger-reviewer", "manager", "toString"]) {
		const result = await unknown.spawn({ type });
		check(`B0 type ${type} is refused`, failedWith(result, "refused"), result);
	}
	check("B0 an unknown type starts nothing", unknown.specs.length === 0 && unknown.clean());

	const candidate = join(ledgerDir, "candidates", "1-0");
	const sibling = `${repo}-sibling`;
	for (const dir of [candidate, join(repo, "sub"), sibling]) mkdirSync(dir, { recursive: true });
	symlinkSync(root, join(repo, "out"));
	symlinkSync(join(repo, "sub"), join(root, "into"));
	symlinkSync(ledgerDir, join(root, "ledger-link"));

	const outside = harness();
	for (const [label, cwd] of [
		["a parent directory", root],
		["a sibling sharing the name prefix", sibling],
		["a symlink pointing out", join(repo, "out")],
		["a missing directory", join(repo, "absent")],
		["the ledger directory outside candidates", ledgerDir],
	]) {
		const result = await outside.spawn({ cwd });
		check(`B1 ${label} is refused`, failedWith(result, "refused") && result.error?.includes(cwd) === true, result);
	}
	check("B1 a refused directory starts nothing", outside.specs.length === 0 && outside.clean());

	for (const [label, cwd, real, over] of [
		["the run directory", repo, repo, {}],
		["a subdirectory", join(repo, "sub"), join(repo, "sub"), {}],
		["a symlink pointing in", join(root, "into"), join(repo, "sub"), {}],
		["a candidate checkout", candidate, candidate, {}],
		["a candidate under a linked ledger", candidate, candidate, { ledgerDir: join(root, "ledger-link") }],
		["an omitted cwd", undefined, repo, {}],
	] as const) {
		const inside = harness(undefined, over);
		const result = await inside.spawn({ cwd });
		check(`B1 ${label} starts on its real path`, result.ok && inside.specs[0]?.cwd === real, {
			result,
			cwd: inside.specs[0]?.cwd,
		});
	}

	const early = new AbortController();
	early.abort();
	const checks = fakeLlm();
	const aborted = harness(undefined, { roles: roles({ llm: checks.llm }) });
	const result = await aborted.spawn({ signal: early.signal });
	check(
		"B2 an aborted signal starts nothing",
		failedWith(result, "aborted") && aborted.specs.length === 0 && checks.calls.length === 0 && aborted.clean(),
		result,
	);

	const refusing = fakeLlm(() => rejection("no adapter for example", "NO_ADAPTER"));
	const refused = harness(undefined, { roles: roles({ llm: refusing.llm }) });
	const refusal = await refused.spawn();
	check(
		"B3 an effort refusal is refused with dsh's message",
		failedWith(refusal, "refused", "no adapter for example") && refused.specs.length === 0 && refused.clean(),
		refusal,
	);

	for (const [label, settle] of [
		["never settles", () => never()],
		["settles after the abort", () => Promise.resolve()],
	] as const) {
		const controller = new AbortController();
		const llm: DshLlm = {
			resolveCallConfig: () => {
				controller.abort();
				return settle();
			},
		};
		const resolving = harness(undefined, { roles: roles({ llm }) });
		const stopped = await resolving.spawn({ signal: controller.signal });
		check(
			`B3 an abort during a resolution that ${label} is aborted`,
			failedWith(stopped, "aborted") && resolving.specs.length === 0 && resolving.clean(),
			stopped,
		);
	}
}

async function testSpawnStart(): Promise<void> {
	let atStart: unknown;
	const h: ReturnType<typeof harness> = harness(async (spec) => {
		atStart = {
			role: h.children.get(spec.childId),
			listeners: h.listeners.size,
			aborted: spec.signal.aborted,
		};
		return h.activation();
	});
	await h.spawn();
	check(
		"before start the child is live, watched and not yet stopped",
		isDeepStrictEqual(atStart, { role: "worker", listeners: 1, aborted: false }),
		atStart,
	);
	const { childId, signal, parent, ...spec } = h.specs[0];
	check("a child gets a reserved uuid", /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(childId), childId);
	check("a child is started for the run's parent", parent.id === "parent" && signal instanceof AbortSignal);
	check(
		"a session-model child is started with no route and the default effort",
		isDeepStrictEqual(spec, {
			provider: "spawn",
			label: "ledger worker: work",
			delivery: "caller",
			agentPreset: "ledger-worker",
			cwd: repo,
			prompt: [{ type: "text", text: `${WORKER_SENTINEL}\nDo it.` }],
			agentOptions: { reasoningEffort: "high" },
		}),
		spec,
	);
	await h.spawn({ type: "ledger-manager" });
	check(
		"a manager starts on its preset under a new id",
		h.specs[1].agentPreset === "ledger-manager" && h.specs[1].childId !== childId,
		h.specs[1],
	);

	const unsupported = fakeLlm((config) => (config.reasoningEffort ? rejection("no", UNSUPPORTED) : undefined));
	const pinned = harness(undefined, {
		roles: roles({ llm: unsupported.llm, requested: { worker: "router/vendor/small" } }),
	});
	await pinned.spawn({ maxOutputTokens: 512 });
	const options = pinned.specs[0].agentOptions;
	check(
		"an explicit ref is split at the first slash, capped, with an undefined effort key",
		isDeepStrictEqual(options, {
			provider: "router",
			model: "vendor/small",
			reasoningEffort: undefined,
			maxTokens: 512,
		}) && Object.hasOwn(options, "reasoningEffort"),
		options,
	);
}

async function testSpawnStartFailures(): Promise<void> {
	for (const [label, err, expected] of [
		["a coded error", rejection("too many", "ACTIVATION_LIMIT_REACHED"), "ACTIVATION_LIMIT_REACHED: too many"],
		["an uncoded error", rejection("restrict failed"), "restrict failed"],
	] as const) {
		const h = harness(() => Promise.reject(err));
		const result = await h.spawn();
		check(`B4 ${label} is refused`, failedWith(result, "refused", expected) && h.clean(), result);
	}
	const thrown = harness(() => {
		throw rejection("sync");
	});
	const sync = await thrown.spawn();
	check("B4 a synchronous throw is refused", failedWith(sync, "refused", "sync") && thrown.clean(), sync);

	const rejectOnAbort: Start = (spec) =>
		new Promise((_resolve, reject) => spec.signal.addEventListener("abort", () => reject(rejection("startup"))));

	for (const [label, start] of [
		["rejects on the signal", rejectOnAbort],
		["never settles", () => never<DshSubagentActivation>()],
	] as const) {
		const controller = new AbortController();
		const aborted = harness((spec, emit) => {
			const pending = start(spec, emit);
			queueMicrotask(() => controller.abort());
			return pending;
		});
		const guardedIds = label === "never settles" ? 1 : 0;
		const stoppedAt = (h: ReturnType<typeof harness>) => h.listeners.size === 0 && h.children.size === guardedIds;
		const stopped = await aborted.spawn({ signal: controller.signal });
		await sleep(0);
		check(
			`B4 an abort while a start that ${label} is aborted`,
			failedWith(stopped, "aborted") && aborted.specs[0].signal.aborted && stoppedAt(aborted),
			stopped,
		);

		const slow = harness(start);
		const timedOut = await slow.spawn({ timeoutMs: 20 });
		await sleep(0);
		check(
			`B4 a timeout while a start that ${label} is a timeout`,
			failedWith(timedOut, "timeout", "timed out after 20 ms") && slow.specs[0].signal.aborted && stoppedAt(slow),
			timedOut,
		);
	}

	let resolveLate: (activation: DshSubagentActivation) => void = () => {};
	const late = harness(
		() =>
			new Promise((resolve) => {
				resolveLate = resolve;
			}),
	);
	const stopped = await late.spawn({ timeoutMs: 20 });
	check("a pending start is not disposed", failedWith(stopped, "timeout") && late.seen.disposed === 0, stopped);
	check("a child that may still start stays guarded", late.children.size === 1);
	resolveLate(late.activation(never(), () => Promise.reject(new Error("teardown"))));
	await sleep(0);
	check("an activation that resolves after the spawn settled is disposed at once", late.seen.disposed === 1);
	check("it is dropped once that disposal ends", late.children.size === 0);

	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	let resolveRejecting: (activation: DshSubagentActivation) => void = () => {};
	const rejecting = harness(
		() =>
			new Promise((resolve) => {
				resolveRejecting = resolve;
			}),
	);
	await rejecting.spawn({ timeoutMs: 20 });
	resolveRejecting(rejecting.activation(Promise.reject(new Error("disposed"))));
	await sleep(10);
	process.off("unhandledRejection", onUnhandled);
	check("a late activation whose result rejects is handled", unhandled.length === 0, unhandled);
}

async function testSpawnStopped(): Promise<void> {
	for (const [row, cause] of [
		["B5", "aborted"],
		["B6", "timeout"],
	] as const) {
		for (const [label, teardown] of [
			["disposes", async () => {}],
			["fails to dispose", () => Promise.reject(new Error("teardown"))],
			["never finishes disposing", () => never<void>()],
		] as const) {
			const controller = new AbortController();
			const h: ReturnType<typeof harness> = harness(
				async (_spec, emit) => {
					if (cause === "aborted") setTimeout(() => controller.abort(), 5);
					return h.activation(never(), () => {
						emit(message("big", { inputTokens: 2, outputTokens: 1 }));
						return teardown();
					});
				},
				{ disposeWaitMs: 30 },
			);
			const result = await h.spawn({
				signal: controller.signal,
				timeoutMs: cause === "timeout" ? 20 : 5000,
			});
			check(`${row} a child that ${label} ends as ${cause}`, failedWith(result, cause), result);
			const guardedIds = label === "never finishes disposing" ? 1 : 0;
			await sleep(0);
			check(
				`${row} a child that ${label} is disposed once and ${guardedIds ? "stays guarded" : "dropped"}`,
				h.seen.disposed === 1 && h.listeners.size === 0 && h.children.size === guardedIds,
			);
			check(`${row} usage during disposal is counted when it ${label}`, result.tokens?.total === 3, result);
		}
	}

	let liveWhileDisposing = false;
	const guarded: ReturnType<typeof harness> = harness(async (spec) =>
		guarded.activation(never(), async () => {
			await sleep(5);
			liveWhileDisposing = guarded.children.has(spec.childId);
		}),
	);
	await guarded.spawn({ timeoutMs: 10 });
	check("a child stays live while it is being disposed", liveWhileDisposing);

	const controller = new AbortController();
	const settled: ReturnType<typeof harness> = harness(async () =>
		settled.activation(Promise.resolve(completed("first")), async () => controller.abort()),
	);
	const first = await settled.spawn({ signal: controller.signal });
	check("the first settled outcome wins over a later abort", first.ok && first.text === "first", first);

	const stuck: ReturnType<typeof harness> = harness(
		async () => stuck.activation(Promise.resolve(completed("done")), () => never<void>()),
		{ disposeWaitMs: 30 },
	);
	const bounded = await Promise.race([stuck.spawn({}), sleep(500).then(() => null)]);
	check("a completed child that never finishes disposing still returns", bounded?.ok === true, bounded);
	check("and stays guarded", stuck.children.size === 1 && stuck.listeners.size === 0);
}

async function testSpawnSettled(): Promise<void> {
	const finish = async (
		result: Promise<DshSubagentResult>,
		type: string,
		events: DshSessionEvent[] = [],
		teardown?: () => Promise<void>,
	) => {
		const h: ReturnType<typeof harness> = harness(async (_spec, emit) => {
			for (const event of events) emit(event);
			return h.activation(result, teardown);
		});
		const outcome = await h.spawn({ type, timeoutMs: 20 });
		await sleep(30);
		check(
			`a ${type} ${outcome.detail ?? "ok"} outcome is disposed, dropped and its timer cleared`,
			h.seen.disposed === 1 && h.clean() && !h.specs[0].signal.aborted,
			{ disposed: h.seen.disposed, aborted: h.specs[0].signal.aborted },
		);
		return outcome;
	};

	const output: DshSubagentResult = {
		stopReason: "completed",
		output: [
			{ type: "text", text: "one " },
			{ type: "reasoning", text: "hidden" },
			{ type: "text", text: "two" },
		],
	};
	for (const type of ["ledger-worker", "ledger-manager"]) {
		const ok = await finish(Promise.resolve(output), type);
		check(`B7 a completed ${type} joins its text blocks`, ok.ok && ok.text === "one two", ok);
	}
	const quiet = await finish(Promise.resolve(completed()), "ledger-worker");
	check("B7 a completed worker with no text is ok", quiet.ok && quiet.text === "", quiet);

	for (const texts of [[], [" \n "]]) {
		const blank = await finish(Promise.resolve(completed(...texts)), "ledger-manager");
		check(`B8 a completed manager with ${texts.length} blank blocks fails`, failedWith(blank, "agent-error"), blank);
	}

	const stopped = (stopReason: string) => Promise.resolve({ stopReason, output: [{ type: "text", text: "part" }] });
	const foreign = await finish(stopped("aborted"), "ledger-worker");
	check("B9 an abort we did not cause fails", failedWith(foreign, "agent-error", "stop reason aborted"), foreign);

	for (const reason of ["error", "max-tokens", "refusal", "something-new"]) {
		const bare = await finish(stopped(reason), "ledger-worker");
		check(`B10 ${reason} alone names the reason`, failedWith(bare, "agent-error", `stop reason ${reason}`), bare);
		const explained = await finish(stopped(reason), "ledger-worker", [
			turnError("first"),
			turnError("last"),
			{ type: "turn/end", data: { reason: { kind: "completed" } } },
		]);
		check(`B10 ${reason} carries the last turn error`, failedWith(explained, "agent-error", "last"), explained);
	}

	const broken = await finish(Promise.reject(new Error("lost")), "ledger-worker");
	check("B11 a rejected result fails", failedWith(broken, "agent-error", "lost"), broken);

	const teardown = await finish(Promise.resolve(completed("kept")), "ledger-worker", [], () =>
		Promise.reject(new Error("teardown")),
	);
	check("a teardown failure keeps the result", teardown.ok && teardown.text === "kept", teardown);

	const unwatched = harness(undefined, {
		events: {
			on: () => {
				throw new Error("no events");
			},
		},
	});
	const result = await unwatched.spawn();
	check(
		"the spawn function never rejects",
		failedWith(result, "refused", "no events") && unwatched.specs.length === 0 && unwatched.children.size === 0,
		result,
	);
}

async function testSpawnTally(): Promise<void> {
	let calls = 0;
	const h: ReturnType<typeof harness> = harness(async (_spec, emit) => {
		calls++;
		emit(message("first", { inputTokens: 10, outputTokens: 5 }));
		emit(message("stranger", { inputTokens: 1000, outputTokens: 1000 }), "someone-else");
		emit(message(`last-${calls}`, { inputTokens: 1, outputTokens: 2, totalTokens: 7 }));
		emit(message(`last-${calls}`));
		return h.activation();
	});
	const worker = await h.spawn();
	check(
		"a child's own usage is summed",
		isDeepStrictEqual(worker.tokens, { input: 11, output: 7, total: 22 }) && typeof worker.durationMs === "number",
		worker,
	);
	await h.spawn();
	await h.spawn({ type: "ledger-manager" });
	check(
		"the tally accumulates by role and keeps the last model",
		isDeepStrictEqual(h.tally, {
			tokens: { manager: 22, worker: 44 },
			models: { manager: "example/last-3", worker: "example/last-2" },
		}),
		h.tally,
	);
	const silent = harness();
	const none = await silent.spawn();
	check(
		"a child with no messages reports no tokens or model",
		none.tokens === undefined && silent.tally.models.worker === null,
		{ none, tally: silent.tally },
	);
}

async function testEffort(): Promise<void> {
	const send = (reasoningEffort: string | undefined) => ({ kind: "send", reasoningEffort });
	const refused = (text: string) => ({ kind: "refused", message: text });
	const explicit: DshConfig = { ...UNSET, workerEffort: "max" };

	const models = roles({
		dsh: { ...UNSET, manager: "cfg/manager", worker: "cfg/worker" },
		requested: { manager: "", worker: "req/worker" },
	}).models;
	check(
		"a role takes the request ref, else the [dsh] ref",
		isDeepStrictEqual(models, { manager: "cfg/manager", worker: "req/worker" }),
		models,
	);
	check(
		"a role with no ref runs on the session model",
		isDeepStrictEqual(roles().models, { manager: null, worker: null }),
	);
	check(
		"the parent route is the latest request's, else the creation options",
		parentRoute(parentAgent({ provider: "p", model: "m" })).model === "m" &&
			parentRoute(parentAgent()).model === "created",
	);

	for (const [label, dsh, expected] of [
		["the default", UNSET, "high"],
		["an explicit effort", explicit, "max"],
	] as const) {
		const none = await roles({ dsh }).effort("worker");
		check(`E1 with no llm ${label} is sent unchecked`, isDeepStrictEqual(none, send(expected)), none);

		const checks = fakeLlm(() => rejection("must not be asked"));
		const parent: DshAgent = { ...parentAgent(), options: { provider: "example" } };
		const unknown = await roles({ dsh, parent, llm: checks.llm }).effort("worker");
		check(
			`E1 with an unknown parent route ${label} is sent unchecked`,
			isDeepStrictEqual(unknown, send(expected)) && checks.calls.length === 0,
			unknown,
		);

		const passing = fakeLlm();
		const sent = await roles({ dsh, llm: passing.llm }).effort("worker");
		check(
			`E2 ${label} that passes is sent`,
			isDeepStrictEqual(sent, send(expected)) &&
				isDeepStrictEqual(passing.calls, [{ provider: "example", model: "big", reasoningEffort: expected }]),
			{ sent, calls: passing.calls },
		);
	}

	const plain = fakeLlm((config) => (config.reasoningEffort ? rejection("no effort", UNSUPPORTED) : undefined));
	const dropped = await roles({ llm: plain.llm, requested: { worker: "stub/plain" } }).effort("worker");
	check(
		"E3 a rejected default is dropped after a second check",
		isDeepStrictEqual(dropped, send(undefined)) &&
			isDeepStrictEqual(plain.calls, [
				{ provider: "stub", model: "plain", reasoningEffort: "high" },
				{ provider: "stub", model: "plain" },
			]),
		{ dropped, calls: plain.calls },
	);
	const gone = fakeLlm((config) =>
		config.reasoningEffort ? rejection("no effort", UNSUPPORTED) : rejection("unknown model", "UNKNOWN_MODEL"),
	);
	const second = await roles({ llm: gone.llm }).effort("worker");
	check("E3 a failed second check refuses", isDeepStrictEqual(second, refused("unknown model")), second);

	const strict = fakeLlm(() => rejection("max is not supported", UNSUPPORTED));
	const named = await roles({ dsh: explicit, llm: strict.llm }).effort("worker");
	check(
		"E4 a rejected explicit effort refuses without a second check",
		isDeepStrictEqual(named, refused("max is not supported")) && strict.calls.length === 1,
		{ named, calls: strict.calls },
	);
	const adapterless = fakeLlm(() => rejection("no adapter", "NO_ADAPTER"));
	const other = await roles({ llm: adapterless.llm }).effort("worker");
	check(
		"E4 any other rejection of the default refuses",
		isDeepStrictEqual(other, refused("no adapter")) && adapterless.calls.length === 1,
		{ other, calls: adapterless.calls },
	);

	let route = { provider: "example", model: "big" };
	const parent: DshAgent = {
		...parentAgent(),
		session: { id: "parent", header: {}, requestHeader: () => ({ config: route }) },
	};
	const counted = fakeLlm((config) => (config.model === "bad" ? rejection("bad", "UNKNOWN_MODEL") : undefined));
	const memo = roles({ parent, llm: counted.llm, dsh: { ...UNSET, managerEffort: "low" } });
	await Promise.all([memo.effort("worker"), memo.effort("worker")]);
	await memo.effort("worker");
	check("effort checks are memoized for a role and route", counted.calls.length === 1, counted.calls);
	const manager = await memo.effort("manager");
	check(
		"each role is checked with its own effort",
		isDeepStrictEqual(manager, send("low")) && counted.calls.length === 2,
		{ manager, calls: counted.calls },
	);
	route = { provider: "example", model: "bad" };
	await memo.effort("worker");
	const again = await memo.effort("worker");
	check(
		"a new session route is checked once, refusals included",
		isDeepStrictEqual(again, refused("bad")) && counted.calls.length === 3,
		{ again, calls: counted.calls },
	);
}

/** A run's directories: a repository with a subdirectory and a nested linked work tree, and one beside it. */
const space = join(root, "space");
const project = join(space, "project");
const nested = join(project, ".worktrees", "feature");
const beside = join(space, "project-beside");

function makeSpace(): void {
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { cwd, stdio: "pipe" });
	for (const dir of [join(project, "sub"), beside]) mkdirSync(dir, { recursive: true });
	for (const dir of [project, beside]) {
		git(dir, "init", "-q");
		git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
	}
	git(project, "worktree", "add", "-q", "--detach", nested);
	writeFileSync(join(project, "sub", "plan.md"), "Do the planned thing.\n");
	writeFileSync(join(project, "a-file"), "");
	symlinkSync(join(project, "sub"), join(space, "into"));
	symlinkSync(beside, join(project, "out"));
	symlinkSync(project, join(space, "project-link"));
}

const REPLY = "### PLAN\nFix it.\n\n### TASKS\n- [todo] Fix it\n\n### STATUS\ndone\n\n### NEXT\n";

const sandbox = (mode: string, workspaceRoot = project, additionalWritableRoots?: string[]): DshSandboxPolicy => ({
	resolve: () => ({ mode, workspaceRoot, additionalWritableRoots }),
});

const collected = (text: string) => ({ text, truncated: false });

const shellResult = (result: Partial<DshShellResult> = {}): DshShellResult => ({
	exitCode: 0,
	signal: null,
	timedOut: false,
	aborted: false,
	timeoutMs: 120_000,
	stdout: collected(""),
	stderr: collected(""),
	...result,
});

/** A command that has already ended with `result`. */
const settled = (result: Partial<DshShellResult> = {}): DshShellExecution => ({
	kill: () => false,
	result: async () => shellResult(result),
});

/** A command that could not be run. */
const unrunnable = (error: Error): DshShellExecution => ({ kill: () => false, result: () => Promise.reject(error) });

/**
 * `spec.command` run by `/bin/sh` in `spec.workdir`, whose process group is killed
 * by `kill`, by the signal, and at the deadline under `onExpiry: "kill"`.
 */
function shExecution(spec: DshShellSpec): DshShellExecution {
	const child = spawn("/bin/sh", ["-c", spec.command], {
		cwd: spec.workdir,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = { stdout: "", stderr: "" };
	for (const name of ["stdout", "stderr"] as const) {
		child[name].on("data", (data) => {
			output[name] += data;
		});
	}
	let running = true;
	let cause: "timedOut" | "aborted" | undefined;
	const kill = () => {
		if (!running || child.pid === undefined) return false;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {}
		return true;
	};
	const stop = (why: "timedOut" | "aborted") => {
		cause ??= why;
		kill();
	};
	const timer = spec.onExpiry === "kill" ? setTimeout(() => stop("timedOut"), spec.timeoutMs) : undefined;
	const onAbort = () => stop("aborted");
	spec.signal?.addEventListener("abort", onAbort, { once: true });
	if (spec.signal?.aborted) onAbort();
	const done = new Promise<DshShellResult>((resolve, reject) => {
		const end = () => {
			running = false;
			clearTimeout(timer);
			spec.signal?.removeEventListener("abort", onAbort);
		};
		child.on("error", (err) => {
			end();
			reject(err);
		});
		child.on("close", (exitCode, signal) => {
			end();
			resolve(
				shellResult({
					exitCode,
					signal,
					timedOut: cause === "timedOut",
					aborted: cause === "aborted",
					timeoutMs: spec.timeoutMs,
					stdout: collected(output.stdout),
					stderr: collected(output.stderr),
				}),
			);
		});
	});
	done.catch(() => {});
	return { kill, result: () => done };
}

/** A shell like dsh's that records the specs it executes and caps timeouts as dsh's does. */
function fakeShell({
	confines = true,
	execute = async (spec: DshShellSpec): Promise<DshShellExecution> => shExecution(spec),
} = {}) {
	const specs: DshShellSpec[] = [];
	const shell: DshShell = {
		sandboxMode: confines ? "read-only" : undefined,
		resolve: (request) => ({
			...request,
			workdir: request.workdir ?? process.cwd(),
			timeoutMs: Math.min(request.timeoutMs ?? 120_000, 600_000),
			onExpiry: request.onExpiry ?? "kill",
		}),
		execute: (spec) => {
			specs.push(spec);
			return execute(spec);
		},
	};
	return Object.assign(shell, { specs });
}

type CreatedListener = (payload: { readonly agent: DshCreatedAgent }) => void;
type Guard = Parameters<DshTools["guard"]>[0];

type FakeChild = DshCreatedAgent & { visible: readonly string[]; masks: DshToolRestriction[] };

/** A new agent that inherits the `visible` tools and records the masks put on it, unless `fail` throws first. */
function fakeChild(id: string, visible: readonly string[] = [], fail?: Error): FakeChild {
	const masks: DshToolRestriction[] = [];
	const restrict = (mask: DshToolRestriction) => {
		if (fail) throw fail;
		masks.push(mask);
		return () => {};
	};
	return { ...parentAgent(), id, ctx: { tools: { restrict } }, visible, masks };
}

/** The part of a plugin context that restricts agents, with what was installed on it. */
function fakeRegistry() {
	const listeners = new Set<CreatedListener>();
	const guards = new Set<Guard>();
	const disposers: (() => void)[] = [];
	const add = <T>(set: Set<T>, item: T) => {
		set.add(item);
		return () => {
			set.delete(item);
		};
	};
	const tools: DshTools = {
		get: (name, agent) => ((agent as FakeChild).visible.includes(name) ? { name } : undefined),
		restrict: () => assert.fail("restricted outside an agent context"),
		guard: (guard) => add(guards, guard),
	};
	return {
		listeners,
		guards,
		tools,
		on: ((name: string, listener: CreatedListener) =>
			name === "agent/created" ? add(listeners, listener) : () => {}) as DshPluginContext["on"],
		effect: (setup: () => () => void) => {
			disposers.push(setup());
		},
		create: (agent: DshCreatedAgent) => {
			for (const listener of listeners) assert.equal(listener({ agent }), undefined);
		},
		denied: (name: string, id?: string): boolean =>
			[...guards].some((guard) => guard({ name, agent: id === undefined ? undefined : { id } }) !== undefined),
		unload: () => {
			for (const dispose of disposers.splice(0)) dispose();
		},
	};
}

/** The restrictions installed on a fake context over the given live children. */
function restricting(children: Map<string, DshRole>) {
	const registry = fakeRegistry();
	const { tools, on, effect } = registry;
	const subagents = { startActivation: () => never<DshSubagentActivation>() };
	restrictLedgerChildren({ tools, on, effect, subagents, get: () => undefined, provide: () => {} }, children);
	return registry;
}

const ALLOWED = ["read", "read_image", "glob", "grep"];
const WORKER_ALLOWED = [...ALLOWED, "write", "edit", "bash"];
const DELEGATION = ["subagent", "subagent_fork", "workflow", "send_message", "team_task_create"];

function testRestrictions(): void {
	const children = new Map<string, DshRole>([
		["mgr", "manager"],
		["wrk", "worker"],
		["odd", "reviewer" as DshRole],
	]);
	const registry = restricting(children);
	const masksOf = (id: string, visible: readonly string[]) => {
		const child = fakeChild(id, visible);
		registry.create(child);
		return child.masks;
	};
	const every = ["write", "grep", "bash", "glob", "read_image", "read", "ledger_solve"];

	const stranger = masksOf("someone", every);
	check("R1 an agent that is not a ledger child is left alone", stranger.length === 0, stranger);
	for (const [label, visible, allow] of [
		["every tool", every, ALLOWED],
		["some of the allowed tools", ["bash", "grep", "read"], ["read", "grep"]],
		["none of the allowed tools", ["bash", "write"], []],
		["no tools", [], []],
	] as const) {
		const masks = masksOf("mgr", visible);
		check(`R2 a manager that sees ${label} keeps only those allowed`, isDeepStrictEqual(masks, [{ allow }]), masks);
	}
	const worker = masksOf("wrk", [...WORKER_ALLOWED, ...DELEGATION, "ledger_solve"]);
	check(
		"R3 a worker keeps only its file and shell tools",
		isDeepStrictEqual(worker, [{ allow: WORKER_ALLOWED }]),
		worker,
	);
	const narrow = masksOf("wrk", ["workflow", "bash"]);
	check("R3 a worker's mask names only tools it sees", isDeepStrictEqual(narrow, [{ allow: ["bash"] }]), narrow);
	const odd = fakeChild("odd", every);
	let thrown = "";
	try {
		registry.create(odd);
	} catch (err) {
		thrown = (err as Error).message;
	}
	check(
		"R4 any other role throws",
		thrown.includes('unknown ledger role "reviewer"') && odd.masks.length === 0,
		thrown,
	);

	for (const name of ["write", "bash", "ledger_solve"]) {
		check(`G1 ${name} with no agent is allowed`, !registry.denied(name));
		check(`G1 ${name} by another agent is allowed`, !registry.denied(name, "someone"));
	}
	for (const name of ["write", "bash", "edit", "run_code", "ledger_solve"]) {
		check(`G2 a manager ${name} is denied`, registry.denied(name, "mgr"));
	}
	for (const name of ALLOWED) check(`G4 a manager ${name} is allowed`, !registry.denied(name, "mgr"));
	for (const name of [...DELEGATION, "run_code", "ledger_solve"]) {
		check(`G3 a worker ${name} is denied`, registry.denied(name, "wrk"));
	}
	for (const name of WORKER_ALLOWED) check(`G4 a worker ${name} is allowed`, !registry.denied(name, "wrk"));
	children.delete("mgr");
	check("G1 a child that is no longer live is allowed", !registry.denied("write", "mgr"));

	check("one listener and one guard are installed", registry.listeners.size === 1 && registry.guards.size === 1);
	registry.unload();
	check("unloading removes the listener and the guard", registry.listeners.size === 0 && registry.guards.size === 0);
}

async function testRestrictionFailure(): Promise<void> {
	for (const [role, visible] of [
		["manager", []],
		["worker", ["ledger_solve"]],
	] as const) {
		let childId = "";
		let live: DshRole | undefined;
		const h: ReturnType<typeof harness> = harness(async (spec) => {
			childId = spec.childId;
			live = h.children.get(childId);
			registry.create(fakeChild(childId, visible, rejection("cannot mask", "RESTRICT_FAILED")));
			return h.activation();
		});
		const registry = restricting(h.children);
		const result = await h.spawn({ type: `ledger-${role}` });
		check(
			`a ${role} that cannot be restricted is refused`,
			live === role && failedWith(result, "refused", "RESTRICT_FAILED: cannot mask"),
			{ live, result },
		);
		check(`a refused ${role} is not left live`, !h.children.has(childId) && h.clean() && h.seen.disposed === 0);
	}

	const host: ReturnType<typeof dshHost> = dshHost({}, async (spec) => {
		host.registry.create(fakeChild(spec.childId, [], rejection("cannot mask")));
		return assert.fail("a child that was not restricted started");
	});
	const outcome = await host.solve();
	check(
		"a run whose manager cannot be restricted stops as a refused spawn",
		outcome.kind === "ran" &&
			outcome.result.stop === "spawn-failure" &&
			outcome.result.stopDetail === "refused" &&
			host.specs.length > 0 &&
			host.specs.every((spec) => !host.service.isLedgerChild(spec.childId)),
		outcome,
	);
}

async function testServiceRestrictions(): Promise<void> {
	const seen: Record<string, unknown> = {};
	const host: ReturnType<typeof dshHost> = dshHost({}, async (spec) => {
		const child = fakeChild(spec.childId, ["read", "write", "ledger_solve"]);
		host.registry.create(child);
		seen[spec.agentPreset] = {
			masks: child.masks,
			write: host.registry.denied("write", child.id),
			solve: host.registry.denied("ledger_solve", child.id),
		};
		return { result: Promise.resolve(completed(REPLY)), dispose: async () => {} };
	});
	const outcome = await host.solve();
	check(
		"the plugin restricts and guards the children of its own runs",
		outcome.kind === "ran" &&
			isDeepStrictEqual(seen, {
				"ledger-manager": { masks: [{ allow: ["read"] }], write: true, solve: true },
				"ledger-worker": { masks: [{ allow: ["read", "write"] }], write: false, solve: true },
			}),
		{ outcome, seen },
	);
	check(
		"a finished child is no longer guarded",
		host.specs.every((spec) => !host.registry.denied("ledger_solve", spec.childId)),
	);
	host.registry.unload();
	check(
		"disposing the plugin removes its listener and guard",
		host.registry.listeners.size === 0 && host.registry.guards.size === 0,
	);
}

/** The root plugin applied to fake dsh services; a service given as undefined is absent. */
function dshHost(
	services: Partial<DshServices> = {},
	start?: (spec: DshSpawnSpec) => Promise<DshSubagentActivation>,
	header: { cwd?: string } = { cwd: project },
) {
	const parent: DshAgent = {
		id: "parent-session",
		session: {
			id: "parent-session",
			header,
			requestHeader: () => ({ config: { provider: "example", model: "big" } }),
		},
		options: {},
	};
	const live = new Map([[parent.id, parent]]);
	const all: Partial<DshServices> = {
		agents: { get: (id) => live.get(id) },
		agentPresets: { resolve: async () => ({}) },
		sandboxPolicy: sandbox("workspace-write"),
		shell: fakeShell(),
		...services,
	};
	const specs: DshSpawnSpec[] = [];
	const provided = new Map<string, unknown>();
	const registry = fakeRegistry();
	const ctx: DshPluginContext = {
		get: (name) => all[name],
		provide: (name, value) => provided.set(name, value),
		on: registry.on,
		effect: registry.effect,
		tools: registry.tools,
		subagents: {
			startActivation: async (spec) => {
				specs.push(spec);
				return start ? start(spec) : { result: Promise.resolve(completed(REPLY)), dispose: async () => {} };
			},
		},
	};
	plugin.apply(ctx);
	const service = provided.get("ledgerpi") as LedgerpiService;
	const solve = (request: Partial<Record<keyof DshSolveRequest, unknown>> = {}, config = "[dsh]\n") => {
		configFrom(`stateDir = "${join(root, "state")}"\n${config}`);
		return service.solve({ parent, task: "Do it.", gate: "true", ...request } as DshSolveRequest);
	};
	return { ctx, service, solve, specs, parent, live, registry };
}

const endOf = (outcome: DshSolveOutcome): string =>
	outcome.kind === "rejected" || outcome.kind === "inactive" ? `${outcome.kind} ${outcome.reason}` : outcome.kind;

const fieldOf = (outcome: DshSolveOutcome): string | undefined =>
	outcome.kind === "rejected" ? outcome.field : undefined;

const messageOf = (outcome: DshSolveOutcome): string =>
	outcome.kind === "rejected" || outcome.kind === "failed" ? outcome.message : "";

/** Check that a call ended as `expected` and neither started a child nor wrote an audit row. */
async function checkRefused(
	label: string,
	expected: string,
	host: ReturnType<typeof dshHost>,
	call: () => Promise<DshSolveOutcome> = () => host.solve(),
): Promise<DshSolveOutcome> {
	const rows = auditRows().length;
	const outcome = await call();
	check(
		label,
		endOf(outcome) === expected &&
			Array.isArray(outcome.warnings) &&
			host.specs.length === 0 &&
			auditRows().length === rows,
		{ outcome, specs: host.specs.length },
	);
	return outcome;
}

/** Whether the lock on work tree `tree` can be taken, leaving it free. */
function lockFree(tree: string): boolean {
	const release = acquireLock(join(root, "state"), tree);
	release?.();
	return release !== null;
}

async function testServiceInactive(): Promise<void> {
	const noRegistry = { agentPresets: undefined };
	for (const [reason, env, config, services] of [
		["env-disabled", "0", "enabled = false\n[dsh]\n", noRegistry],
		["switched-off", undefined, "enabled = false\n[dsh]\n", noRegistry],
		["no-dsh-table", undefined, `${PROVIDER}`, noRegistry],
		["no-preset-registry", undefined, "[dsh]\n", noRegistry],
	] as const) {
		const host = dshHost(services);
		if (env !== undefined) process.env.LEDGERPI = env;
		const aborted = AbortSignal.abort();
		await checkRefused(`D1 ${reason} wins over later rows`, `inactive ${reason}`, host, () =>
			host.solve({ signal: aborted, parent: undefined }, config),
		);
		const status = host.service.status();
		check(`status reports ${reason}`, isDeepStrictEqual(status, { apiVersion: 1, active: false, reason }), status);
		delete process.env.LEDGERPI;
	}

	const host = dshHost();
	configFrom("[dsh]\n");
	check("status reports active", isDeepStrictEqual(host.service.status(), { apiVersion: 1, active: true }));
	rmSync(configFile);
	mkdirSync(configFile);
	const unreadable = host.service.status();
	check("status with an unreadable config is inactive", !unreadable.active, unreadable);
	rmSync(configFile, { recursive: true });

	const throwing = dshHost();
	throwing.ctx.get = () => assert.fail("no services");
	configFrom("[dsh]\n");
	const status = throwing.service.status();
	check("status never throws", !status.active, status);
	await checkRefused("a throwing service lookup is failed", "failed", throwing);
}

async function testServiceParent(): Promise<void> {
	const aborted = dshHost({ agents: undefined });
	await checkRefused("D2 an aborted signal is canceled before the parent is looked at", "canceled", aborted, () =>
		aborted.solve({ signal: AbortSignal.abort(), parent: undefined }),
	);

	const missing = dshHost();
	await checkRefused("D3 no parent", "rejected no-parent", missing, () =>
		missing.solve({ parent: undefined, task: " " }),
	);
	await checkRefused("D3 a copy of a live agent", "rejected no-parent", missing, () =>
		missing.solve({ parent: { ...missing.parent } }),
	);
	const unregistered = dshHost({ agents: undefined });
	await checkRefused("D3 no agent registry", "rejected no-parent", unregistered);
	const gone = dshHost({ agents: { get: () => undefined } });
	await checkRefused("D3 an agent that is not live", "rejected no-parent", gone);

	let nestedCall: DshSolveOutcome | undefined;
	let during = false;
	const host: ReturnType<typeof dshHost> = dshHost({}, async (spec) => {
		if (nestedCall === undefined) {
			const child: DshAgent = { ...host.parent, id: spec.childId };
			host.live.set(child.id, child);
			during = host.service.isLedgerChild(child.id);
			nestedCall = await host.service.solve({ parent: child, task: " " });
		}
		return { result: Promise.resolve(completed(REPLY)), dispose: async () => {} };
	});
	await host.solve();
	check(
		"D4 a ledger child cannot start a run",
		nestedCall?.kind === "rejected" && nestedCall.reason === "nested",
		nestedCall,
	);
	check(
		"a ledger child is known only while it runs",
		during &&
			host.specs.every((spec) => !host.service.isLedgerChild(spec.childId)) &&
			!host.service.isLedgerChild(host.parent.id),
	);
}

async function testServiceArguments(): Promise<void> {
	const host = dshHost({ sandboxPolicy: undefined });
	for (const task of ["  ", undefined, 5]) {
		await checkRefused(`D5 task ${JSON.stringify(task)}`, "rejected blank-task", host, () =>
			host.solve({ task, managerModel: "bare" }),
		);
	}

	for (const field of ["managerModel", "workerModel"]) {
		for (const ref of ["bare", "p /m", " ", 5, null]) {
			const outcome = await checkRefused(`D6 ${field} ${JSON.stringify(ref)}`, "rejected bad-model-ref", host, () =>
				host.solve({ [field]: ref, cwd: 5 }),
			);
			check(`D6 ${field} ${JSON.stringify(ref)} names the field`, fieldOf(outcome) === field, outcome);
		}
	}
	await checkRefused("an empty model ref is absent", "rejected sandbox-unavailable", host, () =>
		host.solve({ managerModel: "", workerModel: "" }),
	);

	for (const [label, cwd] of [
		["a cwd that is not a string", 5],
		["a null cwd", null],
		["a missing directory", "absent"],
		["a file", "a-file"],
	] as const) {
		await checkRefused(`D7 ${label}`, "rejected cwd-unavailable", host, () => host.solve({ cwd }));
	}
	const baseless = dshHost({ sandboxPolicy: undefined }, undefined, {});
	await checkRefused("D7 no base directory", "rejected cwd-unavailable", baseless, () =>
		baseless.solve({ cwd: project }),
	);
	const lost = dshHost({ workingDirectory: { get: () => assert.fail("lost") } });
	await checkRefused("D7 a working directory that cannot be read", "rejected cwd-unavailable", lost);
}

async function testServiceContainment(): Promise<void> {
	const unresolved = dshHost({
		sandboxPolicy: {
			resolve: () => {
				throw new Error("policy store offline");
			},
		},
	});
	await checkRefused(
		"K1 D8 no sandbox policy service",
		"rejected sandbox-unavailable",
		dshHost({ sandboxPolicy: undefined }),
	);
	const failing = await checkRefused(
		"K2 D8 a policy that cannot be resolved",
		"rejected sandbox-unavailable",
		unresolved,
	);
	check("K2 the message carries the cause", messageOf(failing).includes("policy store offline"), failing);
	await checkRefused(
		"K6 D8 an unknown mode",
		"rejected sandbox-unavailable",
		dshHost({ sandboxPolicy: sandbox("something-new") }),
	);

	await checkRefused(
		"K4 D9 a read-only session",
		"rejected read-only-session",
		dshHost({ sandboxPolicy: sandbox("read-only") }),
	);

	let asked: unknown;
	const full = dshHost({
		sandboxPolicy: {
			resolve: (request) => {
				asked = request.session;
				return { mode: "danger-full-access", workspaceRoot: project };
			},
		},
	});
	const outside = await full.solve({ cwd: beside });
	check("K3 full access runs outside the workspace", outside.kind === "ran", outside);
	check("the policy is resolved for the parent session", asked === full.parent.session, asked);

	for (const [label, cwd] of [
		["a sibling sharing the name prefix", beside],
		["the parent of the workspace", space],
		["a symlink pointing outside", "out"],
		["a relative path leading outside", "../project-beside"],
		["a temp directory", realpathSync(tmpdir())],
	]) {
		const host = dshHost();
		const outcome = await checkRefused(`K5 D10 ${label}`, "rejected cwd-outside-workspace", host, () =>
			host.solve({ cwd }),
		);
		check(`K5 ${label} names the field`, fieldOf(outcome) === "cwd", outcome);
	}
	const notGit = dshHost({ sandboxPolicy: sandbox("workspace-write", project) });
	await checkRefused("D10 containment comes before the git check", "rejected cwd-outside-workspace", notGit, () =>
		notGit.solve({ cwd: root }),
	);

	const sub = join(project, "sub");
	const absent = join(space, "absent");
	for (const [label, policy, cwd, expected] of [
		["the workspace root", sandbox("workspace-write"), undefined, project],
		["a subdirectory", sandbox("workspace-write"), "sub", sub],
		["a symlink pointing inside", sandbox("workspace-write"), join(space, "into"), sub],
		["a symlinked workspace root", sandbox("workspace-write", join(space, "project-link")), "sub", sub],
		["an additional writable root", sandbox("workspace-write", project, [absent, beside]), beside, beside],
		["a root beside an unresolvable one", sandbox("workspace-write", absent, [project]), undefined, project],
	] as const) {
		const host = dshHost({ sandboxPolicy: policy });
		const outcome = await host.solve({ cwd });
		check(
			`K5 ${label} runs on its real path`,
			outcome.kind === "ran" &&
				outcome.result.cwd === expected &&
				host.specs.length > 0 &&
				host.specs.every((spec) => spec.cwd === expected) &&
				auditRows().at(-1)?.cwd === expected,
			{ outcome, cwds: host.specs.map((spec) => spec.cwd) },
		);
	}
	const unresolvable = dshHost({ sandboxPolicy: sandbox("workspace-write", absent, [join(space, "gone")]) });
	await checkRefused("K5 no resolvable root", "rejected cwd-outside-workspace", unresolvable);
}

async function testServiceDirectory(): Promise<void> {
	const moved = dshHost({ workingDirectory: { get: () => join(project, "sub") } }, undefined, { cwd: beside });
	const relativeToMoved = await moved.solve({ cwd: ".." });
	check(
		"a relative cwd resolves against the working directory",
		relativeToMoved.kind === "ran" && relativeToMoved.result.cwd === project,
		relativeToMoved,
	);
	for (const [label, services] of [
		["no working directory service", {}],
		["a session the service does not know", { workingDirectory: { get: () => undefined } }],
	] as const) {
		const host = dshHost(services, undefined, { cwd: join(project, "sub") });
		const outcome = await host.solve();
		check(
			`the header cwd is the base with ${label}`,
			outcome.kind === "ran" && outcome.result.cwd === join(project, "sub"),
			outcome,
		);
	}
}

async function testServiceTreeAndPlan(): Promise<void> {
	const full = { sandboxPolicy: sandbox("danger-full-access") };
	const host = dshHost(full);
	await checkRefused("D11 not a git work tree", "rejected not-git", host, () =>
		host.solve({ cwd: root, planFile: "absent.md" }),
	);

	const unpreset = dshHost({ agentPresets: { resolve: () => assert.fail("asked too early") } });
	const bad = await checkRefused("D12 a bad plan file", "rejected bad-plan-file", unpreset, () =>
		unpreset.solve({ cwd: "sub", planFile: "absent.md" }),
	);
	check(
		"a relative plan file is looked for in the run directory",
		messageOf(bad).includes(join(project, "sub", "absent.md")),
		bad,
	);

	for (const [label, planFile] of [
		["relative", " plan.md "],
		["absolute", join(project, "sub", "plan.md")],
	]) {
		const planned = await dshHost().solve({ cwd: "sub", planFile });
		check(
			`a ${label} plan file is supplied to the run`,
			planned.kind === "ran" && planned.result.planSource === "caller",
			planned,
		);
	}

	const loose = await dshHost().solve({ fanout: "lots", planFile: "  " }, '[dsh]\nunknown = "x"\n');
	check(
		"D13 an invalid fan-out warns and runs, after the config warnings",
		loose.kind === "ran" &&
			loose.warnings.length === 2 &&
			loose.warnings[0].includes('"unknown" in [dsh]') &&
			loose.warnings[1].includes('ignoring fanout "lots"'),
		loose,
	);
}

async function testServiceModels(): Promise<void> {
	for (const preset of ["ledger-manager", "ledger-worker"]) {
		for (const [label, resolve] of [
			["throws", () => Promise.reject(new Error("unknown preset"))],
			["is broken", () => Promise.resolve({ broken: "unknown preset" })],
		] as const) {
			const host = dshHost({
				agentPresets: { resolve: (id) => (id === preset ? resolve() : Promise.resolve({})) },
				llm: { resolveCallConfig: () => Promise.reject(new Error("no adapter")) },
			});
			const outcome = await checkRefused(`D14 ${preset} that ${label}`, "rejected presets-unavailable", host, () =>
				host.solve({ workerModel: "stub/missing" }),
			);
			check(`D14 ${preset} that ${label} is named`, messageOf(outcome).includes(preset), outcome);
		}
	}

	for (const field of ["managerModel", "workerModel"]) {
		const llm = fakeLlm((config) => (config.model === "missing" ? new Error("no such model") : undefined));
		const host = dshHost({ llm: llm.llm });
		const outcome = await checkRefused(`D15 a refused ${field}`, "rejected model-refused", host, () =>
			host.solve({ [field]: "stub/missing" }),
		);
		check(`D15 ${field} carries dsh's message`, messageOf(outcome) === "no such model", outcome);
	}

	const llm = fakeLlm((config) => (config.model === "missing" ? new Error("no such model") : undefined));
	const configured = dshHost({ llm: llm.llm });
	const refused = await configured.solve({}, '[dsh]\nmanager = "stub/missing"\n');
	check(
		"a refused config ref is a spawn failure, not a rejection",
		refused.kind === "ran" && refused.result.stop === "spawn-failure" && refused.result.stopDetail === "refused",
		refused,
	);

	const pinned = dshHost({ llm: fakeLlm().llm });
	await pinned.solve({ workerModel: "req/worker" }, '[dsh]\nmanager = "cfg/manager"\nworker = "cfg/worker"\n');
	const started = new Set(pinned.specs.map((spec) => `${spec.agentPreset} ${spec.agentOptions.model}`));
	check(
		"children start on the request ref, else the [dsh] ref",
		isDeepStrictEqual(started, new Set(["ledger-manager manager", "ledger-worker worker"])) &&
			pinned.specs.every(
				(spec) => spec.agentOptions.provider === (spec.agentPreset.endsWith("worker") ? "req" : "cfg"),
			),
		pinned.specs.map((spec) => spec.agentOptions),
	);
}

/** A policy service that resolves to each of `steps` in turn, then to the last again; an Error is thrown. */
function changingPolicy(...steps: (string | Error)[]): DshSandboxPolicy {
	let calls = 0;
	return {
		resolve: () => {
			const step = steps[Math.min(calls++, steps.length - 1)];
			if (step instanceof Error) throw step;
			return { mode: step, workspaceRoot: project };
		},
	};
}

/** Check that a call is refused as `expected` while the lock is held, so before it is taken. */
async function checkRefusedBeforeLock(
	label: string,
	expected: string,
	host: ReturnType<typeof dshHost>,
	call?: () => Promise<DshSolveOutcome>,
): Promise<DshSolveOutcome> {
	const release = acquireLock(join(root, "state"), project);
	try {
		return await checkRefused(label, expected, host, call);
	} finally {
		release?.();
	}
}

/** A gate command that cannot be mistaken for the probe's `true`. */
const GATE = "test -d .";

const probes = (shell: ReturnType<typeof fakeShell>) => shell.specs.filter((spec) => spec.command === "true");

async function testServiceGateShell(): Promise<void> {
	const shellless = dshHost({ shell: undefined });
	await checkRefusedBeforeLock("A1 no shell service", "rejected gate-unavailable", shellless);
	await checkRefusedBeforeLock("A1 a configured gate is checked too", "rejected gate-unavailable", shellless, () =>
		shellless.solve({ gate: undefined }, 'gate = "true"\n[dsh]\n'),
	);
	for (const gate of [undefined, "  "]) {
		const outcome = await shellless.solve({ gate });
		check(
			`A0 with no shell, a run with gate ${JSON.stringify(gate)} still runs`,
			outcome.kind === "ran" && outcome.result.gate === null,
			outcome,
		);
	}
	await checkRefusedBeforeLock(
		"A1 comes before the policy is looked at",
		"rejected gate-unavailable",
		dshHost({ shell: undefined, sandboxPolicy: changingPolicy("workspace-write", new Error("offline")) }),
	);
	await checkRefusedBeforeLock(
		"A1 comes before full access passes",
		"rejected gate-unavailable",
		dshHost({ shell: undefined, sandboxPolicy: sandbox("danger-full-access") }),
	);
	for (const confines of [true, false]) {
		const shell = fakeShell({ confines });
		const outcome = await dshHost({ shell, sandboxPolicy: sandbox("danger-full-access") }).solve({ gate: GATE });
		check(
			`A3 full access runs without a probe on a shell that ${confines ? "confines" : "does not confine"}`,
			outcome.kind === "ran" && outcome.result.converged && probes(shell).length === 0,
			{ outcome, specs: shell.specs },
		);
	}

	for (const mode of ["workspace-write", "read-only"]) {
		const shell = fakeShell({ confines: false });
		const host = dshHost({ shell, sandboxPolicy: changingPolicy("workspace-write", mode) });
		const outcome = await checkRefusedBeforeLock(
			`A4 ${mode} on a shell that does not confine`,
			"rejected gate-unconfined",
			host,
		);
		check(
			`A4 ${mode} is named and nothing is executed`,
			messageOf(outcome).includes(mode) && shell.specs.length === 0,
			{ outcome, specs: shell.specs },
		);
	}
}

async function testServiceGatePolicy(): Promise<void> {
	const absentShell = fakeShell();
	const absent = dshHost({ shell: absentShell });
	const get = absent.ctx.get;
	let asked = 0;
	absent.ctx.get = ((name) =>
		name === "sandboxPolicy" && ++asked > 1 ? undefined : get(name)) as DshPluginContext["get"];
	await checkRefusedBeforeLock("A2 no policy service at the gate check", "rejected sandbox-unavailable", absent);

	const failingShell = fakeShell();
	const failing = await checkRefusedBeforeLock(
		"A2 a policy that cannot be resolved at the gate check",
		"rejected sandbox-unavailable",
		dshHost({
			shell: failingShell,
			sandboxPolicy: changingPolicy("workspace-write", new Error("policy store offline")),
		}),
	);
	check("A2 the message carries the cause", messageOf(failing).includes("policy store offline"), failing);

	const unknownShell = fakeShell();
	const unknown = await checkRefusedBeforeLock(
		"A6 an unknown mode at the gate check",
		"rejected sandbox-unavailable",
		dshHost({ shell: unknownShell, sandboxPolicy: changingPolicy("workspace-write", "something-new") }),
	);
	check("A6 the mode is named", messageOf(unknown).includes("something-new"), unknown);
	check(
		"A2 and A6 execute nothing",
		[absentShell, failingShell, unknownShell].every((shell) => shell.specs.length === 0),
	);
}

async function testServiceGateProbe(): Promise<void> {
	const policy: DshExecutionPolicy = {
		mode: "workspace-write",
		workspaceRoot: project,
		additionalWritableRoots: [beside],
		sessionId: "parent-session",
	};
	const { signal } = new AbortController();
	let freeDuringProbe = false;
	const shell = fakeShell({
		execute: async (spec) => {
			if (spec.command === "true") freeDuringProbe = lockFree(project);
			return shExecution(spec);
		},
	});
	const passed = await dshHost({ shell, sandboxPolicy: { resolve: () => policy } }).solve({
		cwd: "sub",
		gate: GATE,
		signal,
	});
	const [probe] = probes(shell);
	check(
		"A5b a probe that exits 0 lets the run go on",
		passed.kind === "ran" && passed.result.converged && probes(shell).length === 1,
		{ passed, specs: shell.specs },
	);
	check(
		"A5 the probe runs in the run path under the whole policy, with the call's signal and a 10 s deadline",
		probe?.workdir === join(project, "sub") &&
			probe.sandboxPolicy === policy &&
			probe.signal === signal &&
			probe.timeoutMs === 10_000 &&
			probe.onExpiry === "kill",
		probe,
	);
	check("A5 the probe runs before the lock is taken", freeDuringProbe);

	const readOnly = fakeShell();
	await dshHost({ shell: readOnly, sandboxPolicy: changingPolicy("workspace-write", "read-only") }).solve({
		gate: GATE,
	});
	check("A5 a read-only mode is probed", probes(readOnly)[0]?.sandboxPolicy?.mode === "read-only", readOnly.specs);

	const unusable = rejection("no sandbox backend is usable", "SANDBOX_UNAVAILABLE");
	for (const [label, execute, cause] of [
		["a runner that cannot confine", async () => unrunnable(unusable), "no sandbox backend is usable"],
		["a command that cannot start", () => Promise.reject(new Error("spawn failed")), "spawn failed"],
		[
			"a nonzero exit",
			async () => settled({ exitCode: 3, stderr: collected("cannot mount\n") }),
			"exit code 3: cannot mount",
		],
		["a death by signal", async () => settled({ exitCode: null, signal: "SIGKILL" }), "signal SIGKILL"],
		[
			"a timeout",
			async () => settled({ exitCode: null, timedOut: true, timeoutMs: 10_000 }),
			"timed out after 10000 ms",
		],
	] as const) {
		const outcome = await checkRefusedBeforeLock(
			`A5c ${label}`,
			"rejected sandbox-unavailable",
			dshHost({ shell: fakeShell({ execute }) }),
		);
		check(`A5c ${label} is reported`, messageOf(outcome).includes(cause), outcome);
	}
	const unresolvable = fakeShell();
	unresolvable.resolve = () => {
		throw new Error("bad shell config");
	};
	const refused = await checkRefusedBeforeLock(
		"A5c a request the shell cannot resolve",
		"rejected sandbox-unavailable",
		dshHost({ shell: unresolvable }),
	);
	check("A5c the resolve error is reported", messageOf(refused).includes("bad shell config"), refused);

	for (const [label, end] of [
		["ends as aborted", async () => settled({ exitCode: null, aborted: true })],
		["passes", async () => settled()],
		["throws", () => Promise.reject(new Error("aborted"))],
	] as const) {
		const controller = new AbortController();
		const host = dshHost({
			shell: fakeShell({
				execute: () => {
					controller.abort();
					return end();
				},
			}),
		});
		await checkRefusedBeforeLock(`A5a an abort during a probe that ${label} cancels`, "canceled", host, () =>
			host.solve({ signal: controller.signal }),
		);
	}
}

/** The gate runner of a fake dsh host whose services are `services`. */
function gateRunner(services: Partial<DshServices> = {}) {
	const host = dshHost(services);
	return dshGateRunner(host.ctx, host.parent);
}

/** A command that ends only when `end` is called, counting the calls to `kill`. */
function held() {
	let end: (result?: Partial<DshShellResult>) => void = () => {};
	const done = new Promise<DshShellResult>((resolve) => {
		end = (result) => resolve(shellResult(result));
	});
	const seen = { kills: 0 };
	const execution: DshShellExecution = {
		kill: () => {
			seen.kills++;
			return true;
		},
		result: () => done,
	};
	return { execution, seen, end };
}

/** Whether `verdict` says the gate never ran, with `cause` in its output. */
const notRun = (verdict: GateVerdict | null | undefined, cause: string): boolean =>
	verdict?.ran === false && verdict.passed === false && verdict.output?.includes(cause) === true;

/** Whether `verdict` is that of a gate that outlived its timeout. */
const outOfTime = (verdict: GateVerdict | undefined): boolean =>
	verdict?.ran === true && verdict.passed === false && verdict.output?.endsWith("\n[gate timed out]") === true;

async function testGateRunnerRefusals(): Promise<void> {
	const shell = fakeShell();
	const aborted = await gateRunner({ shell })(GATE, project, 1_000, AbortSignal.abort());
	check("B1 an aborted gate does not run", notRun(aborted, "aborted") && aborted.command === GATE, aborted);
	const shellless = await gateRunner({ shell: undefined })(GATE, project, 1_000);
	check("B2 no shell service", notRun(shellless, "No shell service"), shellless);
	for (const [label, sandboxPolicy, cause] of [
		["B3 no policy service", undefined, "No sandbox policy service"],
		["B3 a policy that cannot be resolved", changingPolicy(new Error("policy store offline")), "store offline"],
		["B3 a policy service that returns nothing", { resolve: () => undefined as never }, "mode"],
		["B4 an unknown mode", sandbox("something-new"), "something-new"],
	] as const) {
		const verdict = await gateRunner({ shell, sandboxPolicy })(GATE, project, 1_000);
		check(label, notRun(verdict, cause), verdict);
	}
	for (const mode of ["workspace-write", "read-only"]) {
		const unconfining = fakeShell({ confines: false });
		const verdict = await gateRunner({ shell: unconfining, sandboxPolicy: sandbox(mode) })(GATE, project, 1_000);
		check(
			`B5 ${mode} on a shell that does not confine never runs`,
			notRun(verdict, "does not sandbox") && unconfining.specs.length === 0,
			{ verdict, specs: unconfining.specs },
		);
	}
	check("B1 to B4 execute nothing", shell.specs.length === 0, shell.specs);
}

async function testGateRunnerResults(): Promise<void> {
	const policy: DshExecutionPolicy = { mode: "workspace-write", workspaceRoot: project, sessionId: "parent-session" };
	const shell = fakeShell();
	const passed = await gateRunner({ shell, sandboxPolicy: { resolve: () => policy } })(
		"pwd -P",
		join(project, "sub"),
		700_000,
	);
	const [spec] = shell.specs;
	check("B6e exit 0 passes", isDeepStrictEqual(passed, { ran: true, passed: true, command: "pwd -P" }), passed);
	check(
		"B6 the shell gets the whole policy, the cwd, the command and no deadline of its own",
		spec?.command === "pwd -P" &&
			spec.workdir === join(project, "sub") &&
			spec.sandboxPolicy === policy &&
			spec.onExpiry === "none" &&
			spec.signal?.aborted === false,
		spec,
	);
	for (const confines of [true, false]) {
		const verdict = await gateRunner({
			shell: fakeShell({ confines }),
			sandboxPolicy: sandbox("danger-full-access"),
		})(GATE, project, 1_000);
		check(`B6 full access runs on a shell that ${confines ? "confines" : "does not confine"}`, verdict.passed);
	}

	const run = gateRunner();
	const failed = await run("printf out; echo err >&2; exit 3", project, 10_000);
	check(
		"B6f a failed gate carries both streams",
		failed.ran && !failed.passed && failed.output === "out\nerr\n",
		failed,
	);
	const long = await run("printf 'x%.0s' $(seq 4000); echo end >&2; exit 1", project, 10_000);
	check("B6f the output is cut to its tail", long.output?.length === 3_000 && long.output.endsWith("x\nend\n"), long);
	const killed = await run("kill -9 $$", project, 10_000);
	check("B6f a death by signal fails the gate", killed.ran && !killed.passed, killed);

	const confinement = { mode: "workspace-write", enforcement: "partial" as const };
	for (const denied of [true, false]) {
		const execute = async () =>
			settled({ exitCode: 1, stderr: collected("touch: denied\n"), sandbox: { ...confinement, denied } });
		const verdict = await gateRunner({ shell: fakeShell({ execute }) })(GATE, project, 1_000);
		check(
			`B6f a failure ${denied ? "with" : "without"} a denial ${denied ? "says so" : "says nothing of one"}`,
			verdict.output === `touch: denied\n${denied ? "\n[sandbox denied a write]" : ""}`,
			verdict,
		);
	}

	const unusable = rejection("no sandbox backend is usable", "SANDBOX_UNAVAILABLE");
	for (const [label, execute, cause] of [
		["B6a an execute that rejects", () => Promise.reject(new Error("spawn failed")), "spawn failed"],
		["B6c a runner that cannot confine", async () => unrunnable(unusable), "no sandbox backend is usable"],
		["B6d an aborted result", async () => settled({ exitCode: null, aborted: true }), "aborted"],
	] as const) {
		const verdict = await gateRunner({ shell: fakeShell({ execute }) })(GATE, project, 1_000);
		check(label, notRun(verdict, cause), verdict);
	}
	const unresolvable = fakeShell();
	unresolvable.resolve = () => {
		throw new Error("bad shell config");
	};
	const unresolved = await gateRunner({ shell: unresolvable })(GATE, project, 1_000);
	check("B6a a request the shell cannot resolve", notRun(unresolved, "bad shell config"), unresolved);

	for (const [label, end] of [
		["B6a an execute", () => Promise.reject(new Error("cut off"))],
		["B6c a result", async () => unrunnable(new Error("cut off"))],
	] as const) {
		const controller = new AbortController();
		const execute = () => {
			controller.abort();
			return end();
		};
		const verdict = await gateRunner({ shell: fakeShell({ execute }) })(GATE, project, 1_000, controller.signal);
		check(`${label} rejecting after an abort is aborted`, verdict.output === "aborted" && !verdict.ran, verdict);
	}

	const controller = new AbortController();
	setTimeout(() => controller.abort(), 50);
	const stopped = await run("sleep 30", project, 60_000, controller.signal);
	check("B6d an abort mid-gate stops the command", notRun(stopped, "aborted"), stopped);
}

async function testGateRunnerTimeouts(): Promise<void> {
	const startedAt = Date.now();
	const real = await gateRunner()("echo started; sleep 30", project, 200);
	check(
		"B6b a running gate is killed at its timeout, keeping its output",
		outOfTime(real) && real.output?.startsWith("started\n") === true && Date.now() - startedAt < 10_000,
		real,
	);

	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const pass = async (ms: number) => {
			await turn();
			mock.timers.tick(ms);
			await turn();
		};
		const start = (execute: (spec: DshShellSpec) => Promise<DshShellExecution>, signal?: AbortSignal) => {
			const shell = fakeShell({ execute });
			const state: { verdict?: GateVerdict } = {};
			void gateRunner({ shell })(GATE, project, 700_000, signal).then((verdict) => {
				state.verdict = verdict;
			});
			return { shell, state };
		};

		const slow = held();
		const capped = start(async () => slow.execution);
		await pass(600_000);
		check(
			"B6b a timeout above the shell's cap is not cut to it",
			capped.shell.specs[0]?.timeoutMs === 600_000 && capped.state.verdict === undefined && slow.seen.kills === 0,
			capped.state,
		);
		await pass(100_000);
		check(
			"B6b the timeout kills and then waits for the result",
			slow.seen.kills === 1 && capped.shell.specs[0]?.signal?.aborted === true && capped.state.verdict === undefined,
			{ seen: slow.seen, state: capped.state },
		);
		slow.end({ exitCode: null, aborted: true, stdout: collected("partial") });
		await turn();
		check(
			"B6b a result that settles after the kill gives the timed-out verdict",
			outOfTime(capped.state.verdict) && capped.state.verdict?.output === "partial\n[gate timed out]",
			capped.state,
		);

		const stuck = held();
		const unsettled = start(async () => stuck.execution);
		await pass(700_000);
		await pass(9_999);
		const early = unsettled.state.verdict;
		await pass(1);
		check(
			"B6b a result that never settles is given up after 10 s",
			early === undefined && outOfTime(unsettled.state.verdict),
			unsettled.state,
		);

		const late = held();
		let publish: () => void = () => {};
		const pending = start(
			() =>
				new Promise((resolve) => {
					publish = () => resolve(late.execution);
				}),
		);
		await pass(700_000);
		await pass(10_000);
		check("B6b the timeout covers a pending execute", outOfTime(pending.state.verdict), pending.state);
		publish();
		await turn();
		check("B6b a command published after the timeout is killed", late.seen.kills === 1, late.seen);

		const preparing = start(
			(spec) =>
				new Promise((_, reject) => {
					spec.signal?.addEventListener("abort", () => reject(spec.signal?.reason));
				}),
		);
		await pass(700_000);
		check("B6b a preparation cut by the timeout is timed out", outOfTime(preparing.state.verdict), preparing.state);

		const own = held();
		own.end({ exitCode: null, timedOut: true });
		const expired = start(async () => own.execution);
		await turn();
		check("B6b a result the shell timed out is timed out", outOfTime(expired.state.verdict) && own.seen.kills === 1, {
			state: expired.state,
			seen: own.seen,
		});

		const controller = new AbortController();
		const ignoring = held();
		const abandoned = start(async () => ignoring.execution, controller.signal);
		await turn();
		controller.abort();
		await pass(10_000);
		check(
			"B6 an aborted command that never ends is killed and given up after 10 s",
			notRun(abandoned.state.verdict, "aborted") && ignoring.seen.kills === 1,
			{ state: abandoned.state, seen: ignoring.seen },
		);

		const cancelPreparing = new AbortController();
		const unwanted = held();
		let publishUnwanted: () => void = () => {};
		const cut = start(
			() =>
				new Promise((resolve) => {
					publishUnwanted = () => resolve(unwanted.execution);
				}),
			cancelPreparing.signal,
		);
		await turn();
		cancelPreparing.abort();
		await pass(10_000);
		check("B6 an abort does not wait on a pending execute", notRun(cut.state.verdict, "aborted"), cut.state);
		publishUnwanted();
		await turn();
		check("B6 a command published after an abort is killed", unwanted.seen.kills === 1, unwanted.seen);

		const cancelPassing = new AbortController();
		const passing = held();
		const overtaken = start(async () => passing.execution, cancelPassing.signal);
		await turn();
		cancelPassing.abort();
		passing.end();
		await turn();
		check("B6 a command that passes after the abort is still aborted", notRun(overtaken.state.verdict, "aborted"), {
			state: overtaken.state,
		});

		const probed = (execute: () => Promise<DshShellExecution>) => {
			const host = dshHost({ shell: fakeShell({ execute }) });
			const state: { rejection?: Awaited<ReturnType<typeof gateCheck>> } = {};
			void gateCheck(host.ctx, host.parent, project, new AbortController().signal).then((rejection) => {
				state.rejection = rejection;
			});
			return state;
		};
		const refusedAtDeadline = ({ rejection }: ReturnType<typeof probed>): boolean =>
			rejection?.reason === "sandbox-unavailable" && rejection.message.includes("timed out after 10000 ms");

		const unprepared = probed(() => new Promise<DshShellExecution>(() => {}));
		await pass(10_000);
		check("A5c a probe that is never prepared is refused at its deadline", refusedAtDeadline(unprepared), unprepared);

		const hung = held();
		const unfinished = probed(async () => hung.execution);
		await pass(10_000);
		check(
			"A5c a probe that never ends is killed and refused",
			refusedAtDeadline(unfinished) && hung.seen.kills === 1,
			{
				state: unfinished,
				seen: hung.seen,
			},
		);

		let publishProbe: (execution: DshShellExecution) => void = () => {};
		const preparedLate = probed(
			() =>
				new Promise<DshShellExecution>((resolve) => {
					publishProbe = resolve;
				}),
		);
		await pass(10_000);
		const lateProbe = held();
		publishProbe(lateProbe.execution);
		await turn();
		check(
			"A5c a probe prepared after its deadline is killed",
			refusedAtDeadline(preparedLate) && lateProbe.seen.kills === 1,
			lateProbe.seen,
		);
	} finally {
		mock.timers.reset();
	}
}

/** A fake shell that records every gate command and ends each with `gate`, which is given its ordinal. */
function gateShell(gate: (spec: DshShellSpec, index: number) => Promise<DshShellExecution>) {
	const gates: DshShellSpec[] = [];
	const shell = fakeShell({
		execute: async (spec) => {
			if (spec.command !== GATE) return shExecution(spec);
			gates.push(spec);
			return gate(spec, gates.length - 1);
		},
	});
	return { shell, gates };
}

const gateOf = (outcome: DshSolveOutcome) => (outcome.kind === "ran" ? outcome.result.gate : undefined);

const convergedOf = (outcome: DshSolveOutcome) => (outcome.kind === "ran" ? outcome.result.converged : undefined);

async function testServiceGateRuns(): Promise<void> {
	const policy: DshExecutionPolicy = { mode: "workspace-write", workspaceRoot: project, sessionId: "parent-session" };
	const through = gateShell(async (spec) => shExecution(spec));
	const passed = await dshHost({ shell: through.shell, sandboxPolicy: { resolve: () => policy } }).solve({
		cwd: "sub",
		gate: GATE,
	});
	check(
		"every gate goes through the shell, in the run path under the parent's policy",
		convergedOf(passed) === true &&
			gateOf(passed)?.passed === true &&
			through.gates.length > 0 &&
			through.gates.every(
				(spec) =>
					spec.workdir === join(project, "sub") && spec.sandboxPolicy === policy && spec.onExpiry === "none",
			),
		{ passed, gates: through.gates },
	);

	const unusable = rejection("no sandbox backend is usable", "SANDBOX_UNAVAILABLE");
	const broken = gateShell(async () => unrunnable(unusable));
	const unconverged = await dshHost({ shell: broken.shell }).solve({ gate: GATE });
	check(
		"a gate the runner cannot confine does not converge",
		convergedOf(unconverged) === false && notRun(gateOf(unconverged), "no sandbox backend is usable"),
		unconverged,
	);

	const thrown = gateShell(async (spec) => shExecution(spec));
	const offline = await dshHost({
		shell: thrown.shell,
		sandboxPolicy: changingPolicy("workspace-write", "workspace-write", new Error("policy store offline")),
	}).solve({ gate: GATE });
	check(
		"B3 a policy that fails at gate time runs nothing and does not converge",
		convergedOf(offline) === false && notRun(gateOf(offline), "policy store offline") && thrown.gates.length === 0,
		offline,
	);

	let mode = "workspace-write";
	const narrowing = gateShell(async () => {
		const first = mode === "workspace-write";
		mode = "read-only";
		return settled({ exitCode: first ? 1 : 0 });
	});
	await dshHost({
		shell: narrowing.shell,
		sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: project }) },
	}).solve({ gate: GATE });
	const modes = narrowing.gates.map((spec) => spec.sandboxPolicy?.mode);
	check(
		"a mode narrowed mid-run applies to the next gate",
		modes.length > 1 && modes[0] === "workspace-write" && modes.slice(1).every((next) => next === "read-only"),
		modes,
	);

	const slow = gateShell(async (spec) => shExecution({ ...spec, command: "sleep 30" }));
	const timedOut = await dshHost({ shell: slow.shell }).solve({ gate: GATE }, "gateTimeoutMs = 100\n[dsh]\n");
	check(
		"the configured gate timeout stops the gate",
		convergedOf(timedOut) === false && outOfTime(gateOf(timedOut) ?? undefined),
		timedOut,
	);

	const controller = new AbortController();
	const aborting = gateShell(async (spec) => {
		setTimeout(() => controller.abort(), 50);
		return shExecution({ ...spec, command: "sleep 30" });
	});
	const aborted = await dshHost({ shell: aborting.shell }).solve({ gate: GATE, signal: controller.signal });
	check(
		"an abort mid-gate ends the run as aborted",
		aborted.kind === "ran" &&
			aborted.result.stop === "aborted" &&
			notRun(gateOf(aborted), "aborted") &&
			lockFree(project),
		aborted,
	);
}

async function testServiceGateOrdering(): Promise<void> {
	const llm = fakeLlm((config) => (config.model === "missing" ? new Error("no such model") : undefined));
	const brokenPresets = { resolve: async () => ({ broken: "unknown preset" }) };
	const shellless = { shell: undefined, llm: llm.llm };
	const full = { ...shellless, sandboxPolicy: sandbox("danger-full-access") };
	for (const [label, services, request, expected] of [
		["a bad model ref", shellless, { workerModel: "bare" }, "rejected bad-model-ref"],
		["a bad run directory", shellless, { cwd: "absent" }, "rejected cwd-unavailable"],
		["containment", shellless, { cwd: beside }, "rejected cwd-outside-workspace"],
		["the git check", full, { cwd: root }, "rejected not-git"],
		["the plan file", shellless, { planFile: "absent.md" }, "rejected bad-plan-file"],
		["a refused model", shellless, { workerModel: "stub/missing" }, "rejected model-refused"],
		[
			"a broken preset",
			{ ...shellless, agentPresets: brokenPresets },
			{ gate: "true" },
			"rejected presets-unavailable",
		],
	] as const) {
		const host = dshHost(services);
		const earlier = await host.solve(request);
		const later = await dshHost({ shell: undefined }).solve();
		check(
			`${label} is refused before the gate is checked`,
			endOf(earlier) === expected && endOf(later) === "rejected gate-unavailable",
			{ earlier, later },
		);
	}
	const shell = fakeShell();
	await dshHost({ shell, llm: llm.llm }).solve({ workerModel: "stub/missing" });
	const unprobed = shell.specs.length;
	await dshHost({ shell, llm: llm.llm }).solve({ gate: GATE });
	check("a call refused earlier is never probed", unprobed === 0 && probes(shell).length === 1, shell.specs);
}

async function testServiceAbort(): Promise<void> {
	const refs = { managerModel: "stub/mgr", workerModel: "stub/wrk" };
	for (const step of ["ledger-manager", "ledger-worker", "mgr", "wrk"]) {
		for (const fails of [false, true]) {
			const controller = new AbortController();
			const at = async (name: string) => {
				if (name !== step) return;
				await sleep(0);
				controller.abort();
				if (fails) throw new Error("failed while aborting");
			};
			const host = dshHost({
				agentPresets: { resolve: async (id) => at(id).then(() => ({})) },
				llm: { resolveCallConfig: async (config) => at(config.model) },
			});
			await checkRefused(
				`an abort during the ${step} check that ${fails ? "fails" : "passes"} cancels`,
				"canceled",
				host,
				() => host.solve({ ...refs, signal: controller.signal }),
			);
		}
	}
	for (const step of ["workingDirectory", "sandboxPolicy"]) {
		const controller = new AbortController();
		const host = dshHost({
			workingDirectory: {
				get: () => {
					if (step === "workingDirectory") controller.abort();
					return project;
				},
			},
			sandboxPolicy: {
				resolve: () => {
					if (step === "sandboxPolicy") controller.abort();
					return { mode: "read-only", workspaceRoot: project };
				},
			},
		});
		await checkRefused(`an abort during ${step} cancels`, "canceled", host, () =>
			host.solve({ signal: controller.signal }),
		);
	}
}

async function testServiceBusy(): Promise<void> {
	const release = acquireLock(join(root, "state"), project);
	const host = dshHost();
	const outcome = await checkRefused("D16 a held lock is busy", "busy", host, () => host.solve({ cwd: "sub" }));
	release?.();
	check(
		"busy names the work tree root and holder",
		outcome.kind === "busy" && outcome.root === project && outcome.holder?.pid === process.pid,
		outcome,
	);
}

async function testServiceFailed(): Promise<void> {
	const early = dshHost({
		sandboxPolicy: { resolve: () => undefined as unknown as ReturnType<DshSandboxPolicy["resolve"]> },
	});
	await checkRefused("an unexpected throw before the lock is failed", "failed", early);
	const registry = dshHost({ agents: { get: () => assert.fail("registry down") } });
	const outcome = await checkRefused("a throwing registry is failed", "failed", registry);
	check("failed carries the message", messageOf(outcome) === "registry down", outcome);
	const nothing = dshHost();
	await checkRefused("a missing request is failed", "failed", nothing, () =>
		nothing.service.solve(undefined as unknown as DshSolveRequest),
	);

	const spawner = dshHost();
	Object.defineProperty(spawner.ctx, "subagents", { get: () => assert.fail("no subagents") });
	await checkRefused("a throwing spawner is failed", "failed", spawner);
	check("a throwing spawner releases the lock", lockFree(project));

	const gate = dshHost();
	await checkRefused("a gate that is not a string is failed", "failed", gate, () => gate.solve({ gate: 5 }));
	check("a gate that is not a string leaves the lock free", lockFree(project));

	const blocked = dshHost();
	const session = { ...blocked.parent.session, id: "blocked" };
	const parent: DshAgent = { ...blocked.parent, id: "blocked", session };
	blocked.live.set(parent.id, parent);
	writeFileSync(join(root, "state", "blocked"), "");
	await checkRefused("a ledger that cannot be created is failed", "failed", blocked, () => blocked.solve({ parent }));
	check("a ledger that cannot be created releases the lock", lockFree(project));
}

async function testServiceRan(): Promise<void> {
	let held: unknown;
	const host = dshHost({}, async () => {
		held ??= { nested: lockFree(nested), project: lockFree(project) };
		return { result: Promise.resolve(completed(REPLY)), dispose: async () => {} };
	});
	const rows = auditRows().length;
	let updates = 0;
	const outcome = await host.solve({
		cwd: ".worktrees/feature",
		gate: "pwd -P > gate-ran-in",
		onProgress: () => {
			updates++;
			throw new Error("display");
		},
	});
	check(
		"D17 a run in a nested work tree converges",
		outcome.kind === "ran" && outcome.result.converged && outcome.result.cwd === nested && outcome.handoff !== "",
		outcome,
	);
	check("a throwing progress callback is ignored", updates > 0, updates);
	check(
		"the lock is held on the nested work tree root",
		isDeepStrictEqual(held, { nested: false, project: true }),
		held,
	);
	check("the lock is released after the run", lockFree(nested));
	check("the gate ran in the run directory", readFileSync(join(nested, "gate-ran-in"), "utf8").trim() === nested);
	check(
		"every child runs in the run directory",
		host.specs.length > 0 && host.specs.every((spec) => spec.cwd === nested && spec.parent === host.parent),
		host.specs.map((spec) => spec.cwd),
	);
	const written = auditRows().slice(rows);
	const row = written[0] ?? {};
	check(
		"one audit row records the dsh run",
		written.length === 1 &&
			row.harness === "dsh" &&
			row.entry === "service" &&
			row.session === host.parent.id &&
			row.provider === "example" &&
			row.model === "big" &&
			row.cwd === nested &&
			row.stop === "done",
		written,
	);

	await dshHost().solve({ entry: "tool" });
	check("a tool call is audited as one", auditRows().at(-1)?.entry === "tool", auditRows().at(-1));

	const controller = new AbortController();
	const aborted = dshHost({}, async () => {
		controller.abort();
		return { result: never(), dispose: async () => {} };
	});
	const before = auditRows().length;
	const stopped = await aborted.solve({ signal: controller.signal });
	check(
		"an abort after the lock ends as ran with one aborted audit row",
		stopped.kind === "ran" &&
			stopped.result.stop === "aborted" &&
			auditRows().length === before + 1 &&
			auditRows().at(-1)?.stop === "aborted" &&
			lockFree(project),
		stopped,
	);
}

type ToolValue = { outcome: string; text: string };

/** The tool row applied to a fake preset context over `service`, with what it registered. */
function toolRow(service: LedgerpiService) {
	const registered: { definition: DshToolDefinition<ToolValue>; options?: DshToolOptions }[] = [];
	toolPlugin.apply({
		ledgerpi: service,
		tools: {
			register: <Value>(definition: DshToolDefinition<Value>, options?: DshToolOptions) => {
				registered.push({ definition: definition as unknown as DshToolDefinition<ToolValue>, options });
				return () => {};
			},
		},
	});
	const [{ definition, options }] = registered;
	const call = (args: unknown, exec: Partial<DshToolRunContext> = {}) =>
		definition.execute(args, { agent: parentAgent(), signal: new AbortController().signal, ...exec });
	const offered = (id = "parent"): boolean | undefined => options?.when?.({ agent: { id } });
	return { registered, definition, options, call, offered };
}

/** A service that is active and ends every call as `outcome`, keeping the requests it was given. */
function fakeService(
	outcome: DshSolveOutcome = { kind: "canceled", warnings: [] },
	overrides: Partial<LedgerpiService> = {},
) {
	const requests: DshSolveRequest[] = [];
	const service: LedgerpiService = {
		status: () => ({ apiVersion: 1, active: true }),
		solve: async (request) => {
			requests.push(request);
			return outcome;
		},
		isLedgerChild: (id) => id === "child",
		...overrides,
	};
	return { service, requests };
}

function testToolRegistration(): void {
	check(
		"the tool row injects the service and the tool registry",
		isDeepStrictEqual(toolPlugin.inject, ["ledgerpi", "tools"]) && toolPlugin.name !== "",
		toolPlugin.inject,
	);
	const { registered, definition } = toolRow(fakeService().service);
	check(
		"one ledger_solve tool is registered",
		registered.length === 1 && definition.name === "ledger_solve",
		registered,
	);
	check(
		"the tool has no deadline and runs alone",
		!("timeoutMs" in definition) && !("isConcurrencySafe" in definition),
	);
	check(
		"the description forbids choosing a model",
		definition.description.includes("only when the request names a model for that role; never choose one"),
		definition.description,
	);

	const { properties, ...parameters } = definition.parameters as { properties: Record<string, { type: string }> };
	check(
		"the parameters are closed and require only the task",
		isDeepStrictEqual(parameters, { type: "object", required: ["task"], additionalProperties: false }),
		parameters,
	);
	check(
		"every parameter is a described string",
		isDeepStrictEqual(Object.keys(properties), [
			"task",
			"cwd",
			"plan_file",
			"fanout",
			"manager_model",
			"worker_model",
		]) && Object.values(properties).every((property) => property.type === "string" && "description" in property),
		properties,
	);
	check("the schema has no gate", !("gate" in properties));

	check(
		"the output schema is the outcome and its text",
		isDeepStrictEqual(definition.output.schema, {
			type: "object",
			properties: {
				outcome: {
					type: "string",
					enum: ["bad-arguments", "inactive", "rejected", "canceled", "busy", "ran", "failed"],
				},
				text: { type: "string" },
			},
			required: ["outcome", "text"],
			additionalProperties: false,
		}),
		definition.output.schema,
	);
	const content = definition.output.render({}, { outcome: "ran", text: "Done." });
	check("the text is what is rendered", isDeepStrictEqual(content, [{ type: "text", text: "Done." }]), content);
}

function testToolGating(): void {
	const active = toolRow(fakeService().service);
	check("W an active service offers the tool", active.offered() === true);
	check("W a ledger child is not offered the tool", active.offered("child") === false);

	for (const [label, overrides] of [
		["an inactive service", { status: () => ({ apiVersion: 1, active: false, reason: "no-dsh-table" }) as const }],
		["a throwing status", { status: () => assert.fail("no status") }],
		["a throwing child lookup", { isLedgerChild: () => assert.fail("no children") }],
	] as const) {
		const row = toolRow(fakeService(undefined, overrides).service);
		let offered: unknown = "threw";
		try {
			offered = row.offered();
		} catch {}
		check(`W ${label} hides the tool`, offered === false, offered);
	}

	const host = dshHost();
	const row = toolRow(host.service);
	configFrom("[dsh]\n");
	const on = row.offered(host.parent.id);
	configFrom(PROVIDER);
	const off = row.offered(host.parent.id);
	check("W the condition follows the config at each step", on === true && off === false, { on, off });
}

async function testToolArguments(): Promise<void> {
	const { service, requests } = fakeService();
	const { call } = toolRow(service);
	const bad = async (label: string, args: unknown, mentions: string) => {
		const value = await call(args);
		check(
			label,
			value.outcome === "bad-arguments" &&
				value.text.includes(mentions) &&
				value.text.endsWith(" Implement the task directly.") &&
				requests.length === 0,
			{ value, requests: requests.length },
		);
	};

	for (const args of ['{"task": "Do', "", 5, true, null, undefined, [], [{ task: "x" }], new Map()]) {
		await bad(`T1 ${JSON.stringify(args) ?? "undefined"} arguments are refused`, args, "not an object");
	}
	for (const key of ["gate", "model", "planFile", "constructor"]) {
		await bad(`T2 an unknown ${key} argument is named`, { task: "Do it.", [key]: "x" }, `\`${key}\``);
	}
	await bad("T2 a __proto__ argument is named", JSON.parse('{"task":"x","__proto__":"y"}'), "`__proto__`");
	await bad("T2 comes before T3", { task: 5, gate: "true" }, "`gate`");
	for (const key of ["task", "cwd", "plan_file", "fanout", "manager_model", "worker_model"]) {
		for (const value of [5, null, ["x"]]) {
			await bad(`T3 ${key} = ${JSON.stringify(value)} is refused`, { task: "Do it.", [key]: value }, `\`${key}\``);
		}
	}

	const agent = parentAgent();
	const { signal } = new AbortController();
	await call(
		{
			task: "Do it.",
			cwd: "sub",
			plan_file: "plan.md",
			fanout: "on",
			manager_model: "p/mgr",
			worker_model: "p/wrk",
		},
		{ agent, signal },
	);
	check(
		"T4 solve gets the calling agent, its signal and the mapped arguments",
		isDeepStrictEqual(requests.at(-1), {
			parent: agent,
			task: "Do it.",
			cwd: "sub",
			planFile: "plan.md",
			fanout: "on",
			managerModel: "p/mgr",
			workerModel: "p/wrk",
			signal,
			entry: "tool",
		}) &&
			requests.at(-1)?.parent === agent &&
			requests.at(-1)?.signal === signal,
		requests,
	);
	await call(Object.assign(Object.create(null), { task: "Do it." }));
	const bare = requests.at(-1) ?? ({} as DshSolveRequest);
	check(
		"T4 absent arguments stay absent, with no gate or progress channel",
		requests.length === 2 &&
			bare.task === "Do it." &&
			bare.cwd === undefined &&
			bare.managerModel === undefined &&
			!("gate" in bare) &&
			!("onProgress" in bare),
		bare,
	);
	await call({});
	check("T4 a missing task is left for solve to reject", requests.at(-1)?.task === "", requests.at(-1));
}

async function testToolText(): Promise<void> {
	const textOf = async (outcome: DshSolveOutcome) => toolRow(fakeService(outcome).service).call({ task: "Do it." });
	const punted = " Implement the task directly.";
	const is = async (label: string, outcome: DshSolveOutcome, text: string) => {
		const value = await textOf(outcome);
		check(`C ${label}`, isDeepStrictEqual(value, { outcome: outcome.kind, text }), value);
	};

	for (const [reason, said] of [
		["env-disabled", "disabled by LEDGERPI=0"],
		["switched-off", "disabled by enabled = false in the ledgerpi config"],
		["no-dsh-table", "no usable [dsh] section in the ledgerpi config"],
		["no-preset-registry", "this profile has no agent preset registry"],
	] as const) {
		await is(
			`inactive ${reason} punts`,
			{ kind: "inactive", reason, warnings: [] },
			`ledgerpi is inactive: ${said}.${punted}`,
		);
	}

	const rejected = (message: string, field?: string): DshSolveOutcome => ({
		kind: "rejected",
		reason: "any",
		message,
		field,
		warnings: [],
	});
	await is("a rejection with no field punts with its message", rejected("No parent."), `No parent.${punted}`);
	await is("an unterminated message is closed", rejected("no such model"), `no such model.${punted}`);
	for (const [field, parameter] of [
		["task", "task"],
		["cwd", "cwd"],
		["planFile", "plan_file"],
		["managerModel", "manager_model"],
		["workerModel", "worker_model"],
	]) {
		await is(
			`a rejected ${field} is called ${parameter}`,
			rejected("It is wrong.", field),
			`\`${parameter}\`: It is wrong.${punted}`,
		);
		await is(
			`a message naming ${field} says ${parameter}`,
			rejected(`\`${field}\` is wrong.`, field),
			`\`${parameter}\` is wrong.${punted}`,
		);
	}

	await is(
		"failed punts with the cause",
		{ kind: "failed", message: "disk full", warnings: [] },
		`The ledger run failed: disk full.${punted}`,
	);
	await is("canceled is the aborted hand-off", { kind: "canceled", warnings: [] }, ABORTED_HANDOFF);

	const busy = (holder: { pid: number; token: string } | null): DshSolveOutcome => ({
		kind: "busy",
		root: "/work/tree",
		holder,
		warnings: [],
	});
	for (const [label, holder, pid] of [
		["a known holder", { pid: 4242, token: "t" }, " (pid 4242)"],
		["an unknown holder", null, ""],
	] as const) {
		await is(
			`busy with ${label} refuses without inviting edits`,
			busy(holder),
			`Another ledger loop${pid} is editing \`/work/tree\`. Wait for it to finish, and leave this tree alone until then.`,
		);
	}

	const handoff = "Summary.\nThe worker ran on other/m, not the configured example/big.";
	const result = { stop: "done", mismatches: [handoff.split("\n")[1]] } as DshRunResult;
	await is("a run is its hand-off, mismatch lines once", { kind: "ran", result, handoff, warnings: [] }, handoff);

	const warnings = ["first warning", "second warning"];
	for (const outcome of [
		{ kind: "inactive", reason: "switched-off", warnings: [] },
		{ kind: "canceled", warnings: [] },
		{ kind: "rejected", reason: "any", message: "No.", warnings: [] },
		busy(null),
		{ kind: "ran", result, handoff, warnings: [] },
		{ kind: "failed", message: "boom", warnings: [] },
	] satisfies DshSolveOutcome[]) {
		const plain = await textOf(outcome);
		const warned = await textOf({ ...outcome, warnings });
		check(
			`C ${outcome.kind} ends with one line per warning`,
			warned.text === [plain.text, ...warnings].join("\n"),
			warned,
		);
	}
}

async function testToolRuns(): Promise<void> {
	const config = `stateDir = "${join(root, "state")}"\ngate = "true"\n[dsh]\n`;
	const { signal } = new AbortController();

	const host = dshHost();
	const rows = auditRows().length;
	configFrom(config);
	const first = toolRow(host.service);
	const second = toolRow(host.service);
	for (const [label, row] of [
		["first", first],
		["second", second],
	] as const) {
		const before = auditRows().length;
		const value = await row.call({ task: "Do it." }, { agent: host.parent, signal });
		const written = auditRows().slice(before);
		check(
			`a call through the ${label} tool row runs on the shared service`,
			value.outcome === "ran" &&
				value.text !== "" &&
				written.length === 1 &&
				written[0].entry === "tool" &&
				written[0].harness === "dsh" &&
				written[0].session === host.parent.id,
			{ value, written },
		);
	}
	check("two tool rows wrote two audit rows", auditRows().length === rows + 2, auditRows().length - rows);

	const orphan = await first.call({ task: "Do it." }, { agent: undefined, signal });
	check("a call outside an agent is rejected", orphan.outcome === "rejected", orphan);

	const controller = new AbortController();
	const aborting = dshHost({}, async () => {
		controller.abort();
		return { result: never(), dispose: async () => {} };
	});
	configFrom(config);
	const stopped = await toolRow(aborting.service).call(
		{ task: "Do it." },
		{ agent: aborting.parent, signal: controller.signal },
	);
	check(
		"C a run aborted after the lock is the aborted hand-off",
		isDeepStrictEqual(stopped, { outcome: "ran", text: ABORTED_HANDOFF }) && auditRows().at(-1)?.stop === "aborted",
		stopped,
	);
}

/** Every module specifier a source file imports or re-exports. */
const specifiersIn = (source: string): string[] =>
	[...source.matchAll(/(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g)].map((m) => m[1]);

function testImports(): void {
	const packages = fileURLToPath(new URL("../packages", import.meta.url));
	const published = specifiersIn(readFileSync(join(packages, "dsh", "api.d.ts"), "utf8"));
	check("the published types import nothing", published.length === 0, published);
	const src = join(packages, "dsh", "src");
	const files = fs.readdirSync(src, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
	check("the dsh sources are found", files.length >= 4, files.length);
	for (const file of files) {
		const path = join(file.parentPath, file.name);
		const specifiers = specifiersIn(readFileSync(path, "utf8"));
		const foreign = specifiers.filter((specifier) => {
			if (specifier.startsWith("node:")) return false;
			if (!specifier.startsWith(".")) return true;
			const target = resolve(dirname(path), specifier);
			return !["dsh", "core"].some((name) => target.startsWith(join(packages, name) + sep));
		});
		check(
			`${file.name} imports only node, its own package and core`,
			specifiers.length > 0 && foreign.length === 0,
			foreign,
		);
	}
}

/** Whether two shapes are assignable both ways and name the same keys. */
type Agree<A, B> = [A, B, keyof A, keyof B] extends [B, A, keyof B, keyof A] ? true : false;

/** Fails to type-check when a published type drifts from the core type it copies. */
export const PUBLISHED_TYPES_AGREE: [
	Agree<DshRunResult, SolveRunResult>,
	Agree<DshGateVerdict, GateVerdict>,
	Agree<DshTask, Task>,
	Agree<DshFanoutSummary, FanoutSummary>,
	Agree<DshRoleTiming, RoleTiming>,
	Agree<DshLockHolder, LockHolder>,
	Agree<DshSolveRejection, SolveRejection>,
	Agree<NonNullable<DshSolveRequest["onProgress"]>, LoopDeps["onProgress"]>,
] = [true, true, true, true, true, true, true, true];

interface PatchRow {
	id: string;
	name: string;
	config?: any;
}

function testPatch(): void {
	check(
		"front matter is not part of a persona",
		personaBody('---\nname: "x"\n---\n\nYou plan.\n\n---\n\nKeep this.\n') === "You plan.\n\n---\n\nKeep this.",
	);

	const bodies = agentBodies();
	const patches = JSON.parse(renderPatch(bodies)) as { insert: PatchRow[] }[];
	const [rootRow, ...presets] = patches[0].insert;
	check(
		"the patch is one insert that adds the root plugin beside the patch file",
		patches.length === 1 && isDeepStrictEqual(rootRow, { id: "ledgerpi", name: "./service.js" }),
		patches,
	);
	check(
		"the patch declares exactly the presets children are started on",
		isDeepStrictEqual(
			presets.map((row) => [row.name, row.config.id]),
			Object.values(LEDGER_PRESETS).map((id) => ["@deepseek-ai/dsh-agent-preset", id]),
		) && new Set(patches[0].insert.map((row) => row.id)).size === 3,
		presets,
	);

	const [manager, worker] = presets.map((row) => row.config.plugins as PatchRow[]);
	const toolsOf = ([, ...rows]: PatchRow[]) =>
		rows.filter((row) => row.name !== "cordis:group").map((row) => [row.name, row.config]);
	const search = ["@deepseek-ai/dsh-tool-fs-search", { sampleOverCapGlobResults: false }];
	check(
		"the manager preset has no tool that writes",
		isDeepStrictEqual(toolsOf(manager), [
			["@deepseek-ai/dsh-tool-fs", { write: false, edit: false, applyPatch: false, readImage: false }],
			search,
		]),
		manager,
	);
	check(
		"the worker preset has the file, search and shell tools",
		isDeepStrictEqual(toolsOf(worker), [
			["@deepseek-ai/dsh-tool-fs", undefined],
			search,
			["@deepseek-ai/dsh-tool-bash", { enableRunInBackground: false, promoteOnTimeout: false }],
		]),
		worker,
	);
	const grouped = (rows: PatchRow[]) =>
		rows.flatMap((row) => (row.name === "cordis:group" ? (row.config as unknown as PatchRow[]) : [row]));
	for (const rows of [manager, worker]) {
		check(
			"each preset compacts its own context",
			grouped(rows).some((row) => row.name === "@deepseek-ai/dsh-compaction-basic"),
			rows,
		);
	}
	check(
		"neither preset reaches ledgerpi",
		grouped([...manager, ...worker]).every((row) => row.name.startsWith("@deepseek-ai/dsh-")) &&
			!JSON.stringify(presets).includes("ledger_solve"),
		presets,
	);
	check(
		"each persona is the whole system prompt",
		[manager, worker].every((rows) => rows[0].name === "@deepseek-ai/dsh-persona" && rows[0].config.complete),
		presets,
	);
	check(
		"the manager persona is its agent file's body",
		manager[0].config.prefix === bodies.manager && !bodies.manager.includes("display_name"),
		manager[0],
	);
	const workerPrefix: string = worker[0].config.prefix;
	const rules = workerPrefix.slice(bodies.worker.length);
	check(
		"the worker persona adds the in-place and foreground rules to its body",
		workerPrefix.startsWith(bodies.worker) && /in place/.test(rules) && /foreground/.test(rules),
		rules,
	);

	for (const role of ["manager", "worker"] as const) {
		let refusal = "";
		try {
			renderPatch({ ...bodies, [role]: "Use {{model}}." });
		} catch (err) {
			refusal = (err as Error).message;
		}
		check(
			`a ${role} persona with a variable reference fails the build`,
			refusal.includes(LEDGER_PRESETS[role]) && refusal.includes("{{"),
			refusal,
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
	await testSolveMarksSharedLock();
	await testSolveUnreadableHolder();
	await testSolveThrown();
	await testSolveWarnings();
	await testSolveMismatches();
	await testSpawnRefusedEarly();
	await testSpawnStart();
	await testSpawnStartFailures();
	await testSpawnStopped();
	await testSpawnSettled();
	await testSpawnTally();
	await testEffort();
	testRestrictions();
	makeSpace();
	await testRestrictionFailure();
	await testServiceRestrictions();
	await testServiceInactive();
	await testServiceParent();
	await testServiceArguments();
	await testServiceContainment();
	await testServiceDirectory();
	await testServiceTreeAndPlan();
	await testServiceModels();
	await testServiceGateShell();
	await testServiceGatePolicy();
	await testServiceGateProbe();
	await testServiceGateOrdering();
	await testGateRunnerRefusals();
	await testGateRunnerResults();
	await testGateRunnerTimeouts();
	await testServiceGateRuns();
	await testServiceAbort();
	await testServiceBusy();
	await testServiceFailed();
	await testServiceRan();
	testToolRegistration();
	testToolGating();
	await testToolArguments();
	await testToolText();
	await testToolRuns();
	testImports();
	testPatch();

	rmSync(root, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

await run();
