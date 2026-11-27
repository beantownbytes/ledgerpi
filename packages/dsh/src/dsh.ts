import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { DshAgent, DshRoute, DshSession, LedgerpiService } from "../api.d.ts";

export type { DshAgent, DshRoute, DshSession } from "../api.d.ts";

/** The role a ledger child plays. */
export type DshRole = "manager" | "worker";

/** The name of the tool that starts a ledger run. */
export const LEDGER_TOOL = "ledger_solve";

/** The agent preset each role is started on. */
export const LEDGER_PRESETS: Readonly<Record<DshRole, string>> = {
	manager: "ledger-manager",
	worker: "ledger-worker",
};

export interface DshAgentOptions {
	provider?: string;
	model?: string;
	/** Always present: an explicit `undefined` stops the child inheriting the parent's effort. */
	reasoningEffort: string | undefined;
	maxTokens?: number;
}

/** The argument of `subagents.startActivation`. */
export interface DshSpawnSpec {
	provider: "spawn";
	label: string;
	parent: DshAgent;
	childId: string;
	delivery: "caller";
	agentPreset: string;
	cwd: string;
	prompt: { type: "text"; text: string }[];
	/** Covers startup only; a started child is stopped with `dispose`. */
	signal: AbortSignal;
	agentOptions: DshAgentOptions;
}

export interface DshSubagentResult {
	readonly output: readonly { readonly type: string; readonly text?: string }[];
	/** `completed`, `aborted`, `error`, `max-tokens`, `refusal`, or a reason added later. */
	readonly stopReason: string;
}

export interface DshSubagentActivation {
	readonly result: Promise<DshSubagentResult>;
	dispose(): Promise<void>;
}

export interface DshSubagents {
	startActivation(spec: DshSpawnSpec): Promise<DshSubagentActivation>;
}

export interface DshAssistantMessageEvent {
	readonly type: "assistant/message";
	readonly data: {
		readonly message: { readonly source: { readonly provider: string; readonly model: string } };
		readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens?: number };
	};
}

export interface DshTurnEndEvent {
	readonly type: "turn/end";
	readonly data: { readonly reason: { readonly kind: string; readonly error?: { readonly message: string } } };
}

/** The session events read here; events of other types also arrive and are ignored. */
export type DshSessionEvent = DshAssistantMessageEvent | DshTurnEndEvent;

export type DshSessionListener = (session: { readonly id: string }, event: DshSessionEvent) => void;

/** The part of the plugin context that carries session events. */
export interface DshEvents {
	/** Subscribes to every session's events and returns the unsubscriber. */
	on(name: "session/event", listener: DshSessionListener): () => void;
}

/** A mask over the tools an agent inherits; `allow: []` masks all of them. */
export interface DshToolRestriction {
	readonly allow?: readonly string[];
	readonly deny?: readonly string[];
}

/** One tool call about to run. */
export interface DshToolExecution {
	readonly name: string;
	/** The calling agent, absent for a call made outside one. */
	readonly agent?: { readonly id: string };
}

export interface DshTools {
	/** The definition of tool `name` as `agent` sees it, or undefined when it sees none. */
	get(name: string, agent: DshAgent): unknown;
	/**
	 * Masks tools for the agent whose context this was reached through. Throws on an
	 * unscoped context or a name the agent does not inherit.
	 */
	restrict(restriction: DshToolRestriction): () => void;
	/** Adds a check of every tool call, which a returned reason denies; returns the remover. */
	guard(guard: (execution: DshToolExecution) => string | undefined): () => void;
}

/** A new agent, with the context that scopes registrations to it. */
export interface DshCreatedAgent extends DshAgent {
	readonly ctx: { readonly tools: Pick<DshTools, "restrict"> };
}

export interface DshLlm {
	/** Rejects with a `code` when the provider, model or effort cannot be called. */
	resolveCallConfig(
		config: { provider: string; model: string; reasoningEffort?: string },
		signal?: AbortSignal,
	): Promise<unknown>;
}

