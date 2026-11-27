import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	type DshConfig,
	disabledByEnv,
	type LedgerpiConfig,
	loadConfig,
	MODEL_REF_RE,
	modelRef,
} from "../../core/src/config.ts";
import { type SolveOutcome, type SolveRejection, solveTask } from "../../core/src/solve.ts";
import type { DshInactiveReason, DshSolveOutcome, DshSolveRequest, DshStatus, LedgerpiService } from "../api.d.ts";
import {
	type DshAgent,
	type DshAgentPresets,
	type DshCreatedAgent,
	type DshPluginContext,
	type DshRole,
	type DshSandboxPolicy,
	type DshToolExecution,
	type DshTools,
	isWithin,
	LEDGER_PRESETS,
	LEDGER_TOOL,
	parentRoute,
	realPathOrNull,
} from "./dsh.ts";
import { createDshSpawner, type DshRoles, dshRoles, errorText } from "./spawn.ts";

const ROLES: readonly DshRole[] = ["manager", "worker"];

const READ_TOOLS = ["read", "read_image", "glob", "grep"];

/** The only tools each ledger role may use. */
const ROLE_ALLOW: Record<DshRole, readonly string[]> = {
	manager: READ_TOOLS,
	worker: [...READ_TOOLS, "write", "edit", "bash"],
};

const NESTED_MESSAGE = "A ledger manager or worker cannot start a ledger run.";

/** Mask the tools a new agent inherits according to its ledger role; any other agent is left alone. */
function restrictChild(tools: DshTools, role: DshRole | undefined, agent: DshCreatedAgent): void {
	if (role === undefined) return;
	if (!Object.hasOwn(ROLE_ALLOW, role)) throw new Error(`unknown ledger role "${role}"`);
	agent.ctx.tools.restrict({ allow: ROLE_ALLOW[role].filter((name) => tools.get(name, agent) !== undefined) });
}

/** Why a tool call by a ledger child is denied, or undefined when it may run. */
function denial(children: ReadonlyMap<string, DshRole>, { agent, name }: DshToolExecution): string | undefined {
	const role = agent && children.get(agent.id);
	if (role === undefined || ROLE_ALLOW[role].includes(name)) return undefined;
	if (name === LEDGER_TOOL) return NESTED_MESSAGE;
	return `A ledger ${role} may only use these tools: ${ROLE_ALLOW[role].join(", ")}.`;
}

/**
 * Hold the agents listed in `children` to their role's tools until the plugin
 * unloads: a mask applied as each is created, and a check of every call it makes.
 * Creating an agent listed with an unknown role, or one that cannot be masked, throws.
 */
export function restrictLedgerChildren(ctx: DshPluginContext, children: ReadonlyMap<string, DshRole>): void {
	ctx.effect(() => ctx.on("agent/created", ({ agent }) => restrictChild(ctx.tools, children.get(agent.id), agent)));
	ctx.effect(() => ctx.tools.guard((execution) => denial(children, execution)));
}

type Activation = { warnings: string[] } & (
	| { active: true; cfg: LedgerpiConfig; dsh: DshConfig; presets: DshAgentPresets }
	| { active: false; reason: DshInactiveReason }
);

/** Whether the service runs anything right now, from the environment, a fresh read of the config and the registry. */
function activation(ctx: DshPluginContext): Activation {
	if (disabledByEnv()) return { active: false, reason: "env-disabled", warnings: [] };
	const cfg = loadConfig();
	const { warnings } = cfg;
	if (cfg.switchedOff) return { active: false, reason: "switched-off", warnings };
	if (cfg.dsh === null) return { active: false, reason: "no-dsh-table", warnings };
	const presets = ctx.get("agentPresets");
	if (presets === undefined) return { active: false, reason: "no-preset-registry", warnings };
	return { active: true, cfg, dsh: cfg.dsh, presets, warnings };
}

