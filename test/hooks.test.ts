import { execFileSync, spawnSync } from "node:child_process";
import {
	closeSync,
	constants,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify as stringifyToml } from "smol-toml";
import factory from "../extensions/ledgerpi/index.ts";
import { spawn } from "../extensions/ledgerpi/rpc.ts";
import { auditPassthrough } from "../packages/core/src/audit.ts";
import {
	inScope,
	loadConfig,
	lowerFanout,
	redirectSkillAllowed,
	roleModelsFor,
	scopeReason,
	workerModelFor,
} from "../packages/core/src/config.ts";
import { detectGate, runGate } from "../packages/core/src/gate.ts";
import {
	addCandidateWorktree,
	applyPatch,
	candidatePatch,
	headInfo,
	pruneStaleCandidates,
	removeCandidateWorktree,
	revertPatch,
	snapshotTree,
	treeId,
} from "../packages/core/src/git.ts";
import { handoffBlock } from "../packages/core/src/handoff.ts";
import { Ledger } from "../packages/core/src/ledger.ts";
import type { LoopResult } from "../packages/core/src/loop.ts";
import { briefFor, manageSections, parseBrief, parseMode, sections } from "../packages/core/src/parse.ts";
import { finalizePrompt, managePrompt, planPrompt, workerPrompt } from "../packages/core/src/prompts.ts";
import { WORKER_SENTINEL } from "../packages/core/src/spawn.ts";
import { deadPid, TIMING_KEYS } from "./helpers.ts";

const root = join(tmpdir(), `ledgerpi-test-${process.pid}`);
const agentDirPath = join(root, "agentdir");
const repo = join(root, "repo");
const configFile = join(root, "config.toml");
process.env.PI_CODING_AGENT_DIR = agentDirPath;
process.env.LEDGERPI_CONFIG = configFile;
delete process.env.LEDGERPI;
delete process.env.LEDGERPI_STATE_DIR;
delete process.env.LEDGERPI_AUDIT_LOG;
delete process.env.LEDGERPI_AUDIT_SOURCE;
delete process.env.XDG_CONFIG_HOME;
mkdirSync(agentDirPath, { recursive: true });
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: repo });

type Handler = (event: any, ctx: any) => any;