export interface DshSandboxPolicy {
	resolve(request: { session: DshSession }): {
		readonly mode: string;
		readonly workspaceRoot: string;
		readonly additionalWritableRoots?: readonly string[];
	};
}

export interface DshWorkingDirectory {
	get(session: DshSession): string | undefined;
}

export interface DshAgents {
	/** The live agent with this session id, if any. */
	get(id: string): DshAgent | undefined;
}

export interface DshAgentPresets {
	/** Rejects for an undeclared preset; `broken` says why a declared one cannot be used. */
	resolve(id: string): Promise<{ readonly broken?: string }>;
}

/** The services read with `get`, by name; any of them may be absent. */
export interface DshServices {
	llm: DshLlm;
	workingDirectory: DshWorkingDirectory;
	sandboxPolicy: DshSandboxPolicy;
	agents: DshAgents;
	agentPresets: DshAgentPresets;
}

/** What a tool body is told about its call. */
export interface DshToolRunContext {
	/** The calling agent, absent for a call made outside one. */
	readonly agent?: DshAgent;
	/** Aborts when the call is canceled; the body must observe it and settle. */
	readonly signal: AbortSignal;
}

/** A tool as `tools.register` takes it. */
export interface DshToolDefinition<Value> {
	readonly name: string;
	readonly description: string;
	/** A JSON Schema with an object root. Arguments are not checked against it before `execute`. */
	readonly parameters: Record<string, unknown>;
	readonly output: {
		/** A JSON Schema every returned value is checked against. */
		readonly schema: Record<string, unknown>;
		/** The content the model reads for a returned value. */
		render(args: unknown, value: Value): { type: "text"; text: string }[];
	};
	/** `args` is whatever the model sent, which need not even be an object. */
	execute(args: unknown, exec: DshToolRunContext): Promise<Value>;
}

export interface DshToolOptions {
	/** Whether a model step of `agent` may see and call the tool; a throw fails the step. */
	when?(context: { readonly agent: { readonly id: string } }): boolean;
}

/** The part of the context of a plugin that registers a tool over the `ledgerpi` service. */
export interface DshToolPluginContext {
	/** Injected, so always present. */
	readonly ledgerpi: LedgerpiService;
	/** Injected, so always present. A registration lasts as long as the plugin. */
	readonly tools: {
		register<Value>(definition: DshToolDefinition<Value>, options?: DshToolOptions): () => void;
	};
}

/** The part of the root plugin context used here. */
export interface DshPluginContext extends DshEvents {
	/** Injected, so always present. */
	readonly subagents: DshSubagents;
	/** Injected, so always present. */
	readonly tools: DshTools;
	get<Name extends keyof DshServices>(name: Name): DshServices[Name] | undefined;
	provide(name: string, value: unknown): unknown;
	on(name: "session/event", listener: DshSessionListener): () => void;
	/**
	 * Subscribes to new agents, before their first turn; a throw fails the creation.
	 * The listener must return nothing, or later listeners are skipped.
	 */
	on(name: "agent/created", listener: (payload: { readonly agent: DshCreatedAgent }) => void): () => void;
	/** Runs `setup` now, and the disposer it returns when the plugin unloads. */
	effect(setup: () => () => void): unknown;
}

/** The route `parent`'s children inherit: that of its latest request, else the one it was created with. */
export function parentRoute(parent: DshAgent): DshRoute {
	return parent.session.requestHeader()?.config ?? parent.options;
}

/** The real path of `path`, or null when it cannot be resolved. */
export function realPathOrNull(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/** Whether `path` is `root` or lies under it. Both are real absolute paths. */
export function isWithin(root: string, path: string): boolean {
	const rest = relative(root, path);
	return !isAbsolute(rest) && rest.split(sep)[0] !== "..";
}