function status(ctx: DshPluginContext): DshStatus {
	try {
		const state = activation(ctx);
		return state.active ? { apiVersion: 1, active: true } : { apiVersion: 1, active: false, reason: state.reason };
	} catch {
		return { apiVersion: 1, active: false, reason: "no-dsh-table" };
	}
}

/** The call's own model refs: the usable ones, and the first role whose ref is not a `provider/modelId`. */
function requestedModels(request: DshSolveRequest) {
	const requested: Partial<Record<DshRole, string>> = {};
	let invalid: DshRole | undefined;
	for (const role of ROLES) {
		const ref: unknown = request[`${role}Model`];
		if (ref === undefined || ref === "") continue;
		if (typeof ref === "string" && MODEL_REF_RE.test(ref)) requested[role] = ref;
		else invalid ??= role;
	}
	return { requested, invalid };
}

type RunDirectory = { path: string } | { error: string };

/** The real path of the run directory: `cwd` resolved against the parent's working directory. */
function runDirectory(ctx: DshPluginContext, parent: DshAgent, cwd: unknown): RunDirectory {
	if (cwd !== undefined && typeof cwd !== "string") return { error: "`cwd` is not a string" };
	try {
		const base = ctx.get("workingDirectory")?.get(parent.session) ?? parent.session.header.cwd;
		if (!base) return { error: "the session has no working directory" };
		const path = realpathSync(resolve(base, cwd ?? "."));
		return statSync(path).isDirectory() ? { path } : { error: `\`${path}\` is not a directory` };
	} catch (err) {
		return { error: errorText(err) };
	}
}

/**
 * Why the parent's sandbox policy does not let a run use `runPath`, or null when it
 * does. A child's directory is its write boundary and dsh does not hold it to the
 * parent's, so this does. Fails closed on a missing, failing or unknown policy.
 */
function containment(ctx: DshPluginContext, parent: DshAgent, runPath: string): SolveRejection | null {
	const unavailable = (message: string): SolveRejection => ({ reason: "sandbox-unavailable", message });
	const sandbox = ctx.get("sandboxPolicy");
	if (sandbox === undefined) return unavailable("No sandbox policy service is available to contain the run.");
	let policy: ReturnType<DshSandboxPolicy["resolve"]>;
	try {
		policy = sandbox.resolve({ session: parent.session });
	} catch (err) {
		return unavailable(`The sandbox policy cannot be resolved: ${errorText(err)}`);
	}
	switch (policy.mode) {
		case "danger-full-access":
			return null;
		case "read-only":
			return { reason: "read-only-session", message: "The session's sandbox is read-only." };
		case "workspace-write": {
			const inside = [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])].some((root) => {
				const real = realPathOrNull(root);
				return real !== null && isWithin(real, runPath);
			});
			return inside
				? null
				: {
						reason: "cwd-outside-workspace",
						message: `\`${runPath}\` is outside the directories this session may write to.`,
						field: "cwd",
					};
		}
		default:
			return unavailable(`The sandbox mode "${policy.mode}" is not supported.`);
	}
}

/**
 * The checks that wait on dsh before the lock: both ledger presets, then the effort
 * of each role the call named a model for. Stops early once `signal` aborts, which
 * `solveTask` then reports as canceled.
 */
async function modelsProblem(
	presets: DshAgentPresets,
	roles: DshRoles,
	requested: Partial<Record<DshRole, string>>,
	signal: AbortSignal,
): Promise<SolveRejection | null> {
	for (const role of ROLES) {
		const id = LEDGER_PRESETS[role];
		let broken: string | undefined;
		try {
			broken = (await presets.resolve(id)).broken;
		} catch (err) {
			broken = errorText(err);
		}
		if (signal.aborted) return null;
		if (broken !== undefined) {
			return { reason: "presets-unavailable", message: `The \`${id}\` agent preset is unavailable: ${broken}` };
		}
	}
	for (const role of ROLES) {
		if (requested[role] === undefined) continue;
		const effort = await roles.effort(role);
		if (signal.aborted) return null;
		if (effort.kind === "refused") return { reason: "model-refused", message: effort.message };
	}
	return null;
}