let failures = 0;
const check = (label: string, cond: boolean, detail = "") => {
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `  <- ${detail}`}`);
	if (!cond) failures++;
};

/**
 * The `testing (gate Ns / Ls)` status lines in a recorded status stream, each with
 * its parsed elapsed and limit seconds. Non-gate statuses are dropped.
 */
const gateStatuses = (statuses: (string | undefined)[]) =>
	statuses.flatMap((text) => {
		const m = text?.match(/testing \(gate (\d+)s \/ (\d+)s\)/);
		return m ? [{ text: text as string, elapsed: Number(m[1]), limit: Number(m[2]) }] : [];
	});

// Writes the tracked TOML config. Defaults to an in-scope `cerebras` provider so
// the activation tests below stay green after the JSON->TOML fail-closed migration,
// and to `trigger = "auto"` so they exercise the loop without the ask dialog; the
// trigger tests override it.
const writeConfig = (extra: Record<string, unknown> = {}) => {
	writeFileSync(
		configFile,
		stringifyToml({ providers: ["cerebras"], stateDir: join(root, "state"), trigger: "auto", ...extra }),
	);
};
const removeConfig = () => rmSync(configFile, { force: true });
/** Runs `fn` synchronously with `console.error` captured, returning its value and the captured lines. */
const captureErrors = <T>(fn: () => T): { value: T; errors: string[] } => {
	const errors: string[] = [];
	const origError = console.error;
	console.error = (...a: unknown[]) => {
		errors.push(a.map(String).join(" "));
	};
	try {
		return { value: fn(), errors };
	} finally {
		console.error = origError;
	}
};
/** Loads the config, returning it and its load warnings; loading itself must print nothing. */
const loadCapturingErrors = () => {
	const { value, errors } = captureErrors(loadConfig);
	return { cfg: value, errors: [...value.warnings, ...errors.map((e) => `stderr: ${e}`)] };
};
/** Whether a load went inert through the "no usable" path rather than the malformed one. */
const inertAsUnusable = ({ cfg, errors }: ReturnType<typeof loadCapturingErrors>) =>
	cfg.enabled === false &&
	cfg.providers.length === 0 &&
	errors.some((e) => e.includes(`no usable ${configFile}`)) &&
	!errors.some((e) => e.includes("malformed"));

const gitOut = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// The audit log resolves to `runs.jsonl` under the config's stateDir (join(root, "state")).
const auditPath = join(root, "state", "runs.jsonl");
const readAudit = (): Record<string, any>[] =>
	existsSync(auditPath)
		? readFileSync(auditPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
/** The `role` rows (default `brief`) of every ledger transcript under a run's state dir, in write order. */
const rowsIn = (stateDir: string, role = "brief"): Record<string, any>[] =>
	(existsSync(stateDir) ? readdirSync(stateDir, { recursive: true }) : [])
		.map(String)
		.filter((p) => p.endsWith("transcript.jsonl"))
		.flatMap((p) => readFileSync(join(stateDir, p), "utf8").split("\n").filter(Boolean))
		.map((l) => JSON.parse(l))
		.filter((row) => row.role === role);

/**
 * The `stop` reason of the most recent `run` audit row -- the durable, observable
 * record of why a loop ended. A spawn that times out is a not-ok call, so it
 * surfaces here as `spawn-failure`, and an abort as `aborted`; the spawn's own
 * `timeout` error string only ever reaches the per-turn ledger files.
 */
const lastRunStop = (): string | undefined =>
	readAudit()
		.filter((x) => x.event === "run")
		.at(-1)?.stop;

/**
 * The `stopDetail` of the most recent `run` audit row -- the spawn-failure category
 * the loop threaded from the RPC branch that ended the run. Only `spawn-failure`
 * rows carry a category; every other stop is null, and a legacy row (written before
 * the field) has the key missing.
 */
const lastRunStopDetail = (): string | null | undefined =>
	readAudit()
		.filter((x) => x.event === "run")
		.at(-1)?.stopDetail;

/** A scripted step: the text a spawned agent returns, or a failure/refusal. */
interface Step {
	text?: string;
	fail?: boolean;
	/** The payload error string on a failed agent (default "boom"). */
	failError?: string;
	spawnRefused?: boolean;
	/** The refusal text in the spawn reply (default "refused"). */
	refuseError?: string;
	/** Reply with an id but never emit completion, so the caller can abort mid-run. */
	hang?: boolean;
	/** Hold the reply (and id) until flushReplies(), so the caller can abort/time out before the id arrives. */
	deferReply?: boolean;
}

/**
 * A synchronous in-process stub of the pi-subagents RPC bus. On a spawn it
 * replies with an id, then emits completion carrying the next scripted result.
 * `subagents:ready` fires immediately for any subscriber.
 *
 * A spawn that is not refused is `running` until it is stopped or settles, and
 * `subagents:rpc:consume` is refused for a still-running id, mirroring
 * pi-subagents' `consumeResult`. So a caller can only consume an agent it stopped
 * first. `stops` and `consumes` record what was accepted; `ops` preserves the
 * order across both channels.
 */
function makeBus(script: Step[], opts: { noPing?: boolean } = {}) {
	const handlers: Record<string, Set<(d: unknown) => void>> = {};
	let idx = 0;
	const spawned: string[] = [];
	const spawnedCwds: (string | undefined)[] = [];
	const spawnedPrompts: (string | undefined)[] = [];
	const spawnedModels: (string | null | undefined)[] = [];
	const spawnedOptions: Record<string, unknown>[] = [];
	const spawnedDescriptions: (string | undefined)[] = [];
	const stops: string[] = [];
	const consumes: string[] = [];
	const ops: Array<{ op: "stop" | "consume"; agentId: string }> = [];
	const running = new Set<string>();
	const pendingReplies: Array<() => void> = [];
	const emit = (channel: string, data: unknown) => {
		for (const fn of [...(handlers[channel] ?? [])]) fn(data);
		if (channel === "subagents:rpc:ping") {
			if (opts.noPing) return;
			const { requestId } = data as { requestId: string };
			emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
			return;
		}
		if (channel === "subagents:rpc:stop") {
			const { agentId } = data as { agentId: string };
			stops.push(agentId);
			ops.push({ op: "stop", agentId });
			running.delete(agentId);
			return;
		}
		if (channel === "subagents:rpc:consume") {
			const { agentId } = data as { agentId: string };
			// A refused consume leaves no trace at all, so an ordering assertion cannot
			// be satisfied by a consume the real bus would have rejected.
			if (running.has(agentId)) return;
			consumes.push(agentId);
			ops.push({ op: "consume", agentId });
			return;
		}
		if (channel === "subagents:rpc:spawn") {
			const { requestId } = data as { requestId: string };
			const step = script[Math.min(idx, script.length - 1)] ?? {};
			idx += 1;
			const id = `agent-${idx}`;
			spawned.push((data as any).type);
			spawnedCwds.push((data as any).options?.cwd);
			spawnedPrompts.push((data as any).prompt);
			spawnedModels.push((data as any).options?.model);
			spawnedOptions.push((data as any).options ?? {});
			spawnedDescriptions.push((data as any).options?.description);
			if (step.spawnRefused) {
				emit(`subagents:rpc:spawn:reply:${requestId}`, { success: false, error: step.refuseError ?? "refused" });
				return;
			}
			// Accepted spawns are running from here on, including one whose reply is
			// deferred: the caller can stop or consume it as soon as the reply names it.
			running.add(id);
			const doReply = () => emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id } });
			if (step.deferReply) {
				// Hold the id: the caller aborts/times out first, then flushReplies().
				pendingReplies.push(doReply);
				return;
			}
			doReply();
			if (step.hang) return; // reply with an id but leave the agent "running"
			// Settle before dispatch: subscribers consume inside this emit, and a
			// still-running id would have that consume refused.
			running.delete(id);
			emit(step.fail ? "subagents:failed" : "subagents:completed", {
				id,
				status: step.fail ? "failed" : "completed",
				result: step.text ?? "",
				error: step.fail ? (step.failError ?? "boom") : undefined,
				tokens: { total: 10 },
			});
		}
	};
	const on = (channel: string, fn: (d: unknown) => void) => {
		const set = handlers[channel] ?? new Set();
		handlers[channel] = set;
		set.add(fn);
		if (channel === "subagents:ready") fn({});
		return () => handlers[channel]?.delete(fn);
	};
	const flushReplies = () => {
		for (const f of pendingReplies.splice(0)) f();
	};
	return {
		emit,
		on,
		spawned,
		spawnedCwds,
		spawnedPrompts,
		spawnedModels,
		spawnedOptions,
		spawnedDescriptions,
		stops,
		consumes,
		ops,
		flushReplies,
	};
}

type StubBus = ReturnType<typeof makeBus>;

/** The stub bus's stop/consume history, rendered as ordered `op:agentId` entries. */
const opLog = (bus: StubBus): string => bus.ops.map((o) => `${o.op}:${o.agentId}`).join(",");

/** The spawn descriptions the stub bus saw for one agent type, in spawn order. */
const descriptionsFor = (bus: StubBus, type: string): (string | undefined)[] =>
	bus.spawned.flatMap((t, i) => (t === type ? [bus.spawnedDescriptions[i]] : []));

/**
 * Every description is exactly `want` (a string) or matches it (a RegExp), and
 * there is at least one. An `undefined` entry matches no anchored pattern.
 */
const allAre = (descs: (string | undefined)[], want: string | RegExp): boolean =>
	descs.length > 0 && descs.every((d) => (typeof want === "string" ? d === want : want.test(d ?? "")));

/** Every description for `type` is `ledger <role> (<model>, <phase>)` with a known phase. */
const allLabelled = (bus: StubBus, type: string, role: string, model: string): boolean =>
	allAre(
		descriptionsFor(bus, type),
		new RegExp(
			`^ledger ${role} \\(${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, (plan|ideate|manage|work|review|finalize)\\)$`,
		),
	);

/**
 * The bus accepted exactly one `stop` immediately followed by its `consume`, for
 * the same id and nothing else. A bare stop -- an unconsumed result that would
 * leak a raw notification to the parent session -- and a reversed pair both fail.
 */
const stoppedThenConsumed = (bus: StubBus, agentId: string): boolean =>
	opLog(bus) === `stop:${agentId},consume:${agentId}` && bus.consumes.join(",") === agentId;

/**
 * The bus accepted exactly one `consume` per accepted spawn, in spawn order, and
 * no `stop` at all: the shape of a run that waited on every agent it started and
 * suppressed each one's notification. A missing consume leaks a raw per-worker
 * notification to the parent session; a stop means the loop killed an agent it
 * was supposed to join, and a consume of the same id twice means it was consumed
 * on settlement and again on termination.
 */
const consumedOncePerSpawn = (bus: StubBus, acceptedSpawns: number): boolean =>
	bus.spawned.length === acceptedSpawns &&
	bus.stops.length === 0 &&
	opLog(bus) === Array.from({ length: acceptedSpawns }, (_, i) => `consume:agent-${i + 1}`).join(",");

/**
 * Re-instantiates the extension against a fresh stub bus and captures handlers,
 * tools, and commands. `ui.hasUI` and `ui.selectReply` drive the trigger=ask dialog
 * (an undefined reply is an Escape, `selectThrows` a failed dialog, `selectPending` a
 * dialog that stays open until `press` delivers an Escape, after the listeners ran,
 * as in pi where the focused dialog sees a key after the global listeners); `selects`
 * records each dialog shown, `statuses` each `ledgerpi` status line written,
 * `sent` each `sendUserMessage`, and `classifierCalls` each classifier call.
 * `press` delivers raw terminal input to every live `onTerminalInput` listener and
 * returns their results; `listeners` counts the live ones.
 */
const fresh = (
	script: Step[],
	classifyReply = "code",
	busOpts: { noPing?: boolean } = {},
	ui: { hasUI?: boolean; selectReply?: string; selectThrows?: boolean; selectPending?: boolean } = {},
) => {
	const bus = makeBus(script, busOpts);
	const handlers: Record<string, Handler> = {};
	const tools: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const selects: string[][] = [];
	const openDialogs: Array<(reply: string | undefined) => void> = [];
	const selectSignals: (AbortSignal | undefined)[] = [];
	const notices: string[] = [];
	const statuses: (string | undefined)[] = [];
	const sent: string[] = [];
	const registryModels: Record<string, Record<string, unknown>> = {};
	const terminalInput: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	let classifierCalls = 0;
	factory({
		on: (name: string, fn: Handler) => {
			handlers[name] = fn;
		},
		registerCommand: (name: string, c: any) => {
			commands[name] = c;
		},
		registerTool: (t: any) => {
			tools[t.name] = t;
		},
		sendUserMessage: (content: string) => {
			sent.push(content);
		},
		events: bus,
	} as any);
	const ctx = {
		model: { provider: "cerebras", id: "qwen-3.8-27b", contextWindow: 131072 },
		hasUI: ui.hasUI ?? false,
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				if (key === "ledgerpi") statuses.push(text);
			},
			notify: (msg: string) => {
				notices.push(msg);
			},
			select: async (_title: string, options: string[], opts?: { signal?: AbortSignal }) => {
				selects.push(options);
				selectSignals.push(opts?.signal);
				if (ui.selectThrows) throw new Error("dialog transport closed");
				if (ui.selectPending) {
					return new Promise<string | undefined>((resolve) => {
						openDialogs.push(resolve);
						opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
					});
				}
				return ui.selectReply;
			},
			onTerminalInput: (fn: (data: string) => { consume?: boolean; data?: string } | undefined) => {
				terminalInput.push(fn);
				return () => {
					const i = terminalInput.indexOf(fn);
					if (i >= 0) terminalInput.splice(i, 1);
				};
			},
		},
		cwd: repo,
		isIdle: () => true,
		waitForIdle: async () => {},
		signal: undefined as AbortSignal | undefined,
		sessionManager: { getSessionId: () => "sess-test" },
		modelRegistry: {
			find: (provider: string, id: string) => registryModels[`${provider}/${id}`],
			complete: async () => {
				classifierCalls += 1;
				return { content: [{ type: "text", text: classifyReply }], usage: { totalTokens: 3 } };
			},
		},
	};
	return {
		handlers,
		ctx,
		bus,
		registryModels,
		tools,
		commands,
		selects,
		selectSignals,
		notices,
		statuses,
		sent,
		classifierCalls: () => classifierCalls,
		press: (data: string) => {
			const results = [...terminalInput].map((fn) => fn(data));
			if (data === "\x1b") for (const resolve of openDialogs.splice(0)) resolve(undefined);
			return results;
		},
		listeners: () => terminalInput.length,
	};
};

const input = (text: string, over: Record<string, unknown> = {}) => ({
	type: "input",
	text,
	source: "interactive",
	...over,
});

const beforeAgentStart = (prompt: string, over: Record<string, unknown> = {}) => ({
	type: "before_agent_start",
	prompt,
	systemPrompt: "",
	systemPromptOptions: {},
	...over,
});

const editCall = (path = join(repo, "f.ts")) => ({
	type: "tool_call",
	toolName: "edit",
	toolCallId: "tc-edit",
	input: { path, edits: [{ oldText: "a", newText: "b" }] },
});

const writeCall = (path = join(repo, "f.ts")) => ({
	type: "tool_call",
	toolName: "write",
	toolCallId: "tc-write",
	input: { path, content: "b" },
});

const readCall = (path = join(repo, "f.ts")) => ({
	type: "tool_call",
	toolName: "read",
	toolCallId: "tc-read",
	input: { path },
});

// The section-format replies the host parses.
const PLAN = "### PLAN\nfix it\n### TASKS\n- [todo] do the fix";
const IDEATE = "### NOTES\ntry approach A\n### NEXT\n- approach A";
const manage = (status: string, next: string) =>
	`### STATUS\n${status}\n### NEXT\n- ${next}\n### TASKS\n- [todo] ${next}`;
const worker = (status: string) => `### NOTES\n- **Done:** made the change\n### NEXT\nnone\n### STATUS\n${status}`;

const manageMode = (status: string, next: string, mode: string) =>
	`### STATUS\n${status}\n### NEXT\n- ${next}\n### MODE\n${mode}\n### TASKS\n- [todo] ${next}`;

// The converging script: plan, ideate, manage continue, worker solved, manage done.
const CONVERGE: Step[] = [
	{ text: PLAN },
	{ text: IDEATE },
	{ text: manage("continue", "do the fix") },
	{ text: worker("solved") },
	{ text: manage("done", "") },
];

async function run() {
	// --- passthrough guards ---
	writeConfig({ gate: "true" });

	{
		const { handlers, ctx } = fresh([], "chat");
		const r = await handlers.input(input("what does this function do?"), ctx);
		check("chat classification passes through", r === undefined || r?.action !== "transform");
		const passRows = readAudit();
		const passRow = passRows.find((x) => x.event === "passthrough");
		check(
			"chat passthrough is audited",
			!!passRow &&
				passRow.classified === "chat" &&
				passRow.reason === "classified" &&
				passRow.entry === "input" &&
				passRow.provider === "cerebras",
			JSON.stringify(passRows),
		);
		check(
			"chat passthrough records the classifier call/tokens",
			!!passRow && passRow.calls === 1 && passRow.tokens === 3,
			JSON.stringify(passRow),
		);
	}

	// --- an empty/thinking-only classifier answer is audited as reason=invalid, not classified ---
	{
		writeConfig({ gate: "true" });
		const { handlers, ctx } = fresh([], "code");
		ctx.modelRegistry.complete = async () => ({
			content: [{ type: "text", text: "" }],
			usage: { totalTokens: 7 },
			stopReason: "length",
		});
		const r = await handlers.input(input("fix the bug"), ctx);
		check("empty classifier answer passes through", r === undefined || r?.action !== "transform");
		const row = readAudit()
			.filter((x) => x.event === "passthrough")
			.at(-1);
		check(
			"empty/invalid classifier answer is audited as reason=invalid with its tokens",
			!!row && row.classified === "chat" && row.reason === "invalid" && row.tokens === 7,
			JSON.stringify(row),
		);
	}

	// --- a classifier error/abort passes through but is audited with a distinct reason ---
	{
		writeConfig({ gate: "true" });
		const { handlers, ctx } = fresh([], "code");
		ctx.modelRegistry.complete = async () => {
			throw new Error("classifier outage");
		};
		const r = await handlers.input(input("fix the bug"), ctx);
		check("classifier error passes through", r === undefined || r?.action !== "transform");
		const errRow = readAudit()
			.filter((x) => x.event === "passthrough")
			.at(-1);
		check(
			"classifier error is audited as reason=error, not a genuine chat verdict",
			!!errRow && errRow.classified === "chat" && errRow.reason === "error",
			JSON.stringify(errRow),
		);
	}
	{
		writeConfig({ gate: "true" });
		const { handlers, ctx } = fresh([], "code");
		const ac = new AbortController();
		ac.abort();
		ctx.signal = ac.signal;
		ctx.modelRegistry.complete = async () => {
			throw new Error("aborted");
		};
		await handlers.input(input("fix the bug"), ctx);
		const abRow = readAudit()
			.filter((x) => x.event === "passthrough")
			.at(-1);
		check(
			"aborted classifier is audited as reason=aborted",
			!!abRow && abRow.reason === "aborted",
			JSON.stringify(abRow),
		);
	}
	// A resolved (non-throwing) error/aborted response carries the status on stopReason.
	{
		writeConfig({ gate: "true" });
		const { handlers, ctx } = fresh([], "code");
		ctx.modelRegistry.complete = async () => ({
			content: [],
			usage: { totalTokens: 5 },
			stopReason: "error",
			errorMessage: "provider 500",
		});
		const r = await handlers.input(input("fix the bug"), ctx);
		check("resolved error response passes through", r === undefined || r?.action !== "transform");
		const row = readAudit()
			.filter((x) => x.event === "passthrough")
			.at(-1);
		check(
			"resolved stopReason=error is audited as reason=error with preserved tokens",
			!!row && row.classified === "chat" && row.reason === "error" && row.tokens === 5,
			JSON.stringify(row),
		);
	}
	{
		writeConfig({ gate: "true" });
		const { handlers, ctx } = fresh([], "code");
		ctx.modelRegistry.complete = async () => ({ content: [], usage: { totalTokens: 0 }, stopReason: "aborted" });
		await handlers.input(input("fix the bug"), ctx);
		const row = readAudit()
			.filter((x) => x.event === "passthrough")
			.at(-1);
		check(
			"resolved stopReason=aborted is audited as reason=aborted",
			!!row && row.reason === "aborted",
			JSON.stringify(row),
		);
	}
	{
		const { handlers, ctx } = fresh([], "code");
		const r = await handlers.input(input("/help"), ctx);
		check("slash command passes through", r === undefined);
	}
	{
		const { handlers, ctx } = fresh([], "code");
		ctx.model.provider = "openai-codex";
		const r = await handlers.input(input("fix the bug"), ctx);
		check("out-of-scope provider passes through", r === undefined);
	}
	{
		const { handlers, ctx } = fresh([], "code");
		ctx.cwd = agentDirPath; // not a git repo
		const r = await handlers.input(input("fix the bug"), ctx);
		check("non-git cwd passes through", r === undefined);
	}
	{
		// git's stderr is inherited at the fd level, so only a child process can observe it.
		const gitModule = join(import.meta.dirname, "..", "packages", "core", "src", "git.ts");
		const probe = `import { diffStat, headInfo, isGitRepo, workingDiff } from ${JSON.stringify(gitModule)};
const cwd = ${JSON.stringify(agentDirPath)};
console.log(JSON.stringify([isGitRepo(cwd), workingDiff(cwd), diffStat(cwd), headInfo(cwd)]));`;
		const child = spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", probe], {
			encoding: "utf8",
		});
		check(
			"git helpers on a non-git cwd return empty results and write nothing to stderr",
			child.status === 0 &&
				child.stdout.trim() === JSON.stringify([false, "", "", { repoUrl: null, branch: null, sha: null }]) &&
				child.stderr === "",
			`status=${child.status} stdout=${child.stdout.trim()} stderr=${child.stderr.trim()}`,
		);
	}
	{
		process.env.LEDGERPI = "0";
		const { handlers, ctx } = fresh([], "code");
		const r = await handlers.input(input("fix the bug"), ctx);
		check("LEDGERPI=0 passes through", r === undefined);
		delete process.env.LEDGERPI;
	}
	{
		removeConfig(); // fail-closed: no config file -> inert, input passes through
		const { handlers, ctx } = fresh([], "code");
		const r = await handlers.input(input("fix the bug"), ctx);
		check("no config passes through (inert)", r === undefined);
	}
	{
		writeFileSync(configFile, "providers = = not valid [[["); // malformed TOML -> inert
		const { handlers, ctx } = fresh([], "code");
		const r = await handlers.input(input("fix the bug"), ctx);
		check("malformed config passes through (inert)", r === undefined);
	}
	{
		// in-scope provider, but its allowlist does not include the current model -> passes through
		writeConfig({ gate: "true", allowlist: { cerebras: ["some-other-model"] } });
		const { handlers, ctx } = fresh([], "code");
		const r = await handlers.input(input("fix the bug"), ctx);
		check("model not on the provider allowlist passes through", r === undefined);
	}

	// --- continuation-only guard: a bare "go on" prompt is a passthrough, never a task ---
	{
		// An incident: "please continue -- i had to close my laptop" was
		// promoted into a fresh ledger run in the canonical checkout. The guard keeps
		// the whole closed set in the parent session -- passthrough, no classifier
		// call, no spawn, no audit row, no ledger state -- for every source and with
		// the classifier on or off. The stub classifier is forced to answer "code",
		// so any classifier call is a guard miss, not a benign chat verdict.
		const sessionDir = join(root, "state", "sess-test");
		const sessionChildCount = () => (existsSync(sessionDir) ? readdirSync(sessionDir).length : 0);
		const base = [
			"please continue -- i had to close my laptop", // the exact incident prompt
			"continue",
			"resume",
			"go on",
			"keep going",
			"carry on",
			"pick up where we left off",
			"pick up where you left off",
			"Continue",
			"CONTINUE",
			"Please Continue -- I Had To Close My Laptop",
			"  continue  ",
			"continue\n",
			"  please   continue   --   i  had  to  close  my  laptop  ",
			"continue\n--\ni had to close my laptop",
			"please continue",
			"please resume",
			"please go on",
			"please pick up where we left off",
			"continue.",
			"resume!",
			"go on.",
			"keep going.",
			"carry on!",
			"pick up where you left off!",
			"please continue.",
			"continue where we left off",
			"resume where you left off",
			"continue from where we left off",
			"resume from where you left off",
			"continue the previous task",
			"resume the last task",
			"please continue the previous task.",
			"resume the last task!",
			"continue please",
			"resume the last task please!",
			"please continue please",
			"continue please.",
			"go on please",
			"continue please -- i had to close my laptop",
			"resume the last task please. -- i had to close my laptop",
		];
		const prompts = [...base];
		for (const head of ["continue", "resume"]) {
			for (const sep of ["--", "-", ",", ":", ";", "."]) {
				for (const clause of [
					"i had to close my laptop",
					"i closed my laptop",
					"my laptop went to sleep",
					"i got disconnected",
					"the connection dropped",
				]) {
					prompts.push(`${head} ${sep} ${clause}`);
				}
			}
		}
		const auditAtBlockStart = readAudit().length;
		for (const classifier of [true, false]) {
			writeConfig({ gate: "true", classifier });
			const { handlers, ctx, bus } = fresh([], "code");
			let classifierCalls = 0;
			ctx.modelRegistry.complete = async () => {
				classifierCalls += 1;
				return { content: [{ type: "text", text: "code" }], usage: { totalTokens: 3 } };
			};
			for (const source of ["interactive", "rpc"] as const) {
				const auditBefore = readAudit().length;
				const dirBefore = sessionChildCount();
				const failed: string[] = [];
				for (const text of prompts) {
					const ev = input(text, { source });
					const r = await handlers.input(ev, ctx);
					const ok =
						r === undefined &&
						ev.text === text &&
						classifierCalls === 0 &&
						bus.spawned.length === 0 &&
						bus.spawnedCwds.length === 0 &&
						bus.spawnedPrompts.length === 0 &&
						readAudit().length === auditBefore &&
						sessionChildCount() === dirBefore;
					if (!ok) failed.push(JSON.stringify(text));
				}
				check(
					`continuation-only prompts pass through untouched [${source}, classifier=${classifier}] (${prompts.length} prompts)`,
					failed.length === 0,
					failed.slice(0, 3).join(" "),
				);
			}
			check(
				`continuation-only prompts never reach the forced-code classifier [classifier=${classifier}]`,
				classifierCalls === 0,
				`calls=${classifierCalls}`,
			);
			check(
				`continuation-only prompts leave no spawn, audit row, or ledger state [classifier=${classifier}]`,
				bus.spawned.length === 0 &&
					bus.ops.length === 0 &&
					readAudit().length === auditAtBlockStart &&
					sessionChildCount() === 0,
				`spawned=${bus.spawned.length} audit=${readAudit().length} dir=${sessionChildCount()}`,
			);
		}
	}

	// --- continuation-only guard: a continuation-only turn arms no edit redirect ---
	{
		// autoTrigger off: the redirect machinery is inactive, and a passthrough
		// continuation-only turn still leaves nothing armed.
		writeConfig({ gate: "true" });
		const off = fresh([], "code");
		await off.handlers.before_agent_start(beforeAgentStart("please continue -- i had to close my laptop"), off.ctx);
		const offEdit = await off.handlers.tool_call(editCall(), off.ctx);
		const offWrite = await off.handlers.tool_call(writeCall(), off.ctx);
		check(
			"continuation-only turn is not redirected with autoTrigger off",
			offEdit === undefined && offWrite === undefined,
			JSON.stringify(offEdit),
		);

		// Named-skill redirect: a pending allowlisted command must not arm a
		// continuation-only turn -- without the guard the consumed command would arm.
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const named = fresh([], "code");
		await named.handlers.input(input("/review-task PROJ-7"), named.ctx);
		await named.handlers.before_agent_start(beforeAgentStart("continue where we left off"), named.ctx);
		const namedEdit = await named.handlers.tool_call(editCall(), named.ctx);
		const namedWrite = await named.handlers.tool_call(writeCall(), named.ctx);
		check(
			"continuation-only turn is not redirected under a named-skill redirect",
			namedEdit === undefined && namedWrite === undefined,
			JSON.stringify(namedEdit),
		);

		// Wildcard redirect: redirectSkills=["*"] arms without any slash command, so
		// the input passthrough alone would arm an edit redirect; the guard is what
		// keeps a bare "continue" from arming it.
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["*"] });
		const wild = fresh([], "code");
		await wild.handlers.before_agent_start(beforeAgentStart("please continue -- i had to close my laptop"), wild.ctx);
		const wildEdit = await wild.handlers.tool_call(editCall(), wild.ctx);
		const wildWrite = await wild.handlers.tool_call(writeCall(), wild.ctx);
		check(
			"continuation-only turn is not redirected under a wildcard redirect",
			wildEdit === undefined && wildWrite === undefined,
			JSON.stringify(wildEdit),
		);

		// Trailing-please form: the same wildcard redirect must not arm for it.
		await wild.handlers.before_agent_start(beforeAgentStart("continue please"), wild.ctx);
		const wildEdit2 = await wild.handlers.tool_call(editCall(), wild.ctx);
		const wildWrite2 = await wild.handlers.tool_call(writeCall(), wild.ctx);
		check(
			"a trailing-please continuation is not redirected under a wildcard redirect",
			wildEdit2 === undefined && wildWrite2 === undefined,
			JSON.stringify(wildEdit2),
		);
	}

	// --- continuation-only guard: the decisive same-session sequence ---
	{
		// A legitimate ledger_solve in a carved worktree completes; the parent is back
		// in its original cwd and gets a bare continuation. The incident: that
		// continuation launched a second run in the parent checkout. It must not: no
		// new spawn, no new audit row, no transform, cwd untouched, and no edit
		// redirect armed for the follow-on turn.
		writeConfig({ gate: "true", maxIters: 4, autoTrigger: "redirect", redirectSkills: ["*"] });
		const repo2 = join(root, "repo2");
		mkdirSync(repo2, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: repo2 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, tools, ctx, bus } = fresh(script, "code");
		const solve = await tools.ledger_solve.execute(
			"c-incident",
			{ task: "fix the failing test", cwd: repo2 },
			undefined,
			undefined,
			ctx,
		);
		const solveOut = solve?.content?.[0]?.text ?? "";
		check(
			"the legitimate ledger_solve run in the worktree converges",
			solveOut.includes("converged"),
			solveOut.slice(0, 120),
		);
		const spawnedAfterSolve = bus.spawned.length;
		const auditAfterSolve = readAudit().length;
		ctx.cwd = repo; // the parent session's own cwd
		const r = await handlers.input(input("please continue -- i had to close my laptop"), ctx);
		check(
			"the continuation-only turn after a run passes through (no transform)",
			r === undefined,
			JSON.stringify(r)?.slice(0, 80),
		);
		check(
			"the continuation-only turn spawns no further agents",
			bus.spawned.length === spawnedAfterSolve,
			`${spawnedAfterSolve} -> ${bus.spawned.length}`,
		);
		check(
			"the continuation-only turn adds no run/passthrough audit rows",
			readAudit().length === auditAfterSolve,
			`${auditAfterSolve} -> ${readAudit().length}`,
		);
		check("the parent cwd is untouched by the continuation-only turn", ctx.cwd === repo, ctx.cwd);
		await handlers.before_agent_start(beforeAgentStart("please continue -- i had to close my laptop"), ctx);
		const after = await handlers.tool_call(editCall(), ctx);
		check(
			"the continuation-only turn arms no edit redirect for the follow-on edit",
			after === undefined,
			JSON.stringify(after)?.slice(0, 80),
		);
	}

	// --- continuation-only guard is anchored to the whole message, not a prefix ---
	{
		// Standalone coding requests that merely BEGIN with "continue"/"resume"
		// must proceed exactly as before: classifier called, run launched, prompt
		// transformed.
		const negatives = [
			"continue to fix parser.ts so empty input returns []",
			"resume implementing pagination in api.ts with cursor validation",
			"continue -- fix parser.ts so empty input returns []",
		];
		for (const text of negatives) {
			writeConfig({ gate: "true", maxIters: 4 });
			const script: Step[] = [
				{ text: PLAN },
				{ text: IDEATE },
				{ text: manage("continue", "do the fix") },
				{ text: worker("solved") },
				{ text: manage("done", "") },
			];
			const { handlers, ctx, bus } = fresh(script, "code");
			let classifierCalls = 0;
			ctx.modelRegistry.complete = async () => {
				classifierCalls += 1;
				return { content: [{ type: "text", text: "code" }], usage: { totalTokens: 3 } };
			};
			const r = await handlers.input(input(text), ctx);
			const label = text.slice(0, 44);
			check(
				`standalone task beginning like a continuation (${label}...) transforms as before`,
				r?.action === "transform",
				JSON.stringify(r)?.slice(0, 80),
			);
			check(
				`standalone task (${label}...) reaches the classifier`,
				classifierCalls === 1,
				`calls=${classifierCalls}`,
			);
			check(`standalone task (${label}...) launches a run`, bus.spawned.length > 0, `spawned=${bus.spawned.length}`);
		}
	}

	// --- converging run ---
	{
		writeConfig({ gate: "true", maxIters: 4 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		const r = await handlers.input(input("fix the failing test"), ctx);
		check("converging run transforms the prompt", r?.action === "transform", JSON.stringify(r)?.slice(0, 80));
		const firstManage = bus.spawnedPrompts.find(
			(p, i) => bus.spawned[i] === "ledger-manager" && !!p?.includes("### VERIFY"),
		);
		check(
			"the first manage pass names the configured gate before it has run",
			!!firstManage?.includes("The host runs the full gate, `true`,") &&
				firstManage.includes("(no gate has been run yet)"),
			firstManage?.slice(0, 200),
		);
		const runRow = readAudit()
			.filter((x) => x.event === "run" && x.entry === "input")
			.at(-1);
		check(
			"converging input run is audited",
			!!runRow &&
				runRow.converged === true &&
				runRow.stop === "done" &&
				runRow.provider === "cerebras" &&
				runRow.model === "qwen-3.8-27b" &&
				runRow.classified === "code" &&
				runRow.gate?.passed === true &&
				typeof runRow.tokens === "number" &&
				typeof runRow.durationMs === "number",
			JSON.stringify(runRow),
		);
		const timingKeys = TIMING_KEYS;
		check(
			"converging input run row carries the six numeric timing fields",
			!!runRow && timingKeys.every((k) => typeof runRow[k] === "number"),
			JSON.stringify(runRow),
		);
		check(
			"timing busy time fits inside durationMs, and the role calls are the loop calls less the classifier call",
			!!runRow &&
				runRow.managerMs + runRow.workerMs + runRow.gateMs <= runRow.durationMs &&
				runRow.managerCalls + runRow.workerCalls === runRow.calls - 1 &&
				runRow.gateRuns >= 1,
			JSON.stringify(runRow),
		);
		check(
			"an input run in an unborn repo without an origin stamps the branch and null repoUrl/heads",
			runRow?.repoUrl === null &&
				runRow?.branch === gitOut(repo, ["symbolic-ref", "--short", "HEAD"]) &&
				runRow?.headStart === null &&
				runRow?.headEnd === null,
			JSON.stringify({ r: runRow?.repoUrl, b: runRow?.branch, s: runRow?.headStart, e: runRow?.headEnd }),
		);
		check(
			"the input run row carries the budget in force (configured maxIters, default callTimeoutMs)",
			runRow?.maxIters === 4 && runRow?.callTimeoutMs === 300_000,
			JSON.stringify({ maxIters: runRow?.maxIters, callTimeoutMs: runRow?.callTimeoutMs }),
		);
		check("transform carries the result block", r?.text?.includes("<ledgerpi-result>") === true);
		check("converged run says converged", r?.text?.includes("converged") === true);
		check("original prompt preserved", r?.text?.startsWith("fix the failing test") === true);
		check(
			"manager and worker types were spawned",
			bus.spawned.includes("ledger-manager") && bus.spawned.includes("ledger-worker"),
		);
		check(
			"a converging run consumes every agent it spawned, exactly once, and stops none",
			consumedOncePerSpawn(bus, 5),
			`spawned=${bus.spawned.length} ${opLog(bus)}`,
		);
	}

	// --- converging run: an allowlist naming the current model still activates ---
	{
		writeConfig({ gate: "true", maxIters: 4, allowlist: { cerebras: ["qwen-3.8-27b"] } });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		const r = await handlers.input(input("fix the failing test"), ctx);
		check(
			"an allowlist naming the current model activates the loop",
			r?.action === "transform",
			JSON.stringify(r)?.slice(0, 80),
		);
		check(
			"allowlisted-model run spawns manager and worker",
			bus.spawned.includes("ledger-manager") && bus.spawned.includes("ledger-worker"),
		);
	}

	// --- the manager's task brief reaches the worker and the transcript ---
	{
		const stateDir = join(root, "brief-state");
		writeConfig({ gate: "true", maxIters: 4, stateDir });
		const brief =
			"### STATUS\ncontinue\n" +
			"### NEXT\n- make parse return [] on empty input\n  - check the length first\n  - then return early\n" +
			"### FILES\n- src/parse.ts\n- test/parse.test.ts\n" +
			"### ACCEPT\n- parse('') returns []\n" +
			"### OUT_OF_SCOPE\n- src/render.ts\n" +
			"### VERIFY\nnode test/parse.test.ts\n" +
			"### TASKS\n- [todo] make parse return [] on empty input";
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: brief },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		await handlers.input(input("fix the failing test"), ctx);
		const work = bus.spawnedPrompts.filter((_, i) => bus.spawned[i] === "ledger-worker")[1] ?? "";
		check(
			"the worker prompt carries the brief's task, files, acceptance, and out-of-scope fields",
			work.includes("YOUR ONE TASK: make parse return [] on empty input\n\nFILES TO CHANGE:") &&
				!work.includes("check the length first") &&
				work.includes("FILES TO CHANGE:\n- src/parse.ts\n- test/parse.test.ts") &&
				work.includes("ACCEPTANCE CRITERIA:\n- parse('') returns []") &&
				work.includes("OUT OF SCOPE:\n- src/render.ts") &&
				work.includes("Keep your edits to the files listed"),
			work,
		);
		check(
			"the brief's VERIFY leads the check and the full gate stays visible",
			work.includes("verify by running: node test/parse.test.ts") &&
				!work.includes("verify by running: true") &&
				work.includes("Do not run the full gate yourself; the host runs it afterward: true"),
			work,
		);
		const briefRows = rowsIn(stateDir);
		check(
			"each worker round writes its brief to the transcript",
			briefRows.length === 1 &&
				briefRows[0].iter === 1 &&
				briefRows[0].taskSource === "next" &&
				briefRows[0].task === "make parse return [] on empty input" &&
				briefRows[0].files?.join(",") === "src/parse.ts,test/parse.test.ts" &&
				briefRows[0].accept?.join(",") === "parse('') returns []" &&
				briefRows[0].outOfScope?.join(",") === "src/render.ts" &&
				briefRows[0].verify === "node test/parse.test.ts",
			JSON.stringify(briefRows),
		);
	}

	// --- a red-gate override drops the "done" reply's brief, so the worker gets the gate ---
	{
		const stateDir = join(root, "override-state");
		writeConfig({ gate: "false", maxIters: 2, stateDir });
		const round1 =
			"### STATUS\ncontinue\n### NEXT\n- do the fix\n### FILES\n- src/a.ts\n### VERIFY\nnode test/a.test.ts\n" +
			"### TASKS\n- [todo] do the fix";
		const staleDone =
			"### STATUS\ndone\n### FILES\n- src/stale.ts\n### VERIFY\nnode stale.js\n### TASKS\n- [done] do the fix";
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: round1 },
			{ text: worker("solved") },
			{ text: staleDone },
			{ text: worker("solved") },
			{ text: manage("continue", "keep going") },
			{ text: worker("continue") },
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		await handlers.input(input("fix the failing test"), ctx);
		const work = bus.spawnedPrompts.filter((_, i) => bus.spawned[i] === "ledger-worker")[2] ?? "";
		check(
			"a red-gate override gives the next worker the gate, not the done reply's stale brief",
			work.includes("YOUR ONE TASK: The gate is still failing") &&
				work.includes("verify by running: false") &&
				!work.includes("node stale.js") &&
				!work.includes("src/stale.ts"),
			work,
		);
		const briefRows = rowsIn(stateDir);
		check(
			"each worker round writes its own numbered brief row",
			briefRows.map((r) => r.iter).join(",") === "1,2" &&
				briefRows.map((r) => r.taskSource).join(",") === "next,gate-override" &&
				briefRows[0].files?.join(",") === "src/a.ts" &&
				briefRows[1].files?.length === 0 &&
				briefRows[1].verify === "",
			JSON.stringify(briefRows),
		);
	}

	// --- a "done" first reply still has to pass the gate; a red gate sends the worker after it ---
	{
		const stateDir = join(root, "first-done-red-state");
		writeConfig({ gate: "false", maxIters: 2, stateDir, auditLog: auditPath });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("done", "") },
			{ text: worker("solved") },
			{ text: manage("continue", "keep going") },
			{ text: worker("solved") },
			{ text: manage("continue", "keep going") },
			{ text: worker("solved") },
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		await handlers.input(input("fix the failing test"), ctx);
		const work = bus.spawnedPrompts.filter((_, i) => bus.spawned[i] === "ledger-worker");
		check(
			"a first-pass done reply runs the gate and records its verdict",
			rowsIn(stateDir, "gate").length >= 1,
			JSON.stringify(rowsIn(stateDir, "gate")),
		);
		check(
			"a red gate after a first-pass done reply hands the worker the gate as its task",
			work.some((w) => w?.includes("YOUR ONE TASK: The gate is still failing")),
			work[0] ?? "",
		);
		const runRow = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check(
			"a first-pass done reply with a red gate is not converged at iters 0 with no gate",
			runRow?.converged === false && runRow.iters > 0 && runRow.gate?.ran === true && runRow.gate.passed === false,
			JSON.stringify(runRow),
		);
	}

	// --- a "done" first reply with a green gate converges at once, with the gate on record ---
	{
		const stateDir = join(root, "first-done-green-state");
		writeConfig({ gate: "true", maxIters: 2, stateDir, auditLog: auditPath });
		const script: Step[] = [{ text: PLAN }, { text: IDEATE }, { text: manage("done", "") }];
		const { handlers, ctx, bus } = fresh(script, "code");
		await handlers.input(input("fix the failing test"), ctx);
		const runRow = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check(
			"a first-pass done reply with a green gate converges at iters 0",
			runRow?.converged === true && runRow.stop === "done" && runRow.iters === 0 && runRow.gate?.passed === true,
			JSON.stringify(runRow),
		);
		const gateRows = rowsIn(stateDir, "gate");
		check(
			"the green gate verdict is recorded exactly once",
			gateRows.length === 1 && gateRows[0]?.passed === true,
			JSON.stringify(gateRows),
		);
		const work = bus.spawnedPrompts.filter((_, i) => bus.spawned[i] === "ledger-worker");
		check(
			"no worker task is spawned after a green first-pass gate",
			!work.some((w) => w?.includes("YOUR ONE TASK")),
			work[0] ?? "",
		);
	}

	// --- a "done" first reply with no gate configured converges without a gate row ---
	{
		const stateDir = join(root, "first-done-nogate-state");
		writeConfig({ maxIters: 2, stateDir, auditLog: auditPath });
		const script: Step[] = [{ text: PLAN }, { text: IDEATE }, { text: manage("done", "") }];
		const { handlers, ctx } = fresh(script, "code");
		await handlers.input(input("fix the failing test"), ctx);
		const runRow = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check(
			"a first-pass done reply with no gate converges with no gate verdict",
			runRow?.converged === true && runRow.gate == null,
			JSON.stringify(runRow),
		);
		check("no gate row is recorded when no gate is configured", rowsIn(stateDir, "gate").length === 0);
	}

	// --- a brief with no NEXT takes its task from the list and keeps its fields ---
	{
		const stateDir = join(root, "no-next-state");
		writeConfig({ gate: "true", maxIters: 4, stateDir });
		const noNext =
			"### STATUS\ncontinue\n" +
			"### FILES\n- src/parse.ts\n" +
			"### ACCEPT\n- parse('') returns []\n" +
			"### OUT OF SCOPE\n- test/parse.test.ts\n" +
			"### VERIFY\nnode test/parse.test.ts\n" +
			"### TASKS\n- [todo] guard empty input in parse";
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: noNext },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		await handlers.input(input("fix the failing test"), ctx);
		const work = bus.spawnedPrompts.filter((_, i) => bus.spawned[i] === "ledger-worker")[1] ?? "";
		check(
			"a manage reply without NEXT keeps its brief fields and takes the first todo as the task",
			work.includes("YOUR ONE TASK: guard empty input in parse") &&
				work.includes("- src/parse.ts") &&
				work.includes("- parse('') returns []") &&
				work.includes("OUT OF SCOPE:\n- test/parse.test.ts") &&
				work.includes("verify by running: node test/parse.test.ts"),
			work,
		);
		const briefRows = rowsIn(stateDir);
		check(
			"a brief whose task came from the list says so in the transcript",
			briefRows.length === 1 &&
				briefRows[0].taskSource === "task-list" &&
				JSON.stringify(briefRows[0].outOfScope) === '["test/parse.test.ts"]',
			JSON.stringify(briefRows),
		);
	}

	// --- a failed manage call hands the worker the first open task with no brief fields ---
	{
		const stateDir = join(root, "manage-fail-state");
		writeConfig({ gate: "true", maxIters: 4, stateDir });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ fail: true },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		await handlers.input(input("fix it"), ctx);
		const work = bus.spawnedPrompts.filter((_, i) => bus.spawned[i] === "ledger-worker")[1] ?? "";
		check(
			"a failed manage call still runs the worker on the first open task, unscoped",
			work.includes("YOUR ONE TASK: do the fix") &&
				!work.includes("FILES TO CHANGE") &&
				!work.includes("ACCEPTANCE CRITERIA") &&
				!work.includes("OUT OF SCOPE"),
			work,
		);
		const briefRows = rowsIn(stateDir);
		check(
			"a failed manage call records a manage-failed brief with no fields",
			briefRows.length === 1 &&
				briefRows[0].taskSource === "manage-failed" &&
				briefRows[0].task === "do the fix" &&
				briefRows[0].files.length === 0 &&
				briefRows[0].verify === "",
			JSON.stringify(briefRows),
		);
	}

	// --- a task-only manage reply still drives the worker, with no empty brief headers ---
	{
		writeConfig({ gate: "true", maxIters: 4 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		await handlers.input(input("fix the failing test"), ctx);
		const work = bus.spawnedPrompts.filter((_, i) => bus.spawned[i] === "ledger-worker")[1] ?? "";
		check(
			"a task-only brief keeps the gate hint and adds no empty brief headers",
			work.includes("YOUR ONE TASK: do the fix") &&
				work.includes("verify by running: true") &&
				!work.includes("FILES TO CHANGE") &&
				!work.includes("ACCEPTANCE CRITERIA") &&
				!work.includes("OUT OF SCOPE") &&
				!work.includes("Keep your edits to the files listed"),
			work,
		);
	}

	// --- no-progress guard ---
	{
		writeConfig({ gate: "false", maxIters: 6 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "same task") },
			{ text: worker("continue") },
			{ text: manage("continue", "same task") },
		];
		const { handlers, ctx } = fresh(script, "code");
		const r = await handlers.input(input("fix it"), ctx);
		check("no-progress run still transforms", r?.action === "transform");
		check(
			"no-progress run is unconverged",
			r?.text?.includes("without a passing gate") === true,
			r?.text?.slice(0, 120),
		);
	}

	// --- no-progress with a passing gate is described as such, not as gate-less ---
	{
		writeConfig({ gate: "true", maxIters: 6 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "same task") },
			{ text: worker("continue") },
			{ text: manage("continue", "same task") },
		];
		const { handlers, ctx } = fresh(script, "code");
		const r = await handlers.input(input("fix it"), ctx);
		check(
			"no-progress with a passing gate reports a passing gate in the handoff",
			r?.text?.includes("with a passing gate") === true &&
				r.text.includes("Gate: passed") &&
				!r.text.includes("without a passing gate"),
			r?.text?.slice(0, 300),
		);
	}

	// --- spawn-failure stop ---
	{
		writeConfig({ gate: "false", maxIters: 6 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "task A") },
			{ fail: true }, // worker fails
			{ fail: true }, // worker fails again -> stop
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		const r = await handlers.input(input("fix it"), ctx);
		check(
			"two spawn failures stop the loop unconverged",
			r?.text?.includes("without a passing gate") === true,
			r?.text?.slice(0, 120),
		);
		check(
			"a failing worker is consumed once and never stopped",
			consumedOncePerSpawn(bus, 5),
			`spawned=${bus.spawned.length} ${opLog(bus)}`,
		);
		check(
			"repeated worker failure is audited as stop:spawn-failure",
			lastRunStop() === "spawn-failure",
			String(lastRunStop()),
		);
		check(
			"the second (final) worker failure's category is audited as the stopDetail",
			lastRunStopDetail() === "agent-error",
			String(lastRunStopDetail()),
		);
		const gateRow = readAudit()
			.filter((x) => x.event === "run")
			.at(-1)?.gate;
		check(
			"repeated worker failure re-runs the gate and audits its verdict",
			gateRow?.ran === true && gateRow?.passed === false,
			JSON.stringify(gateRow),
		);
	}

	// --- spawn-failure after a passing round reports the fresh gate, not the stale one ---
	{
		const mark = join(root, "spawn-failure-gate-mark");
		rmSync(mark, { force: true });
		writeConfig({ gate: `if [ -f '${mark}' ]; then false; else touch '${mark}'; fi`, maxIters: 6 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "task A") },
			{ text: worker("continue") },
			{ text: manage("continue", "task B") },
			{ fail: true },
			{ fail: true },
		];
		const { handlers, ctx } = fresh(script, "code");
		const r = await handlers.input(input("fix it"), ctx);
		const gateRow = readAudit()
			.filter((x) => x.event === "run")
			.at(-1)?.gate;
		check(
			"spawn-failure after a passing round stops with agent-error",
			lastRunStop() === "spawn-failure" && lastRunStopDetail() === "agent-error",
			`${lastRunStop()} ${lastRunStopDetail()}`,
		);
		check(
			"spawn-failure audits the re-run gate verdict, not the earlier pass",
			gateRow?.ran === true && gateRow?.passed === false,
			JSON.stringify(gateRow),
		);
		check(
			"spawn-failure handoff reports the failed gate",
			r?.text?.includes("Gate: FAILED") === true && r.text.includes("without a passing gate"),
			r?.text?.slice(0, 300),
		);
	}

	// --- gate-fail keeps it unconverged even if the manager says done ---
	{
		writeConfig({ gate: "false", maxIters: 1 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") }, // manager claims done, but gate 'false' overrides
			{ text: worker("solved") }, // finalize
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		const r = await handlers.input(input("fix it"), ctx);
		check(
			"failing gate overrides a done verdict",
			r?.text?.includes("without a passing gate") === true,
			r?.text?.slice(0, 120),
		);
		const gateRow = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check(
			"a run-but-failed gate is audited as ran:true, passed:false (not null)",
			!!gateRow && gateRow.gate?.ran === true && gateRow.gate?.passed === false,
			JSON.stringify(gateRow?.gate),
		);
		const workerDescs = descriptionsFor(bus, "ledger-worker");
		check(
			"a gate-failed run labels the finalize worker with the finalize phase",
			(workerDescs.at(-1) ?? "").endsWith(", finalize)"),
			workerDescs.join(" | "),
		);
	}

	// --- a repo-local .ledgerpi-gate gates a repo with no manifest and no global gate ---
	{
		writeConfig({ maxIters: 1 });
		const gateFile = join(repo, ".ledgerpi-gate");
		writeFileSync(gateFile, "false\n");
		try {
			const script: Step[] = [
				{ text: PLAN },
				{ text: IDEATE },
				{ text: manage("continue", "do the fix") },
				{ text: worker("solved") },
				{ text: manage("done", "") },
				{ text: worker("solved") },
			];
			const { handlers, ctx } = fresh(script, "code");
			const r = await handlers.input(input("fix it"), ctx);
			check(
				"a failing .ledgerpi-gate overrides a done verdict",
				r?.text?.includes("without a passing gate") === true,
				r?.text?.slice(0, 120),
			);
			const gateRow = readAudit()
				.filter((x) => x.event === "run")
				.at(-1);
			check(
				"the .ledgerpi-gate command is audited as the gate that ran and failed",
				gateRow?.gate?.command === "false" && gateRow.gate.ran === true && gateRow.gate.passed === false,
				JSON.stringify(gateRow?.gate),
			);
		} finally {
			rmSync(gateFile, { force: true });
		}
	}

	// --- the status line advances the gate's elapsed time while the gate runs ---
	{
		writeConfig({ gate: "sleep 2", gateTimeoutMs: 30_000, maxIters: 1 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, ctx, statuses } = fresh(script, "code", {}, { hasUI: true });
		const r = await handlers.input(input("fix it"), ctx);
		const gates = gateStatuses(statuses);
		check(
			"a passing gate ticks the elapsed status at least twice, strictly increasing",
			gates.length >= 2 && gates.every((g, i) => i === 0 || g.elapsed > gates[i - 1].elapsed),
			JSON.stringify(gates),
		);
		check(
			"every gate status counts against the configured gateTimeoutMs",
			gates.length > 0 && gates.every((g) => g.limit === 30),
			JSON.stringify(gates),
		);
		const reviewingAt = statuses.findIndex((s) => s?.includes("reviewing"));
		check(
			"no gate label follows the gate's own resolution in the same round",
			reviewingAt >= 0 && !statuses.slice(reviewingAt).some((s) => s?.includes("testing (gate ")),
			JSON.stringify(statuses),
		);
		check(
			"the passing run clears the status line when it ends",
			statuses.at(-1) === undefined && r?.text?.includes("without a passing gate") !== true,
			JSON.stringify(statuses.at(-3)),
		);
	}

	// --- a throwing status write inside the gate tick does not take the loop down ---
	{
		writeConfig({ gate: "sleep 2", gateTimeoutMs: 30_000, maxIters: 1 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, ctx } = fresh(script, "code", {}, { hasUI: true });
		const startedAt = Date.now();
		let threw = 0;
		ctx.ui.setStatus = (key: string, text?: string) => {
			if (key === "ledgerpi" && /testing \(gate [1-9]/.test(text ?? "")) {
				threw += 1;
				throw new Error("stale session context");
			}
		};
		const r = await handlers.input(input("fix it"), ctx);
		check("the gate tick threw at least once", threw >= 1, String(threw));
		check(
			"a throwing gate tick leaves the run converged",
			r?.text?.includes("without a passing gate") !== true && r?.text !== undefined,
			r?.text?.slice(0, 120),
		);
		check(
			"the throwing tick does not cut the gate short",
			Date.now() - startedAt >= 2000,
			String(Date.now() - startedAt),
		);
	}

	// --- a timed-out gate restarts its elapsed counter at each of the two call sites ---
	{
		writeConfig({ gate: "sleep 5", gateTimeoutMs: 2000, maxIters: 1 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
			{ text: worker("solved") }, // finalize
		];
		const { handlers, ctx, statuses } = fresh(script, "code", {}, { hasUI: true });
		const startedAt = Date.now();
		const r = await handlers.input(input("fix it"), ctx);
		const gates = gateStatuses(statuses);
		check(
			"a timed-out gate still fails the run",
			r?.text?.includes("without a passing gate") === true,
			r?.text?.slice(0, 120),
		);
		check(
			"both gates ran to their timeout rather than resolving early",
			Date.now() - startedAt >= 3800,
			String(Date.now() - startedAt),
		);
		check(
			"a tick fires during a timed-out gate",
			gates.some((g) => g.elapsed >= 1),
			JSON.stringify(gates),
		);
		check(
			"the in-round and finalize gates each start their counter at zero",
			gates.filter((g) => g.elapsed === 0).length === 2,
			JSON.stringify(gates),
		);
		check(
			"the finalize path runs and reports its own status",
			statuses.some((s) => s?.includes("finalizing")),
			JSON.stringify(statuses.slice(-4)),
		);
		check(
			"the timed-out run clears the status line when it ends",
			statuses.at(-1) === undefined,
			JSON.stringify(statuses.at(-2)),
		);
		const settled = statuses.length;
		await new Promise((r) => setTimeout(r, 1200));
		check(
			"a leaked ticker would keep writing after a timed-out gate resolves, and none does",
			statuses.length === settled,
			`${settled} -> ${statuses.length}`,
		);
	}

	// --- .ledgerpi-gate precedence and fall-through ---
	{
		const dir = join(root, "gate-detect");
		const gateFile = join(dir, ".ledgerpi-gate");
		const reset = () => {
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir, { recursive: true });
		};
		writeConfig();
		const cfg = loadConfig();

		reset();
		check("no gate file and no manifest detects no gate", detectGate(cfg, dir) === undefined);

		writeFileSync(gateFile, "  make ci-gate\n");
		check("a gate file's trimmed content is the gate", detectGate(cfg, dir) === "make ci-gate", detectGate(cfg, dir));

		writeFileSync(join(dir, "Makefile"), "test:\n\ttrue\n");
		check(
			"a gate file wins over a Makefile test target",
			detectGate(cfg, dir) === "make ci-gate",
			detectGate(cfg, dir),
		);

		writeConfig({ gate: "true" });
		check(
			"the global gate wins over a gate file",
			detectGate(loadConfig(), dir) === "true",
			detectGate(loadConfig(), dir),
		);

		reset();
		writeFileSync(gateFile, " \n\t\n");
		check("a blank gate file is ignored", detectGate(cfg, dir) === undefined, detectGate(cfg, dir));

		writeFileSync(join(dir, "Makefile"), "test:\n\ttrue\n");
		check(
			"a blank gate file falls through to the probes",
			detectGate(cfg, dir) === "make test",
			detectGate(cfg, dir),
		);

		reset();
		mkdirSync(gateFile);
		check("a .ledgerpi-gate directory is ignored", detectGate(cfg, dir) === undefined, detectGate(cfg, dir));

		reset();
		writeFileSync(gateFile, "false\ntrue\n");
		const multiLine = detectGate(cfg, dir);
		const verdict = multiLine ? await runGate(multiLine, dir, 10_000) : undefined;
		check(
			"a failing earlier line of a multi-line gate file fails the gate",
			verdict?.ran === true && verdict.passed === false,
			JSON.stringify({ multiLine, verdict }),
		);

		reset();
		writeFileSync(gateFile, "true\r\ntrue\r\n");
		const crlf = detectGate(cfg, dir);
		const crlfVerdict = crlf ? await runGate(crlf, dir, 10_000) : undefined;
		check(
			"a CRLF multi-line gate file runs without carriage returns",
			crlf === "set -e\ntrue\ntrue" && crlfVerdict?.passed === true,
			JSON.stringify({ crlf, crlfVerdict }),
		);

		writeFileSync(gateFile, "make ci-gate\r\n");
		check(
			"a single-line CRLF gate file drops its line ending",
			detectGate(cfg, dir) === "make ci-gate",
			detectGate(cfg, dir),
		);

		writeFileSync(gateFile, "true\rtrue\r");
		check(
			"bare CR line endings split a gate file into lines",
			detectGate(cfg, dir) === "set -e\ntrue\ntrue",
			detectGate(cfg, dir),
		);

		reset();
		writeFileSync(gateFile, "# TODO\n  # later\n\n");
		check("a comment-only gate file is ignored", detectGate(cfg, dir) === undefined, detectGate(cfg, dir));
		writeFileSync(join(dir, "Makefile"), "test:\n\ttrue\n");
		check(
			"a comment-only gate file falls through to the probes",
			detectGate(cfg, dir) === "make test",
			detectGate(cfg, dir),
		);

		reset();
		writeFileSync(gateFile, "# lint\nmake ci-gate\n");
		check(
			"a gate file keeps its comments alongside real commands",
			detectGate(cfg, dir) === "set -e\n# lint\nmake ci-gate",
			detectGate(cfg, dir),
		);

		for (const name of [".ledgerpi-gate", "Makefile", "package.json"]) {
			reset();
			execFileSync("mkfifo", [join(dir, name)]);
			check(
				`a FIFO named ${name} is skipped without blocking`,
				detectGate(cfg, dir) === undefined,
				detectGate(cfg, dir),
			);
		}

		for (const [content, extra, expected] of [
			["make lint\nmake test\n", {}, "gate:\n  set -e\n  make lint\n  make test\nmaxIters: "],
			["make ci-gate\n", {}, "gate: make ci-gate\nmaxIters: "],
			["", { gate: "make test\n" }, "gate: make test\nmaxIters: "],
		] as const) {
			reset();
			writeFileSync(gateFile, content);
			writeConfig(extra);
			const { commands, ctx, notices } = fresh([], "code", {}, { hasUI: true });
			ctx.cwd = dir;
			await commands.ledgerpi.handler("", ctx);
			check(
				`/ledgerpi shows the gate ${JSON.stringify(content || extra)} on its own lines`,
				notices.some((n) => n.includes(expected)),
				notices.join("\n---\n"),
			);
		}
		rmSync(dir, { recursive: true, force: true });

		const fence = "```sh\nset -e\nmake lint\nmake test\n```";
		const work = workerPrompt({
			task: "t",
			plan: "",
			notes: "",
			diff: "",
			brief: briefFor("n"),
			gateHint: "set -e\nmake lint\nmake test",
		});
		check(
			"a multi-line gate reaches the worker as a fenced block, not glued to the prose",
			work.includes(fence) && !work.includes("make test (run only"),
			work,
		);
		const managerText = managePrompt({
			task: "t",
			plan: "",
			notes: "",
			diff: "",
			tasks: [],
			lastResult: "",
			gate: { ran: true, passed: false, command: "set -e\nmake lint\nmake test", output: "boom" },
		});
		check(
			"a multi-line failing gate reaches the manager as a fenced block",
			managerText.includes(fence),
			managerText,
		);
		check(
			"a single-line gate keeps its inline worker prompt",
			workerPrompt({
				task: "t",
				plan: "",
				notes: "",
				diff: "",
				brief: briefFor("n"),
				gateHint: "make test",
			}).includes("verify by running: make test (run only"),
		);
	}

	// --- fan-out: the manager's MODE recommendation, parseMode, and the config knobs ---
	{
		const baseArgs = { task: "t", plan: "", notes: "", diff: "", tasks: [], lastResult: "", gate: null };
		const original =
			"TASK:\nt\n\n" +
			"PLAN:\n(none)\n\n" +
			"NOTES:\n(none)\n\n" +
			"CURRENT DIFF (git diff in the working tree):\n(no changes yet)\n\n" +
			"CURRENT TASK LIST:\n(none)\n\n" +
			"LATEST WORKER RESULT: (none)\n\n" +
			"(no gate has been run yet)\n\n" +
			"You own the task list and decide when the problem is solved. The GATE verdict is ground truth: set STATUS 'done' only if the gate PASSED (or there is no gate and the change is complete and correct); if it FAILED you MUST set STATUS 'continue' and choose a task that fixes the failing case or switches approach. If the current approach keeps failing, switch to a DIFFERENT one from the notes rather than polishing a stuck one. Curate the list: merge duplicates, mark completed items [done], add only genuinely new sub-tasks, then name the single most valuable next task. Brief the worker on that one task only: inspect the repository with your read-only tools before naming files, list only paths that exist or that the task creates, and keep the acceptance criteria and the out-of-scope list to this task.\n\n" +
			"Respond with EXACTLY these sections:\n### STATUS\n<done|continue>\n### NEXT\n<required when STATUS is continue: the exact text of the ONE task to do next, on one line; leave NEXT, FILES, ACCEPT, OUT_OF_SCOPE, and VERIFY empty if done, and still curate TASKS>\n### FILES\n<the repository paths this task should change, one per line as '- path'>\n### ACCEPT\n<observable conditions that mean this task is done, one per line as '- ...'>\n### OUT_OF_SCOPE\n<files, areas, or changes the worker must leave alone, one per line as '- ...'>\n### VERIFY\n<one targeted command that checks this task, or 'none'>\n### TASKS\n<curated list, one per line, each '- [done] ...' or '- [todo] ...'>";
		check(
			"managePrompt with no fanout arg is the pre-fan-out prompt, byte for byte",
			managePrompt(baseArgs) === original,
		);
		check(
			"managePrompt with fanout off is the pre-fan-out prompt, byte for byte",
			managePrompt({ ...baseArgs, fanout: "off" }) === original,
		);
		for (const setting of ["advise", "on"] as const) {
			const text = managePrompt({ ...baseArgs, fanout: setting });
			check(
				`managePrompt with fanout ${setting} asks for a MODE section ahead of TASKS`,
				text.includes("### MODE\n") &&
					text.indexOf("### VERIFY") < text.indexOf("### MODE") &&
					text.indexOf("### MODE") < text.indexOf("### TASKS"),
				text,
			);
			check(
				`managePrompt with fanout ${setting} carries the serial, best-of-n, and fleet guidance`,
				text.includes("serial when the next task depends on the last result or the open tasks share files") &&
					text.includes(
						"best-of-n for a small self-contained task with an uncertain approach or a retry after a failed gate",
					) &&
					text.includes("fleet for 2 or more open tasks on disjoint files"),
			);
			check(
				`managePrompt with fanout ${setting} keeps the brief sections unchanged`,
				text.replace(/### MODE\n[^\n]*\n/, "") === original,
			);
		}

		const modeOf = (body: string) => parseMode(sections(`### STATUS\ncontinue\n### NEXT\n- t\n### MODE\n${body}`));
		const bestOf = modeOf("best-of-n: retry after red gate");
		check(
			"parseMode reads a best-of-n recommendation and its reason",
			bestOf.mode === "best-of-n" && bestOf.reason === "retry after red gate",
			JSON.stringify(bestOf),
		);
		check(
			"parseMode reads serial and fleet the same way",
			modeOf("serial: next step needs this result").mode === "serial" &&
				modeOf("serial: next step needs this result").reason === "next step needs this result" &&
				modeOf("fleet: three disjoint files").mode === "fleet" &&
				modeOf("fleet: three disjoint files").reason === "three disjoint files",
		);
		const loose = modeOf("  - FLEET :  two files  ");
		check(
			"parseMode ignores case and surrounding whitespace",
			loose.mode === "fleet" && loose.reason === "two files",
			JSON.stringify(loose),
		);
		check(
			"parseMode reads a bare mode word with an empty reason",
			JSON.stringify(modeOf("serial")) === JSON.stringify({ mode: "serial", reason: "" }),
		);
		check(
			"parseMode returns null mode for a missing section",
			parseMode(sections("### STATUS\ncontinue\n### NEXT\n- t")).mode === null,
		);
		check(
			"parseMode returns null mode for an unknown word or an empty section",
			modeOf("parallel: go wide").mode === null && modeOf("").mode === null && modeOf("fleetish: x").mode === null,
		);

		check(
			"lowerFanout gives the less permissive setting",
			lowerFanout("on", "off") === "off" &&
				lowerFanout("advise", "on") === "advise" &&
				lowerFanout("off", "on") === "off" &&
				lowerFanout("on", "on") === "on" &&
				lowerFanout("advise", "advise") === "advise",
		);

		writeFileSync(configFile, stringifyToml({ providers: ["cerebras"] }));
		const defaults = loadConfig();
		check("fanout defaults to off", defaults.fanout === "off");
		check("fanoutMax defaults to 2", defaults.fanoutMax === 2);
		for (const value of ["advise", "on"] as const) {
			writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], fanout: value }));
			check(`fanout honors ${value}`, loadConfig().fanout === value);
		}
		writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], fanout: "nope" }));
		check("fanout falls back to off on a bogus value", loadConfig().fanout === "off");
		writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], fanout: true }));
		check("fanout falls back to off on a non-string value", loadConfig().fanout === "off");
		for (const value of [2, 3, 8]) {
			writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], fanoutMax: value }));
			const cfg = loadConfig();
			check(
				`fanoutMax keeps ${value} without a warning`,
				cfg.fanoutMax === value && !cfg.warnings.some((w) => w.includes("fanoutMax")),
				cfg.warnings.join(" | "),
			);
		}
		for (const value of [1, 9, 2.5, "4"]) {
			writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], fanoutMax: value }));
			const cfg = loadConfig();
			check(
				`fanoutMax ${JSON.stringify(value)} warns and falls back to 2`,
				cfg.fanoutMax === 2 && cfg.warnings.filter((w) => w.includes("fanoutMax")).length === 1,
				cfg.warnings.join(" | "),
			);
		}
		writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], fanout: "on", fanoutMax: 4 }));
		const known = loadConfig();
		check(
			"fanout and fanoutMax are known config keys",
			known.fanout === "on" &&
				known.fanoutMax === 4 &&
				!known.warnings.some((w) => w.includes("unknown config key")),
			known.warnings.join(" | "),
		);
		writeFileSync(configFile, readFileSync(join(import.meta.dirname, "..", "ledgerpi.example.toml"), "utf8"));
		const example = loadConfig();
		check(
			"ledgerpi.example.toml loads with no unknown config key",
			example.enabled && !example.warnings.some((w) => w.includes("unknown config key")),
			example.warnings.join(" | "),
		);
	}

	// --- the task brief: parsing and the manager prompts that ask for it ---
	{
		const full = parseBrief(
			sections(
				"### NEXT\n- add the guard\n**FILES**\n- src/a.ts\n### ACCEPT\n- a() throws on null\n### OUT_OF_SCOPE\n- src/b.ts\n### VERIFY\nNone",
			),
		);
		check(
			"parseBrief reads every field, accepts a **FILES** header, and treats VERIFY 'none' as no command",
			full.task === "add the guard" &&
				full.files.join(",") === "src/a.ts" &&
				full.accept.join(",") === "a() throws on null" &&
				full.outOfScope.join(",") === "src/b.ts" &&
				full.verify === "",
			JSON.stringify(full),
		);
		const bare = parseBrief(sections("### STATUS\ncontinue\n### NEXT\n- just the task"));
		check(
			"parseBrief reads missing brief sections as empty",
			JSON.stringify(bare) === JSON.stringify(briefFor("just the task")),
			JSON.stringify(bare),
		);
		const verifyOf = (body: string) => parseBrief(sections(`### NEXT\n- t\n### VERIFY\n${body}`)).verify;
		check(
			"parseBrief reads a fenced or backticked VERIFY as its command",
			verifyOf("```bash\nnpm test -- a.test.ts\n```") === "npm test -- a.test.ts" &&
				verifyOf("`node t.js`") === "node t.js",
			JSON.stringify([verifyOf("```bash\nnpm test -- a.test.ts\n```"), verifyOf("`node t.js`")]),
		);
		check(
			"parseBrief reads the fenced command, not the prose line before it",
			verifyOf("Run the targeted test:\n```sh\nnpm test -- a.test.ts\n```") === "npm test -- a.test.ts" &&
				verifyOf("```npm test```") === "npm test",
			JSON.stringify([
				verifyOf("Run the targeted test:\n```sh\nnpm test -- a.test.ts\n```"),
				verifyOf("```npm test```"),
			]),
		);
		const noneLists = parseBrief(
			manageSections(
				"### NEXT\n- t\n### FILES\n- none\n### ACCEPT\n- N/A\n### OUT_OF_SCOPE\n- (none)\n- src/none.ts",
			),
		);
		check(
			"a 'none' list entry reads as no entry, but a path that contains none stays",
			noneLists.files.length === 0 &&
				noneLists.accept.length === 0 &&
				JSON.stringify(noneLists.outOfScope) === '["src/none.ts"]',
			JSON.stringify(noneLists),
		);
		const echoes = (n: number) => Array.from({ length: n }, (_, i) => `echo ${i}`).join("\n");
		const longVerify = verifyOf(`\`\`\`sh\n${echoes(30)}\n\`\`\``);
		const fullVerify = verifyOf(echoes(12));
		check(
			"a runaway multi-line VERIFY is capped like the brief lists and says it was cut",
			longVerify.split("\n").length === 13 &&
				longVerify.startsWith(`${echoes(12)}\n`) &&
				longVerify.endsWith("\n# (truncated: only the first 12 lines are shown)") &&
				fullVerify === echoes(12),
			JSON.stringify([longVerify, fullVerify]),
		);
		const introVerify = verifyOf("Run the targeted test:\n- npm test -- a.test.ts");
		const noneBullets = verifyOf("- none\n- n/a");
		check(
			"an unfenced VERIFY reads the bullet after an intro line, and none bullets read as no command",
			introVerify === "npm test -- a.test.ts" && noneBullets === "",
			JSON.stringify([introVerify, noneBullets]),
		);
		const afterIntro = [
			verifyOf("Run the targeted test:\nnode test/parse.test.ts"),
			verifyOf("Targeted check:\n- none"),
			verifyOf("- none\n- npm test -- a.test.ts"),
			verifyOf("Run the targeted test:"),
		];
		check(
			"an intro line or a none bullet is never read as the VERIFY command",
			JSON.stringify(afterIntro) === JSON.stringify(["node test/parse.test.ts", "", "", ""]),
			JSON.stringify(afterIntro),
		);
		const noneThenProse = [
			verifyOf("None.\nThe full gate is sufficient."),
			verifyOf("Targeted check:\nn/a\nthe gate covers this"),
			verifyOf("echo `date`"),
			verifyOf("None:\nthe gate covers it"),
			verifyOf("- N/A:\nthe gate covers it"),
		];
		check(
			"a VERIFY that opens with a none answer is no check even with an explanation after it",
			JSON.stringify(noneThenProse) === JSON.stringify(["", "", "echo `date`", "", ""]),
			JSON.stringify(noneThenProse),
		);
		const forwarded = [
			verifyOf("npm test -- a.test.ts\n- note: needs a build first\n- also run lint"),
			verifyOf("Run the targeted test:\nnpm test -- a.test.ts\n- note: needs a build first"),
			verifyOf("set -e\nmake test"),
			verifyOf("- set -e\n- `npm test -- a.test.ts`"),
		];
		check(
			"a multi-line VERIFY body reaches the worker as written, notes and all",
			JSON.stringify(forwarded) ===
				JSON.stringify([
					"npm test -- a.test.ts\n- note: needs a build first\n- also run lint",
					"npm test -- a.test.ts\n- note: needs a build first",
					"set -e\nmake test",
					"- set -e\n- `npm test -- a.test.ts`",
				]),
			JSON.stringify(forwarded),
		);
		const multiVerify = verifyOf("```sh\nset -e\nnpm test -- a.test.ts\n```");
		check(
			"a multi-line fenced VERIFY keeps every line, not just a leading set -e",
			multiVerify === "set -e\nnpm test -- a.test.ts",
			multiVerify,
		);
		const multiWork = workerPrompt({
			task: "t",
			plan: "",
			notes: "",
			diff: "",
			brief: { ...briefFor("n"), verify: "set -e\nnpm test -- a.test.ts" },
			gateHint: "make test",
		});
		check(
			"a multi-line VERIFY reaches the worker as a fenced block",
			multiWork.includes("verify by running: \n```sh\nset -e\nnpm test -- a.test.ts\n```\n"),
			multiWork,
		);
		const drifted = [
			"### OUT OF SCOPE",
			"**OUT OF SCOPE**",
			"OUT OF SCOPE:",
			"### Out of scope",
			"### OUT OF SCOPE:",
			"### Out-of-scope",
			"OUT-OF-SCOPE:",
		].map((header) => parseBrief(manageSections(`### NEXT\n- t\n### ACCEPT\n- a() throws\n${header}\n- src/b.ts`)));
		check(
			"a spaced OUT OF SCOPE header in a manage reply stays out of scope instead of joining ACCEPT",
			drifted.every((b) => b.accept.join(",") === "a() throws" && b.outOfScope.join(",") === "src/b.ts"),
			JSON.stringify(drifted),
		);
		check(
			"a mixed-case multi-word heading is still prose, not a section",
			JSON.stringify(Object.keys(sections("### PLAN\nstep one\n### Step two of it\nmore"))) === '["PLAN"]',
			JSON.stringify(sections("### PLAN\nstep one\n### Step two of it\nmore")),
		);
		const mixed = ["Out of scope:", "**Out of scope**"].map((header) =>
			parseBrief(manageSections(`### NEXT\n- t\n### ACCEPT\n- a() throws\n${header}\n- src/b.ts`)),
		);
		check(
			"a mixed-case bare or bold 'Out of scope' header in a manage reply stays out of ACCEPT",
			mixed.every((b) => b.accept.join(",") === "a() throws" && b.outOfScope.join(",") === "src/b.ts"),
			JSON.stringify(mixed),
		);
		const echoed = [
			"### NEXT\n- t\n### FILES\n- src/a.ts\n### Acceptance criteria\n- a() throws",
			"### NEXT\n- t\n### FILES\n- src/a.ts\n**ACCEPTANCE CRITERIA**\n- a() throws",
			"### NEXT\n- t\n### Files to change:\n- src/a.ts\n### ACCEPTANCE\n- a() throws",
			"### NEXT\n- t\nFILES TO CHANGE:\n- src/a.ts\nAcceptance:\n- a() throws",
		].map((reply) => parseBrief(manageSections(reply)));
		check(
			"a manage reply's FILES TO CHANGE / ACCEPTANCE CRITERIA headers read as FILES and ACCEPT",
			echoed.every((b) => b.task === "t" && b.files.join(",") === "src/a.ts" && b.accept.join(",") === "a() throws"),
			JSON.stringify(echoed),
		);
		const workerNotes = sections("### NOTES\n- a\n### Out of scope\n- b\n**OUT OF SCOPE**\n- c\n### NEXT\n- x");
		check(
			"a spaced OUT OF SCOPE heading outside a manage reply stays inside its section",
			JSON.stringify(Object.keys(workerNotes)) === '["NOTES","NEXT"]' &&
				workerNotes.NOTES.includes("- b") &&
				workerNotes.NOTES.includes("- c"),
			JSON.stringify(workerNotes),
		);
		const prose = sections("### NOTES\n**APPROACH A**\nbody\nNEXT STEPS:\nmore\n### KEY RISKS\nrisk\n### NEXT\n- x");
		check(
			"all-caps multi-word lines other than OUT OF SCOPE stay inside the section",
			JSON.stringify(Object.keys(prose)) === '["NOTES","NEXT"]' &&
				prose.NOTES.includes("**APPROACH A**") &&
				prose.NOTES.includes("more") &&
				prose.NOTES.includes("risk"),
			JSON.stringify(prose),
		);
		const verifyNoGate = workerPrompt({
			task: "t",
			plan: "",
			notes: "",
			diff: "",
			brief: { ...briefFor("n"), verify: "node t.js" },
		});
		check(
			"a VERIFY with no gate claims no host gate",
			verifyNoGate.includes("verify by running: node t.js") && !verifyNoGate.includes("full gate"),
			verifyNoGate,
		);
		const many = Array.from({ length: 20 }, (_, i) => `- f${i}.ts`).join("\n");
		const capped = parseBrief(
			sections(`### NEXT\n- t\n### FILES\n${many}\n### ACCEPT\n${many}\n### OUT_OF_SCOPE\n${many}`),
		);
		check(
			"parseBrief caps each brief list like the task list",
			capped.files.length === 12 && capped.accept.length === 12 && capped.outOfScope.length === 12,
			JSON.stringify([capped.files.length, capped.accept.length, capped.outOfScope.length]),
		);
		check(
			"parseBrief reads none-like VERIFY answers as no command",
			["None.", "none -- the gate covers it", "N/A", "(none)"].every((v) => verifyOf(v) === ""),
			JSON.stringify(["None.", "none -- the gate covers it", "N/A", "(none)"].map(verifyOf)),
		);
		check(
			"a VERIFY command that only starts with 'none' stays a command",
			verifyOf("none-check.sh") === "none-check.sh" && verifyOf("`nonexistent.test.sh`") === "nonexistent.test.sh",
			JSON.stringify([verifyOf("none-check.sh"), verifyOf("`nonexistent.test.sh`")]),
		);
		check(
			"parseBrief forwards a VERIFY command with its trailing prose",
			parseBrief(sections("### NEXT\n- t\n### VERIFY\n- npm test -- a.test.ts\nthen eyeball it")).verify ===
				"- npm test -- a.test.ts\nthen eyeball it",
		);
		const managerText = managePrompt({
			task: "t",
			plan: "",
			notes: "",
			diff: "",
			tasks: [],
			lastResult: "",
			gate: null,
		});
		check(
			"the manage prompt asks for a repo-grounded brief in its own sections",
			["### FILES", "### ACCEPT", "### OUT_OF_SCOPE", "### VERIFY", "inspect the repository"].every((s) =>
				managerText.includes(s),
			),
			managerText,
		);
		check(
			"the plan prompt asks the manager to inspect the repository and name each task's files",
			planPrompt("t").includes("Inspect the repository") &&
				planPrompt("t").includes("name the files each task touches"),
			planPrompt("t"),
		);
		const finalText = finalizePrompt({ task: "t", plan: "", notes: "", diff: "", gateHint: "make test" });
		check(
			"finalize stays an unscoped pass with no brief headers",
			finalText.includes("YOUR ONE TASK: Produce the definitive final solution now") &&
				!finalText.includes("FILES TO CHANGE") &&
				!finalText.includes("Keep your edits to the files listed"),
			finalText,
		);
		const finalGoal = (hint: string) =>
			`YOUR ONE TASK: Produce the definitive final solution now, using all notes and current work. Make the repository changes complete and correct.\n\nAfter editing, verify by running: ${hint} (run only the targeted test, not the whole suite -- the host runs the full gate).\n\nEdit the repository files directly`;
		const multiFinal = finalizePrompt({ task: "t", plan: "", notes: "", diff: "", gateHint: "set -e\nmake test" });
		check(
			"finalize renders the same goal text as before the brief, for a single-line and a multi-line gate",
			finalText.includes(finalGoal("make test")) &&
				multiFinal.includes(finalGoal("\n```sh\nset -e\nmake test\n```\n")),
			JSON.stringify([finalText, multiFinal]),
		);
		const sameAsGate = workerPrompt({
			task: "t",
			plan: "",
			notes: "",
			diff: "",
			brief: { ...briefFor("fix it"), verify: "make test" },
			gateHint: "make test",
		});
		check(
			"a VERIFY equal to the gate reads as the plain gate hint, not run-it-and-do-not-run-it",
			sameAsGate.includes(
				"verify by running: make test (run only the targeted test, not the whole suite -- the host runs the full gate).",
			) && !sameAsGate.includes("Do not run the full gate yourself"),
			sameAsGate,
		);
		const gateLike = [
			{ verify: "cd /tmp/repo && make test", gateHint: "make test" },
			{ verify: "make   test", gateHint: "make test" },
			{ verify: "set -e\nmake lint\nmake test", gateHint: "set -e\n  make lint\n\nmake test\n" },
		].map(({ verify, gateHint }) =>
			workerPrompt({ task: "t", plan: "", notes: "", diff: "", brief: { ...briefFor("fix it"), verify }, gateHint }),
		);
		check(
			"a VERIFY that only restates the gate (a cd prefix, spacing, blank lines) reads as the plain gate hint",
			gateLike.every(
				(p) => p.includes("(run only the targeted test") && !p.includes("Do not run the full gate yourself"),
			),
			JSON.stringify(gateLike),
		);
		const narrower = workerPrompt({
			task: "t",
			plan: "",
			notes: "",
			diff: "",
			brief: { ...briefFor("fix it"), verify: "cd /tmp/repo && make test TEST=parse" },
			gateHint: "make test",
		});
		check(
			"a VERIFY narrower than the gate still leads the worker's check",
			narrower.includes("verify by running: cd /tmp/repo && make test TEST=parse") &&
				narrower.includes("Do not run the full gate yourself"),
			narrower,
		);
		const gatedManage = managePrompt({
			task: "t",
			plan: "",
			notes: "",
			diff: "",
			tasks: [],
			lastResult: "",
			gate: null,
			gateHint: "make test",
		});
		check(
			"the manage prompt names the full gate before it has run, so VERIFY can be narrower than it",
			gatedManage.includes("`make test`") && gatedManage.includes("narrower than the full gate"),
			gatedManage,
		);
	}

	// --- the hand-off block keeps the gate summary on one line ---
	{
		const result = (command: string): LoopResult => ({
			converged: false,
			iters: 3,
			calls: 6,
			tokens: 100,
			gate: { ran: true, passed: false, command, output: "boom" },
			stop: "unconverged",
			notes: "",
			tasks: [],
			managerModel: null,
			workerModel: null,
			planSource: "manager",
			timing: { managerMs: 0, workerMs: 0, gateMs: 0, managerCalls: 0, workerCalls: 0, gateRuns: 0 },
		});
		const multi = handoffBlock(repo, result("set -e\nmake lint\nmake test"));
		check(
			"a multi-line gate leaves the hand-off summary on one line and fences the command",
			multi.includes("Gate: FAILED. Rounds: 3. Sub-agent calls: 6. Tokens: 100.") &&
				multi.includes("Gate command:\n```sh\nset -e\nmake lint\nmake test\n```"),
			multi,
		);
		check(
			"a single-line gate keeps its inline hand-off summary",
			handoffBlock(repo, result("false")).includes("Gate: FAILED (`false`). Rounds: 3."),
		);
		const plain = handoffBlock(repo, result("false"));
		check(
			"a null fan-out summary leaves the hand-off byte-identical to an absent one, with no Fan-out line",
			handoffBlock(repo, { ...result("false"), fanout: null }) === plain && !plain.includes("Fan-out:"),
		);
		const summary = {
			setting: "on" as const,
			max: 3,
			rounds: 2,
			downgrades: ["no-gate", "latched"],
			escapes: ["tree-changed"],
			asked: 0,
			advised: { serial: 1, "best-of-n": 2, fleet: 1, none: 0 },
		};
		const fanLines = handoffBlock(repo, { ...result("false"), fanout: summary })
			.split("\n")
			.filter((l) => l.startsWith("Fan-out:"));
		check(
			"a fan-out summary adds one Fan-out line with downgrades and escapes only when present",
			fanLines.length === 1 &&
				fanLines[0] ===
					"Fan-out: on (max 3). Best-of-N rounds: 2. Recommended: serial 1, best-of-n 2, fleet 1, none 0. Downgrades: no-gate, latched. Escapes: tree-changed.",
			fanLines.join("|"),
		);
	}

	// --- ledger_solve tool: registered and runs the loop on a converging run ---
	{
		writeConfig({ gate: "true", maxIters: 4, callTimeoutMs: 900_000 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { tools, ctx, bus } = fresh(script, "code");
		const tool = tools.ledger_solve;
		check("ledger_solve tool is registered", !!tool && typeof tool.execute === "function");
		const r = await tool.execute("call-1", { task: "fix the failing test" }, undefined, undefined, ctx);
		const out = r?.content?.[0]?.text ?? "";
		check(
			"ledger_solve spawns manager and worker",
			bus.spawned.includes("ledger-manager") && bus.spawned.includes("ledger-worker"),
			bus.spawned.join(","),
		);
		// describe's model === null branch is unreachable through the shipped entry points (a null model only when the provider or model id is missing, which scopeReason refuses earlier), so it is deliberately left uncovered.
		check(
			"ledger_solve labels every role with the session model",
			allLabelled(bus, "ledger-manager", "manager", "cerebras/qwen-3.8-27b") &&
				allLabelled(bus, "ledger-worker", "worker", "cerebras/qwen-3.8-27b"),
			bus.spawnedDescriptions.join(","),
		);
		check("ledger_solve returns the result block", out.includes("<ledgerpi-result>"), out.slice(0, 80));
		check("ledger_solve converged run says converged", out.includes("converged"), out.slice(0, 80));
		const toolRow = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check(
			"ledger_solve run is audited with entry=tool",
			!!toolRow && toolRow.converged === true && toolRow.provider === "cerebras" && toolRow.classified === null,
			JSON.stringify(toolRow),
		);
		check(
			"a converged ledger_solve run writes a null stopDetail",
			toolRow?.stopDetail === null,
			String(toolRow?.stopDetail),
		);
		check(
			"the ledger_solve run row carries the configured budget",
			toolRow?.maxIters === 4 && toolRow?.callTimeoutMs === 900_000,
			JSON.stringify({ maxIters: toolRow?.maxIters, callTimeoutMs: toolRow?.callTimeoutMs }),
		);
	}

	// --- run rows stamp the origin, branch, and HEAD before and after the loop ---
	{
		const headRepo = join(root, "repo-head");
		mkdirSync(headRepo, { recursive: true });
		execFileSync("git", ["init", "-q", "-b", "feat/x"], { cwd: headRepo });
		execFileSync("git", ["remote", "add", "origin", "https://user:secret@git.example.org/o/r.git"], {
			cwd: headRepo,
		});
		const commit =
			"git -c user.name=t -c user.email=t@t -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q --allow-empty -m";
		execFileSync("/bin/sh", ["-c", `${commit} base`], { cwd: headRepo });
		const converging = (): Step[] => [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const stamp = (r: Record<string, any> | undefined) =>
			JSON.stringify({ r: r?.repoUrl, b: r?.branch, s: r?.headStart, e: r?.headEnd });

		writeConfig({ gate: "true", maxIters: 4 });
		const before = gitOut(headRepo, ["rev-parse", "HEAD"]);
		{
			const { tools, ctx } = fresh(converging(), "code");
			await tools.ledger_solve.execute(
				"call-head",
				{ task: "fix the failing test", cwd: headRepo, gate: `${commit} gate` },
				undefined,
				undefined,
				ctx,
			);
		}
		const after = gitOut(headRepo, ["rev-parse", "HEAD"]);
		const toolRow = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check(
			"a ledger_solve run row stamps the redacted origin, branch, and HEAD before and after the loop",
			before !== after &&
				toolRow?.repoUrl === "https://git.example.org/o/r.git" &&
				toolRow?.branch === "feat/x" &&
				toolRow?.headStart === before &&
				toolRow?.headEnd === after,
			`${stamp(toolRow)} before=${before} after=${after}`,
		);

		writeConfig({ gate: `${commit} gate`, maxIters: 4 });
		{
			const { handlers, ctx } = fresh(converging(), "code");
			ctx.cwd = headRepo;
			await handlers.input(input("fix the failing test"), ctx);
		}
		const afterInput = gitOut(headRepo, ["rev-parse", "HEAD"]);
		const inputRow = readAudit()
			.filter((x) => x.event === "run" && x.entry === "input")
			.at(-1);
		check(
			"an input run row stamps the origin, branch, and HEAD of the session cwd before and after the loop",
			after !== afterInput &&
				inputRow?.cwd === headRepo &&
				inputRow?.repoUrl === "https://git.example.org/o/r.git" &&
				inputRow?.branch === "feat/x" &&
				inputRow?.headStart === after &&
				inputRow?.headEnd === afterInput,
			`${stamp(inputRow)} after=${after} afterInput=${afterInput}`,
		);

		const originAs = (url: string) => {
			execFileSync("git", ["remote", "set-url", "origin", url], { cwd: headRepo });
			return headInfo(headRepo).repoUrl;
		};
		check(
			"an ssh, scp-style, or local origin is stamped verbatim; a bare https token is stripped",
			originAs("ssh://git@git.example.org:2222/o/r.git") === "ssh://git@git.example.org:2222/o/r.git" &&
				originAs("git@git.example.org:o/r.git") === "git@git.example.org:o/r.git" &&
				originAs("/srv/git/r.git") === "/srv/git/r.git" &&
				originAs("http://tok3n@git.example.org/o/r.git") === "http://git.example.org/o/r.git" &&
				originAs("https://user:p@ss@git.example.org/o/r.git") === "https://git.example.org/o/r.git" &&
				originAs("https://git.example.org/o/r@v1.git") === "https://git.example.org/o/r@v1.git",
			String(headInfo(headRepo).repoUrl),
		);

		execFileSync("git", ["tag", "feat/x"], { cwd: headRepo });
		check(
			"a tag sharing the branch name does not change the stamped branch",
			headInfo(headRepo).branch === "feat/x",
			String(headInfo(headRepo).branch),
		);

		execFileSync("git", ["switch", "-q", "--detach"], { cwd: headRepo });
		{
			const { tools, ctx } = fresh(converging(), "code");
			await tools.ledger_solve.execute(
				"call-detached",
				{ task: "fix the failing test", cwd: headRepo, gate: "true" },
				undefined,
				undefined,
				ctx,
			);
		}
		const detachedRow = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check(
			"a run on a detached HEAD stamps a null branch and still records the SHA",
			detachedRow?.converged === true &&
				detachedRow?.branch === null &&
				detachedRow?.headStart === afterInput &&
				detachedRow?.headEnd === afterInput,
			stamp(detachedRow),
		);

		execFileSync("git", ["switch", "-q", "feat/x"], { cwd: headRepo });
		execFileSync("git", ["remote", "set-url", "origin", "https://git.example.org/o/r.git"], { cwd: headRepo });
		{
			const { tools, ctx } = fresh(converging(), "code");
			await tools.ledger_solve.execute(
				"call-moved",
				{ task: "fix the failing test", cwd: headRepo, gate: "git remote remove origin && git switch -q --detach" },
				undefined,
				undefined,
				ctx,
			);
		}
		const movedRow = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check(
			"a run that loses its origin and branch mid-loop keeps the start origin and branch",
			headInfo(headRepo).repoUrl === null &&
				headInfo(headRepo).branch === null &&
				movedRow?.repoUrl === "https://git.example.org/o/r.git" &&
				movedRow?.branch === "feat/x",
			stamp(movedRow),
		);

		execFileSync("git", ["switch", "-q", "feat/x"], { cwd: headRepo });
		execFileSync("git", ["remote", "add", "origin", "https://git.example.org/o/r.git"], { cwd: headRepo });
		{
			const { tools, ctx } = fresh(converging(), "code");
			await tools.ledger_solve.execute(
				"call-swapped",
				{
					task: "fix the failing test",
					cwd: headRepo,
					gate: "git remote set-url origin https://git.example.org/other/r.git && git switch -q -c feat/y",
				},
				undefined,
				undefined,
				ctx,
			);
		}
		const swappedRow = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check(
			"a run whose origin and branch change mid-loop stamps the end origin and the start branch",
			headInfo(headRepo).branch === "feat/y" &&
				swappedRow?.repoUrl === "https://git.example.org/other/r.git" &&
				swappedRow?.branch === "feat/x",
			stamp(swappedRow),
		);
	}

	// --- git helpers behind best-of-N: snapshot, candidate worktrees, patches ---
	{
		const snapRepo = join(root, "repo-snap");
		const snapLedger = join(root, "snap-ledger");
		mkdirSync(snapRepo, { recursive: true });
		const g = (cwd: string, ...args: string[]) => gitOut(cwd, args);
		const gitIdent = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
		g(snapRepo, "init", "-q");
		writeFileSync(join(snapRepo, "staged.txt"), "one\n");
		writeFileSync(join(snapRepo, "edited.txt"), "alpha\n");
		writeFileSync(join(snapRepo, "gone.txt"), "bye\n");
		writeFileSync(join(snapRepo, "icon.bin"), Buffer.from([0, 1, 2, 255, 254, 0, 7]));
		writeFileSync(join(snapRepo, ".gitignore"), "ignored.txt\n");
		g(snapRepo, "add", "-A");
		g(snapRepo, ...gitIdent, "commit", "-q", "-m", "base");
		writeFileSync(join(snapRepo, "staged.txt"), "one\ntwo\n");
		g(snapRepo, "add", "staged.txt");
		writeFileSync(join(snapRepo, "edited.txt"), "alpha\nbeta\n");
		writeFileSync(join(snapRepo, "untracked.txt"), "fresh\n");
		writeFileSync(join(snapRepo, "ignored.txt"), "skip\n");

		const cachedBefore = g(snapRepo, "diff", "--cached");
		const indexBefore = readFileSync(join(snapRepo, ".git", "index"));
		const base = snapshotTree(snapRepo);
		const shown = (rev: string, path: string) => g(snapRepo, "show", `${rev}:${path}`);
		check(
			"snapshotTree captures staged, unstaged, and untracked changes and skips ignored files",
			shown(base, "staged.txt") === "one\ntwo" &&
				shown(base, "edited.txt") === "alpha\nbeta" &&
				shown(base, "untracked.txt") === "fresh" &&
				!g(snapRepo, "ls-tree", "-r", "--name-only", base).split("\n").includes("ignored.txt"),
			g(snapRepo, "ls-tree", "-r", "--name-only", base),
		);
		check(
			"snapshotTree leaves the index and `git diff --cached` untouched",
			g(snapRepo, "diff", "--cached") === cachedBefore &&
				readFileSync(join(snapRepo, ".git", "index")).equals(indexBefore) &&
				g(snapRepo, "status", "--porcelain").includes("?? untracked.txt"),
		);
		check(
			"snapshotTree is a dangling commit on HEAD and treeId agrees with its tree",
			g(snapRepo, "rev-parse", `${base}^`) === g(snapRepo, "rev-parse", "HEAD") &&
				treeId(snapRepo) === treeId(snapRepo, base),
		);

		const candidate = addCandidateWorktree(snapRepo, snapLedger, 3, 1, base);
		const listing = g(snapRepo, "worktree", "list", "--porcelain");
		check(
			"addCandidateWorktree makes a detached, locked worktree at the snapshot under <ledgerDir>/candidates/<iter>-<i>",
			candidate === join(snapLedger, "candidates", "3-1") &&
				g(candidate, "rev-parse", "HEAD") === base &&
				listing.includes(`locked ledgerpi:${process.pid}`) &&
				listing.includes(candidate) &&
				/^detached$/m.test(listing) &&
				readFileSync(join(candidate, "untracked.txt"), "utf8") === "fresh\n",
			listing,
		);

		writeFileSync(join(candidate, "edited.txt"), "alpha\nbeta\ngamma\n");
		writeFileSync(join(candidate, "brand-new.txt"), "new file\n");
		writeFileSync(join(candidate, "icon.bin"), Buffer.from([9, 0, 255, 128, 3]));
		writeFileSync(join(candidate, "added.bin"), Buffer.from([0, 0, 1, 2, 3, 250]));
		rmSync(join(candidate, "gone.txt"));
		const patch = candidatePatch(candidate, base);
		const before = treeId(snapRepo);
		applyPatch(snapRepo, patch);
		check(
			"candidatePatch then applyPatch reproduces text, new, deleted, and binary changes on the real tree",
			treeId(snapRepo) === treeId(candidate) &&
				readFileSync(join(snapRepo, "edited.txt"), "utf8") === "alpha\nbeta\ngamma\n" &&
				readFileSync(join(snapRepo, "icon.bin")).equals(Buffer.from([9, 0, 255, 128, 3])) &&
				readFileSync(join(snapRepo, "added.bin")).equals(Buffer.from([0, 0, 1, 2, 3, 250])) &&
				!existsSync(join(snapRepo, "gone.txt")),
		);
		revertPatch(snapRepo, patch);
		check(
			"revertPatch restores the tree id from before the apply",
			treeId(snapRepo) === before &&
				existsSync(join(snapRepo, "gone.txt")) &&
				!existsSync(join(snapRepo, "added.bin")),
		);

		applyPatch(snapRepo, patch);
		const applied = treeId(snapRepo);
		let threw = false;
		try {
			applyPatch(snapRepo, patch);
		} catch {
			threw = true;
		}
		check("a patch that does not apply throws and leaves the tree unchanged", threw && treeId(snapRepo) === applied);
		let revertThrew = false;
		writeFileSync(join(snapRepo, "edited.txt"), "diverged\n");
		const diverged = treeId(snapRepo);
		try {
			revertPatch(snapRepo, patch);
		} catch {
			revertThrew = true;
		}
		check(
			"a revert that does not apply throws and leaves the tree unchanged",
			revertThrew && treeId(snapRepo) === diverged,
		);
		check(
			"an empty patch applies as a no-op",
			(() => {
				const t = treeId(snapRepo);
				applyPatch(snapRepo, candidatePatch(snapRepo, snapshotTree(snapRepo)));
				return treeId(snapRepo) === t;
			})(),
		);

		g(snapRepo, "config", "diff.noprefix", "true");
		g(snapRepo, "config", "diff.mnemonicPrefix", "true");
		g(snapRepo, "config", "apply.whitespace", "error");
		const configBase = snapshotTree(snapRepo);
		const configured = addCandidateWorktree(snapRepo, snapLedger, 5, 1, configBase);
		writeFileSync(join(configured, "brand-new.txt"), "trailing space \n");
		const configuredPatch = candidatePatch(configured, configBase);
		const configuredBefore = treeId(snapRepo);
		let configuredApplied = false;
		try {
			applyPatch(snapRepo, configuredPatch);
			configuredApplied = readFileSync(join(snapRepo, "brand-new.txt"), "utf8") === "trailing space \n";
			revertPatch(snapRepo, configuredPatch);
		} catch {}
		check(
			"candidatePatch and applyPatch ignore diff.noprefix, diff.mnemonicPrefix and apply.whitespace=error in the user's git config",
			configuredPatch.toString("utf8").includes("diff --git a/brand-new.txt b/brand-new.txt") &&
				configuredApplied &&
				treeId(snapRepo) === configuredBefore,
		);
		removeCandidateWorktree(snapRepo, configured);
		for (const key of ["diff.noprefix", "diff.mnemonicPrefix", "apply.whitespace"]) {
			g(snapRepo, "config", "--unset", key);
		}

		g(snapRepo, "config", "diff.up.textconv", "tr a-z A-Z <");
		const converted = addCandidateWorktree(snapRepo, snapLedger, 7, 1, configBase);
		writeFileSync(join(converted, ".gitattributes"), "*.dat diff=up\n");
		writeFileSync(join(converted, "payload.dat"), "lowercase payload\n");
		const convertedPatch = candidatePatch(converted, configBase);
		const convertedBefore = treeId(snapRepo);
		let convertedApplied = false;
		try {
			applyPatch(snapRepo, convertedPatch);
			convertedApplied = readFileSync(join(snapRepo, "payload.dat"), "utf8") === "lowercase payload\n";
			revertPatch(snapRepo, convertedPatch);
		} catch {}
		check(
			"candidatePatch ignores a diff textconv driver, so the patch carries the real file content",
			convertedPatch.toString("utf8").includes("lowercase payload") &&
				convertedApplied &&
				treeId(snapRepo) === convertedBefore,
		);
		removeCandidateWorktree(snapRepo, converted);
		g(snapRepo, "config", "--unset", "diff.up.textconv");

		const hooksDir = join(snapRepo, ".git", "hooks");
		const marker = join(root, "post-checkout-ran");
		mkdirSync(hooksDir, { recursive: true });
		writeFileSync(join(hooksDir, "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
		const hooked = addCandidateWorktree(snapRepo, snapLedger, 6, 1, base);
		check("addCandidateWorktree does not run the repository's post-checkout hook", !existsSync(marker));
		rmSync(join(hooksDir, "post-checkout"));

		const ghost = join(root, "ghost-wt");
		g(snapRepo, "worktree", "add", "-q", "--detach", ghost, base);
		rmSync(ghost, { recursive: true, force: true });
		removeCandidateWorktree(snapRepo, hooked);
		check(
			"removeCandidateWorktree leaves the metadata of an unrelated worktree whose directory is missing",
			g(snapRepo, "worktree", "list", "--porcelain").includes(ghost) && !existsSync(hooked),
		);
		g(snapRepo, "worktree", "prune");

		const live = addCandidateWorktree(snapRepo, snapLedger, 4, 1, base);
		const stale = addCandidateWorktree(snapRepo, snapLedger, 4, 2, base);
		const staleId = await deadPid();
		g(snapRepo, "worktree", "unlock", stale);
		g(snapRepo, "worktree", "lock", "--reason", `ledgerpi:${staleId}`, stale);
		const outside = join(root, "outside-wt");
		g(snapRepo, "worktree", "add", "-q", "--detach", "--lock", "--reason", `ledgerpi:${staleId}`, outside, base);
		const pruned = pruneStaleCandidates(snapRepo, snapLedger);
		const after = g(snapRepo, "worktree", "list", "--porcelain");
		check(
			"pruneStaleCandidates removes a candidate locked by a dead pid and keeps live and unrelated worktrees",
			pruned.length === 1 &&
				pruned[0] === stale &&
				!existsSync(stale) &&
				!after.includes(stale) &&
				after.includes(live) &&
				after.includes(candidate) &&
				after.includes(outside),
			`${JSON.stringify(pruned)}\n${after}`,
		);

		const oldRun = join(snapLedger, "sess-old", "turn-old");
		const nestedStale = join(oldRun, "candidates", "1-1");
		const nonCandidate = join(oldRun, "elsewhere");
		mkdirSync(join(oldRun, "candidates"), { recursive: true });
		for (const path of [nestedStale, nonCandidate]) {
			g(snapRepo, "worktree", "add", "-q", "--detach", "--lock", "--reason", `ledgerpi:${staleId}`, path, base);
		}
		const prunedNested = pruneStaleCandidates(snapRepo, snapLedger);
		const afterNested = g(snapRepo, "worktree", "list", "--porcelain");
		check(
			"pruneStaleCandidates scans every <session>/<turn>/candidates directory under the state dir, and only those",
			prunedNested.length === 1 &&
				prunedNested[0] === nestedStale &&
				!existsSync(nestedStale) &&
				!afterNested.includes(nestedStale) &&
				afterNested.includes(nonCandidate) &&
				afterNested.includes(live),
			`${JSON.stringify(prunedNested)}\n${afterNested}`,
		);
		removeCandidateWorktree(snapRepo, nonCandidate);

		for (const path of [candidate, live]) removeCandidateWorktree(snapRepo, path);
		removeCandidateWorktree(snapRepo, outside);
		const finalList = g(snapRepo, "worktree", "list", "--porcelain");
		check(
			"removeCandidateWorktree removes a locked worktree from disk and from the list",
			!existsSync(candidate) &&
				!existsSync(live) &&
				!finalList.includes("candidates") &&
				!finalList.includes(outside),
			finalList,
		);
		removeCandidateWorktree(snapRepo, candidate);
		check("removing a worktree that is already gone does not throw", true);
	}

	// --- ledger_solve tool: a pinned [roleModel] entry drives both roles ---
	{
		writeConfig({
			gate: "true",
			maxIters: 4,
			callTimeoutMs: 900_000,
			roleModel: { "cerebras/qwen-3.8-27b": { manager: "local/qwen3.8-m", worker: "local/qwen3.8-w" } },
		});
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { tools, ctx, bus } = fresh(script, "code");
		await tools.ledger_solve.execute("call-pinned", { task: "fix the failing test" }, undefined, undefined, ctx);
		const toolManagers = bus.spawned.flatMap((t, i) => (t === "ledger-manager" ? [bus.spawnedModels[i]] : []));
		const toolWorkers = bus.spawned.flatMap((t, i) => (t === "ledger-worker" ? [bus.spawnedModels[i]] : []));
		check(
			"ledger_solve spawns every manager on the pinned manager model",
			toolManagers.length > 0 && toolManagers.every((m) => m === "local/qwen3.8-m"),
			toolManagers.join(","),
		);
		check(
			"ledger_solve spawns every worker on the pinned worker model",
			toolWorkers.length > 0 && toolWorkers.every((m) => m === "local/qwen3.8-w"),
			toolWorkers.join(","),
		);
		check(
			"ledger_solve labels each role with its own pinned model",
			allLabelled(bus, "ledger-manager", "manager", "local/qwen3.8-m") &&
				allLabelled(bus, "ledger-worker", "worker", "local/qwen3.8-w"),
			bus.spawnedDescriptions.join(","),
		);
		const pinnedToolRow = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check(
			"the ledger_solve tool row records both pinned role models",
			pinnedToolRow?.managerModel === "local/qwen3.8-m" && pinnedToolRow?.workerModel === "local/qwen3.8-w",
			JSON.stringify({ managerModel: pinnedToolRow?.managerModel, workerModel: pinnedToolRow?.workerModel }),
		);
	}

	// --- ledger_solve tool: the reserved default serves a model no entry names ---
	{
		writeConfig({ gate: "true", maxIters: 4, roleModel: { default: { worker: "local/qwen3.8-w" } } });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { tools, ctx, bus } = fresh(script, "code");
		const r = await tools.ledger_solve.execute(
			"call-default",
			{ task: "fix the failing test" },
			undefined,
			undefined,
			ctx,
		);
		const out = r?.content?.[0]?.text ?? "";
		check(
			"ledger_solve does not punt for a model the default serves",
			!out.includes("the model is inactive"),
			out.slice(0, 90),
		);
		const toolWorkers = bus.spawned.flatMap((t, i) => (t === "ledger-worker" ? [bus.spawnedModels[i]] : []));
		check(
			"ledger_solve spawns the default-pinned worker",
			toolWorkers.length > 0 && toolWorkers.every((m) => m === "local/qwen3.8-w"),
			toolWorkers.join(","),
		);
		const defaultToolRow = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check(
			"the ledger_solve tool row records the default-pinned worker with a null manager",
			defaultToolRow?.managerModel === null && defaultToolRow?.workerModel === "local/qwen3.8-w",
			JSON.stringify({ managerModel: defaultToolRow?.managerModel, workerModel: defaultToolRow?.workerModel }),
		);
	}

	// --- ledger_solve tool entry: a spawn failure carries its provenance ---
	{
		// The tool entry runs the same loop with no classifier; its run row must name
		// entry=tool and carry the terminal failure's category the same way the input
		// hook's rows do.
		writeConfig({ gate: "true", maxIters: 4 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "task A") },
			{ fail: true }, // worker fails
			{ fail: true }, // worker fails again -> stop
		];
		const { tools, ctx } = fresh(script, "code");
		await tools.ledger_solve.execute("call-detail", { task: "fix it" }, undefined, undefined, ctx);
		const toolRow = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check(
			"a tool-entry spawn failure is audited with the terminal worker failure's category",
			toolRow?.stop === "spawn-failure" && toolRow.entry === "tool" && toolRow.stopDetail === "agent-error",
			JSON.stringify({ stop: toolRow?.stop, entry: toolRow?.entry, stopDetail: toolRow?.stopDetail }),
		);
	}

	// --- ledger_solve tool: a supplied plan_file skips planning and ideation ---
	{
		const stateDir = join(root, "plan-file-state");
		writeConfig({ gate: "true", maxIters: 4, stateDir, auditLog: auditPath });
		const planFile = join(root, "approved-plan.md");
		writeFileSync(planFile, "\n  ## Approved\nchange the parser\n\n");
		const script: Step[] = [
			{ text: manage("continue", "change the parser") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { tools, ctx, bus } = fresh(script, "code");
		await tools.ledger_solve.execute(
			"call-plan",
			{ task: "fix the failing test", plan_file: planFile },
			undefined,
			undefined,
			ctx,
		);
		const planned = (readdirSync(stateDir, { recursive: true }) as string[])
			.filter((p) => p.endsWith("plan.md"))
			.map((p) => readFileSync(join(stateDir, p), "utf8"));
		check(
			"a supplied plan_file makes the manager's manage pass the first spawn, with no plan or ideate spawn",
			bus.spawned[0] === "ledger-manager" &&
				descriptionsFor(bus, "ledger-manager")[0] === "ledger manager (cerebras/qwen-3.8-27b, manage)" &&
				descriptionsFor(bus, "ledger-worker").join(",") === "ledger worker (cerebras/qwen-3.8-27b, work)",
			bus.spawnedDescriptions.join(" | "),
		);
		const firstPrompt = bus.spawnedPrompts[0] ?? "";
		check(
			"the first manage prompt carries the plan text and an empty task list",
			firstPrompt.includes("## Approved\nchange the parser") &&
				firstPrompt.includes("CURRENT TASK LIST:\n(none)") &&
				firstPrompt.includes("The caller supplied the PLAN above"),
			firstPrompt,
		);
		check(
			"the ledger plan is the trimmed supplied text",
			planned.length === 1 && planned[0] === "## Approved\nchange the parser",
			JSON.stringify(planned),
		);
		const callerRow = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check(
			"a supplied-plan run converges and its audit row records planSource caller",
			callerRow?.converged === true && callerRow.planSource === "caller",
			JSON.stringify({ converged: callerRow?.converged, planSource: callerRow?.planSource }),
		);
	}

	// --- ledger_solve tool: a per-call fanout can lower the configured setting, never raise it ---
	{
		const stateDir = join(root, "fanout-override-state");
		const managePromptsFor = async (cfgFanout: string, param: Record<string, unknown>) => {
			writeConfig({ gate: "true", maxIters: 4, stateDir, auditLog: auditPath, fanout: cfgFanout });
			const script: Step[] = [
				{ text: manage("continue", "change the parser") },
				{ text: worker("solved") },
				{ text: manage("done", "") },
			];
			const { tools, ctx, bus } = fresh(script, "code");
			await tools.ledger_solve.execute("call-fanout", { task: "fix it", ...param }, undefined, undefined, ctx);
			return bus.spawnedPrompts.filter((_, i) => bus.spawned[i] === "ledger-manager");
		};
		const asked = (prompts: (string | undefined)[]) => prompts.some((p) => p?.includes("### MODE"));
		check("fanout=on with no override asks the manager for a MODE", asked(await managePromptsFor("on", {})));
		check(
			"a fanout:off override lowers configured on: the manage prompt has no MODE",
			!asked(await managePromptsFor("on", { fanout: "off" })),
		);
		check(
			"a fanout:advise override keeps asking for a MODE under configured on",
			asked(await managePromptsFor("on", { fanout: "advise" })),
		);
		check(
			"a fanout:on override cannot raise configured off: no MODE",
			!asked(await managePromptsFor("off", { fanout: "on" })),
		);
		check(
			"an invalid fanout value is ignored: configured on still asks for a MODE",
			asked(await managePromptsFor("on", { fanout: "turbo" })),
		);
	}

	// --- ledger_solve tool: fanout=ask with no UI never asks and records no-ui ---
	{
		const stateDir = join(root, "fanout-ask-tool-state");
		writeConfig({ gate: "true", maxIters: 4, stateDir, auditLog: auditPath, fanout: "ask" });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manageMode("continue", "change the parser", "best-of-n: uncertain approach") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { tools, ctx, bus, selects } = fresh(script, "code");
		await tools.ledger_solve.execute("call-ask-no-ui", { task: "fix it" }, undefined, undefined, ctx);
		const row = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check("fanout=ask without a UI shows no dialog", selects.length === 0, String(selects.length));
		check(
			"fanout=ask without a UI still asks the manager for a MODE",
			bus.spawnedPrompts.some((p, i) => bus.spawned[i] === "ledger-manager" && p?.includes("### MODE")),
		);
		check(
			"fanout=ask without a UI runs the recommended best-of-n round serially as no-ui",
			row?.converged === true &&
				row.fanout?.setting === "ask" &&
				row.fanout.rounds === 0 &&
				row.fanout.asked === 0 &&
				row.fanout.downgrades.join(",") === "no-ui",
			JSON.stringify(row?.fanout),
		);
		check(
			"the no-ui round is a serial brief row carrying the downgrade",
			rowsIn(stateDir).some((b) => b.mode === "serial" && b.advised === "best-of-n" && b.downgrade === "no-ui"),
			JSON.stringify(rowsIn(stateDir)),
		);
	}

	// --- ledger_solve tool: fanout=ask with a UI maps the dialog label to the answer ---
	{
		const stateDir = join(root, "fanout-ask-tool-ui-state");
		writeConfig({ gate: "true", maxIters: 4, stateDir, auditLog: auditPath, fanout: "ask" });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manageMode("continue", "first change", "best-of-n: uncertain approach") },
			{ text: worker("continue") },
			{ text: manageMode("continue", "second change", "best-of-n: still uncertain") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { tools, ctx, selects } = fresh(
			script,
			"code",
			{},
			{ hasUI: true, selectReply: "No for the rest of this run" },
		);
		await tools.ledger_solve.execute("call-ask-ui-no-run", { task: "fix it" }, undefined, undefined, ctx);
		const row = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check(
			"ledger_solve with a UI shows the fan-out dialog once for two recommended rounds",
			selects.length === 1,
			String(selects.length),
		);
		check(
			"'No for the rest of this run' is remembered: both rounds ran serially as declined after one question",
			row?.fanout?.setting === "ask" &&
				row.fanout.asked === 1 &&
				row.fanout.rounds === 0 &&
				row.fanout.downgrades.join(",") === "declined" &&
				rowsIn(stateDir).filter((b) => b.mode === "serial" && b.downgrade === "declined").length === 2,
			JSON.stringify([row?.fanout, rowsIn(stateDir)]),
		);
	}

	// --- ledger_solve tool: a yes label is not a decline ---
	for (const label of ["Yes (this round)", "Yes for the rest of this run"]) {
		const stateDir = join(root, "fanout-ask-tool-yes-state");
		writeConfig({ gate: "true", maxIters: 4, stateDir, auditLog: auditPath, fanout: "ask" });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manageMode("continue", "change the parser", "best-of-n: uncertain approach") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { tools, ctx, selects } = fresh(script, "code", {}, { hasUI: true, selectReply: label });
		await tools.ledger_solve.execute("call-ask-ui-yes", { task: "fix it" }, undefined, undefined, ctx);
		const row = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check(
			`'${label}' is a yes: one question asked and the round is not declined`,
			selects.length === 1 &&
				row?.fanout?.asked === 1 &&
				!row.fanout.downgrades.includes("declined") &&
				!row.fanout.downgrades.includes("ask-failed"),
			JSON.stringify(row?.fanout),
		);
	}

	// --- /ledgerpi status shows the fanout setting and cap ---
	{
		writeConfig({ fanout: "advise", fanoutMax: 3 });
		const { commands, ctx, notices } = fresh([], "code", {}, { hasUI: true });
		await commands.ledgerpi.handler("", ctx);
		check(
			"/ledgerpi prints the fanout setting and max",
			notices.some((n) => n.split("\n").includes("fanout: advise (max 3)")),
			notices.join("\n---\n"),
		);
	}

	// --- ledger_solve tool: a supplied plan longer than planMaxChars reaches the manager whole ---
	{
		writeConfig({ gate: "true", maxIters: 4, planMaxChars: 40 });
		const planFile = join(root, "long-plan.md");
		const longPlan = `## Approved\n${"step detail ".repeat(20)}\nTAIL-STEP: change the parser`;
		writeFileSync(planFile, longPlan);
		const script: Step[] = [
			{ text: manage("continue", "change the parser") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { tools, ctx, bus } = fresh(script, "code");
		await tools.ledger_solve.execute(
			"call-long-plan",
			{ task: "fix the failing test", plan_file: planFile },
			undefined,
			undefined,
			ctx,
		);
		const firstPrompt = bus.spawnedPrompts[0] ?? "";
		check(
			"a supplied plan longer than planMaxChars reaches the first manage prompt whole",
			longPlan.length > 40 && firstPrompt.includes(longPlan),
			firstPrompt,
		);
		check(
			"a supplied plan reaches the worker prompt whole",
			(bus.spawnedPrompts[1] ?? "").includes("TAIL-STEP: change the parser"),
			bus.spawnedPrompts[1] ?? "",
		);
	}

	// --- ledger_solve tool: a supplied plan_file whose first manage pass fails still finalizes ---
	{
		writeConfig({ gate: "true", maxIters: 4 });
		const planFile = join(root, "approved-plan.md");
		writeFileSync(planFile, "change the parser");
		const { tools, ctx, bus } = fresh([{ fail: true }, { text: worker("solved") }], "code");
		await tools.ledger_solve.execute(
			"call-plan-fail",
			{ task: "fix the failing test", plan_file: planFile },
			undefined,
			undefined,
			ctx,
		);
		check(
			"a failed first manage pass on a supplied plan goes straight to finalize",
			descriptionsFor(bus, "ledger-manager").length === 1 &&
				descriptionsFor(bus, "ledger-worker").join(",") === "ledger worker (cerebras/qwen-3.8-27b, finalize)",
			bus.spawnedDescriptions.join(" | "),
		);
	}

	// --- ledger_solve tool: a supplied plan whose first manage pass says done still has to pass the gate ---
	{
		writeConfig({ gate: "false", maxIters: 2, auditLog: auditPath });
		const planFile = join(root, "approved-plan.md");
		writeFileSync(planFile, "change the parser");
		const script: Step[] = [
			{ text: manage("done", "") },
			{ text: worker("solved") },
			{ text: manage("continue", "keep going") },
			{ text: worker("solved") },
			{ text: manage("continue", "keep going") },
			{ text: worker("solved") },
		];
		const { tools, ctx, bus } = fresh(script, "code");
		await tools.ledger_solve.execute(
			"call-plan-done-red",
			{ task: "fix the failing test", plan_file: planFile },
			undefined,
			undefined,
			ctx,
		);
		const work = bus.spawnedPrompts.filter((_, i) => bus.spawned[i] === "ledger-worker");
		check(
			"a red gate after a supplied plan's first-pass done hands the worker the gate as its task",
			work[0]?.includes("YOUR ONE TASK: The gate is still failing") === true,
			work[0] ?? "",
		);
		const runRow = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check(
			"a supplied plan's first-pass done with a red gate is not converged at iters 0",
			runRow?.converged === false &&
				runRow.iters > 0 &&
				runRow.gate?.passed === false &&
				runRow.planSource === "caller",
			JSON.stringify(runRow),
		);
	}

	// --- ledger_solve tool: an unreadable plan_file punts without spawning ---
	{
		writeConfig({ gate: "true", maxIters: 4 });
		const missing = join(root, "no-such-plan.md");
		const empty = join(root, "empty-plan.md");
		writeFileSync(empty, " \n\t\n");
		for (const [label, path, why] of [
			["missing", missing, "cannot be read"],
			["empty", empty, "is empty"],
			["directory", root, "not a regular file"],
		] as const) {
			const { tools, ctx, bus } = fresh(CONVERGE, "code");
			const r = await tools.ledger_solve.execute(
				`call-plan-${label}`,
				{ task: "fix the failing test", plan_file: path },
				undefined,
				undefined,
				ctx,
			);
			const out = r?.content?.[0]?.text ?? "";
			check(
				`a ${label} plan_file punts naming the path`,
				out.includes(`\`${path}\``) && out.includes(why) && out.includes("Implement the task directly"),
				out,
			);
			check(`a ${label} plan_file spawns nothing`, bus.spawned.length === 0, bus.spawned.join(","));
		}
	}

	// --- ledger_solve tool: no plan_file, or a blank one, runs the manager's own plan ---
	{
		writeConfig({ gate: "true", maxIters: 4 });
		const { tools, ctx, bus } = fresh(CONVERGE, "code");
		await tools.ledger_solve.execute(
			"call-no-plan",
			{ task: "fix the failing test", plan_file: "   " },
			undefined,
			undefined,
			ctx,
		);
		check(
			"a blank plan_file counts as absent: the manager plans and the worker ideates first",
			descriptionsFor(bus, "ledger-manager")[0]?.endsWith(", plan)") === true &&
				descriptionsFor(bus, "ledger-worker")[0]?.endsWith(", ideate)") === true,
			bus.spawnedDescriptions.join(" | "),
		);
		const managerRow = readAudit()
			.filter((x) => x.event === "run" && x.entry === "tool")
			.at(-1);
		check("the audit row records planSource manager without a plan", managerRow?.planSource === "manager");
	}

	// --- first-plan agent failure reaches the audit writer with its category ---
	{
		// A failed agent payload on the very first call (the plan) exits through
		// spawnFailure; the row must carry agent-error, not the refused path's category.
		writeConfig({ gate: "true", maxIters: 4 });
		const { handlers, ctx, bus } = fresh([{ fail: true, failError: "manager crashed" }], "code");
		await handlers.input(input("fix it"), ctx);
		check(
			"a first-plan agent failure is audited as stopDetail:agent-error",
			lastRunStop() === "spawn-failure" && lastRunStopDetail() === "agent-error",
			`stop=${lastRunStop()} detail=${String(lastRunStopDetail())}`,
		);
		check(
			"the failed plan agent was consumed once and never stopped",
			consumedOncePerSpawn(bus, 1),
			`spawned=${bus.spawned.length} ${opLog(bus)}`,
		);
	}

	// --- ledger_solve tool: out-of-scope provider punts without spawning ---
	{
		writeConfig({ gate: "true" });
		const { tools, ctx, bus } = fresh([], "code");
		const tool = tools.ledger_solve;
		const offScope = { ...ctx, model: { provider: "openai", id: "gpt-x" } };
		const r = await tool.execute("call-2", { task: "do it" }, undefined, undefined, offScope);
		const out = r?.content?.[0]?.text ?? "";
		check(
			"ledger_solve punts for out-of-scope provider",
			out.includes("Implement the task directly"),
			out.slice(0, 80),
		);
		check("ledger_solve did not spawn when punting", bus.spawned.length === 0, bus.spawned.join(","));
	}

	// --- ledger_solve tool: a model not on its provider allowlist punts without spawning ---
	{
		writeConfig({ gate: "true", allowlist: { cerebras: ["some-other-model"] } });
		const { tools, ctx, bus } = fresh([], "code");
		const r = await tools.ledger_solve.execute("call-block", { task: "do it" }, undefined, undefined, ctx);
		const out = r?.content?.[0]?.text ?? "";
		check("ledger_solve punts for a non-allowlisted model", out.includes("not allowlisted"), out.slice(0, 80));
		check("ledger_solve did not spawn for a non-allowlisted model", bus.spawned.length === 0, bus.spawned.join(","));
	}

	// --- ledger_solve tool: a present [roleModel] table that names no entry punts ---
	{
		writeConfig({
			gate: "true",
			roleModel: { "remote/other": { manager: "remote/m", worker: "remote/w" } },
		});
		const { tools, ctx, bus } = fresh([], "code");
		const r = await tools.ledger_solve.execute("call-no-role", { task: "do it" }, undefined, undefined, ctx);
		const out = r?.content?.[0]?.text ?? "";
		check(
			"ledger_solve punts for a model with no [roleModel] entry and no default",
			out.includes(
				"no [roleModel] entry and no [roleModel].default for cerebras/qwen-3.8-27b; the model is inactive.",
			),
			out.slice(0, 90),
		);
		check(
			"ledger_solve did not spawn for a model with no [roleModel] entry",
			bus.spawned.length === 0,
			bus.spawned.join(","),
		);
	}

	// --- ledger_solve tool: a dropped malformed [roleModel] entry punts ---
	{
		writeConfig({ gate: "true", roleModel: { "cerebras/qwen-3.8-27b": { manager: "remote/m" } } });
		const { tools, ctx, bus } = fresh([], "code");
		const r = await tools.ledger_solve.execute("call-bad-role", { task: "do it" }, undefined, undefined, ctx);
		const out = r?.content?.[0]?.text ?? "";
		check(
			"ledger_solve punts for a malformed [roleModel] entry",
			out.includes("[roleModel] entry for cerebras/qwen-3.8-27b is malformed"),
			out.slice(0, 90),
		);
		check(
			"ledger_solve did not spawn for a malformed [roleModel] entry",
			bus.spawned.length === 0,
			bus.spawned.join(","),
		);
	}

	// --- ledger_solve tool: empty task punts ---
	{
		writeConfig({ gate: "true" });
		const { tools, ctx } = fresh([], "code");
		const r = await tools.ledger_solve.execute("call-3", { task: "   " }, undefined, undefined, ctx);
		const out = r?.content?.[0]?.text ?? "";
		check("ledger_solve punts on an empty task", out.includes("Implement the task directly"), out.slice(0, 80));
	}

	// --- ledger_solve tool: a non-git cwd override punts without spawning ---
	{
		writeConfig({ gate: "true" });
		const { tools, ctx, bus } = fresh([], "code");
		const r = await tools.ledger_solve.execute(
			"call-4",
			{ task: "do it", cwd: agentDirPath },
			undefined,
			undefined,
			ctx,
		);
		const out = r?.content?.[0]?.text ?? "";
		check(
			"ledger_solve punts on a non-git cwd override",
			out.includes("Implement the task directly"),
			out.slice(0, 80),
		);
		check("ledger_solve did not spawn for a bad cwd", bus.spawned.length === 0, bus.spawned.join(","));
	}

	// --- ledger_solve tool: overlapping calls are rejected by the synchronous running guard ---
	{
		writeConfig({ gate: "true", maxIters: 4 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { tools, ctx } = fresh(script, "code");
		const tool = tools.ledger_solve;
		check("ledger_solve declares sequential execution", tool.executionMode === "sequential");
		// Start one call (it claims `running` synchronously before its first await),
		// then issue a second before the first settles: it must punt, not race in.
		const first = tool.execute("c-a", { task: "fix it" }, undefined, undefined, ctx);
		const second = await tool.execute("c-b", { task: "fix it too" }, undefined, undefined, ctx);
		const firstOut = (await first)?.content?.[0]?.text ?? "";
		const secondOut = second?.content?.[0]?.text ?? "";
		check("overlapping ledger_solve is rejected", secondOut.includes("already running"), secondOut.slice(0, 80));
		check(
			"the first overlapping call still converged",
			firstOut.includes("<ledgerpi-result>"),
			firstOut.slice(0, 80),
		);
	}

	// --- input hook rechecks the shared guard: a tool claim mid-classification defers the hook ---
	{
		writeConfig({ gate: "true", maxIters: 4 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "x") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, tools, ctx } = fresh(script, "code");
		let toolRun: Promise<unknown> | undefined;
		ctx.modelRegistry.complete = async () => {
			// A concurrent ledger_solve claims the shared running guard while the
			// input hook is classifying; it sets state.running synchronously.
			toolRun = tools.ledger_solve.execute("concurrent", { task: "other" }, undefined, undefined, ctx);
			return { content: [{ type: "text", text: "code" }], usage: { totalTokens: 3 } };
		};
		const r = await handlers.input(input("fix it"), ctx);
		check(
			"input hook defers when a run is claimed mid-classification",
			r === undefined || r?.action !== "transform",
			JSON.stringify(r)?.slice(0, 80),
		);
		await toolRun;
	}

	// --- ledger_solve tool: a valid cwd override routes spawns there; an explicit gate overrides config ---
	{
		// config gate "false" would fail the run; the explicit param gate "true" must win.
		writeConfig({ gate: "false", maxIters: 4 });
		const repo2 = join(root, "repo2");
		mkdirSync(repo2, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: repo2 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "x") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { tools, ctx, bus } = fresh(script, "code");
		const r = await tools.ledger_solve.execute(
			"c-cwd",
			{ task: "work in repo2", cwd: repo2, gate: "true" },
			undefined,
			undefined,
			ctx,
		);
		const out = r?.content?.[0]?.text ?? "";
		check(
			"ledger_solve routes every spawn to the cwd override",
			bus.spawnedCwds.length > 0 && bus.spawnedCwds.every((c) => c === repo2),
			bus.spawnedCwds.join(","),
		);
		check(
			"explicit gate override converges over a failing config gate",
			out.includes("converged"),
			out.slice(0, 120),
		);
	}

	// --- the stub bus refuses a consume for a still-running agent, so ordering is provable ---
	{
		// Driven straight at the bus: a hung agent stays running and nothing else is
		// stopped or consumed, isolating the guard from the extension's lifecycle.
		const bus = makeBus([{ hang: true }]);
		bus.emit("subagents:rpc:spawn", { requestId: "req-guard", type: "worker", prompt: "fix it" });
		bus.emit("subagents:rpc:consume", { requestId: "req-guard-early", agentId: "agent-1" });
		const refused = { consumes: [...bus.consumes], ops: [...bus.ops] };
		bus.emit("subagents:rpc:stop", { requestId: "req-guard-stop", agentId: "agent-1" });
		bus.emit("subagents:rpc:consume", { requestId: "req-guard-late", agentId: "agent-1" });
		check(
			"the stub refuses a consume before its stop and accepts it only after",
			refused.consumes.length === 0 && refused.ops.length === 0 && stoppedThenConsumed(bus, "agent-1"),
			`${JSON.stringify(refused)} then ${opLog(bus)}`,
		);
	}

	// --- rpc abort stops the still-running agent (no orphaned worker) ---
	{
		writeConfig({ gate: "true", maxIters: 4 });
		const { handlers, ctx, bus } = fresh([{ hang: true }], "code");
		const ac = new AbortController();
		ctx.signal = ac.signal;
		const pending = handlers.input(input("fix it"), ctx);
		await new Promise((r) => setTimeout(r, 10));
		ac.abort();
		const r = await pending;
		check(
			"abort emits a stop for the hung agent",
			bus.stops.length === 1 && bus.stops[0] === "agent-1",
			bus.stops.join(","),
		);
		check(
			"abort consumes the hung agent's result immediately after stopping it",
			stoppedThenConsumed(bus, "agent-1"),
			opLog(bus),
		);
		check("aborted run drops the turn", r?.action === "handled", JSON.stringify(r));
		check(
			"aborted run is still audited (stop:aborted)",
			readAudit().some((x) => x.event === "run" && x.stop === "aborted"),
			JSON.stringify(
				readAudit()
					.filter((x) => x.event === "run")
					.map((x) => x.stop),
			),
		);
	}

	// --- abort BEFORE the id arrives: the late reply still stops the agent ---
	{
		writeConfig({ gate: "true", maxIters: 4 });
		const { handlers, ctx, bus } = fresh([{ deferReply: true }], "code");
		const ac = new AbortController();
		ctx.signal = ac.signal;
		const pending = handlers.input(input("fix it"), ctx);
		await new Promise((r) => setTimeout(r, 10));
		ac.abort(); // abort while the spawn reply (and id) is still pending
		await pending;
		bus.flushReplies(); // the id arrives only now
		await new Promise((r) => setTimeout(r, 0));
		check("abort-before-reply stops the late agent", bus.stops.includes("agent-1"), bus.stops.join(","));
		check(
			"abort-before-reply consumes the late agent's result immediately after stopping it",
			stoppedThenConsumed(bus, "agent-1"),
			opLog(bus),
		);
		check(
			"an abort before the id arrives is audited as stop:aborted",
			lastRunStop() === "aborted",
			String(lastRunStop()),
		);
		check(
			"an aborted stop writes a null stopDetail (no spawn-failure category)",
			lastRunStopDetail() === null,
			String(lastRunStopDetail()),
		);
	}

	// --- timeout BEFORE the id arrives: the late reply still stops the agent ---
	{
		writeConfig({ gate: "true", maxIters: 4, callTimeoutMs: 15 });
		const { handlers, ctx, bus } = fresh([{ deferReply: true }], "code");
		await handlers.input(input("fix it"), ctx); // the manager spawn times out before the id arrives
		bus.flushReplies();
		await new Promise((res) => setTimeout(res, 0));
		check("timeout-before-reply stops the late agent", bus.stops.includes("agent-1"), bus.stops.join(","));
		check(
			"timeout-before-reply consumes the late agent's result immediately after stopping it",
			stoppedThenConsumed(bus, "agent-1"),
			opLog(bus),
		);
		check(
			"a timeout before the id arrives is audited as stop:spawn-failure",
			lastRunStop() === "spawn-failure",
			String(lastRunStop()),
		);
		check(
			"the timeout's stopDetail is timeout, not a text inference",
			lastRunStopDetail() === "timeout",
			String(lastRunStopDetail()),
		);
		const timeoutRow = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check(
			"the timeout row carries the callTimeoutMs and maxIters it ran under",
			timeoutRow?.callTimeoutMs === 15 && timeoutRow?.maxIters === 4,
			JSON.stringify({ callTimeoutMs: timeoutRow?.callTimeoutMs, maxIters: timeoutRow?.maxIters }),
		);
	}

	// --- timeout with the id already known: the hung agent is stopped, then consumed ---
	{
		// The stub names the agent synchronously inside the spawn emit, so the id is
		// known long before the 15ms budget expires and the late-reply path is not
		// involved. The timed-out plan call ends the run, so exactly one agent exists.
		writeConfig({ gate: "true", maxIters: 4, callTimeoutMs: 15 });
		const { handlers, ctx, bus } = fresh([{ hang: true }], "code");
		await handlers.input(input("fix it"), ctx);
		check(
			"timeout with a known id stops the one hung agent and nothing else",
			bus.spawned.length === 1 && bus.stops.length === 1 && bus.stops[0] === "agent-1",
			`spawned=${bus.spawned.length} stops=${bus.stops.join(",")}`,
		);
		check(
			"timeout-with-id consumes the hung agent's result immediately after stopping it",
			stoppedThenConsumed(bus, "agent-1"),
			opLog(bus),
		);
		check(
			"a timeout with a known id is audited as stop:spawn-failure",
			lastRunStop() === "spawn-failure",
			String(lastRunStop()),
		);
		check(
			"a timeout with a known id is audited with stopDetail:timeout",
			lastRunStopDetail() === "timeout",
			String(lastRunStopDetail()),
		);
	}

	// --- each termination path resolves with its own distinct RPC error string ---
	{
		// The hook-level cases above can only observe `spawn-failure`, which the loop
		// records identically for a timeout, a failed worker, and a refused spawn, so
		// they cannot tell those apart. Driven at `rpc.spawn` directly, the two distinct
		// error strings are pinned at the source instead of conflated by the audit proxy.
		const term = async (opts: { label: string; step: Step; mode: "abort" | "timeout"; delayedReply: boolean }) => {
			const expect = opts.mode === "abort" ? "aborted" : "timeout";
			const bus = makeBus([opts.step]);
			const ac = new AbortController();
			const pending = spawn(bus, {
				type: "ledger-worker",
				prompt: "fix it",
				description: "ledger worker",
				timeoutMs: opts.mode === "abort" ? 10_000 : 15,
				signal: opts.mode === "abort" ? ac.signal : undefined,
			});
			// Abort only after `spawn` registered its listener, so this is an interrupt
			// mid-run rather than the already-aborted guard tested below.
			if (opts.mode === "abort") ac.abort();
			const r = await pending;
			if (opts.delayedReply) {
				check(`${opts.label} stops nothing before the id arrives`, bus.ops.length === 0, opLog(bus));
				bus.flushReplies();
			}
			check(
				`${opts.label} resolves {ok:false, error:${expect}}`,
				r.ok === false && r.error === expect,
				JSON.stringify(r),
			);
			check(`${opts.label} tags its own failure branch`, r.ok === false && r.detail === expect, JSON.stringify(r));
			check(`${opts.label} stops then consumes the agent`, stoppedThenConsumed(bus, "agent-1"), opLog(bus));
		};
		await term({ label: "abort with a known id", step: { hang: true }, mode: "abort", delayedReply: false });
		await term({ label: "timeout with a known id", step: { hang: true }, mode: "timeout", delayedReply: false });
		await term({
			label: "abort before the reply",
			step: { deferReply: true },
			mode: "abort",
			delayedReply: true,
		});
		await term({
			label: "timeout before the reply",
			step: { deferReply: true },
			mode: "timeout",
			delayedReply: true,
		});
	}

	// --- identical error text across refusal and agent failure must not collide ---
	{
		// Both branches emit their host's/agent's arbitrary string: a spawn reply refusing
		// with "boom" and a failed agent payload carrying "boom" produce the same error
		// text from two different sources. The detail must come from the branch, not the
		// text -- this is the case a text-inference implementation would get wrong.
		const refused = await spawn(makeBus([{ spawnRefused: true, refuseError: "boom" }]), {
			type: "ledger-worker",
			prompt: "fix it",
			description: "ledger worker",
			timeoutMs: 10_000,
		});
		const agentFailed = await spawn(makeBus([{ fail: true, failError: "boom" }]), {
			type: "ledger-worker",
			prompt: "fix it",
			description: "ledger worker",
			timeoutMs: 10_000,
		});
		check(
			"refusal and agent failure can carry identical error text",
			refused.error === agentFailed.error && agentFailed.error === "boom",
			`refused=${JSON.stringify(refused)} failed=${JSON.stringify(agentFailed)}`,
		);
		check(
			"identical error text still resolves to different categories",
			refused.detail === "refused" && agentFailed.detail === "agent-error",
			`refused.detail=${String(refused.detail)} failed.detail=${String(agentFailed.detail)}`,
		);
	}

	// --- a successful spawn carries no failure detail ---
	{
		const okResult = await spawn(makeBus([{ text: "done" }]), {
			type: "ledger-worker",
			prompt: "fix it",
			description: "ledger worker",
			timeoutMs: 10_000,
		});
		check(
			"a successful spawn resolves ok with no detail",
			okResult.ok === true && okResult.detail === undefined,
			JSON.stringify(okResult),
		);
	}

	// --- the loop keeps the final consecutive failure's category, not the first's ---
	{
		// The first worker call times out (a hang against a tiny callTimeoutMs), so the
		// first failure's category is "timeout"; the reissued worker call fails as an
		// agent error, which is the terminal second failure -- its category is the one
		// the audit row must carry.
		writeConfig({ gate: "true", maxIters: 6, callTimeoutMs: 15 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "task A") },
			{ hang: true }, // worker call times out -> first consecutive failure
			{ fail: true, failError: "crashed" }, // reissued worker fails -> second -> stop
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		await handlers.input(input("fix it"), ctx);
		check(
			"mixed consecutive failures still stop as spawn-failure",
			lastRunStop() === "spawn-failure",
			String(lastRunStop()),
		);
		check(
			"the final consecutive failure's category wins over the first's",
			lastRunStopDetail() === "agent-error",
			String(lastRunStopDetail()),
		);
		check(
			"the timed-out worker is stopped then consumed; the failed worker consumed once",
			bus.spawned.length === 5 &&
				bus.stops.length === 1 &&
				opLog(bus) ===
					`consume:agent-1,consume:agent-2,consume:agent-3,stop:agent-4,consume:agent-4,consume:agent-5`,
			`spawned=${bus.spawned.length} ${opLog(bus)}`,
		);
	}

	// --- a first-plan spawn failure carries its own category ---
	{
		// The manager's very first call is refused, so the first-plan failure exit
		// (spawnFailure) threads the plan reply's category, not the worker path's.
		writeConfig({ gate: "true", maxIters: 4 });
		const { handlers, ctx, bus } = fresh([{ spawnRefused: true, refuseError: "quota exceeded" }], "code");
		await handlers.input(input("fix it"), ctx);
		check(
			"a refused first plan is audited as stop:spawn-failure with stopDetail:refused",
			lastRunStop() === "spawn-failure" && lastRunStopDetail() === "refused",
			`stop=${lastRunStop()} detail=${String(lastRunStopDetail())}`,
		);
		check(
			"a refused plan spawn stops and consumes no id that never existed",
			bus.spawned.length === 1 && bus.stops.length === 0 && bus.consumes.length === 0 && bus.ops.length === 0,
			`spawned=${bus.spawned.length} ${opLog(bus)}`,
		);
	}

	// --- a signal already aborted before the spawn never reaches the bus ---
	{
		// Driven at `rpc.spawn` directly: the input hook cannot reach this guard, since
		// `index.ts` hands `ctx.signal` to the classifier, which reports an interrupt as
		// a chat passthrough and returns before the loop spawns anything. So the loop
		// never calls `spawn` with an already-aborted signal; the module under test does.
		const bus = makeBus([{ text: "x" }]);
		const ac = new AbortController();
		ac.abort();
		const r = await spawn(bus, {
			type: "ledger-manager",
			prompt: "fix it",
			description: "ledger manager",
			timeoutMs: 1000,
			signal: ac.signal,
		});
		check(
			"a pre-aborted signal resolves {ok:false, error:aborted} instead of rejecting",
			r.ok === false && r.error === "aborted",
			`${JSON.stringify(r)} spawned=${bus.spawned.length} ${opLog(bus)}`,
		);
		check(
			"a pre-aborted signal spawns, stops, and consumes nothing",
			bus.spawned.length === 0 && bus.stops.length === 0 && bus.consumes.length === 0 && bus.ops.length === 0,
			`spawned=${bus.spawned.length} ${opLog(bus)}`,
		);
	}

	// --- a refused spawn never becomes an agent, so there is nothing to stop or consume ---
	{
		writeConfig({ gate: "true", maxIters: 4 });
		const { handlers, ctx, bus } = fresh([{ spawnRefused: true }], "code");
		await handlers.input(input("fix it"), ctx);
		check(
			"a refused spawn still reaches the bus once, so the empty ops log below is not vacuous",
			bus.spawned.length === 1,
			`spawned=${bus.spawned.length} ${opLog(bus)}`,
		);
		check(
			"a refused spawn stops and consumes no id that never existed",
			bus.stops.length === 0 && bus.consumes.length === 0 && bus.ops.length === 0,
			`spawned=${bus.spawned.length} ${opLog(bus)}`,
		);
		check(
			"a refused spawn is audited as stop:spawn-failure",
			lastRunStop() === "spawn-failure",
			`stop=${lastRunStop()} spawned=${bus.spawned.length} ${opLog(bus)}`,
		);
		check(
			"a refused spawn is audited with stopDetail:refused",
			lastRunStopDetail() === "refused",
			String(lastRunStopDetail()),
		);
	}

	// --- audit and worker mapping use the provider/model snapshotted before classification ---
	{
		writeConfig({ gate: "true", maxIters: 4, workerModel: { "cerebras/qwen-3.8-27b": "local/qwen3.8-27b" } });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		ctx.modelRegistry.complete = async () => {
			// The model switches during classification; the audit must record the
			// identity captured before the awaits, not the live post-switch value.
			ctx.model.id = "switched-after-capture";
			return { content: [{ type: "text", text: "code" }], usage: { totalTokens: 3 } };
		};
		await handlers.input(input("fix it"), ctx);
		const row = readAudit()
			.filter((x) => x.event === "run" && x.entry === "input")
			.at(-1);
		check(
			"audit records the model snapshotted before classification",
			row?.model === "qwen-3.8-27b",
			JSON.stringify(row),
		);
		check("a successful input run writes a null stopDetail", row?.stopDetail === null, String(row?.stopDetail));
		const workerModels = bus.spawned.flatMap((t, i) => (t === "ledger-worker" ? [bus.spawnedModels[i]] : []));
		check(
			"the worker mapping follows the model snapshotted before classification",
			workerModels.length > 0 &&
				workerModels.every((m) => m === "local/qwen3.8-27b") &&
				row?.workerModel === "local/qwen3.8-27b",
			`workers=${workerModels.join(",")} audit=${row?.workerModel}`,
		);
	}

	// --- audit provenance: every row carries the source label in effect at its own write ---
	{
		// The provenance stamp is resolved per write from LEDGERPI_AUDIT_SOURCE, so
		// both entry paths label organic use "organic" and a caller-supplied harness
		// label verbatim. The env is isolated here and restored afterward so an
		// ambient value cannot contaminate a later block.
		const converging = (): Step[] => [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const lastSource = (entry: "input" | "tool"): unknown =>
			readAudit()
				.filter((x) => x.event === "run" && x.entry === entry)
				.at(-1)?.source;
		const inputRun = async () => {
			const { handlers, ctx } = fresh(converging(), "code");
			await handlers.input(input("fix it"), ctx);
		};
		const toolRun = async () => {
			const { tools, ctx } = fresh(converging(), "code");
			await tools.ledger_solve.execute("c-source", { task: "fix it" }, undefined, undefined, ctx);
		};
		writeConfig({ gate: "true", maxIters: 4 });
		const savedSource = process.env.LEDGERPI_AUDIT_SOURCE;
		try {
			delete process.env.LEDGERPI_AUDIT_SOURCE;
			await inputRun();
			check(
				"input-path run is stamped source:organic when the env is unset",
				lastSource("input") === "organic",
				String(lastSource("input")),
			);
			await toolRun();
			check(
				"tool-path run is stamped source:organic when the env is unset",
				lastSource("tool") === "organic",
				String(lastSource("tool")),
			);
			process.env.LEDGERPI_AUDIT_SOURCE = "benchmark";
			await inputRun();
			check(
				"input-path run is stamped with the supplied label",
				lastSource("input") === "benchmark",
				String(lastSource("input")),
			);
			await toolRun();
			check(
				"tool-path run is stamped with the supplied label",
				lastSource("tool") === "benchmark",
				String(lastSource("tool")),
			);
		} finally {
			if (savedSource === undefined) delete process.env.LEDGERPI_AUDIT_SOURCE;
			else process.env.LEDGERPI_AUDIT_SOURCE = savedSource;
		}
	}

	// --- abort inside a round preserves iters and the gate verdict (not 0/null) ---
	{
		// A blocking gate makes the abort land deterministically at the round-1 gate
		// step (iters already 1, gate verdict already an object), so the aborted audit
		// row must carry that progress rather than the abort helper's old 0/null.
		writeConfig({ gate: "sleep 5", maxIters: 6 });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "task 1") },
			{ text: worker("continue") }, // round 1 worker completes, then the gate blocks
		];
		const { handlers, ctx } = fresh(script, "code");
		const ac = new AbortController();
		ctx.signal = ac.signal;
		const pending = handlers.input(input("fix it"), ctx);
		await new Promise((r) => setTimeout(r, 20));
		ac.abort();
		await pending;
		const row = readAudit()
			.filter((x) => x.event === "run" && x.stop === "aborted")
			.at(-1);
		check(
			"aborted-in-round audit preserves iters (>=1) and a non-null gate verdict",
			!!row && row.iters === 1 && row.gate !== null && row.gate?.command === "sleep 5",
			JSON.stringify(row),
		);
		check(
			"an aborted run is still stamped with the repo state",
			row?.branch === gitOut(repo, ["symbolic-ref", "--short", "HEAD"]) &&
				row?.repoUrl === null &&
				row?.headStart === null &&
				row?.headEnd === null,
			JSON.stringify({ r: row?.repoUrl, b: row?.branch, s: row?.headStart, e: row?.headEnd }),
		);
	}

	// --- ledger_solve tool: not registered when disabled ---
	{
		writeConfig({ gate: "true", enabled: false });
		const { tools } = fresh([], "code");
		check("ledger_solve is not registered when disabled", tools.ledger_solve === undefined);
		writeConfig({ gate: "true" });
	}

	// --- ledger_solve tool: not registered when inert (no config) ---
	{
		removeConfig();
		const { tools } = fresh([], "code");
		check("ledger_solve is not registered when inert (no config)", tools.ledger_solve === undefined);
	}

	// --- auto-trigger redirect: arms a skill session and blocks the first inline edit ---
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["*"] });
		const { handlers, ctx } = fresh([], "code");
		await handlers.before_agent_start(beforeAgentStart("implement the claimed item"), ctx);
		const blocked = await handlers.tool_call(editCall(), ctx);
		check("redirect blocks the first inline edit", blocked?.block === true, JSON.stringify(blocked)?.slice(0, 80));
		check(
			"redirect reason names ledger_solve",
			blocked?.reason?.includes("ledger_solve") === true,
			blocked?.reason?.slice(0, 80),
		);
		const readr = await handlers.tool_call(readCall(), ctx);
		check("redirect does not block a read", readr === undefined || readr?.block !== true);
	}

	// --- auto-trigger redirect: a recorded run disarms it ---
	{
		writeConfig({ gate: "true", maxIters: 4, autoTrigger: "redirect", redirectSkills: ["*"] });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, tools, ctx } = fresh(script, "code");
		await handlers.before_agent_start(beforeAgentStart("do it"), ctx);
		await tools.ledger_solve.execute("c-disarm", { task: "fix the failing test" }, undefined, undefined, ctx);
		const after = await handlers.tool_call(editCall(), ctx);
		check("redirect disarms after a recorded run", after === undefined, JSON.stringify(after)?.slice(0, 80));
	}

	// --- auto-trigger redirect: out-of-scope provider does not arm ---
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["*"] });
		const { handlers, ctx } = fresh([], "code");
		ctx.model.provider = "openai-codex";
		await handlers.before_agent_start(beforeAgentStart("do it"), ctx);
		const r = await handlers.tool_call(editCall(), ctx);
		check("redirect not armed for an out-of-scope provider", r === undefined);
	}

	// --- auto-trigger redirect: no block when the subagents RPC is absent ---
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["*"] });
		const { handlers, ctx } = fresh([], "code", { noPing: true });
		await handlers.before_agent_start(beforeAgentStart("do it"), ctx);
		const r = await handlers.tool_call(editCall(), ctx);
		check("redirect does not block when subagents RPC is absent", r === undefined);
	}

	// --- auto-trigger redirect: relents after the retry cap ---
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["*"] });
		const { handlers, ctx } = fresh([], "code");
		await handlers.before_agent_start(beforeAgentStart("do it"), ctx);
		const b1 = await handlers.tool_call(editCall(), ctx);
		const b2 = await handlers.tool_call(editCall(), ctx);
		const b3 = await handlers.tool_call(editCall(), ctx);
		check("redirect blocks up to the cap", b1?.block === true && b2?.block === true);
		check("redirect relents after the cap", b3 === undefined, JSON.stringify(b3)?.slice(0, 80));
	}

	// --- auto-trigger redirect: an input-hook run owns the turn, so no double-run ---
	{
		writeConfig({ gate: "true", maxIters: 4, autoTrigger: "redirect", redirectSkills: ["*"] });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "x") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		const r = await handlers.input(input("fix it"), ctx);
		check("input-hook run still transforms under redirect", r?.action === "transform");
		const spawnCount = bus.spawned.length;
		await handlers.before_agent_start(beforeAgentStart("fix it"), ctx);
		const after = await handlers.tool_call(editCall(), ctx);
		check("no redirect after an input-hook run owns the turn", after === undefined);
		check("no second loop is spawned by the redirect", bus.spawned.length === spawnCount, bus.spawned.join(","));
	}

	// --- auto-trigger redirect: an allowlisted slash command arms; a non-listed one does not ---
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const { handlers, ctx } = fresh([], "code");
		const passthrough = await handlers.input(input("/review-task PROJ-7"), ctx);
		check("slash command still passes through under redirect", passthrough === undefined);
		await handlers.before_agent_start(beforeAgentStart("triage and fix PROJ-7"), ctx);
		const blocked = await handlers.tool_call(editCall(), ctx);
		check(
			"redirect arms for an allowlisted slash command",
			blocked?.block === true,
			JSON.stringify(blocked)?.slice(0, 80),
		);
	}
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const { handlers, ctx } = fresh([], "code");
		await handlers.input(input("/create-worktree feature-x"), ctx);
		await handlers.before_agent_start(beforeAgentStart("make a worktree"), ctx);
		const r = await handlers.tool_call(editCall(), ctx);
		check("redirect does not arm for a non-allowlisted slash command", r === undefined);
	}

	// --- auto-trigger redirect: pi's `/skill:<name>` form matches a bare redirectSkills entry ---
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const { handlers, ctx } = fresh([], "code");
		await handlers.input(input("/skill:review-task PROJ-5"), ctx);
		await handlers.before_agent_start(beforeAgentStart("triage and fix PROJ-5"), ctx);
		const blocked = await handlers.tool_call(editCall(), ctx);
		check(
			"redirect arms for an allowlisted /skill:<name> command",
			blocked?.block === true,
			JSON.stringify(blocked)?.slice(0, 80),
		);
	}
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const { handlers, ctx } = fresh([], "code");
		await handlers.input(input("/skill:report-task a bug"), ctx);
		await handlers.before_agent_start(beforeAgentStart("file a bug"), ctx);
		const r = await handlers.tool_call(editCall(), ctx);
		check("redirect does not arm for a non-allowlisted /skill:<name> command", r === undefined);
	}
	{
		const cfg = { ...loadConfig(), redirectSkills: ["skill:review-task"] };
		check(
			"a skill:-prefixed redirectSkills entry matches both command forms",
			redirectSkillAllowed(cfg, "review-task") && redirectSkillAllowed(cfg, "skill:review-task"),
		);
	}

	// --- auto-trigger redirect: a write outside any git work tree passes and keeps the run armed ---
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const scratch = join(root, "scratch-nogit");
		mkdirSync(scratch, { recursive: true });
		const { handlers, ctx } = fresh([], "code");
		await handlers.input(input("/skill:review-task X"), ctx);
		await handlers.before_agent_start(beforeAgentStart("triage and fix X"), ctx);
		const planWrite = await handlers.tool_call(writeCall(join(scratch, "plan.md")), ctx);
		check("redirect lets a scratch write outside a git work tree through", planWrite === undefined);
		const nested = await handlers.tool_call(writeCall(join(scratch, "new", "dir", "x.txt")), ctx);
		check("redirect lets a write to a new dir outside a work tree through", nested === undefined);
		const realHome = process.env.HOME;
		process.env.HOME = scratch;
		const tilde = await handlers.tool_call(writeCall("~/notes/plan.md"), ctx);
		process.env.HOME = realHome;
		check(
			"redirect resolves a ~/ scratch path against HOME, not the cwd",
			tilde === undefined,
			JSON.stringify(tilde),
		);
		const at = await handlers.tool_call(writeCall(`@${join(scratch, "at-plan.md")}`), ctx);
		check("redirect strips pi's @ prefix before checking the work tree", at === undefined, JSON.stringify(at));
		const url = await handlers.tool_call(writeCall(pathToFileURL(join(scratch, "url-plan.md")).href), ctx);
		check("redirect resolves a file:// scratch path", url === undefined, JSON.stringify(url));
		const blocked = await handlers.tool_call(editCall(), ctx);
		check(
			"redirect still blocks the first in-repo edit after a scratch write",
			blocked?.block === true,
			JSON.stringify(blocked)?.slice(0, 80),
		);
	}
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const scratch = join(root, "scratch-links");
		mkdirSync(scratch, { recursive: true });
		writeFileSync(join(scratch, "plan.md"), "plan");
		writeFileSync(join(repo, "linked-target.ts"), "x");
		symlinkSync(join(scratch, "plan.md"), join(repo, "plan-link.md"));
		symlinkSync(join(repo, "linked-target.ts"), join(scratch, "repo-link.ts"));
		const { handlers, ctx } = fresh([], "code");
		await handlers.input(input("/skill:review-task X"), ctx);
		await handlers.before_agent_start(beforeAgentStart("triage and fix X"), ctx);
		const malformed = await handlers.tool_call(writeCall("file://not-a-local-host/x.md"), ctx);
		check(
			"a malformed file:// target fails open without throwing",
			malformed === undefined,
			JSON.stringify(malformed),
		);
		const outward = await handlers.tool_call(writeCall(join(repo, "plan-link.md")), ctx);
		check("an in-repo symlink to a scratch file is not redirected", outward === undefined, JSON.stringify(outward));
		const inward = await handlers.tool_call(editCall(join(scratch, "repo-link.ts")), ctx);
		check(
			"a scratch symlink into the repo is redirected",
			inward?.block === true,
			JSON.stringify(inward)?.slice(0, 80),
		);
		rmSync(join(repo, "plan-link.md"));
		rmSync(join(repo, "linked-target.ts"));
	}
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const scratch = join(root, "scratch-dangling");
		mkdirSync(scratch, { recursive: true });
		const spaced = join(root, "spaced repo");
		mkdirSync(spaced, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: spaced });
		symlinkSync(join(scratch, "missing-plan.md"), join(repo, "dangling-out.md"));
		symlinkSync(join(repo, "missing-target.ts"), join(scratch, "dangling-in.ts"));
		const { handlers, ctx } = fresh([], "code");
		await handlers.input(input("/skill:review-task X"), ctx);
		await handlers.before_agent_start(beforeAgentStart("triage and fix X"), ctx);
		const outward = await handlers.tool_call(writeCall(join(repo, "dangling-out.md")), ctx);
		check(
			"an in-repo dangling symlink to a scratch path is not redirected",
			outward === undefined,
			JSON.stringify(outward),
		);
		const inward = await handlers.tool_call(writeCall(join(scratch, "dangling-in.ts")), ctx);
		check(
			"a scratch dangling symlink into the repo is redirected",
			inward?.block === true,
			JSON.stringify(inward)?.slice(0, 80),
		);
		const nbsp = await handlers.tool_call(writeCall(join(root, "spaced repo", "new.ts")), ctx);
		check(
			"a target with a no-break space resolves like pi's file tools",
			nbsp?.block === true,
			JSON.stringify(nbsp)?.slice(0, 80),
		);
		rmSync(join(repo, "dangling-out.md"));
	}
	{
		// A relative leaf link reached through a directory symlink resolves against
		// the directory's real location, as the filesystem does.
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const planning = join(root, "planning");
		mkdirSync(join(planning, "subdir"), { recursive: true });
		symlinkSync(join(planning, "subdir"), join(repo, "scratch-dir"));
		symlinkSync("../plan.md", join(planning, "subdir", "plan.md"));
		mkdirSync(join(repo, "src", "deep"), { recursive: true });
		symlinkSync(join(repo, "src", "deep"), join(planning, "repo-dir"));
		symlinkSync("../target.ts", join(repo, "src", "deep", "link.ts"));
		const { handlers, ctx } = fresh([], "code");
		await handlers.input(input("/skill:review-task X"), ctx);
		await handlers.before_agent_start(beforeAgentStart("triage and fix X"), ctx);
		const outward = await handlers.tool_call(writeCall(join(repo, "scratch-dir", "plan.md")), ctx);
		check(
			"a relative link behind an in-repo dir symlink resolves outside the repo",
			outward === undefined,
			JSON.stringify(outward),
		);
		const inward = await handlers.tool_call(writeCall(join(planning, "repo-dir", "link.ts")), ctx);
		check(
			"a relative link behind a scratch dir symlink resolves into the repo",
			inward?.block === true,
			JSON.stringify(inward)?.slice(0, 80),
		);
		rmSync(join(repo, "scratch-dir"));
		rmSync(join(repo, "src"), { recursive: true, force: true });
	}
	{
		// A `..` inside a link destination is taken after the preceding directory
		// symlink, as the filesystem does, not collapsed as text first.
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const scratchRoot = join(root, "dotdot-scratch");
		mkdirSync(join(scratchRoot, "subdir"), { recursive: true });
		symlinkSync(join(scratchRoot, "subdir"), join(repo, "alias"));
		symlinkSync("alias/../plan.md", join(repo, "dotdot-out.md"));
		mkdirSync(join(repo, "inner", "deep"), { recursive: true });
		symlinkSync(join(repo, "inner", "deep"), join(scratchRoot, "repo-alias"));
		symlinkSync("repo-alias/../target.ts", join(scratchRoot, "dotdot-in.ts"));
		const { handlers, ctx } = fresh([], "code");
		await handlers.input(input("/skill:review-task X"), ctx);
		await handlers.before_agent_start(beforeAgentStart("triage and fix X"), ctx);
		const outward = await handlers.tool_call(writeCall(join(repo, "dotdot-out.md")), ctx);
		check(
			"a link destination's .. after an outward dir link stays outside",
			outward === undefined,
			JSON.stringify(outward),
		);
		const inward = await handlers.tool_call(writeCall(join(scratchRoot, "dotdot-in.ts")), ctx);
		check(
			"a link destination's .. after an inward dir link lands in the repo",
			inward?.block === true,
			JSON.stringify(inward)?.slice(0, 80),
		);
		rmSync(join(repo, "alias"));
		rmSync(join(repo, "dotdot-out.md"));
		rmSync(join(repo, "inner"), { recursive: true, force: true });
	}
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const other = join(root, "other-worktree");
		mkdirSync(other, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: other });
		const { handlers, ctx } = fresh([], "code");
		await handlers.input(input("/skill:review-task X"), ctx);
		await handlers.before_agent_start(beforeAgentStart("triage and fix X"), ctx);
		const r = await handlers.tool_call(writeCall(join(other, "src", "new.ts")), ctx);
		check(
			"redirect blocks a new-file write in another git work tree",
			r?.block === true,
			JSON.stringify(r)?.slice(0, 80),
		);
	}

	// --- auto-trigger redirect: empty redirectSkills is fail-closed (arms nothing) ---
	{
		writeConfig({ gate: "true", autoTrigger: "redirect" });
		const { handlers, ctx } = fresh([], "code");
		await handlers.input(input("/review-task PROJ-7"), ctx);
		await handlers.before_agent_start(beforeAgentStart("triage and fix"), ctx);
		const r = await handlers.tool_call(editCall(), ctx);
		check("empty redirectSkills arms nothing (fail-closed)", r === undefined);
	}

	// --- auto-trigger redirect: eligibility is consumed per run (a follow-on run is fail-closed) ---
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const { handlers, ctx } = fresh([], "code");
		await handlers.input(input("/review-task X"), ctx);
		await handlers.before_agent_start(beforeAgentStart("triage and fix"), ctx);
		const blocked = await handlers.tool_call(editCall(), ctx);
		check("redirect arms for the allowlisted run", blocked?.block === true);
		await handlers.before_agent_start(beforeAgentStart("a later run with no fresh command"), ctx);
		const after = await handlers.tool_call(editCall(), ctx);
		check("redirect does not arm a follow-on run (command consumed)", after === undefined);
	}

	// --- auto-trigger redirect: a queued slash command leaves no stale eligibility ---
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const { handlers, ctx } = fresh([], "code");
		await handlers.input(input("/review-task X", { streamingBehavior: "followUp" }), ctx);
		await handlers.before_agent_start(beforeAgentStart("a later run"), ctx);
		const r = await handlers.tool_call(editCall(), ctx);
		check("a queued slash command does not arm a later run", r === undefined);
	}

	// --- auto-trigger redirect: agent_end disarms a run that armed but never edited ---
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["*"] });
		const { handlers, ctx } = fresh([], "code");
		await handlers.before_agent_start(beforeAgentStart("do it"), ctx);
		await handlers.agent_end({ type: "agent_end", messages: [] }, ctx);
		const r = await handlers.tool_call(editCall(), ctx);
		check("agent_end disarms an armed-but-idle run before the next run", r === undefined);
	}

	// --- auto-trigger redirect: a non-slash input clears a pending redirect command ---
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["review-task"] });
		const { handlers, ctx } = fresh([], "code");
		await handlers.input(input("/review-task X"), ctx);
		await handlers.input(input("@somefile note"), ctx);
		await handlers.before_agent_start(beforeAgentStart("a later run"), ctx);
		const r = await handlers.tool_call(editCall(), ctx);
		check("a non-slash input clears a pending redirect command", r === undefined);
	}

	// --- auto-trigger redirect: a ledger sub-agent session (sentinel) never arms ---
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["*"] });
		const { handlers, ctx } = fresh([], "code");
		await handlers.before_agent_start(beforeAgentStart(`${WORKER_SENTINEL}\nTASK: do the fix`), ctx);
		const r = await handlers.tool_call(editCall(), ctx);
		check("redirect does not arm a ledger sub-agent session", r === undefined);
	}

	// --- worker safety: spawn prompts carry the sentinel, and the input hook bails on it ---
	{
		writeConfig({ gate: "true", maxIters: 4, autoTrigger: "redirect", redirectSkills: ["*"] });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "x") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { handlers, ctx, bus } = fresh(script, "code");
		await handlers.input(input("fix it"), ctx);
		check(
			"every spawned sub-agent prompt carries the worker sentinel",
			bus.spawnedPrompts.length > 0 && bus.spawnedPrompts.every((p) => p?.includes(WORKER_SENTINEL)),
			bus.spawnedPrompts.join(" | ").slice(0, 100),
		);
	}
	{
		writeConfig({ gate: "true", autoTrigger: "redirect", redirectSkills: ["*"] });
		const { handlers, ctx, bus } = fresh([], "code");
		const r = await handlers.input(input(`${WORKER_SENTINEL}\nfix the bug`), ctx);
		check("input hook bails on a sentinel-prefixed prompt (worker session)", r === undefined);
		check("no loop is spawned for a sentinel input", bus.spawned.length === 0, bus.spawned.join(","));
	}

	// --- auto-trigger off (default): edits are never blocked ---
	{
		writeConfig({ gate: "true", redirectSkills: ["*"] });
		const { handlers, ctx } = fresh([], "code");
		await handlers.before_agent_start(beforeAgentStart("do it"), ctx);
		const r = await handlers.tool_call(editCall(), ctx);
		check("autoTrigger off does not block edits", r === undefined);
	}
	writeFileSync(configFile, stringifyToml({ providers: ["cerebras"] }));
	check("autoTrigger defaults to off", loadConfig().autoTrigger === "off");
	writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], autoTrigger: "redirect" }));
	check("autoTrigger honors redirect", loadConfig().autoTrigger === "redirect");
	writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], autoTrigger: "nope" }));
	check("autoTrigger falls back to off on a bogus value", loadConfig().autoTrigger === "off");
	writeFileSync(configFile, stringifyToml({ providers: ["cerebras"] }));
	check("redirectSkills defaults to empty", loadConfig().redirectSkills.length === 0);
	writeFileSync(
		configFile,
		stringifyToml({ providers: ["cerebras"], redirectSkills: ["review-task", "other-skill"] }),
	);
	check(
		"redirectSkills loads the allowlist",
		JSON.stringify(loadConfig().redirectSkills) === JSON.stringify(["review-task", "other-skill"]),
	);

	// --- trigger=ask: Run starts the loop and reports the wait to herdr ---
	{
		writeConfig({ gate: "true", maxIters: 4, trigger: "ask" });
		const { handlers, ctx, bus, selects } = fresh(
			CONVERGE,
			"code",
			{},
			{ hasUI: true, selectReply: "Run ledger loop" },
		);
		const blocked: unknown[] = [];
		const labels: unknown[] = [];
		bus.on("herdr:blocked", (d) => {
			blocked.push((d as { active: unknown }).active);
			labels.push((d as { label?: unknown }).label);
		});
		const r = await handlers.input(input("fix the failing test"), ctx);
		check("trigger=ask shows the dialog once", selects.length === 1, String(selects.length));
		check(
			"the blocked event carries the ledgerpi question label",
			labels[0] === "question: ledgerpi",
			String(labels[0]),
		);
		check("trigger=ask + Run transforms the prompt", r?.action === "transform", JSON.stringify(r)?.slice(0, 80));
		check("trigger=ask + Run spawns the loop", bus.spawned.includes("ledger-manager"), bus.spawned.join(","));
		check("the ask dialog reports blocked then released", blocked.join(",") === "true,false", blocked.join(","));
	}

	// --- trigger=ask: Skip passes through and audits the decline ---
	{
		writeConfig({ gate: "true", trigger: "ask" });
		const { handlers, ctx, bus } = fresh(CONVERGE, "code", {}, { hasUI: true, selectReply: "Skip (this prompt)" });
		const r = await handlers.input(input("fix the failing test"), ctx);
		check("trigger=ask + Skip passes through", r === undefined, JSON.stringify(r));
		check("trigger=ask + Skip spawns nothing", bus.spawned.length === 0, bus.spawned.join(","));
		const row = readAudit()
			.filter((x) => x.event === "passthrough")
			.at(-1);
		check(
			"a declined prompt is audited as reason=declined with the classifier spend",
			!!row && row.reason === "declined" && row.classified === "code" && row.calls === 1 && row.tokens === 3,
			JSON.stringify(row),
		);
	}

	// --- trigger=ask: Escape (no selection) is a Skip ---
	{
		writeConfig({ gate: "true", trigger: "ask" });
		const { handlers, ctx, bus } = fresh(CONVERGE, "code", {}, { hasUI: true });
		const r = await handlers.input(input("fix the failing test"), ctx);
		check("trigger=ask + Escape passes through without a run", r === undefined && bus.spawned.length === 0);
	}

	// --- trigger=ask: a failed dialog passes through, is not counted as a decline, and releases herdr ---
	{
		writeConfig({ gate: "true", trigger: "ask" });
		const { handlers, ctx, bus } = fresh(CONVERGE, "code", {}, { hasUI: true, selectThrows: true });
		const blocked: unknown[] = [];
		bus.on("herdr:blocked", (d) => blocked.push((d as { active: unknown }).active));
		const r = await handlers.input(input("fix the failing test"), ctx);
		const row = readAudit()
			.filter((x) => x.event === "passthrough")
			.at(-1);
		check("a failed ask dialog passes through without a run", r === undefined && bus.spawned.length === 0);
		check(
			"a failed ask dialog is audited as reason=ask-error, not declined",
			row?.reason === "ask-error",
			row?.reason,
		);
		check(
			"a failed ask dialog still releases the herdr block",
			blocked.join(",") === "true,false",
			blocked.join(","),
		);
	}

	// --- trigger=ask: Skip for this session stops asking until session_start ---
	{
		writeConfig({ gate: "true", trigger: "ask" });
		const { handlers, ctx, bus, selects, notices } = fresh(
			CONVERGE,
			"code",
			{},
			{ hasUI: true, selectReply: "Skip for this session" },
		);
		const r1 = await handlers.input(input("fix the failing test"), ctx);
		const row = readAudit()
			.filter((x) => x.event === "passthrough")
			.at(-1);
		check("Skip for this session passes through", r1 === undefined && bus.spawned.length === 0);
		check("Skip for this session is audited as declined-session", row?.reason === "declined-session", row?.reason);
		check(
			"Skip for this session points at /ledger",
			notices.some((n) => n.includes("/ledger")),
			notices.join("|"),
		);
		const r2 = await handlers.input(input("now fix the other test"), ctx);
		check(
			"a suppressed session asks nothing and runs nothing on the next prompt",
			r2 === undefined && selects.length === 1 && bus.spawned.length === 0,
			`selects=${selects.length} spawned=${bus.spawned.length}`,
		);
		handlers.session_start({}, ctx);
		await handlers.input(input("fix it again"), ctx);
		check("session_start clears the suppression", selects.length === 2, String(selects.length));
		await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
	}

	// --- workerModel: a mapped session model spawns the worker on the mapped model ---
	{
		writeConfig({ gate: "true", maxIters: 4, workerModel: { "cerebras/qwen-3.8-27b": "local/qwen3.8-27b" } });
		const { handlers, ctx, bus } = fresh(CONVERGE, "code");
		const r = await handlers.input(input("fix the failing test"), ctx);
		const managerModels = bus.spawned.flatMap((t, i) => (t === "ledger-manager" ? [bus.spawnedModels[i]] : []));
		const workerModels = bus.spawned.flatMap((t, i) => (t === "ledger-worker" ? [bus.spawnedModels[i]] : []));
		check(
			"a mapped session model spawns every worker on the mapped model",
			workerModels.length > 0 && workerModels.every((m) => m === "local/qwen3.8-27b"),
			workerModels.join(","),
		);
		check(
			"a mapped session model keeps the manager on the session model",
			managerModels.length > 0 && managerModels.every((m) => m === null),
			managerModels.join(","),
		);
		check(
			"a mapped session model labels the manager and worker with their own models",
			allLabelled(bus, "ledger-manager", "manager", "cerebras/qwen-3.8-27b") &&
				allLabelled(bus, "ledger-worker", "worker", "local/qwen3.8-27b"),
			bus.spawnedDescriptions.join(","),
		);
		const managerDescs = descriptionsFor(bus, "ledger-manager");
		const workerDescs = descriptionsFor(bus, "ledger-worker");
		check(
			"a mapped session model labels the manager passes in spawn order as plan, manage, review",
			managerDescs.join(" | ") ===
				[
					"ledger manager (cerebras/qwen-3.8-27b, plan)",
					"ledger manager (cerebras/qwen-3.8-27b, manage)",
					"ledger manager (cerebras/qwen-3.8-27b, review)",
				].join(" | "),
			managerDescs.join(" | "),
		);
		check(
			"a mapped session model labels the worker passes in spawn order as ideate, work",
			workerDescs.join(" | ") ===
				["ledger worker (local/qwen3.8-27b, ideate)", "ledger worker (local/qwen3.8-27b, work)"].join(" | "),
			workerDescs.join(" | "),
		);
		check(
			"the hand-off names the worker model",
			typeof r?.text === "string" && r.text.includes("Worker model: local/qwen3.8-27b"),
			r?.text?.slice(-400),
		);
		const row = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check("the audit row records the worker model", row?.workerModel === "local/qwen3.8-27b", row?.workerModel);
		check("the audit row records a null manager model", row?.managerModel === null, String(row?.managerModel));
	}

	// --- workerModel: a supplied plan drops the plan and ideate passes from the labeled spawn order ---
	{
		writeConfig({ gate: "true", maxIters: 4, workerModel: { "cerebras/qwen-3.8-27b": "local/qwen3.8-27b" } });
		const planFile = join(root, "supplied-order-plan.md");
		writeFileSync(planFile, "change the parser");
		const script: Step[] = [
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { tools, ctx, bus } = fresh(script, "code");
		await tools.ledger_solve.execute(
			"call-supplied-order",
			{ task: "fix the failing test", plan_file: planFile },
			undefined,
			undefined,
			ctx,
		);
		const managerDescs = descriptionsFor(bus, "ledger-manager");
		const workerDescs = descriptionsFor(bus, "ledger-worker");
		check(
			"a supplied plan labels the manager passes in spawn order as manage, review",
			managerDescs.join(" | ") ===
				["ledger manager (cerebras/qwen-3.8-27b, manage)", "ledger manager (cerebras/qwen-3.8-27b, review)"].join(
					" | ",
				),
			managerDescs.join(" | "),
		);
		check(
			"a supplied plan labels the worker passes as work only, with no ideate",
			workerDescs.join(" | ") === "ledger worker (local/qwen3.8-27b, work)",
			workerDescs.join(" | "),
		);
	}

	// --- workerModel: an unmapped session model runs every role on the session model ---
	{
		writeConfig({ gate: "true", maxIters: 4, workerModel: { "remote/qwen3.8-flash-next": "local/qwen3.8-27b" } });
		const { handlers, ctx, bus } = fresh(CONVERGE, "code");
		const r = await handlers.input(input("fix the failing test"), ctx);
		check(
			"an unmapped session model spawns every role with no model override",
			bus.spawned.length > 0 && bus.spawnedModels.every((m) => m === null),
			bus.spawnedModels.join(","),
		);
		check(
			"an unmapped session model labels every role with the session model",
			allLabelled(bus, "ledger-manager", "manager", "cerebras/qwen-3.8-27b") &&
				allLabelled(bus, "ledger-worker", "worker", "cerebras/qwen-3.8-27b"),
			bus.spawnedDescriptions.join(","),
		);
		check(
			"the hand-off says the worker ran on the session model",
			typeof r?.text === "string" && r.text.includes("Worker model: session model"),
			r?.text?.slice(-400),
		);
		const row = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check("the audit row records a null worker model", row?.workerModel === null, String(row?.workerModel));
	}

	// --- workerModel: a malformed value is dropped and the config stays active ---
	{
		writeConfig({
			gate: "true",
			maxIters: 4,
			workerModel: { "cerebras/qwen-3.8-27b": "no-slash", "remote/qwen3.8-flash-next": "local/qwen3.8-27b" },
		});
		const { cfg, errors } = loadCapturingErrors();
		check("a malformed workerModel value keeps the config active", cfg.enabled && inScope(cfg, "cerebras", "x"));
		check(
			"a malformed workerModel entry is reported once by name, not as an unknown key",
			errors.filter((e) => e.includes('malformed [workerModel] entry "cerebras/qwen-3.8-27b"')).length === 1 &&
				!errors.some((e) => e.includes("unknown config key")),
			errors.join(" | "),
		);
		check(
			"dropping a malformed workerModel entry keeps the valid ones",
			workerModelFor(cfg, "remote", "qwen3.8-flash-next") === "local/qwen3.8-27b" &&
				workerModelFor(cfg, "cerebras", "qwen-3.8-27b") === null,
		);
		writeConfig({ gate: "true", workerModel: "not-a-table" });
		const table = loadCapturingErrors();
		check(
			"a non-table workerModel is reported and leaves the config active",
			table.cfg.enabled && table.errors.some((e) => e.includes("malformed [workerModel];")),
			table.errors.join(" | "),
		);
		writeConfig({ gate: "true", maxIters: 4, workerModel: { "cerebras/qwen-3.8-27b": "no-slash" } });
		const { handlers, ctx, bus } = fresh(CONVERGE, "code");
		await handlers.input(input("fix the failing test"), ctx);
		check(
			"a malformed workerModel value runs the worker on the session model",
			bus.spawned.length > 0 && bus.spawnedModels.every((m) => m === null),
			bus.spawnedModels.join(","),
		);
	}

	// --- workerMaxTokens: a valid entry loads; absent is an empty map ---
	{
		writeConfig({ gate: "true", workerMaxTokens: { "local-router/qwen3.8-27b": 65536 } });
		const { cfg, errors } = loadCapturingErrors();
		check(
			"a workerMaxTokens entry loads with no warning and no unknown-key warning",
			cfg.enabled && cfg.workerMaxTokens["local-router/qwen3.8-27b"] === 65536 && errors.length === 0,
			errors.join(" | "),
		);
		writeConfig({ gate: "true" });
		const absent = loadCapturingErrors().cfg.workerMaxTokens;
		check(
			"an absent workerMaxTokens is an empty null-prototype map",
			Object.keys(absent).length === 0 && Object.getPrototypeOf(absent) === null,
		);
	}

	// --- workerMaxTokens: a malformed entry is dropped and the config stays active ---
	{
		const sibling = "local-router/qwen3.8-27b";
		const badEntries: Array<[string, unknown]> = [
			["no-slash", 4096],
			["cerebras/zero", 0],
			["cerebras/negative", -1],
			["cerebras/float", 1.5],
			["cerebras/string", "4096"],
		];
		for (const [key, value] of badEntries) {
			writeConfig({ gate: "true", workerMaxTokens: { [key]: value, [sibling]: 65536 } });
			const { cfg, errors } = loadCapturingErrors();
			check(
				`a workerMaxTokens entry "${key}" = ${JSON.stringify(value)} is dropped and reported once by name`,
				errors.filter((e) => e.includes(`malformed [workerMaxTokens] entry "${key}"`)).length === 1 &&
					!errors.some((e) => e.includes("unknown config key")) &&
					!(key in cfg.workerMaxTokens),
				errors.join(" | "),
			);
			check(
				`dropping workerMaxTokens "${key}" keeps the valid sibling and the config active`,
				cfg.enabled && cfg.workerMaxTokens[sibling] === 65536 && Object.keys(cfg.workerMaxTokens).length === 1,
				JSON.stringify(cfg.workerMaxTokens),
			);
		}
		writeConfig({ gate: "true", workerMaxTokens: "not-a-table" });
		const table = loadCapturingErrors();
		check(
			"a non-table workerMaxTokens is reported, yields an empty map and leaves the config active",
			table.cfg.enabled &&
				Object.keys(table.cfg.workerMaxTokens).length === 0 &&
				table.errors.some((e) => e.includes("malformed [workerMaxTokens];")),
			table.errors.join(" | "),
		);
	}

	// --- workerMaxTokens: worker spawns carry a capped copy of the registry model ---
	{
		const sessionRef = "cerebras/qwen-3.8-27b";
		const mappedRef = "local/qwen3.8-27b";
		const registryModel = (provider: string, id: string, contextWindow: number) => ({
			provider,
			id,
			name: id,
			api: "openai-completions",
			contextWindow,
			maxTokens: 32768,
		});
		const roleOptions = (bus: StubBus, type: string) =>
			bus.spawned.flatMap((t, i) => (t === type ? [bus.spawnedOptions[i] as Record<string, any>] : []));
		const noticesAbout = (notices: string[]) => notices.filter((n) => n.includes("[workerMaxTokens] entry"));

		writeConfig({ gate: "true", maxIters: 4, workerMaxTokens: { [sessionRef]: 65536 } });
		{
			const { handlers, ctx, bus, registryModels } = fresh(CONVERGE, "code");
			registryModels[sessionRef] = registryModel("cerebras", "qwen-3.8-27b", 200000);
			const before = JSON.stringify(registryModels[sessionRef]);
			await handlers.input(input("fix the failing test"), ctx);
			const workers = roleOptions(bus, "ledger-worker");
			const managers = roleOptions(bus, "ledger-manager");
			check(
				"a worker on the session model with an entry spawns on a copy with the capped maxTokens",
				workers.length > 0 && workers.every((o) => o.model?.maxTokens === 65536 && o.model?.id === "qwen-3.8-27b"),
				JSON.stringify(workers.map((o) => o.model)),
			);
			check(
				"the capped copy keeps the registry model's other fields",
				workers.every(
					(o) =>
						o.model?.provider === "cerebras" &&
						o.model?.contextWindow === 200000 &&
						o.model?.api === "openai-completions",
				),
			);
			check(
				"capping a worker leaves the registry model unmodified",
				JSON.stringify(registryModels[sessionRef]) === before && registryModels[sessionRef].maxTokens === 32768,
			);
			check(
				"a manager on the capped session model still spawns with no model override",
				managers.length > 0 && managers.every((o) => o.model === null),
				JSON.stringify(managers.map((o) => o.model)),
			);
			check(
				"maxOutputTokens is never forwarded in the spawn payload",
				bus.spawnedOptions.length > 0 && bus.spawnedOptions.every((o) => !("maxOutputTokens" in o)),
			);
		}

		writeConfig({
			gate: "true",
			maxIters: 4,
			workerModel: { [sessionRef]: mappedRef },
			workerMaxTokens: { [mappedRef]: 4096 },
		});
		{
			const { handlers, ctx, bus, registryModels } = fresh(CONVERGE, "code");
			registryModels[mappedRef] = registryModel("local", "qwen3.8-27b", 200000);
			await handlers.input(input("fix the failing test"), ctx);
			const workers = roleOptions(bus, "ledger-worker");
			check(
				"a worker pinned to a mapped model is capped by the mapped model's entry",
				workers.length > 0 && workers.every((o) => o.model?.maxTokens === 4096 && o.model?.id === "qwen3.8-27b"),
				JSON.stringify(workers.map((o) => o.model)),
			);
			check(
				"a manager is not capped by the mapped model's entry",
				roleOptions(bus, "ledger-manager").every((o) => o.model === null),
			);
		}

		writeConfig({ gate: "true", maxIters: 4, workerMaxTokens: { [mappedRef]: 4096 } });
		{
			const { handlers, ctx, bus, notices, registryModels } = fresh(CONVERGE, "code", {}, { hasUI: true });
			registryModels[sessionRef] = registryModel("cerebras", "qwen-3.8-27b", 200000);
			await handlers.input(input("fix the failing test"), ctx);
			check(
				"a worker whose model has no entry spawns exactly as before, with no model override",
				bus.spawned.length > 0 && bus.spawnedModels.every((m) => m === null),
				JSON.stringify(bus.spawnedModels),
			);
			check("a worker with no entry produces no workerMaxTokens warning", noticesAbout(notices).length === 0);
		}

		writeConfig({ gate: "true", maxIters: 4, workerMaxTokens: { [sessionRef]: 65536 } });
		{
			const { handlers, ctx, bus, notices } = fresh(CONVERGE, "code", {}, { hasUI: true });
			await handlers.input(input("fix the failing test"), ctx);
			const about = noticesAbout(notices);
			check(
				"a capped model the registry does not know spawns every role unchanged",
				bus.spawned.length > 0 && bus.spawnedModels.every((m) => m === null),
				JSON.stringify(bus.spawnedModels),
			);
			check(
				"an unknown capped model warns once, naming the ref",
				about.length === 1 && about[0].includes(`"${sessionRef}"`) && about[0].includes("does not know"),
				about.join(" | "),
			);
		}

		{
			const { handlers, ctx, bus, notices, registryModels } = fresh(CONVERGE, "code", {}, { hasUI: true });
			registryModels[sessionRef] = registryModel("cerebras", "qwen-3.8-27b", 32768);
			await handlers.input(input("fix the failing test"), ctx);
			const about = noticesAbout(notices);
			const workers = roleOptions(bus, "ledger-worker");
			check(
				"a cap at or above the context window warns once, naming the ref and window",
				about.length === 1 && about[0].includes(`"${sessionRef}"`) && about[0].includes("context window (32768)"),
				about.join(" | "),
			);
			check(
				"a cap at or above the context window is still applied",
				workers.length > 0 && workers.every((o) => o.model?.maxTokens === 65536),
				JSON.stringify(workers.map((o) => o.model)),
			);
		}
	}

	// --- roleModel: a pinned entry spawns both roles on the pinned models ---
	{
		writeConfig({
			gate: "true",
			maxIters: 4,
			roleModel: { "cerebras/qwen-3.8-27b": { manager: "local/qwen3.8-m", worker: "local/qwen3.8-w" } },
		});
		const { handlers, ctx, bus } = fresh(CONVERGE, "code");
		const r = await handlers.input(input("fix the failing test"), ctx);
		const managerModels = bus.spawned.flatMap((t, i) => (t === "ledger-manager" ? [bus.spawnedModels[i]] : []));
		const workerModels = bus.spawned.flatMap((t, i) => (t === "ledger-worker" ? [bus.spawnedModels[i]] : []));
		check(
			"a pinned [roleModel] entry spawns every manager on the pinned manager model",
			managerModels.length > 0 && managerModels.every((m) => m === "local/qwen3.8-m"),
			managerModels.join(","),
		);
		check(
			"a pinned [roleModel] entry spawns every worker on the pinned worker model",
			workerModels.length > 0 && workerModels.every((m) => m === "local/qwen3.8-w"),
			workerModels.join(","),
		);
		check(
			"a pinned [roleModel] entry labels each role with its own model",
			allLabelled(bus, "ledger-manager", "manager", "local/qwen3.8-m") &&
				allLabelled(bus, "ledger-worker", "worker", "local/qwen3.8-w"),
			bus.spawnedDescriptions.join(","),
		);
		const row = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check(
			"the audit row records the pinned manager model",
			row?.managerModel === "local/qwen3.8-m",
			row?.managerModel,
		);
		check("the audit row records the pinned worker model", row?.workerModel === "local/qwen3.8-w", row?.workerModel);
		check(
			"the hand-off names the pinned manager model",
			typeof r?.text === "string" && r.text.includes("Manager model: local/qwen3.8-m"),
			r?.text?.slice(-400),
		);
		check(
			"the hand-off names the pinned worker model",
			typeof r?.text === "string" && r.text.includes("Worker model: local/qwen3.8-w"),
			r?.text?.slice(-400),
		);
	}

	// --- roleModel: a model absent from the table keeps its [workerModel] alias ---
	{
		writeConfig({
			gate: "true",
			maxIters: 4,
			roleModel: {
				"remote/qwen3.8-flash-next": { manager: "local/qwen3.8-m", worker: "local/qwen3.8-w" },
				default: { manager: "local/qwen3.8-dm", worker: "local/qwen3.8-dw" },
			},
			workerModel: { "cerebras/qwen-3.8-27b": "local/qwen3.8-27b" },
		});
		const { handlers, ctx, bus } = fresh(CONVERGE, "code");
		const r = await handlers.input(input("fix the failing test"), ctx);
		const managerModels = bus.spawned.flatMap((t, i) => (t === "ledger-manager" ? [bus.spawnedModels[i]] : []));
		const workerModels = bus.spawned.flatMap((t, i) => (t === "ledger-worker" ? [bus.spawnedModels[i]] : []));
		check(
			"a [workerModel] alias under a present [roleModel] keeps the manager on the session model",
			managerModels.length > 0 && managerModels.every((m) => m === null),
			managerModels.join(","),
		);
		check(
			"a [workerModel] alias under a present [roleModel] spawns every worker on the aliased model",
			workerModels.length > 0 && workerModels.every((m) => m === "local/qwen3.8-27b"),
			workerModels.join(","),
		);
		check(
			"a [workerModel] alias under a present [roleModel] labels each role with its own model",
			allLabelled(bus, "ledger-manager", "manager", "cerebras/qwen-3.8-27b") &&
				allLabelled(bus, "ledger-worker", "worker", "local/qwen3.8-27b"),
			bus.spawnedDescriptions.join(","),
		);
		const row = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check(
			"the audit row records a null manager model under the alias",
			row?.managerModel === null,
			String(row?.managerModel),
		);
		check(
			"the audit row records the aliased worker model",
			row?.workerModel === "local/qwen3.8-27b",
			row?.workerModel,
		);
		check(
			"the hand-off says the aliased run left the manager on the session model",
			typeof r?.text === "string" && r.text.includes("Manager model: session model"),
			r?.text?.slice(-400),
		);
		const aliased = roleModelsFor(loadConfig(), "cerebras", "qwen-3.8-27b");
		check(
			"a [workerModel] alias under a present [roleModel] wins over the default for both roles",
			aliased?.manager === null && aliased?.worker === "local/qwen3.8-27b" && aliased?.source === "workerModel",
			JSON.stringify(aliased),
		);
	}

	// --- roleModel: the [roleModel] table parses -- absent is null, present pins both roles ---
	{
		writeConfig({ gate: "true" });
		const absent = loadConfig();
		check(
			"an absent [roleModel] leaves roleModel null and nothing malformed",
			absent.roleModel === null && absent.roleModelMalformed.length === 0,
			JSON.stringify({ roleModel: absent.roleModel, malformed: absent.roleModelMalformed }),
		);
		check(
			"an absent [roleModel] keeps today's scope behavior",
			inScope(absent, "cerebras", "qwen-3.8-27b") === true && inScope(absent, "openai", "m") === false,
		);

		writeConfig({ gate: "true", roleModel: {} });
		const empty = loadConfig();
		check(
			"a present empty [roleModel] is a non-null record with no entries",
			empty.roleModel !== null && Object.keys(empty.roleModel).length === 0 && empty.roleModelMalformed.length === 0,
		);

		writeConfig({
			gate: "true",
			roleModel: {
				"cerebras/qwen-3.8-27b": { manager: "local/qwen3.8-27b", worker: "local/qwen3.8-27b" },
			},
		});
		const pinned = loadConfig();
		check(
			"a valid [roleModel] entry pins both roles",
			pinned.roleModel?.["cerebras/qwen-3.8-27b"] !== undefined &&
				pinned.roleModel!["cerebras/qwen-3.8-27b"].manager === "local/qwen3.8-27b" &&
				pinned.roleModel!["cerebras/qwen-3.8-27b"].worker === "local/qwen3.8-27b",
			JSON.stringify(pinned.roleModel),
		);
	}

	// --- roleModel: malformed shapes drop the entry, keep the config active ---
	{
		writeConfig({
			gate: "true",
			providers: ["cerebras", "remote"],
			roleModel: {
				"cerebras/qwen-3.8-27b": { manager: "local/qwen3.8-27b" },
				"cerebras/only-worker": { worker: "local/qwen3.8-27b" },
				"cerebras/bad-manager": { manager: "no-slash", worker: "local/qwen3.8-27b" },
				"cerebras/bad-worker": { manager: "local/qwen3.8-27b", worker: "no-slash" },
				"cerebras/nonstring": { manager: 7, worker: "local/qwen3.8-27b" },
				"no-slash-key": { manager: "local/qwen3.8-27b", worker: "local/qwen3.8-27b" },
				"cerebras/non-table": "not-a-table",
				"remote/qwen3.8-flash-next": { manager: "local/qwen3.8-27b", worker: "local/qwen3.8-27b" },
			},
		});
		const { cfg: mixed, errors } = loadCapturingErrors();
		check(
			"malformed [roleModel] entries are dropped and the valid one is kept",
			mixed.enabled === true &&
				Object.keys(mixed.roleModel ?? {}).length === 1 &&
				mixed.roleModel?.["remote/qwen3.8-flash-next"] !== undefined,
			JSON.stringify(mixed.roleModel),
		);
		check(
			"every dropped [roleModel] entry is named in roleModelMalformed",
			JSON.stringify([...mixed.roleModelMalformed].sort()) ===
				JSON.stringify(
					[
						"cerebras/bad-manager",
						"cerebras/bad-worker",
						"cerebras/non-table",
						"cerebras/nonstring",
						"cerebras/only-worker",
						"cerebras/qwen-3.8-27b",
						"no-slash-key",
					].sort(),
				),
			JSON.stringify(mixed.roleModelMalformed),
		);
		check(
			"each dropped [roleModel] entry warns once, naming the key and the expected shape",
			[
				"cerebras/qwen-3.8-27b",
				"cerebras/only-worker",
				"cerebras/bad-manager",
				"cerebras/bad-worker",
				"cerebras/nonstring",
				"no-slash-key",
				"cerebras/non-table",
			].every(
				(k) =>
					errors.filter(
						(e) =>
							e.includes(`malformed [roleModel] entry "${k}"`) &&
							e.includes('manager = "provider/modelId", worker = "provider/modelId"'),
					).length === 1,
			),
			errors.join(" | "),
		);
		check(
			"the dropped-entry warning says the session model stays inactive",
			errors.some((e) => e.includes("this session model stays inactive")),
			errors.join(" | "),
		);
		check(
			"dropping malformed [roleModel] entries keeps the config active",
			mixed.enabled === true &&
				inScope(mixed, "remote", "qwen3.8-flash-next") === true &&
				scopeReason(mixed, "remote", "qwen3.8-flash-next") === "in-scope" &&
				inScope(mixed, "cerebras", "x") === false,
		);

		writeConfig({
			gate: "true",
			roleModel: {
				"cerebras/qwen-3.8-27b": { manager: "local/qwen3.8-27b", worker: "local/qwen3.8-27b", extra: "x" },
			},
		});
		const sub = loadCapturingErrors();
		check(
			"an unknown sub-key warns and is ignored, keeping the entry",
			sub.cfg.roleModel?.["cerebras/qwen-3.8-27b"] !== undefined &&
				sub.errors.some((e) =>
					e.includes('unknown sub-key "extra" in [roleModel] entry "cerebras/qwen-3.8-27b"'),
				) &&
				sub.cfg.roleModelMalformed.length === 0,
			JSON.stringify({ roleModel: sub.cfg.roleModel, errors: sub.errors }),
		);

		writeConfig({ gate: "true", roleModel: "not-a-table" });
		const notable = loadCapturingErrors();
		check(
			"a non-table [roleModel] fails closed to an empty table, warning that no model is opted in",
			notable.cfg.enabled === true &&
				notable.cfg.roleModel !== null &&
				Object.keys(notable.cfg.roleModel).length === 0 &&
				notable.errors.some((e) => e.includes("malformed [roleModel]; no session model is opted in")),
			notable.errors.join(" | "),
		);

		writeFileSync(
			configFile,
			stringifyToml({ providers: ["cerebras"], roleModel: new Date("1979-05-27T07:32:00Z") }),
		);
		const dateRole = loadCapturingErrors();
		check(
			"a datetime [roleModel] fails closed to an empty table instead of a valid one",
			dateRole.cfg.enabled === true &&
				dateRole.cfg.roleModel !== null &&
				Object.keys(dateRole.cfg.roleModel).length === 0,
			dateRole.errors.join(" | "),
		);

		writeConfig({ gate: "true", workerModel: { "cerebras/qwen-3.8-27b": "local/qwen3.8-27b" } });
		const dep = loadCapturingErrors();
		check(
			"a present [workerModel] key warns once that it is deprecated",
			dep.errors.filter((e) => e.includes("[workerModel] is deprecated and will be removed in a later release"))
				.length === 1,
			dep.errors.join(" | "),
		);

		writeConfig({
			gate: "true",
			roleModel: {
				"cerebras/qwen-3.8-27b": { manager: "local/qwen3.8-27b", worker: "local/qwen3.8-27b" },
			},
			workerModel: { "cerebras/qwen-3.8-27b": "openai/other" },
		});
		const both = loadCapturingErrors();
		check(
			"a key in both tables warns that [roleModel] wins, with the deprecation warning too",
			both.errors.filter((e) => e.includes("in both [workerModel] and [roleModel]; [roleModel] wins")).length ===
				1 && both.errors.some((e) => e.includes("[workerModel] is deprecated")),
			both.errors.join(" | "),
		);

		writeConfig({
			gate: "true",
			roleModel: { "cerebras/qwen-3.8-27b": { worker: "local/qwen3.8-27b" } },
			workerModel: { "cerebras/qwen-3.8-27b": "local/qwen3.8-27b" },
		});
		const bothDropped = loadCapturingErrors();
		check(
			"a dropped [roleModel] entry with a valid alias warns that the alias keeps the model active",
			bothDropped.errors.some((e) =>
				e.includes("the deprecated [workerModel] alias keeps this session model active"),
			) &&
				!bothDropped.errors.some((e) => e.includes("in both [workerModel] and [roleModel]")) &&
				bothDropped.cfg.roleModelMalformed.includes("cerebras/qwen-3.8-27b"),
			bothDropped.errors.join(" | "),
		);
	}

	// --- roleModel default: the reserved fallback re-widens activation and pins roles ---
	{
		// The inline spelling users write. `writeConfig` emits the `[roleModel.default]`
		// sub-table instead, so this one case needs a raw config string.
		writeFileSync(
			configFile,
			[
				'providers = ["cerebras"]',
				`stateDir = "${join(root, "state")}"`,
				'trigger = "auto"',
				'gate = "true"',
				"maxIters = 4",
				"",
				"[roleModel]",
				'default = { worker = "local/qwen3.8-w" }',
				"",
			].join("\n"),
		);
		const inline = loadConfig();
		check(
			"an inline [roleModel] default re-widens activation to an allowlisted model no entry names",
			scopeReason(inline, "cerebras", "qwen-3.8-27b") === "in-scope",
			scopeReason(inline, "cerebras", "qwen-3.8-27b"),
		);
		const inlineRoles = roleModelsFor(inline, "cerebras", "qwen-3.8-27b");
		check(
			"the inline default pins the worker and leaves the manager on the session model",
			inlineRoles?.manager === null &&
				inlineRoles?.worker === "local/qwen3.8-w" &&
				inlineRoles?.source === "roleModelDefault",
			JSON.stringify(inlineRoles),
		);

		const { handlers, ctx, bus } = fresh(CONVERGE, "code");
		await handlers.input(input("fix the failing test"), ctx);
		const managerModels = bus.spawned.flatMap((t, i) => (t === "ledger-manager" ? [bus.spawnedModels[i]] : []));
		const workerModels = bus.spawned.flatMap((t, i) => (t === "ledger-worker" ? [bus.spawnedModels[i]] : []));
		check(
			"the default activates the run and spawns every worker on the pinned model",
			workerModels.length > 0 && workerModels.every((m) => m === "local/qwen3.8-w"),
			workerModels.join(","),
		);
		check(
			"the default leaves every manager on the session model",
			managerModels.length > 0 && managerModels.every((m) => m === null),
			managerModels.join(","),
		);
		check(
			"the default labels each role with its own model",
			allLabelled(bus, "ledger-manager", "manager", "cerebras/qwen-3.8-27b") &&
				allLabelled(bus, "ledger-worker", "worker", "local/qwen3.8-w"),
			bus.spawnedDescriptions.join(","),
		);
		const row = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check(
			"the audit row records the default-pinned worker with a null manager",
			row?.managerModel === null && row?.workerModel === "local/qwen3.8-w",
			JSON.stringify({ managerModel: row?.managerModel, workerModel: row?.workerModel }),
		);
	}

	// --- roleModel default: an exact named entry wins over the default for both roles ---
	{
		writeConfig({
			gate: "true",
			roleModel: {
				"cerebras/qwen-3.8-27b": { manager: "local/qwen3.8-m", worker: "local/qwen3.8-w" },
				default: { manager: "local/qwen3.8-dm", worker: "local/qwen3.8-dw" },
			},
		});
		const named = loadConfig();
		const namedRoles = roleModelsFor(named, "cerebras", "qwen-3.8-27b");
		check(
			"an exact [roleModel] entry wins over the default for both roles",
			namedRoles?.manager === "local/qwen3.8-m" &&
				namedRoles?.worker === "local/qwen3.8-w" &&
				namedRoles?.source === "roleModel",
			JSON.stringify(namedRoles),
		);
		check(
			"the [roleModel.default] sub-table spelling parses like the inline form",
			named.roleModelDefault?.manager === "local/qwen3.8-dm" &&
				named.roleModelDefault?.worker === "local/qwen3.8-dw",
			JSON.stringify(named.roleModelDefault),
		);
	}

	// --- roleModel default: a manager-only default leaves the worker on the session model ---
	{
		writeConfig({ gate: "true", maxIters: 4, roleModel: { default: { manager: "local/qwen3.8-dm" } } });
		const managerOnly = roleModelsFor(loadConfig(), "cerebras", "qwen-3.8-27b");
		check(
			"a manager-only default pins the manager and leaves the worker on the session model",
			managerOnly?.manager === "local/qwen3.8-dm" &&
				managerOnly?.worker === null &&
				managerOnly?.source === "roleModelDefault",
			JSON.stringify(managerOnly),
		);

		const { handlers, ctx, bus } = fresh(CONVERGE, "code");
		await handlers.input(input("fix the failing test"), ctx);
		const managerModels = bus.spawned.flatMap((t, i) => (t === "ledger-manager" ? [bus.spawnedModels[i]] : []));
		const workerModels = bus.spawned.flatMap((t, i) => (t === "ledger-worker" ? [bus.spawnedModels[i]] : []));
		check(
			"a manager-only default spawns the manager on its pin and every worker on the session model",
			managerModels.length > 0 &&
				managerModels.every((m) => m === "local/qwen3.8-dm") &&
				workerModels.length > 0 &&
				workerModels.every((m) => m === null),
			`${managerModels.join(",")} | ${workerModels.join(",")}`,
		);
		const row = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check(
			"the audit row records the manager-only default's pin and a null worker",
			row?.managerModel === "local/qwen3.8-dm" && row?.workerModel === null,
			JSON.stringify({ managerModel: row?.managerModel, workerModel: row?.workerModel }),
		);
	}

	// --- roleModel default: a default-only table re-widens activation for real ---
	{
		writeConfig({ gate: "true", roleModel: { default: { worker: "local/qwen3.8-w" } } });
		const defaultOnly = loadConfig();
		check(
			"a default-only [roleModel] table opts an allowlisted model in",
			defaultOnly.roleModel !== null &&
				Object.keys(defaultOnly.roleModel).length === 0 &&
				inScope(defaultOnly, "cerebras", "qwen-3.8-27b") === true,
			JSON.stringify(defaultOnly.roleModel),
		);

		writeConfig({ gate: "true", roleModel: {} });
		const withoutDefault = loadConfig();
		check(
			"the same table without the default opts the model out",
			inScope(withoutDefault, "cerebras", "qwen-3.8-27b") === false &&
				scopeReason(withoutDefault, "cerebras", "qwen-3.8-27b") === "no-role-entry",
		);

		// The re-widening reaches every allowlisted model, not every model: the provider
		// and allowlist gates still run ahead of the default branch.
		writeConfig({
			gate: "true",
			allowlist: { cerebras: ["m-x"] },
			roleModel: { default: { worker: "local/qwen3.8-w" } },
		});
		const gatedDefault = loadConfig();
		check(
			"the default does not bypass the allowlist gate",
			inScope(gatedDefault, "cerebras", "m-y") === false &&
				scopeReason(gatedDefault, "cerebras", "m-y") === "not-allowlisted",
			scopeReason(gatedDefault, "cerebras", "m-y"),
		);
		check(
			"the default does not bypass the provider gate",
			inScope(gatedDefault, "openai", "m-y") === false &&
				scopeReason(gatedDefault, "openai", "m-y") === "out-of-scope",
			scopeReason(gatedDefault, "openai", "m-y"),
		);
	}

	// --- roleModel default: a malformed default warns once, is dropped, and changes nothing else ---
	{
		for (const bad of [{ manager: "no-slash" }, {}, "not-a-table"]) {
			writeConfig({
				gate: "true",
				roleModel: {
					"cerebras/qwen-3.8-27b": { manager: "local/qwen3.8-m", worker: "local/qwen3.8-w" },
					default: bad,
				},
			});
			const malformed = loadCapturingErrors();
			const label = JSON.stringify(bad);
			check(
				`a malformed default ${label} is dropped, warned about once by name, and keeps the config active`,
				malformed.cfg.roleModelDefault === null &&
					malformed.cfg.enabled === true &&
					malformed.cfg.roleModelMalformed.length === 0 &&
					malformed.errors.filter((e) => e.includes("malformed [roleModel] default")).length === 1,
				malformed.errors.join(" | "),
			);
			check(
				`a malformed default ${label} leaves the named entries working`,
				roleModelsFor(malformed.cfg, "cerebras", "qwen-3.8-27b")?.source === "roleModel" &&
					scopeReason(malformed.cfg, "cerebras", "qwen-3.8-27b") === "in-scope",
			);
			check(
				`a malformed default ${label} leaves a model no entry names out of scope`,
				scopeReason(malformed.cfg, "cerebras", "other-model") === "no-role-entry" &&
					roleModelsFor(malformed.cfg, "cerebras", "other-model") === null,
				scopeReason(malformed.cfg, "cerebras", "other-model"),
			);
			check(
				`a malformed default ${label} says the named entries still apply when one survived`,
				malformed.errors.some(
					(e) =>
						e.includes("malformed [roleModel] default") && e.includes("named [roleModel] entries still apply"),
				),
				malformed.errors.join(" | "),
			);
		}

		// A default-only table has no named entry to fall back to, so the same warning
		// must not promise that named entries still apply.
		writeConfig({ gate: "true", roleModel: { default: { manager: "no-slash" } } });
		const defaultOnlyMalformed = loadCapturingErrors();
		check(
			"a malformed default in a default-only table states that nothing is opted in",
			defaultOnlyMalformed.cfg.roleModelDefault === null &&
				defaultOnlyMalformed.errors.some(
					(e) =>
						e.includes("malformed [roleModel] default") &&
						e.includes("no [roleModel] entry names a session model, so none is opted in") &&
						!e.includes("named [roleModel] entries still apply"),
				) &&
				scopeReason(defaultOnlyMalformed.cfg, "cerebras", "qwen-3.8-27b") === "no-role-entry",
			defaultOnlyMalformed.errors.join(" | "),
		);

		// A [workerModel] alias still opts its own models in, so the warning must not
		// claim that nothing is.
		writeConfig({
			gate: "true",
			roleModel: { default: { manager: "no-slash" } },
			workerModel: { "cerebras/qwen-3.8-27b": "local/alias-w" },
		});
		const aliasOnlyMalformed = loadCapturingErrors();
		check(
			"a malformed default in an alias-only table says the aliases still opt a model in",
			aliasOnlyMalformed.cfg.roleModelDefault === null &&
				aliasOnlyMalformed.errors.some(
					(e) =>
						e.includes("malformed [roleModel] default") &&
						e.includes("only the [workerModel] aliases opt a model in") &&
						!e.includes("so none is opted in"),
				) &&
				roleModelsFor(aliasOnlyMalformed.cfg, "cerebras", "qwen-3.8-27b")?.source === "workerModel",
			aliasOnlyMalformed.errors.join(" | "),
		);

		// A stray sub-key is reported and ignored; the default itself still applies.
		writeConfig({
			gate: "true",
			roleModel: { default: { worker: "local/qwen3.8-w", extra: "x" } },
		});
		const straySubKey = loadCapturingErrors();
		check(
			"an unknown sub-key in the default is reported and the default still pins its roles",
			straySubKey.cfg.roleModelDefault?.worker === "local/qwen3.8-w" &&
				straySubKey.errors.some((e) => e.includes('unknown sub-key "extra"') && e.includes("[roleModel] default")),
			straySubKey.errors.join(" | "),
		);

		writeConfig({
			gate: "true",
			roleModel: { "remote/other": { manager: "remote/m", worker: "remote/w" }, default: { manager: "no-slash" } },
		});
		const { tools, ctx, bus } = fresh([], "code");
		const r = await tools.ledger_solve.execute("call-bad-default", { task: "do it" }, undefined, undefined, ctx);
		const out = r?.content?.[0]?.text ?? "";
		check(
			"ledger_solve punts again when the default is malformed",
			out.includes(
				"no [roleModel] entry and no [roleModel].default for cerebras/qwen-3.8-27b; the model is inactive.",
			),
			out.slice(0, 90),
		);
		check(
			"ledger_solve did not spawn for a model a malformed default leaves uncovered",
			bus.spawned.length === 0,
			bus.spawned.join(","),
		);
	}

	// --- redirect under trigger=ask: Run blocks the edit, asked once per armed run ---
	{
		writeConfig({ gate: "true", trigger: "ask", autoTrigger: "redirect", redirectSkills: ["*"] });
		const { handlers, ctx, selects } = fresh([], "code", {}, { hasUI: true, selectReply: "Run ledger loop" });
		await handlers.before_agent_start(beforeAgentStart("implement the claimed item"), ctx);
		const b1 = await handlers.tool_call(editCall(), ctx);
		const b2 = await handlers.tool_call(editCall(), ctx);
		check("redirect + ask + Run blocks the first edit", b1?.block === true, JSON.stringify(b1)?.slice(0, 80));
		check("redirect + ask + Run keeps blocking without re-asking", b2?.block === true && selects.length === 1);
	}

	// --- redirect under trigger=ask: Skip lets the edit through and disarms ---
	{
		writeConfig({ gate: "true", trigger: "ask", autoTrigger: "redirect", redirectSkills: ["*"] });
		const { handlers, ctx, selects } = fresh([], "code", {}, { hasUI: true, selectReply: "Skip (this prompt)" });
		await handlers.before_agent_start(beforeAgentStart("implement the claimed item"), ctx);
		const r1 = await handlers.tool_call(editCall(), ctx);
		const r2 = await handlers.tool_call(writeCall(), ctx);
		check("redirect + ask + Skip allows the edit", r1 === undefined, JSON.stringify(r1)?.slice(0, 80));
		check("redirect + ask + Skip disarms for the run", r2 === undefined && selects.length === 1);
		const row = readAudit()
			.filter((x) => x.event === "passthrough")
			.at(-1);
		check(
			"a redirect decline is audited as entry=redirect reason=declined",
			row?.entry === "redirect" && row?.reason === "declined",
			JSON.stringify(row),
		);
	}

	// --- redirect under trigger=ask: Skip for this session also silences the input hook ---
	{
		writeConfig({ gate: "true", trigger: "ask", autoTrigger: "redirect", redirectSkills: ["*"] });
		const { handlers, ctx, bus, selects } = fresh(
			CONVERGE,
			"code",
			{},
			{ hasUI: true, selectReply: "Skip for this session" },
		);
		await handlers.before_agent_start(beforeAgentStart("implement the claimed item"), ctx);
		const r1 = await handlers.tool_call(editCall(), ctx);
		handlers.agent_end({}, ctx);
		await handlers.before_agent_start(beforeAgentStart("implement the next item"), ctx);
		const r2 = await handlers.tool_call(editCall(), ctx);
		await handlers.input(input("fix the failing test"), ctx);
		check(
			"redirect Skip for this session allows edits and never asks again",
			r1 === undefined && r2 === undefined && selects.length === 1 && bus.spawned.length === 0,
			`selects=${selects.length} spawned=${bus.spawned.length}`,
		);
	}

	// --- redirect under trigger=ask: a failed dialog falls back to the inline edit ---
	{
		writeConfig({ gate: "true", trigger: "ask", autoTrigger: "redirect", redirectSkills: ["*"] });
		const { handlers, ctx } = fresh([], "code", {}, { hasUI: true, selectThrows: true });
		await handlers.before_agent_start(beforeAgentStart("implement the claimed item"), ctx);
		const r = await handlers.tool_call(editCall(), ctx);
		check("a failed redirect dialog allows the edit", r === undefined, JSON.stringify(r)?.slice(0, 80));
	}

	// --- redirect under trigger=auto: blocks without asking ---
	{
		writeConfig({ gate: "true", trigger: "auto", autoTrigger: "redirect", redirectSkills: ["*"] });
		const { handlers, ctx, selects } = fresh([], "code", {}, { hasUI: true, selectReply: "Skip (this prompt)" });
		await handlers.before_agent_start(beforeAgentStart("implement the claimed item"), ctx);
		const r = await handlers.tool_call(editCall(), ctx);
		check("redirect + auto blocks without a dialog", r?.block === true && selects.length === 0);
	}

	// --- trigger=ask: no UI passes through without asking or classifying ---
	{
		writeConfig({ gate: "true", trigger: "ask" });
		const { handlers, ctx, bus, selects, classifierCalls } = fresh(CONVERGE, "code");
		const before = readAudit().length;
		const r = await handlers.input(input("fix the failing test"), ctx);
		check(
			"trigger=ask with no UI passes through untouched",
			r === undefined && bus.spawned.length === 0 && selects.length === 0 && classifierCalls() === 0,
			`spawned=${bus.spawned.length} selects=${selects.length} classify=${classifierCalls()}`,
		);
		check("trigger=ask with no UI writes no audit row", readAudit().length === before);
	}

	// --- trigger=ask: a chat verdict never shows the dialog ---
	{
		writeConfig({ gate: "true", trigger: "ask" });
		const { handlers, ctx, selects } = fresh([], "chat", {}, { hasUI: true, selectReply: "Run ledger loop" });
		await handlers.input(input("what does this function do?"), ctx);
		check("trigger=ask does not ask on a chat verdict", selects.length === 0, String(selects.length));
	}

	// --- trigger=ask with the classifier off: asks, and a decline records no classifier call ---
	{
		writeConfig({ gate: "true", trigger: "ask", classifier: false });
		const { handlers, ctx, selects } = fresh([], "code", {}, { hasUI: true, selectReply: "Skip (this prompt)" });
		await handlers.input(input("fix the failing test"), ctx);
		const row = readAudit()
			.filter((x) => x.event === "passthrough")
			.at(-1);
		check(
			"classifier-off decline is audited with classified=null and no calls",
			selects.length === 1 && row?.reason === "declined" && row.classified === null && row.calls === 0,
			JSON.stringify(row),
		);
	}

	// --- trigger=manual: the input hook never classifies or runs ---
	{
		writeConfig({ gate: "true", trigger: "manual" });
		const { handlers, ctx, bus, selects, classifierCalls } = fresh(
			CONVERGE,
			"code",
			{},
			{ hasUI: true, selectReply: "Run ledger loop" },
		);
		const r = await handlers.input(input("fix the failing test"), ctx);
		check(
			"trigger=manual passes through with no classifier call, dialog, or spawn",
			r === undefined && classifierCalls() === 0 && selects.length === 0 && bus.spawned.length === 0,
			`classify=${classifierCalls()} selects=${selects.length} spawned=${bus.spawned.length}`,
		);
	}

	// --- a prompt the trigger keeps out of the loop never arms the edit redirect either ---
	for (const [label, trigger, ui] of [
		["trigger=manual", "manual", { hasUI: true }],
		["trigger=ask with no UI", "ask", {}],
		["trigger=ask + Skip", "ask", { hasUI: true, selectReply: "Skip (this prompt)" }],
	] as const) {
		writeConfig({ gate: "true", trigger, autoTrigger: "redirect", redirectSkills: ["*"] });
		const { handlers, ctx, bus } = fresh(CONVERGE, "code", {}, ui);
		await handlers.input(input("fix the failing test"), ctx);
		await handlers.before_agent_start(beforeAgentStart("fix the failing test"), ctx);
		const after = await handlers.tool_call(editCall(), ctx);
		check(
			`${label}: a wildcard redirect does not pull the declined prompt into the loop`,
			after === undefined && bus.spawned.length === 0,
			JSON.stringify(after)?.slice(0, 80),
		);
	}

	// --- /ledger: runs the loop on an explicit task and hands the result to the session ---
	{
		writeConfig({ gate: "true", maxIters: 4, trigger: "manual" });
		const { commands, ctx, bus, sent, classifierCalls, selects } = fresh(CONVERGE, "code", {}, { hasUI: true });
		check("/ledger command is registered", typeof commands.ledger?.handler === "function");
		await commands.ledger.handler("fix the failing test", ctx);
		check("/ledger spawns the loop", bus.spawned.includes("ledger-manager"), bus.spawned.join(","));
		check("/ledger skips the classifier and the dialog", classifierCalls() === 0 && selects.length === 0);
		check(
			"/ledger sends the task plus the hand-off block once",
			sent.length === 1 && sent[0].startsWith("fix the failing test") && sent[0].includes("<ledgerpi-result>"),
			JSON.stringify(sent).slice(0, 120),
		);
		const row = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check(
			"/ledger run is audited with entry=command",
			row?.entry === "command" && row.classified === null && row.converged === true,
			JSON.stringify(row),
		);
	}

	// --- /ledger: the hand-off turn never arms a wildcard edit redirect ---
	{
		writeConfig({ gate: "true", maxIters: 4, trigger: "manual", autoTrigger: "redirect", redirectSkills: ["*"] });
		const { commands, handlers, ctx, bus, sent } = fresh(CONVERGE, "code", {}, { hasUI: true });
		await commands.ledger.handler("fix the failing test", ctx);
		const spawnCount = bus.spawned.length;
		await handlers.input(input(sent[0] ?? "", { source: "extension" }), ctx);
		await handlers.before_agent_start(beforeAgentStart(sent[0] ?? ""), ctx);
		const after = await handlers.tool_call(editCall(), ctx);
		check(
			"/ledger hand-off turn is not redirected back into the loop",
			sent.length === 1 && after === undefined && bus.spawned.length === spawnCount,
			JSON.stringify(after)?.slice(0, 80),
		);
	}

	// --- /ledger: a turn that started during the loop is waited out before the hand-off ---
	{
		writeConfig({ gate: "true", maxIters: 4, trigger: "manual" });
		const { commands, ctx, sent } = fresh(CONVERGE, "code", {}, { hasUI: true });
		const order: string[] = [];
		let idleChecks = 0;
		ctx.isIdle = () => idleChecks++ === 0;
		(ctx as any).waitForIdle = async () => {
			order.push(`waited:sent=${sent.length}`);
		};
		await commands.ledger.handler("fix the failing test", ctx);
		check(
			"/ledger waits for a concurrent turn to finish before sending the hand-off once",
			order.join(",") === "waited:sent=0" && sent.length === 1,
			`order=${order.join(",")} sent=${sent.length}`,
		);
	}

	// --- /ledger with no UI (print mode): writes the hand-off to stderr instead of starting a turn ---
	{
		writeConfig({ gate: "true", maxIters: 4, trigger: "manual" });
		const { commands, ctx, bus, sent } = fresh(CONVERGE, "code");
		const printed: string[] = [];
		const origError = console.error;
		console.error = (...a: unknown[]) => {
			printed.push(a.join(" "));
		};
		try {
			await commands.ledger.handler("fix the failing test", ctx);
		} finally {
			console.error = origError;
		}
		check(
			"/ledger in print mode runs the loop and writes the hand-off block to stderr without a hand-off turn",
			bus.spawned.includes("ledger-manager") &&
				sent.length === 0 &&
				printed.some((l) => l.includes("<ledgerpi-result>")),
			`sent=${sent.length} printed=${printed.length}`,
		);
	}

	// --- /ledger: guards notify and run nothing ---
	{
		writeConfig({ gate: "true", trigger: "manual" });
		const empty = fresh(CONVERGE, "code", {}, { hasUI: true });
		await empty.commands.ledger.handler("   ", empty.ctx);
		check(
			"/ledger with no task prints usage and runs nothing",
			empty.bus.spawned.length === 0 && empty.sent.length === 0 && empty.notices.some((n) => n.includes("usage")),
			empty.notices.join("|"),
		);

		const busy = fresh(CONVERGE, "code", {}, { hasUI: true });
		busy.ctx.isIdle = () => false;
		await busy.commands.ledger.handler("fix it", busy.ctx);
		check("/ledger while the agent is busy runs nothing", busy.bus.spawned.length === 0 && busy.sent.length === 0);

		const outside = fresh(CONVERGE, "code", {}, { hasUI: true });
		outside.ctx.model = { provider: "openai", id: "gpt-x", contextWindow: 1 };
		await outside.commands.ledger.handler("fix it", outside.ctx);
		check("/ledger out of scope runs nothing", outside.bus.spawned.length === 0 && outside.sent.length === 0);

		const noRepo = fresh(CONVERGE, "code", {}, { hasUI: true });
		noRepo.ctx.cwd = root;
		await noRepo.commands.ledger.handler("fix it", noRepo.ctx);
		check("/ledger outside a git repo runs nothing", noRepo.bus.spawned.length === 0 && noRepo.sent.length === 0);

		const noRpc = fresh(CONVERGE, "code", { noPing: true }, { hasUI: true });
		await noRpc.commands.ledger.handler("fix it", noRpc.ctx);
		check("/ledger without pi-subagents runs nothing", noRpc.bus.spawned.length === 0 && noRpc.sent.length === 0);
	}

	// --- /ledger: never overlaps a running loop ---
	{
		writeConfig({ gate: "true", maxIters: 4, trigger: "manual" });
		const { commands, tools, ctx, bus, sent } = fresh([{ text: PLAN }, { hang: true }], "code", {}, { hasUI: true });
		const ac = new AbortController();
		ctx.signal = ac.signal;
		const first = tools.ledger_solve.execute("call-1", { task: "fix it" }, undefined, undefined, ctx);
		await new Promise((r) => setTimeout(r, 20));
		const spawnedBefore = bus.spawned.length;
		await commands.ledger.handler("fix the other thing", ctx);
		check(
			"/ledger during a running loop starts no second run",
			bus.spawned.length === spawnedBefore && sent.length === 0,
			`spawned ${spawnedBefore} -> ${bus.spawned.length}, sent=${sent.length}`,
		);
		ac.abort();
		await first;
	}

	// --- Escape cancels an input-hook loop started while the session is idle ---
	{
		writeConfig({ gate: "true", maxIters: 4, trigger: "auto" });
		const { handlers, commands, ctx, bus, sent, notices, press, listeners } = fresh(
			[{ hang: true }],
			"code",
			{},
			{ hasUI: true },
		);
		// A cooperating workflow's claim attempt: `busy` comes back true while the group is held.
		const groupHeld = () => {
			const attempt = { session: ctx.sessionManager, group: "agent-workflow", busy: false };
			bus.emit("workflow:mutex:v1", attempt);
			return attempt.busy;
		};
		const pending = handlers.input(input("fix the failing test"), ctx);
		await new Promise((r) => setTimeout(r, 10));
		check("a running idle loop holds the workflow group", groupHeld());
		check(
			"an idle input-hook run (no pi signal) listens for Escape",
			ctx.signal === undefined && listeners() === 1 && bus.spawned.length === 1,
			`listeners=${listeners()} spawned=${bus.spawned.length}`,
		);
		const other = press("a");
		check(
			"a non-Escape key is neither consumed nor cancels the run",
			other.every((x) => x === undefined) && bus.stops.length === 0,
			JSON.stringify(other),
		);
		const esc = press("\x1b");
		const r = await pending;
		check(
			"Escape is consumed while the loop runs",
			esc.length === 1 && esc[0]?.consume === true,
			JSON.stringify(esc),
		);
		check("Escape stops the running worker", stoppedThenConsumed(bus, "agent-1"), opLog(bus));
		check("a cancelled input-hook run drops the turn", r?.action === "handled", JSON.stringify(r));
		check(
			"a cancelled input-hook run says the prompt was not run",
			notices.some((n) => n.includes("the prompt was not run")),
			JSON.stringify(notices),
		);
		const row = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check(
			"a cancelled input-hook run is audited stop:aborted with entry=input",
			row?.stop === "aborted" && row.entry === "input",
			JSON.stringify(row),
		);
		check(
			"a cancelled run sends no hand-off and leaves no Escape listener",
			sent.length === 0 && listeners() === 0,
			`sent=${sent.length} listeners=${listeners()}`,
		);
		check("Escape after the run is not intercepted", press("\x1b").length === 0);
		check("a cancelled run releases the workflow group", !groupHeld());
		// The guard and the workflow mutex are released: a fresh run starts, with its own controller.
		const next = commands.ledger.handler("fix it again", ctx);
		await new Promise((r) => setTimeout(r, 10));
		check(
			"the run guard and mutex are released after a cancel",
			bus.spawned.length === 2 && listeners() === 1,
			`spawned=${bus.spawned.length} listeners=${listeners()}`,
		);
		press("\x1b");
		await next;
		check(
			"a second run is cancellable independently",
			bus.stops.join(",") === "agent-1,agent-2" && lastRunStop() === "aborted",
			bus.stops.join(","),
		);
	}

	// --- /ledger with fanout=ask: Escape in the fan-out dialog means "no", not "stop the run" ---
	{
		const stateDir = join(root, "fanout-ask-command-state");
		writeConfig({ gate: "true", maxIters: 4, trigger: "manual", stateDir, auditLog: auditPath, fanout: "ask" });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manageMode("continue", "do the fix", "best-of-n: uncertain approach") },
			{ text: worker("solved") },
			{ text: manage("done", "") },
		];
		const { commands, ctx, bus, sent, selects, press, listeners, statuses } = fresh(
			script,
			"code",
			{},
			{ hasUI: true, selectPending: true },
		);
		const workSpawns = () => descriptionsFor(bus, "ledger-worker").filter((d) => d?.endsWith(", work)")).length;
		const blocked: unknown[] = [];
		bus.on("herdr:blocked", (d) => {
			blocked.push((d as { active: unknown }).active);
		});
		const pending = commands.ledger.handler("fix the failing test", ctx);
		for (let i = 0; i < 100 && selects.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
		check(
			"the fan-out dialog offers this round, run serially, and the rest-of-run answers",
			selects.length === 1 &&
				selects[0].join("|") ===
					"Yes (this round)|No, run serially|Yes for the rest of this run|No for the rest of this run",
			JSON.stringify(selects),
		);
		check(
			"the run waits on the dialog with the Escape listener live and no worker spawned",
			listeners() === 1 && workSpawns() === 0,
			`listeners=${listeners()} work=${workSpawns()}`,
		);
		check(
			"while the dialog is open the footer says escape means no, not stop",
			statuses.at(-1) === "ledgerpi: confirm fan-out (esc = no)",
			JSON.stringify(statuses.at(-1)),
		);
		const esc = press("\x1b");
		await pending;
		check(
			"Escape in the dialog is not consumed by the run's own listener",
			esc.length === 1 && esc[0] === undefined,
			JSON.stringify(esc),
		);
		const row = readAudit()
			.filter((x) => x.event === "run" && x.entry === "command")
			.at(-1);
		check(
			"Escape in the dialog neither aborts the run nor stops a worker",
			bus.stops.length === 0 && row?.stop !== "aborted" && row?.converged === true && sent.length === 1,
			`stops=${bus.stops.join(",")} stop=${row?.stop} sent=${sent.length}`,
		);
		check(
			"a dismissed dialog is a no: one question asked, the round ran serially as declined",
			row?.fanout?.setting === "ask" &&
				row.fanout.asked === 1 &&
				row.fanout.rounds === 0 &&
				row.fanout.downgrades.join(",") === "declined",
			JSON.stringify(row?.fanout),
		);
		check(
			"the declined round is a serial brief row and the worker ran once",
			rowsIn(stateDir).some((b) => b.mode === "serial" && b.advised === "best-of-n" && b.downgrade === "declined") &&
				workSpawns() === 1,
			JSON.stringify(rowsIn(stateDir)),
		);
		check("the Escape listener is gone after the run", listeners() === 0 && press("\x1b").length === 0);
		check(
			"the fan-out dialog blocks the herdr pane while open and releases it on close",
			blocked.join(",") === "true,false",
			blocked.join(","),
		);
	}

	// --- /ledger with fanout=ask: stopping the run dismisses an open dialog ---
	{
		const stateDir = join(root, "fanout-ask-command-stop-state");
		writeConfig({ gate: "true", maxIters: 4, trigger: "manual", stateDir, auditLog: auditPath, fanout: "ask" });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manageMode("continue", "do the fix", "best-of-n: uncertain approach") },
			{ text: worker("solved") },
		];
		const { commands, ctx, bus, selects, selectSignals } = fresh(
			script,
			"code",
			{},
			{ hasUI: true, selectPending: true },
		);
		const pending = commands.ledger.handler("fix the failing test", ctx);
		for (let i = 0; i < 100 && selects.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
		await commands["ledger-stop"].handler("", ctx);
		await pending;
		const row = readAudit()
			.filter((x) => x.event === "run" && x.entry === "command")
			.at(-1);
		check(
			"/ledger-stop aborts the signal handed to the open dialog, which dismisses it and ends the run without a worker",
			selectSignals.length === 1 &&
				selectSignals[0]?.aborted === true &&
				row?.stop === "aborted" &&
				descriptionsFor(bus, "ledger-worker").filter((d) => d?.endsWith(", work)")).length === 0,
			JSON.stringify([selectSignals[0]?.aborted, row?.stop]),
		);
	}

	// --- /ledger with fanout=ask: Escape aborts again once the dialog has closed ---
	{
		const stateDir = join(root, "fanout-ask-command-esc-state");
		writeConfig({ gate: "true", maxIters: 4, trigger: "manual", stateDir, auditLog: auditPath, fanout: "ask" });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manageMode("continue", "do the fix", "best-of-n: uncertain approach") },
			{ hang: true },
		];
		const { commands, ctx, bus, selects, press } = fresh(script, "code", {}, { hasUI: true, selectPending: true });
		const workSpawns = () => descriptionsFor(bus, "ledger-worker").filter((d) => d?.endsWith(", work)")).length;
		const pending = commands.ledger.handler("fix the failing test", ctx);
		for (let i = 0; i < 100 && selects.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
		press("\x1b");
		for (let i = 0; i < 100 && workSpawns() < 1; i++) await new Promise((r) => setTimeout(r, 10));
		const second = press("\x1b");
		await pending;
		const row = readAudit()
			.filter((x) => x.event === "run" && x.entry === "command")
			.at(-1);
		check(
			"after the dialog closes the run's own listener consumes Escape again and aborts the run",
			workSpawns() === 1 &&
				second.length === 1 &&
				(second[0] as { consume?: boolean })?.consume === true &&
				row?.stop === "aborted",
			JSON.stringify([second, row?.stop, workSpawns()]),
		);
	}

	// --- /ledger-stop cancels a /ledger loop ---
	{
		writeConfig({ gate: "true", maxIters: 4, trigger: "manual" });
		const { commands, ctx, bus, sent, notices } = fresh([{ hang: true }], "code", {}, { hasUI: true });
		check("/ledger-stop command is registered", typeof commands["ledger-stop"]?.handler === "function");
		const pending = commands.ledger.handler("fix the failing test", ctx);
		await new Promise((r) => setTimeout(r, 10));
		await commands["ledger-stop"].handler("", ctx);
		await pending;
		check("/ledger-stop stops the running worker", stoppedThenConsumed(bus, "agent-1"), opLog(bus));
		check(
			"/ledger-stop acknowledges and the /ledger run reports the abort",
			notices.some((n) => n.includes("stopping the ledger loop")) && notices.some((n) => n.includes("aborted")),
			JSON.stringify(notices),
		);
		const row = readAudit()
			.filter((x) => x.event === "run")
			.at(-1);
		check(
			"a cancelled /ledger run is audited stop:aborted with entry=command",
			row?.stop === "aborted" && row.entry === "command",
			JSON.stringify(row),
		);
		check("a cancelled /ledger run sends no hand-off", sent.length === 0, JSON.stringify(sent));
	}

	// --- session teardown cancels a running /ledger loop before pi invalidates the context ---
	{
		writeConfig({ gate: "true", maxIters: 4, trigger: "manual" });
		const { handlers, commands, ctx, bus, sent, notices } = fresh([{ hang: true }], "code", {}, { hasUI: true });
		const rowsBefore = readAudit().filter((x) => x.event === "run").length;
		const pending = commands.ledger.handler("fix the failing test", ctx);
		await new Promise((r) => setTimeout(r, 10));
		await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
		// pi disposes the session as soon as shutdown handlers return; any later ctx read throws.
		for (const key of ["cwd", "hasUI", "ui", "model", "sessionManager"]) {
			Object.defineProperty(ctx, key, {
				get: () => {
					throw new Error("stale ctx");
				},
			});
		}
		const outcome = await pending.then(
			() => "resolved",
			(err: Error) => `rejected: ${err.message}`,
		);
		const runRows = readAudit().filter((x) => x.event === "run");
		check("session_shutdown stops the running worker", stoppedThenConsumed(bus, "agent-1"), opLog(bus));
		check(
			"a run cut by session_shutdown is audited stop:aborted before the context goes stale",
			runRows.length === rowsBefore + 1 && runRows.at(-1)?.stop === "aborted",
			`rows ${rowsBefore} -> ${runRows.length}, stop=${runRows.at(-1)?.stop}`,
		);
		check(
			"a run cut by session_shutdown ends quietly: no hand-off, no notice, no stale-context error",
			outcome === "resolved" && sent.length === 0 && notices.length === 0,
			`${outcome} sent=${sent.length} notices=${JSON.stringify(notices)}`,
		);
	}

	// --- a cancel during the finalize pass is still an abort, not a hand-off ---
	{
		writeConfig({ gate: "false", maxIters: 1, trigger: "manual" });
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("continue", "keep going") },
			{ hang: true }, // finalize
		];
		const { commands, ctx, bus, sent, press } = fresh(script, "code", {}, { hasUI: true });
		const pending = commands.ledger.handler("fix the failing test", ctx);
		for (let i = 0; i < 100 && bus.spawned.length < 6; i++) await new Promise((r) => setTimeout(r, 10));
		press("\x1b");
		await pending;
		check(
			"Escape during the finalize worker stops it and audits stop:aborted",
			bus.spawned.length === 6 &&
				bus.stops.join(",") === "agent-6" &&
				opLog(bus).endsWith("stop:agent-6,consume:agent-6") &&
				lastRunStop() === "aborted",
			`spawned=${bus.spawned.length} ops=${opLog(bus)} stop=${lastRunStop()}`,
		);
		check("a cancel during finalize sends no hand-off", sent.length === 0, JSON.stringify(sent).slice(0, 80));
	}

	// --- a cancel during the final gate is still an abort, not a hand-off ---
	{
		const mark = join(root, "final-gate-mark");
		rmSync(mark, { force: true });
		// The in-round gate fails fast and leaves the mark; the final gate then blocks.
		writeConfig({
			gate: `test -f '${mark}' && sleep 30 || { touch '${mark}'; false; }`,
			maxIters: 1,
			trigger: "manual",
		});
		const script: Step[] = [
			{ text: PLAN },
			{ text: IDEATE },
			{ text: manage("continue", "do the fix") },
			{ text: worker("solved") },
			{ text: manage("continue", "keep going") },
			{ text: worker("solved") }, // finalize
		];
		const { commands, ctx, bus, sent, press, statuses } = fresh(script, "code", {}, { hasUI: true });
		const startedAt = Date.now();
		const pending = commands.ledger.handler("fix the failing test", ctx);
		for (let i = 0; i < 200 && (bus.spawned.length < 6 || !existsSync(mark)); i++)
			await new Promise((r) => setTimeout(r, 10));
		await new Promise((r) => setTimeout(r, 200));
		press("\x1b");
		await pending;
		check(
			"Escape during the final gate kills it and audits stop:aborted",
			lastRunStop() === "aborted" && Date.now() - startedAt < 20_000,
			`stop=${lastRunStop()} ms=${Date.now() - startedAt}`,
		);
		check("a cancel during the final gate sends no hand-off", sent.length === 0 && bus.spawned.length === 6);
		check(
			"the in-round and final gates each started their counter at zero before the cancel",
			gateStatuses(statuses).filter((g) => g.elapsed === 0).length === 2,
			JSON.stringify(gateStatuses(statuses)),
		);
		check(
			"the aborted gate run clears the status line",
			statuses.at(-1) === undefined,
			JSON.stringify(statuses.at(-2)),
		);
		const settledCount = statuses.length;
		await new Promise((r) => setTimeout(r, 1200));
		check(
			"no gate tick lands after an aborted gate resolves",
			statuses.length === settledCount,
			`${settledCount} -> ${statuses.length}`,
		);
	}

	// --- a cancelled input-hook run releases its claim on the turn ---
	{
		writeConfig({
			gate: "true",
			maxIters: 4,
			trigger: "auto",
			autoTrigger: "redirect",
			redirectSkills: ["review-task"],
		});
		const { handlers, ctx, press } = fresh([{ hang: true }], "code", {}, { hasUI: true });
		const pending = handlers.input(input("fix the failing test"), ctx);
		await new Promise((r) => setTimeout(r, 10));
		press("\x1b");
		const r = await pending;
		await handlers.input(input("/review-task PROJ-9"), ctx);
		await handlers.before_agent_start(beforeAgentStart("review PROJ-9"), ctx);
		const edit = await handlers.tool_call(editCall(), ctx);
		check(
			"the next allowlisted skill turn after a cancel is still redirected",
			r?.action === "handled" && edit?.block === true,
			JSON.stringify({ r, edit }).slice(0, 160),
		);
	}

	// --- /ledger-stop and session teardown with no cancellable loop ---
	{
		writeConfig({ gate: "true", maxIters: 4, trigger: "manual" });
		const { handlers, commands, tools, ctx, bus, notices } = fresh(
			[{ text: PLAN }, { hang: true }],
			"code",
			{},
			{
				hasUI: true,
			},
		);
		await commands["ledger-stop"].handler("", ctx);
		await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
		check(
			"/ledger-stop with nothing running says so",
			notices.at(-1)?.includes("no ledger loop is running") === true,
			JSON.stringify(notices),
		);
		const ac = new AbortController();
		ctx.signal = ac.signal;
		const solving = tools.ledger_solve.execute("call-1", { task: "fix it" }, undefined, undefined, ctx);
		await new Promise((r) => setTimeout(r, 20));
		await commands["ledger-stop"].handler("", ctx);
		check(
			"/ledger-stop leaves a ledger_solve run alone and points at Escape",
			bus.stops.length === 0 && notices.at(-1)?.includes("Escape") === true,
			JSON.stringify(notices.at(-1)),
		);
		ac.abort();
		await solving;
	}

	// --- /ledger: not registered when disabled ---
	{
		writeConfig({ gate: "true", enabled: false });
		const { commands } = fresh([], "code");
		check("/ledger is not registered when disabled", commands.ledger === undefined);
		writeConfig({ gate: "true" });
	}

	// --- config loader: fail-closed parsing + allowlist + operational overrides ---
	{
		removeConfig();
		const noCfg = loadConfig();
		check("no config -> inert (disabled, no providers)", noCfg.enabled === false && noCfg.providers.length === 0);

		writeFileSync(configFile, "providers = = broken [[[");
		const badCfg = loadConfig();
		check("malformed config -> inert", badCfg.enabled === false && badCfg.providers.length === 0);

		removeConfig();
		execFileSync("mkfifo", [configFile]);
		const fifoLoad = loadCapturingErrors();
		check("config path is a FIFO -> inert without blocking", inertAsUnusable(fifoLoad), fifoLoad.errors.join(" | "));
		removeConfig();

		mkdirSync(configFile);
		const dirLoad = loadCapturingErrors();
		check("config path is a directory -> inert as unusable", inertAsUnusable(dirLoad), dirLoad.errors.join(" | "));
		rmSync(configFile, { recursive: true, force: true });

		writeFileSync(configFile, stringifyToml({ maxIters: 3 }));
		const noProv = loadConfig();
		check("config without providers -> inert", noProv.enabled === false && noProv.providers.length === 0);

		writeFileSync(
			configFile,
			stringifyToml({ providers: ["cerebras"], maxIters: 3, allowlist: { cerebras: ["m-y"] } }),
		);
		const cfg = loadConfig();
		check("valid config -> enabled with its providers", cfg.enabled === true && cfg.providers.includes("cerebras"));
		check("operational override applies (maxIters)", cfg.maxIters === 3);
		check("trigger defaults to ask", cfg.trigger === "ask", cfg.trigger);
		check("model not on the provider allowlist is out of scope", inScope(cfg, "cerebras", "m-x") === false);
		check("allowlisted model is in scope", inScope(cfg, "cerebras", "m-y") === true);
		check("provider not in list is out of scope", inScope(cfg, "openai", "m-y") === false);

		writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], trigger: "manual" }));
		check("trigger=manual parses", loadConfig().trigger === "manual");
		writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], trigger: "sometimes" }));
		check("an unknown trigger falls back to ask", loadConfig().trigger === "ask");

		// A provider with no [allowlist] entry is unrestricted; an entry restricts it to
		// exactly the ids listed, and an empty entry permits none.
		writeFileSync(configFile, stringifyToml({ providers: ["cerebras", "local"], allowlist: { cerebras: ["m-y"] } }));
		const scoped = loadConfig();
		check("provider with no allowlist entry allows every model", inScope(scoped, "local", "anything") === true);
		check("provider with an entry stays restricted", inScope(scoped, "cerebras", "anything") === false);

		writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], allowlist: { cerebras: [] } }));
		check("empty allowlist entry allows no models", inScope(loadConfig(), "cerebras", "m-y") === false);

		// auditLog defaults under stateDir, tracks a stateDir override, and honors an explicit value / env.
		writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], stateDir: join(root, "s2") }));
		const auditDefault = loadConfig();
		check("auditLog defaults to runs.jsonl under stateDir", auditDefault.auditLog === join(root, "s2", "runs.jsonl"));

		writeFileSync(
			configFile,
			stringifyToml({ providers: ["cerebras"], stateDir: join(root, "s2"), auditLog: join(root, "custom.jsonl") }),
		);
		const auditExplicit = loadConfig();
		check(
			"explicit auditLog is honored over the stateDir default",
			auditExplicit.auditLog === join(root, "custom.jsonl"),
		);

		process.env.LEDGERPI_AUDIT_LOG = join(root, "env.jsonl");
		writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], auditLog: join(root, "custom.jsonl") }));
		const auditEnv = loadConfig();
		check("LEDGERPI_AUDIT_LOG env wins over the config file", auditEnv.auditLog === join(root, "env.jsonl"));
		delete process.env.LEDGERPI_AUDIT_LOG;

		// A malformed [allowlist] (value not an array of strings) fails closed.
		writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], allowlist: { cerebras: "m-x" } }));
		const badAllow = loadConfig();
		check("malformed allowlist -> inert", badAllow.enabled === false && badAllow.providers.length === 0);

		// A bare TOML datetime parses to a Date, not a table -> fail closed, not empty.
		writeFileSync(
			configFile,
			stringifyToml({ providers: ["cerebras"], allowlist: new Date("1979-05-27T07:32:00Z") }),
		);
		const dateAllow = loadConfig();
		check("allowlist as a datetime -> inert", dateAllow.enabled === false && dateAllow.providers.length === 0);

		// The retired [blocklist] has inverted meaning, so its presence fails closed
		// rather than silently widening scope to every model of the provider.
		writeFileSync(configFile, stringifyToml({ providers: ["cerebras"], blocklist: { cerebras: ["m-x"] } }));
		const legacy = loadConfig();
		check("retired [blocklist] -> inert", legacy.enabled === false && legacy.providers.length === 0);

		// A provider named like an Object.prototype member must not resolve to an
		// inherited property and throw in the scope check -- with or without an
		// allowlist entry of the same name.
		writeFileSync(configFile, stringifyToml({ providers: ["constructor"] }));
		const protoCfg = loadConfig();
		check("provider named like an Object member does not throw", inScope(protoCfg, "constructor", "m-y") === true);

		writeFileSync(configFile, stringifyToml({ providers: ["constructor"], allowlist: { constructor: ["m-y"] } }));
		const protoAllow = loadConfig();
		check(
			"proto-named provider with an allowlist entry scopes by that entry",
			inScope(protoAllow, "constructor", "m-y") === true && inScope(protoAllow, "constructor", "m-z") === false,
		);
	}

	// --- scope gate: one ordered decision list behind inScope and scopeReason ---
	{
		// S1: a disabled config, inert or otherwise, denies everything.
		writeConfig({ gate: "true", enabled: false });
		const s1 = loadConfig();
		check(
			"S1: a disabled config is out of scope with reason disabled",
			inScope(s1, "cerebras", "m-y") === false && scopeReason(s1, "cerebras", "m-y") === "disabled",
		);
		removeConfig();
		check(
			"S1: a missing config is inert and reads as disabled",
			scopeReason(loadConfig(), "cerebras", "m-y") === "disabled",
		);

		// S2: the provider is not one the config serves, or is unknown.
		writeConfig({ gate: "true" });
		const s2 = loadConfig();
		check(
			"S2: a provider outside the config is out of scope",
			inScope(s2, "openai", "m-y") === false && scopeReason(s2, "openai", "m-y") === "out-of-scope",
		);
		check(
			"S2: an unknown provider is out of scope",
			inScope(s2, undefined, "m-y") === false && scopeReason(s2, undefined, "m-y") === "out-of-scope",
		);

		// S3: the provider allowlist denies before any role check.
		writeConfig({ gate: "true", allowlist: { cerebras: ["m-y"] } });
		const s3 = loadConfig();
		check(
			"S3: a model the allowlist denies is out of scope",
			inScope(s3, "cerebras", "m-x") === false && scopeReason(s3, "cerebras", "m-x") === "not-allowlisted",
		);

		// S4: no [roleModel] table -- the legacy gate, alias pinning included.
		writeConfig({ gate: "true", workerModel: { "cerebras/m-y": "local/b-y" } });
		const s4 = loadCapturingErrors();
		check(
			"S4: an allowlisted model with no [roleModel] table is in scope",
			inScope(s4.cfg, "cerebras", "m-y") === true && scopeReason(s4.cfg, "cerebras", "m-y") === "in-scope",
		);
		const s4mapped = roleModelsFor(s4.cfg, "cerebras", "m-y");
		check(
			"S4: the alias entry pins the worker and leaves the manager on the session model",
			s4mapped !== null &&
				s4mapped.manager === null &&
				s4mapped.worker === "local/b-y" &&
				s4mapped.source === "workerModel",
		);
		const s4unmapped = roleModelsFor(s4.cfg, "cerebras", "m-z");
		check(
			"S4: an unmapped model runs every role on the session model",
			s4unmapped !== null &&
				s4unmapped.manager === null &&
				s4unmapped.worker === null &&
				s4unmapped.source === "session",
		);

		// S5: a [roleModel] entry names the model and pins both roles.
		writeConfig({ gate: "true", roleModel: { "cerebras/m-y": { manager: "local/m-y", worker: "local/w-y" } } });
		const s5 = loadConfig();
		check(
			"S5: a model a [roleModel] entry names is in scope",
			inScope(s5, "cerebras", "m-y") === true && scopeReason(s5, "cerebras", "m-y") === "in-scope",
		);
		const s5roles = roleModelsFor(s5, "cerebras", "m-y");
		check(
			"S5: both roles take the pinned models",
			s5roles !== null &&
				s5roles.manager === "local/m-y" &&
				s5roles.worker === "local/w-y" &&
				s5roles.source === "roleModel",
		);

		// S6: the table is present but names no entry for the model; the deprecated
		// alias still opts it in, manager on the session model.
		writeConfig({
			gate: "true",
			roleModel: { "cerebras/other": { manager: "local/m-x", worker: "local/w-x" } },
			workerModel: { "cerebras/m-y": "local/b-y" },
		});
		const s6 = loadCapturingErrors();
		check(
			"S6: an alias entry under a present [roleModel] table is in scope",
			inScope(s6.cfg, "cerebras", "m-y") === true && scopeReason(s6.cfg, "cerebras", "m-y") === "in-scope",
		);
		const s6roles = roleModelsFor(s6.cfg, "cerebras", "m-y");
		check(
			"S6: the worker takes the alias model and the manager the session model",
			s6roles !== null &&
				s6roles.manager === null &&
				s6roles.worker === "local/b-y" &&
				s6roles.source === "workerModel",
		);

		// S7: a dropped [roleModel] entry leaves its model opted out, with its own reason,
		// and a valid default does not rescue it -- the malformed branch comes first.
		writeConfig({
			gate: "true",
			roleModel: {
				"cerebras/m-y": { manager: "local/m-y" },
				default: { manager: "local/dm", worker: "local/dw" },
			},
		});
		const s7 = loadCapturingErrors();
		check(
			"S7: a malformed [roleModel] entry opts its model out",
			inScope(s7.cfg, "cerebras", "m-y") === false &&
				scopeReason(s7.cfg, "cerebras", "m-y") === "malformed-role-entry",
		);
		check(
			"S7: the gate denial yields no role mapping even with a valid default present",
			roleModelsFor(s7.cfg, "cerebras", "m-y") === null,
		);

		// S8: the table is present and names nothing for the model: no entry, an
		// empty table, and an unknown model id all read the same.
		writeConfig({ gate: "true", roleModel: { "cerebras/m-y": { manager: "local/m-y", worker: "local/w-y" } } });
		const s8 = loadConfig();
		check(
			"S8: a model no entry names is out of scope",
			inScope(s8, "cerebras", "m-x") === false && scopeReason(s8, "cerebras", "m-x") === "no-role-entry",
		);
		check("S8: the gate denial yields no role mapping", roleModelsFor(s8, "cerebras", "m-x") === null);
		check(
			"S8: an unknown model id under a present table is no-role-entry",
			inScope(s8, "cerebras", undefined) === false && scopeReason(s8, "cerebras", undefined) === "no-role-entry",
		);
		writeConfig({ gate: "true", roleModel: {} });
		const s8empty = loadConfig();
		check(
			"S8: an empty [roleModel] table opts every model out",
			inScope(s8empty, "cerebras", "m-y") === false && scopeReason(s8empty, "cerebras", "m-y") === "no-role-entry",
		);

		// S5 x S9: the null-ref branch outranks the default, so a default cannot
		// rescue a session model it cannot name -- and the diagnostics must not
		// claim the default is missing when it is configured.
		writeConfig({ gate: "true", roleModel: { default: { worker: "local/w" } } });
		const s5Default = loadConfig();
		check(
			"S5 x S9: a null model ref is no-role-entry even with a default present",
			inScope(s5Default, "cerebras", undefined) === false &&
				scopeReason(s5Default, "cerebras", undefined) === "no-role-entry",
		);
		{
			const idless = fresh([], "code", {}, { hasUI: true });
			const noId = { ...idless.ctx, model: { provider: "cerebras", id: undefined } };
			await idless.commands.ledgerpi.handler(undefined, noId);
			const statusText = idless.notices.at(-1) ?? "";
			check(
				"/ledger: a null model id under a configured default does not claim the default is missing",
				statusText.includes("session model has no id") && !statusText.includes("no [roleModel].default"),
				statusText.split("\n")[1],
			);
		}
		{
			const { tools, ctx, bus } = fresh([], "code");
			const noId = { ...ctx, model: { provider: "cerebras", id: undefined } };
			const r = await tools.ledger_solve.execute("call-no-id", { task: "do it" }, undefined, undefined, noId);
			const out = r?.content?.[0]?.text ?? "";
			check(
				"ledger_solve: a null model id under a configured default reports the missing id, not a missing default",
				out.includes("the session model has no id") && !out.includes("no [roleModel].default"),
				out.slice(0, 120),
			);
			check("ledger_solve: a null model id does not spawn", bus.spawned.length === 0, bus.spawned.join(","));
		}

		// The same diagnostic must hold with no default configured: the cause is the
		// missing model id, not the table.
		writeConfig({ gate: "true", roleModel: { "cerebras/m-y": { manager: "local/m-y", worker: "local/w-y" } } });
		{
			const idless = fresh([], "code", {}, { hasUI: true });
			const noId = { ...idless.ctx, model: { provider: "cerebras", id: undefined } };
			await idless.commands.ledgerpi.handler(undefined, noId);
			const statusText = idless.notices.at(-1) ?? "";
			check(
				"/ledger: a null model id with no default still reports the missing id, not a missing entry",
				statusText.includes("session model has no id") && !statusText.includes("no [roleModel] entry"),
				statusText.split("\n")[1],
			);
		}
		{
			const { tools, ctx, bus } = fresh([], "code");
			const noId = { ...ctx, model: { provider: "cerebras", id: undefined } };
			const r = await tools.ledger_solve.execute("call-no-id-2", { task: "do it" }, undefined, undefined, noId);
			const out = r?.content?.[0]?.text ?? "";
			check(
				"ledger_solve: a null model id with no default still reports the missing id, not a missing entry",
				out.includes("the session model has no id") && !out.includes("no [roleModel] entry"),
				out.slice(0, 120),
			);
			check(
				"ledger_solve: a null model id with no default does not spawn",
				bus.spawned.length === 0,
				bus.spawned.join(","),
			);
		}

		// Overlaps: the decision list resolves them in order.
		writeConfig({
			gate: "true",
			roleModel: { "cerebras/m-y": { manager: "local/m-y", worker: "local/w-y" } },
			workerModel: { "cerebras/m-y": "local/alias-y" },
		});
		const bothTables = loadCapturingErrors();
		const bothRoles = roleModelsFor(bothTables.cfg, "cerebras", "m-y");
		check(
			"overlap: a model in both tables resolves to the [roleModel] entry",
			bothRoles !== null &&
				bothRoles.manager === "local/m-y" &&
				bothRoles.worker === "local/w-y" &&
				bothRoles.source === "roleModel" &&
				bothTables.errors.some((e) => e.includes("in both [workerModel] and [roleModel]")),
		);
		writeConfig({
			gate: "true",
			roleModel: { "cerebras/m-y": { manager: "local/m-y" } },
			workerModel: { "cerebras/m-y": "local/alias-y" },
		});
		const overlapped = loadCapturingErrors();
		const overlappedRoles = roleModelsFor(overlapped.cfg, "cerebras", "m-y");
		check(
			"overlap: a malformed [roleModel] entry with a valid alias resolves to the alias",
			overlappedRoles !== null &&
				overlappedRoles.manager === null &&
				overlappedRoles.worker === "local/alias-y" &&
				overlappedRoles.source === "workerModel" &&
				scopeReason(overlapped.cfg, "cerebras", "m-y") === "in-scope",
		);
		writeConfig({
			gate: "true",
			allowlist: { cerebras: ["m-x"] },
			roleModel: { "cerebras/m-y": { manager: "local/m-y", worker: "local/w-y" } },
		});
		const allowDenied = loadConfig();
		check(
			"overlap: an allowlist denial precedes a [roleModel] entry",
			inScope(allowDenied, "cerebras", "m-y") === false &&
				scopeReason(allowDenied, "cerebras", "m-y") === "not-allowlisted",
		);
	}
	// S5: a model a [roleModel] entry names shows the pinned roles and its entry.
	writeConfig({
		gate: "true",
		roleModel: { "cerebras/qwen-3.8-27b": { manager: "local/qwen3.8-m", worker: "local/qwen3.8-w" } },
	});
	{
		const { commands, ctx, notices } = fresh([], "code", {}, { hasUI: true });
		await commands.ledgerpi.handler(undefined, ctx);
		const text = notices.at(-1) ?? "";
		check(
			"/ledger: a model a [roleModel] entry names reads as in scope",
			text.includes("model: cerebras/qwen-3.8-27b -- in scope"),
			text.split("\n")[1],
		);
		check(
			"/ledger: the roles line shows both pinned roles via [roleModel]",
			text.includes("roles: manager=local/qwen3.8-m, worker=local/qwen3.8-w (via [roleModel])"),
			text,
		);
		check(
			"/ledger: the roleModel line lists the opted-in entry with empty alias and malformed lists",
			text.includes("roleModel: cerebras/qwen-3.8-27b; [workerModel] (deprecated): (none); malformed: (none)"),
			text,
		);
	}

	// S7: a dropped [roleModel] entry names the model as malformed.
	writeConfig({ gate: "true", roleModel: { "cerebras/qwen-3.8-27b": { manager: "local/qwen3.8-m" } } });
	{
		const { commands, ctx, notices } = fresh([], "code", {}, { hasUI: true });
		await commands.ledgerpi.handler(undefined, ctx);
		const text = notices.at(-1) ?? "";
		check(
			"/ledger: a malformed [roleModel] entry reads as its own scope note",
			text.includes("model: cerebras/qwen-3.8-27b -- malformed [roleModel] entry (passes through)"),
			text.split("\n")[1],
		);
		check("/ledger: a gate-denied model reports no roles at all", text.includes("roles: (inactive)"), text);
		check(
			"/ledger: the roleModel line names the dropped entry under malformed",
			text.includes("roleModel: (none); [workerModel] (deprecated): (none); malformed: cerebras/qwen-3.8-27b"),
			text,
		);
	}

	// S8: a model no entry names reads as no [roleModel] entry.
	writeConfig({
		gate: "true",
		roleModel: { "cerebras/other": { manager: "local/qwen3.8-m", worker: "local/qwen3.8-w" } },
	});
	{
		const { commands, ctx, notices } = fresh([], "code", {}, { hasUI: true });
		await commands.ledgerpi.handler(undefined, ctx);
		const text = notices.at(-1) ?? "";
		check(
			"/ledger: a model no [roleModel] entry names reads as no entry",
			text.includes(
				"model: cerebras/qwen-3.8-27b -- no [roleModel] entry and no [roleModel].default for this model (passes through)",
			),
			text.split("\n")[1],
		);
		check(
			"/ledger: the roleModel line lists the opted-in model that is not the session model",
			text.includes(
				"roleModel: cerebras/other; [workerModel] (deprecated): (none); malformed: (none); default: (none)",
			),
			text,
		);
	}

	// S9: the reserved default pins the roles for a model no entry names, and it is
	// labelled as its own source rather than the deprecated alias.
	writeConfig({
		gate: "true",
		roleModel: { default: { manager: "local/qwen3.8-dm", worker: "local/qwen3.8-dw" } },
	});
	{
		const { commands, ctx, notices } = fresh([], "code", {}, { hasUI: true });
		await commands.ledgerpi.handler(undefined, ctx);
		const text = notices.at(-1) ?? "";
		check(
			"/ledger: a model the reserved default covers reads as in scope",
			text.includes("model: cerebras/qwen-3.8-27b -- in scope"),
			text.split("\n")[1],
		);
		check(
			"/ledger: the roles line labels the reserved default as its own source, not the deprecated alias",
			text.includes("roles: manager=local/qwen3.8-dm, worker=local/qwen3.8-dw (via [roleModel] default)"),
			text,
		);
		check(
			"/ledger: the roleModel line names the default instead of rendering (none)",
			text.includes(
				"roleModel: (none); [workerModel] (deprecated): (none); malformed: (none); default: manager=local/qwen3.8-dm, worker=local/qwen3.8-dw",
			),
			text,
		);
	}

	// S4: an absent table keeps the legacy behavior, including the alias role line.
	writeConfig({ gate: "true", workerModel: { "cerebras/qwen-3.8-27b": "local/qwen3.8-27b" } });
	{
		const { commands, ctx, notices } = fresh([], "code", {}, { hasUI: true });
		await commands.ledgerpi.handler(undefined, ctx);
		const text = notices.at(-1) ?? "";
		check(
			"/ledger: an absent [roleModel] table shows the alias role via the deprecated table",
			text.includes("roles: manager=session model, worker=local/qwen3.8-27b (via [workerModel] (deprecated))"),
			text,
		);
		check(
			"/ledger: an absent [roleModel] table shows the no-table note",
			text.includes("roleModel: (no table -- every allowlisted model is in scope)"),
			text,
		);
	}

	// --- ledger + audit files: a non-regular file at a ledger path fails without blocking ---
	{
		const cfg = { ...loadConfig(), stateDir: join(root, "ledger-io") };
		const ledger = new Ledger(cfg, "sess", "turn");
		for (const name of ["task.md", "notes.md", "transcript.jsonl"]) execFileSync("mkfifo", [join(ledger.dir, name)]);

		check("a FIFO task.md reads as empty without blocking", ledger.task() === "");
		check("a FIFO notes.md reads as empty without blocking", ledger.notes() === "");
		const setTask = captureErrors(() => ledger.setTask("fix it"));
		check(
			"a FIFO task.md write fails without blocking",
			setTask.errors.some((e) => e.includes("write task.md failed")),
			setTask.errors.join(" | "),
		);
		const append = captureErrors(() => ledger.appendNotes("more"));
		check(
			"a FIFO notes.md append fails without blocking",
			append.errors.some((e) => e.includes("write notes.md failed")),
			append.errors.join(" | "),
		);
		const record = captureErrors(() => ledger.record({ role: "manager", ok: true }));
		check(
			"a FIFO transcript.jsonl append fails without blocking",
			record.errors.some((e) => e.includes("transcript append failed")),
			record.errors.join(" | "),
		);

		const planFifo = join(ledger.dir, "plan.md");
		execFileSync("mkfifo", [planFifo]);
		const reader = openSync(planFifo, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			const setPlan = captureErrors(() => ledger.setPlan("the plan"));
			let got = 0;
			try {
				got = readSync(reader, Buffer.alloc(64));
			} catch {
				got = 0;
			}
			check(
				"a FIFO plan.md with a reader is refused and receives nothing",
				setPlan.errors.some((e) => e.includes("write plan.md failed")) && got === 0,
				`read=${got} ${setPlan.errors.join(" | ")}`,
			);
		} finally {
			closeSync(reader);
		}
		rmSync(planFifo);

		mkdirSync(planFifo);
		check("a directory at plan.md reads as empty", ledger.plan() === "");
		const dirPlan = captureErrors(() => ledger.setPlan("the plan"));
		check(
			"a directory at plan.md is refused",
			dirPlan.errors.some((e) => e.includes("write plan.md failed")),
			dirPlan.errors.join(" | "),
		);

		const okLedger = new Ledger(cfg, "sess", "turn-ok");
		okLedger.setTask("first");
		okLedger.setTask("second");
		okLedger.record({ role: "manager" });
		okLedger.record({ role: "worker" });
		const rows = readFileSync(join(okLedger.dir, "transcript.jsonl"), "utf8").split("\n").filter(Boolean);
		check("a regular task.md is replaced on write", okLedger.task() === "second", okLedger.task());
		check(
			"a regular transcript.jsonl is appended one row per record with mode 0600",
			rows.length === 2 && (statSync(join(okLedger.dir, "transcript.jsonl")).mode & 0o777) === 0o600,
			`rows=${rows.length}`,
		);

		const auditFifo = join(root, "audit-fifo.jsonl");
		execFileSync("mkfifo", [auditFifo]);
		const meta = { entry: "input" as const, session: "sess", cwd: repo };
		const audit = captureErrors(() =>
			auditPassthrough({ ...cfg, auditLog: auditFifo }, meta, "chat", "classified", 1),
		);
		check(
			"a FIFO audit log append fails without blocking",
			audit.errors.some((e) => e.includes("audit append failed")),
			audit.errors.join(" | "),
		);
		rmSync(auditFifo);
	}

	// --- audit through the input hook: a FIFO at the configured audit log does not hang the turn ---
	{
		const auditFifo = join(root, "hook-audit-fifo.jsonl");
		execFileSync("mkfifo", [auditFifo]);
		writeConfig({ gate: "true", auditLog: auditFifo });
		const { handlers, ctx } = fresh([], "chat");
		const printed: string[] = [];
		const origError = console.error;
		console.error = (...a: unknown[]) => {
			printed.push(a.map(String).join(" "));
		};
		let r: any;
		try {
			r = await handlers.input(input("what does this function do?"), ctx);
		} finally {
			console.error = origError;
		}
		check(
			"a chat passthrough with a FIFO audit log completes and logs the failed append",
			(r === undefined || r?.action !== "transform") && printed.some((l) => l.includes("audit append failed")),
			printed.join(" | "),
		);
		rmSync(auditFifo);
		writeConfig({ gate: "true" });
	}

	// --- diagnostics: nothing is written to the terminal a UI session owns ---
	{
		writeConfig({ gate: "true", bogusKey: 1 });
		const load = captureErrors(loadConfig);
		check(
			"loadConfig returns an unknown-key warning instead of printing it",
			load.errors.length === 0 &&
				(load.value.warnings ?? []).some((w) => w.includes('unknown config key "bogusKey"')),
			`stderr=${load.errors.join(" | ")} warnings=${JSON.stringify(load.value.warnings)}`,
		);

		const main = captureErrors(() => fresh([], "code", {}, { hasUI: true }));
		const mainStart = captureErrors(() =>
			main.value.handlers.session_start({ type: "session_start" }, main.value.ctx),
		);
		check(
			"a UI session shows config warnings as notices, not on stderr",
			main.errors.length === 0 &&
				mainStart.errors.length === 0 &&
				main.value.notices.filter((n) => n.includes("bogusKey")).length === 1,
			`stderr=${[...main.errors, ...mainStart.errors].join(" | ")} notices=${main.value.notices.join(" | ")}`,
		);

		const sub = captureErrors(() => fresh([], "code"));
		const subStart = captureErrors(() => sub.value.handlers.session_start({ type: "session_start" }, sub.value.ctx));
		check(
			"a headless session inside a UI process (a sub-agent) prints no config warning",
			sub.errors.length === 0 && subStart.errors.length === 0,
			[...sub.errors, ...subStart.errors].join(" | "),
		);

		const ledger = new Ledger({ ...load.value, stateDir: join(root, "ledger-sink") }, "sess", "turn");
		execFileSync("mkfifo", [join(ledger.dir, "task.md")]);
		const write = captureErrors(() => ledger.setTask("fix it"));
		check(
			"a runtime failure while a UI session is live reaches its notices, not stderr",
			write.errors.length === 0 && main.value.notices.some((n) => n.includes("write task.md failed")),
			`stderr=${write.errors.join(" | ")} notices=${main.value.notices.join(" | ")}`,
		);

		await sub.value.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, sub.value.ctx);
		const afterSub = captureErrors(() => ledger.setTask("fix it"));
		check(
			"a sub-agent's shutdown leaves the UI session's sink in place",
			afterSub.errors.length === 0,
			afterSub.errors.join(" | "),
		);

		await main.value.handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, main.value.ctx);
		const afterMain = captureErrors(() => ledger.setTask("fix it"));
		check(
			"once the UI session shuts down, runtime failures fall back to stderr",
			afterMain.errors.some((e) => e.includes("write task.md failed")),
			afterMain.errors.join(" | "),
		);

		// pi-subagents loads a separate copy of the extension's modules per sub-agent;
		// a distinct module URL gives a distinct instance that must still share the sink.
		const reportUrl = pathToFileURL(join(import.meta.dirname, "..", "packages", "core", "src", "report.ts")).href;
		type ReportModule = typeof import("../packages/core/src/report.ts");
		const copyA: ReportModule = await import(`${reportUrl}?copy=a`);
		const copyB: ReportModule = await import(`${reportUrl}?copy=b`);
		const copyNotices: string[] = [];
		const copyOwner = {};
		copyA.bindUISink(copyOwner, { ui: { notify: (msg: string) => copyNotices.push(msg) } } as any);
		const viaCopy = captureErrors(() => copyB.report("[ledgerpi] from another module copy"));
		check(
			"a sink bound through one module copy receives another copy's reports",
			copyB.uiSinkBound() &&
				viaCopy.errors.length === 0 &&
				copyNotices.includes("[ledgerpi] from another module copy"),
			`bound=${copyB.uiSinkBound()} stderr=${viaCopy.errors.join(" | ")} notices=${copyNotices.join(" | ")}`,
		);
		copyB.releaseUISink({});
		const stillBound = copyA.uiSinkBound();
		copyB.releaseUISink(copyOwner);
		check(
			"only the owner releases the sink, from any module copy",
			stillBound && !copyA.uiSinkBound(),
			`afterForeign=${stillBound} afterOwner=${copyA.uiSinkBound()}`,
		);

		const print = captureErrors(() => fresh([], "code"));
		const printStart = captureErrors(() =>
			print.value.handlers.session_start({ type: "session_start" }, print.value.ctx),
		);
		check(
			"print mode (no UI in the process) reports config warnings on stderr at session_start",
			print.errors.length === 0 &&
				printStart.errors.filter((e) => e.includes('unknown config key "bogusKey"')).length === 1,
			`load=${print.errors.join(" | ")} start=${printStart.errors.join(" | ")}`,
		);
		writeConfig({ gate: "true" });
	}

	// --- packaging: the ledger-continue skill ships through the pi manifest ---
	{
		const pkgRoot = join(import.meta.dirname, "..");
		const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
		const skillFile = (pkg.pi?.skills ?? [])
			.map((dir: string) => join(pkgRoot, dir, "ledger-continue", "SKILL.md"))
			.find((p: string) => existsSync(p));
		check("package manifest ships the ledger-continue skill", skillFile !== undefined, JSON.stringify(pkg.pi));
		const front = skillFile ? (readFileSync(skillFile, "utf8").match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "") : "";
		check(
			"ledger-continue frontmatter names the skill and describes it",
			/^name: ledger-continue$/m.test(front) && /^description: \S/m.test(front),
			front.slice(0, 80),
		);
	}

	rmSync(root, { recursive: true, force: true });
	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