/** How a call ends when nothing unexpected is thrown. */
type Ending = SolveOutcome | { kind: "inactive"; reason: DshInactiveReason };

async function attempt(
	ctx: DshPluginContext,
	children: Map<string, DshRole>,
	request: DshSolveRequest,
	warnings: string[],
): Promise<Ending> {
	const state = activation(ctx);
	warnings.push(...state.warnings);
	if (!state.active) return { kind: "inactive", reason: state.reason };
	const signal = request.signal ?? new AbortController().signal;
	if (signal.aborted) return { kind: "canceled" };
	const { parent } = request;
	const agents = ctx.get("agents");
	if (!parent || agents === undefined || agents.get(parent.id) !== parent) {
		return { kind: "rejected", reason: "no-parent", message: "The parent is not a live agent." };
	}
	if (children.has(parent.id)) {
		return { kind: "rejected", reason: "nested", message: NESTED_MESSAGE };
	}

	const route = parentRoute(parent);
	const { requested, invalid } = requestedModels(request);
	const roles = dshRoles({ parent, llm: ctx.get("llm"), dsh: state.dsh, requested, signal });
	const run = runDirectory(ctx, parent, request.cwd);
	const runPath = "path" in run ? run.path : "";
	const { planFile } = request;

	return solveTask(
		state.cfg,
		{
			cwd: runPath,
			gate: request.gate,
			planFile: typeof planFile === "string" && planFile.trim() ? resolve(runPath, planFile.trim()) : planFile,
			fanout: request.fanout,
			session: parent.id,
			task: typeof request.task === "string" ? request.task : "",
		},
		{
			harness: "dsh",
			entry: request.entry === "tool" ? "tool" : "service",
			provider: route.provider,
			model: route.model,
			managerModel: roles.models.manager,
			workerModel: roles.models.worker,
			sessionModel: modelRef(route.provider, route.model),
			signal,
			onProgress: (iter, label) => {
				try {
					request.onProgress?.(iter, label);
				} catch {}
			},
			warn: (message) => warnings.push(message),
			spawner: (ledger) =>
				createDshSpawner({
					parent,
					subagents: ctx.subagents,
					events: ctx,
					roles,
					runPath,
					ledgerDir: ledger.dir,
					children,
				}),
			checkArgs: () => {
				if (invalid !== undefined) {
					const field = `${invalid}Model`;
					return {
						reason: "bad-model-ref",
						message: `\`${field}\` must be a "provider/modelId" reference.`,
						field,
					};
				}
				if ("error" in run) {
					return { reason: "cwd-unavailable", message: `The run directory cannot be used: ${run.error}` };
				}
				return containment(ctx, parent, run.path);
			},
			beforeLock: () => modelsProblem(state.presets, roles, requested, signal),
		},
	);
}

/** The `ledgerpi` service on `ctx`, recording its running managers and workers in `children`. */
function ledgerpiService(ctx: DshPluginContext, children: Map<string, DshRole>): LedgerpiService {
	return {
		status: () => status(ctx),
		async solve(request): Promise<DshSolveOutcome> {
			const warnings: string[] = [];
			try {
				return { ...(await attempt(ctx, children, request, warnings)), warnings };
			} catch (err) {
				return { kind: "failed", message: errorText(err), warnings };
			}
		},
		isLedgerChild: (id) => children.has(id),
	};
}

/** The root plugin: restricts ledger children and provides the `ledgerpi` service. */
export default {
	name: "ledgerpi",
	inject: ["subagents", "tools"],
	apply(ctx: DshPluginContext): void {
		const children = new Map<string, DshRole>();
		restrictLedgerChildren(ctx, children);
		ctx.provide("ledgerpi", ledgerpiService(ctx, children));
	},
};
