import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { readRegularFile } from "./files.ts";
/** The thinking levels pi accepts; defined locally since the public package does not re-export the type. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * How ledgerpi triggers in a skill/slash-driven session, where the `input` hook
 * never fires (the launching command is escaped). `off`: only the `ledger_solve`
 * tool the model may call. `redirect`: block the first inline edit in such a
 * session and steer the model to `ledger_solve`. `auto` is reserved for a future
 * mode where ledgerpi synthesizes the task and runs the loop itself.
 */
export type AutoTrigger = "off" | "redirect";

/**
 * Whether the loop may run concurrent workers on a round. `off`: never, and the
 * manager is not asked to recommend. `advise`: the manager recommends a mode and the
 * recommendation is recorded, but every round still runs one worker. `ask`: a
 * best-of-n recommendation is acted on only after the user confirms it; without a way
 * to ask, the round runs one worker. `on`: the recommendation is acted on.
 */
export type FanoutSetting = "off" | "advise" | "ask" | "on";

/** Fan-out settings from least to most permissive. */
const FANOUT_ORDER: readonly FanoutSetting[] = ["off", "advise", "ask", "on"];

/** The less permissive of two fan-out settings (off < advise < ask < on). */
export function lowerFanout(a: FanoutSetting, b: FanoutSetting): FanoutSetting {
	return FANOUT_ORDER[Math.min(FANOUT_ORDER.indexOf(a), FANOUT_ORDER.indexOf(b))];
}

export const FANOUT_MAX_MIN = 2;
export const FANOUT_MAX_MAX = 8;
export const FANOUT_MAX_DEFAULT = 2;

/**
 * How the `input` hook starts the loop on a natural-language coding prompt.
 * `ask`: show a Run / Skip / Skip-for-session dialog once the prompt is eligible
 * (and classified `code`), passing through when declined or when no UI is
 * available. `auto`: run the loop without asking. `manual`: never run it from the
 * hook (no classifier call either); only the `/ledger` command and the
 * `ledger_solve` tool start runs.
 */
export type InputTrigger = "ask" | "auto" | "manual";

/**
 * The model each role spawns on. `null` means "the session model", so a role the
 * pin does not name keeps running on the session model.
 */
export type RolePin = { manager: string | null; worker: string | null };

/**
 * Which config source produced a session model's role pin: a named `[roleModel]`
 * entry, the deprecated `[workerModel]` alias, the reserved `[roleModel] default`
 * fallback, or no source at all (both roles on the session model).
 */
export type RoleSource = "roleModel" | "workerModel" | "roleModelDefault" | "session";

/** The manager model when `[claude]` names none. */
export const CLAUDE_MANAGER_DEFAULT = "claude-opus-5-5";
/** The worker model when `[claude]` names none. */
export const CLAUDE_WORKER_DEFAULT = "claude-sonnet-5-5";

/** The full model id each role runs on under Claude Code. */
export type ClaudeRoles = { manager: string; worker: string };

/** The `[claude]` roles, and whether each came from the config or the default. */
export type ClaudeConfig = ClaudeRoles & { sources: Record<keyof ClaudeRoles, "config" | "default"> };

export interface LedgerpiConfig {
	/** Master switch. False disables the extension entirely (it still loads, but every input passes through). */
	enabled: boolean;
	/** Provider ids the loop is allowed to run under. The paper's gains are a local-small-model effect; a cloud frontier provider is off by default. */
	providers: string[];
	/**
	 * Per-provider permitted model ids. A provider in `providers` with NO entry here
	 * runs every one of its models; a provider WITH an entry runs only the ids listed
	 * under its key (an empty entry permits none).
	 */
	allowlist: Record<string, string[]>;
	/** Explicit gate command. When unset the gate is detected from the project (a `.ledgerpi-gate` file, a Makefile test target, then the manifest). */
	gate: string | null;
	/** Manager -> worker round budget. */
	maxIters: number;
	/** Thinking level for the worker role. Bounded reasoning is one of the paper's mechanisms, so this is a knob. */
	workerThinking: ThinkingLevel;
	/** Thinking level for the manager role. */
	managerThinking: ThinkingLevel;
	/**
	 * Per-session-model worker model, keyed `"provider/modelId"` of the session and
	 * valued `"provider/modelId"` of the model the worker role spawns on. Deprecated
	 * alias of `[roleModel]`: a session model the alias does not map runs the worker on
	 * the table's reserved `default` worker, or on the session model when the table sets
	 * no default. Where both tables name a session model the `[roleModel]` entry wins,
	 * and an alias takes both roles, so it also outranks the default.
	 */
	workerModel: Record<string, string>;
	/**
	 * Per-model output-token cap for worker spawns, keyed `"provider/modelId"` of the
	 * model the worker runs on and valued by a positive integer. A worker whose model
	 * has no entry keeps the model's own default cap. Null-prototype map.
	 */
	workerMaxTokens: Record<string, number>;
	/**
	 * Role pinning and activation narrowing, keyed `"provider/modelId"` of the
	 * session and valued by the model each role spawns on; every entry names both
	 * the manager and the worker. `null` means the table is absent and activation
	 * stays allowlist-only; a non-null record (possibly empty) narrows activation to
	 * its entries and to the `[workerModel]` alias entries -- unless its reserved
	 * `default` is set, which widens activation back to every allowlisted model --
	 * and an entry's session model spawns the two roles on the entry's two models.
	 */
	roleModel: Record<string, { manager: string; worker: string }> | null;
	/**
	 * The reserved `default` entry of the `[roleModel]` table: the fallback pin for
	 * session models the table does not name, and an activation opt-in that widens
	 * the present table back to every allowlisted model. `null` when the table has no
	 * usable default (absent, or dropped as malformed).
	 */
	roleModelDefault: RolePin | null;
	/**
	 * `[roleModel]` entry names dropped as malformed at load. A session model whose
	 * reference is listed here is inactive, and the status command names it as the
	 * reason.
	 */
	roleModelMalformed: string[];
	/**
	 * Whether to run the code-vs-chat classifier. False bypasses classification
	 * only: every eligible prompt is treated as code and goes on to `trigger` (asked
	 * under `ask`, run under `auto`, never under `manual`), while the unconditional
	 * guards still run -- a continuation-only prompt passes through untouched and
	 * escaped input (`/`, `!`, `@` prefix) never enters the loop.
	 */
	classifier: boolean;
	/** How the `input` hook starts the loop on an eligible prompt: ask first, run automatically, or never. */
	trigger: InputTrigger;
	/**
	 * Trigger mode for skill/slash-driven sessions. Off by default: the loop's cost
	 * should not be always-on (the A/B never cleared the adoption bar). `redirect`
	 * blocks the first inline edit in such a session and steers the model to
	 * `ledger_solve`.
	 */
	autoTrigger: AutoTrigger;
	/** Opt-in concurrent workers: `off` (default), `advise` (record the manager's recommendation only), `ask` (act on it after the user confirms), or `on`. */
	fanout: FanoutSetting;
	/** Most concurrent workers on one round, an integer from 2 to 8. */
	fanoutMax: number;
	/**
	 * Slash-command names (as typed, without the leading `/`) whose sessions the
	 * `redirect` mechanism arms for. Only consulted when `autoTrigger = "redirect"`.
	 * Empty is fail-closed: redirect arms nothing until a skill is listed. `"*"` arms
	 * every skill/slash session. This is the allowlist that keeps the redirect off
	 * non-coding skills (`/create-worktree`, `/report-task`, ...) on an in-scope model.
	 * Matches markdown skill/prompt-template commands (whose raw `/name` reaches the
	 * input hook before expansion), not extension-registered commands, which pi
	 * dispatches before any input event -- list the former.
	 */
	redirectSkills: string[];
	/**
	 * The `[claude]` section: the opt-in for running the loop under Claude Code and
	 * the model each role runs on there. `null` means inert under Claude Code, which
	 * an absent table, a table that is not one, and top-level `enabled = false` all
	 * produce. It has no effect on pi.
	 */
	claude: ClaudeConfig | null;
	/** Top-level `enabled = false` was set: the file switches the loop off on both harnesses. */
	switchedOff: boolean;
	/** Root for per-session ledger state. */
	stateDir: string;
	/** Durable, append-only audit log (one JSON row per run). Defaults to `runs.jsonl` under stateDir. */
	auditLog: string;
	/** Per manager/worker call timeout, milliseconds. */
	callTimeoutMs: number;
	/** Gate command timeout, milliseconds. */
	gateTimeoutMs: number;
	/** notes.md character budget. */
	notesMaxChars: number;
	/** plan.md character budget. */
	planMaxChars: number;
	/** Problems found while loading the config file, in order. The extension reports them once, at session start. */
	warnings: string[];
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * The tracked config path. Resolution: an explicit `LEDGERPI_CONFIG` full-path
 * override (the operational override and test seam, mirroring `LEDGERPI_STATE_DIR`),
 * then `$XDG_CONFIG_HOME/ledgerpi/config.toml`, then `~/.config/ledgerpi/config.toml`.
 */
export function configPath(): string {
	const override = process.env.LEDGERPI_CONFIG;
	if (override && override.trim() !== "") return override;
	const xdg = process.env.XDG_CONFIG_HOME;
	const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".config");
	return join(base, "ledgerpi", "config.toml");
}

/**
 * The operational knobs only -- everything EXCEPT the activation policy
 * (`enabled`/`providers`/`allowlist`). Built at load time so `stateDir` tracks
 * `agentDir()`. Splitting these out is the point of the fail-closed design: the
 * activation policy can never default silently to a built-in provider list; it
 * comes only from a valid config file.
 */
interface OperationalDefaults {
	gate: string | null;
	maxIters: number;
	workerThinking: ThinkingLevel;
	managerThinking: ThinkingLevel;
	workerModel: Record<string, string>;
	workerMaxTokens: Record<string, number>;
	roleModel: Record<string, { manager: string; worker: string }> | null;
	roleModelDefault: RolePin | null;
	roleModelMalformed: string[];
	classifier: boolean;
	trigger: InputTrigger;
	autoTrigger: AutoTrigger;
	fanout: FanoutSetting;
	fanoutMax: number;
	redirectSkills: string[];
	claude: ClaudeConfig | null;
	switchedOff: boolean;
	stateDir: string;
	auditLog: string;
	callTimeoutMs: number;
	gateTimeoutMs: number;
	notesMaxChars: number;
	planMaxChars: number;
}

function operationalDefaults(): OperationalDefaults {
	return {
		gate: null,
		maxIters: 8,
		workerThinking: "high",
		managerThinking: "high",
		workerModel: Object.create(null) as Record<string, string>,
		workerMaxTokens: Object.create(null) as Record<string, number>,
		roleModel: null,
		roleModelDefault: null,
		roleModelMalformed: [],
		classifier: true,
		trigger: "ask",
		autoTrigger: "off",
		fanout: "off",
		fanoutMax: FANOUT_MAX_DEFAULT,
		redirectSkills: [],
		claude: null,
		switchedOff: false,
		stateDir: join(agentDir(), "ledgerpi"),
		auditLog: join(agentDir(), "ledgerpi", "runs.jsonl"),
		callTimeoutMs: 300_000,
		gateTimeoutMs: 180_000,
		notesMaxChars: 8_000,
		planMaxChars: 4_000,
	};
}

/** The fail-closed result: loaded but inert. Every gate passes through and the tool is not registered. */
function inertConfig(ops: OperationalDefaults, warnings: string[]): LedgerpiConfig {
	return {
		enabled: false,
		providers: [],
		allowlist: Object.create(null) as Record<string, string[]>,
		...ops,
		warnings,
	};
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function coerceThinking(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : fallback;
}

const INPUT_TRIGGERS = new Set(["ask", "auto", "manual"]);

function coerceInputTrigger(value: unknown, fallback: InputTrigger): InputTrigger {
	return typeof value === "string" && INPUT_TRIGGERS.has(value) ? (value as InputTrigger) : fallback;
}

const AUTO_TRIGGERS = new Set(["off", "redirect"]);

function coerceAutoTrigger(value: unknown, fallback: AutoTrigger): AutoTrigger {
	return typeof value === "string" && AUTO_TRIGGERS.has(value) ? (value as AutoTrigger) : fallback;
}

const FANOUT_SETTINGS = new Set<string>(FANOUT_ORDER);

/** `value` as a fan-out setting (surrounding whitespace ignored), or undefined when it is absent or not off/advise/on. */
export function asFanoutSetting(value: unknown): FanoutSetting | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return FANOUT_SETTINGS.has(trimmed) ? (trimmed as FanoutSetting) : undefined;
}

function coerceFanout(value: unknown, fallback: FanoutSetting): FanoutSetting {
	return asFanoutSetting(value) ?? fallback;
}

function coerceFanoutMax(value: unknown, fallback: number, warnings: string[]): number {
	if (value === undefined) return fallback;
	if (Number.isInteger(value) && (value as number) >= FANOUT_MAX_MIN && (value as number) <= FANOUT_MAX_MAX) {
		return value as number;
	}
	warnings.push(
		`[ledgerpi] fanoutMax must be an integer from ${FANOUT_MAX_MIN} to ${FANOUT_MAX_MAX}; using ${fallback}`,
	);
	return fallback;
}

/**
 * Parse the `[allowlist]` table into a null-prototype `Record<string, string[]>`.
 * Absent -> empty (every in-scope provider unrestricted). A present-but-malformed
 * table (not a table, or any value not an array of strings) returns null so the
 * loader can fail closed rather than silently drop a user's restriction. The map
 * is null-prototype so a provider named like an Object member (`constructor`,
 * `toString`) cannot resolve to an inherited property and make the scope check
 * throw.
 */
function parseAllowlist(value: unknown): Record<string, string[]> | null {
	const out: Record<string, string[]> = Object.create(null);
	if (value === undefined) return out;
	// Require a plain table: smol-toml returns a Date subclass for a bare TOML
	// datetime, which is an object with no enumerable entries and would otherwise
	// pass as an empty allowlist instead of failing closed.
	if (!isPlainTable(value)) return null;
	for (const [provider, ids] of Object.entries(value as Record<string, unknown>)) {
		if (!Array.isArray(ids) || !ids.every((m) => typeof m === "string")) return null;
		out[provider] = ids as string[];
	}
	return out;
}

const MODEL_REF_RE = /^[^/\s]+\/\S+$/;

/**
 * True for a plain object table: an object (not an array) whose prototype is
 * `Object.prototype` or null. smol-toml returns a Date subclass for a bare TOML
 * datetime, which must not pass as a table.
 */
function isPlainTable(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Parse the `[workerMaxTokens]` table into a null-prototype `Record<string, number>`.
 * An operational knob, not activation policy: a malformed table or entry is reported
 * and dropped (that worker keeps its model's default cap) instead of making the
 * config inert. Each key must be `"provider/modelId"` and each value a positive
 * safe integer.
 */
function parseWorkerMaxTokens(value: unknown, path: string, warnings: string[]): Record<string, number> {
	const out: Record<string, number> = Object.create(null);
	if (value === undefined) return out;
	if (!isPlainTable(value)) {
		warnings.push(`[ledgerpi] ${path} has a malformed [workerMaxTokens]; workers keep their model's default cap`);
		return out;
	}
	for (const [model, cap] of Object.entries(value as Record<string, unknown>)) {
		if (!MODEL_REF_RE.test(model) || !Number.isSafeInteger(cap) || (cap as number) <= 0) {
			warnings.push(
				`[ledgerpi] ignoring malformed [workerMaxTokens] entry "${model}"; expected "provider/modelId" = <positive integer>`,
			);
			continue;
		}
		out[model] = cap as number;
	}
	return out;
}

/**
 * Parse the `[workerModel]` table into a null-prototype `Record<string, string>`.
 * It is an operational knob, not activation policy, so a malformed table or entry
 * is reported and dropped (the worker then runs on the session model) instead of
 * making the config inert. Both key and value must be `"provider/modelId"`.
 */
function parseWorkerModel(value: unknown, path: string, warnings: string[]): Record<string, string> {
	const out: Record<string, string> = Object.create(null);
	if (value === undefined) return out;
	if (!isPlainTable(value)) {
		warnings.push(`[ledgerpi] ${path} has a malformed [workerModel]; workers run on the session model`);
		return out;
	}
	for (const [session, worker] of Object.entries(value as Record<string, unknown>)) {
		if (!MODEL_REF_RE.test(session) || typeof worker !== "string" || !MODEL_REF_RE.test(worker)) {
			warnings.push(
				`[ledgerpi] ignoring malformed [workerModel] entry "${session}"; expected "provider/modelId" = "provider/modelId"`,
			);
			continue;
		}
		out[session] = worker;
	}
	return out;
}

/**
 * The warning for a dropped `[roleModel]` entry: the shape to write instead and the
 * consequence for that session model, which depends on whether a `[workerModel]`
 * alias still opts it in.
 */
const malformedRoleEntryWarning = (ref: string, aliasKeepsActive: boolean) =>
	`[ledgerpi] ignoring malformed [roleModel] entry "${ref}"; expected { manager = "provider/modelId", worker = "provider/modelId" } -- ${
		aliasKeepsActive
			? "the deprecated [workerModel] alias keeps this session model active with the manager on the session model"
			: "this session model stays inactive"
	}`;

/**
 * Warn about sub-keys of a `[roleModel]` entry that name no role, naming the entry by
 * `label` (its `provider/modelId`, or `[roleModel] default`). Shared by the named-entry
 * and default paths so the message text is single-sourced; a stray sub-key is
 * reported but does not by itself drop the entry.
 */
function warnUnknownRoleSubKeys(fields: Record<string, unknown>, where: string, warnings: string[]): void {
	for (const sub of Object.keys(fields)) {
		if (sub !== "manager" && sub !== "worker") {
			warnings.push(`[ledgerpi] ignoring unknown sub-key "${sub}" in ${where}`);
		}
	}
}

/**
 * The warning for a dropped `[roleModel]` default: the shape to write instead and the
 * consequence, which depends on what still opts a session model in -- a named entry
 * keeps the table narrowing to its own keys, the deprecated `[workerModel]` alias keeps
 * its own models active on their worker pin, and a table with neither opts no session
 * model in at all.
 */
const malformedRoleDefaultWarning = (hasNamedEntries: boolean, hasAliasEntries: boolean): string => {
	const consequence = hasNamedEntries
		? "named [roleModel] entries still apply"
		: hasAliasEntries
			? "no [roleModel] entry names a session model; only the [workerModel] aliases opt a model in"
			: "no [roleModel] entry names a session model, so none is opted in";
	return `[ledgerpi] ignoring malformed [roleModel] default; expected a table naming at least one of manager/worker as "provider/modelId" -- ${consequence}`;
};

/**
 * Parse the reserved `default` entry of the `[roleModel]` table: the fallback role
 * pin for session models the table does not name. Kept only when it is a plain table
 * naming at least one of `manager`/`worker` as a `"provider/modelId"` reference; a
 * role it omits is `null` (the session model). Any other shape reports `malformed`
 * and drops the default, leaving `null`, so a malformed default never makes the
 * config inert and never lands in the malformed entry list. The caller warns, because
 * only it knows whether any named entry survived to narrow the table instead.
 */
function parseRoleDefault(value: unknown, warnings: string[]): { pin: RolePin | null; malformed: boolean } {
	if (!isPlainTable(value)) return { pin: null, malformed: true };
	const fields = value as Record<string, unknown>;
	warnUnknownRoleSubKeys(fields, '[roleModel] entry "[roleModel] default"', warnings);
	const manager = fields.manager;
	const worker = fields.worker;
	const validRef = (ref: unknown): ref is string => typeof ref === "string" && MODEL_REF_RE.test(ref);
	if (
		(manager === undefined && worker === undefined) ||
		(manager !== undefined && !validRef(manager)) ||
		(worker !== undefined && !validRef(worker))
	) {
		return { pin: null, malformed: true };
	}
	return {
		pin: { manager: validRef(manager) ? manager : null, worker: validRef(worker) ? worker : null },
		malformed: false,
	};
}

/**
 * Parse the `[roleModel]` table. Absent (`undefined`) -> `null` (no table; activation
 * stays allowlist-only). A present key yields a null-prototype
 * `Record<string, { manager: string; worker: string }>` plus the names of the
 * entries dropped as malformed and the reserved `default` pin (or null): a
 * present-but-not-a-table value fails closed to an empty table with a warning (the
 * key is present, so the narrowing gate is on and no session model is opted in), and
 * an entry is kept only when its key and both `manager` and `worker` values are
 * `"provider/modelId"` references; any other shape drops just that entry with a
 * warning naming it, and a malformed table or entry never makes the config inert.
 * `aliasKeys` names the session models the deprecated `[workerModel]` alias still
 * opts in, so a dropped entry's warning can state the real consequence for that
 * model. The literal `default` key is reserved before the reference test, so it is a
 * fallback pin rather than an entry keyed by a model.
 */
function parseRoleModel(
	value: unknown,
	path: string,
	warnings: string[],
	aliasKeys: ReadonlySet<string>,
): {
	table: Record<string, { manager: string; worker: string }> | null;
	malformed: string[];
	defaultEntry: RolePin | null;
} {
	const malformed: string[] = [];
	if (value === undefined) return { table: null, malformed, defaultEntry: null };
	const table: Record<string, { manager: string; worker: string }> = Object.create(null);
	let defaultEntry: RolePin | null = null;
	let defaultMalformed = false;
	if (!isPlainTable(value)) {
		warnings.push(`[ledgerpi] ${path} has a malformed [roleModel]; no session model is opted in`);
		return { table, malformed, defaultEntry };
	}
	for (const [ref, entry] of Object.entries(value as Record<string, unknown>)) {
		if (ref === "default") {
			const parsed = parseRoleDefault(entry, warnings);
			defaultEntry = parsed.pin;
			defaultMalformed = parsed.malformed;
			continue;
		}
		const aliasKeepsActive = aliasKeys.has(ref);
		if (!MODEL_REF_RE.test(ref) || !isPlainTable(entry)) {
			malformed.push(ref);
			warnings.push(malformedRoleEntryWarning(ref, aliasKeepsActive));
			continue;
		}
		const fields = entry as Record<string, unknown>;
		warnUnknownRoleSubKeys(fields, `[roleModel] entry "${ref}"`, warnings);
		const { manager, worker } = fields as { manager: unknown; worker: unknown };
		if (
			typeof manager !== "string" ||
			!MODEL_REF_RE.test(manager) ||
			typeof worker !== "string" ||
			!MODEL_REF_RE.test(worker)
		) {
			malformed.push(ref);
			warnings.push(malformedRoleEntryWarning(ref, aliasKeepsActive));
			continue;
		}
		table[ref] = { manager, worker };
	}
	// The consequence of a dropped default depends on whether any named entry survived,
	// so it is stated here, where the parsed table is known.
	if (defaultMalformed) warnings.push(malformedRoleDefaultWarning(Object.keys(table).length > 0, aliasKeys.size > 0));
	return { table, malformed, defaultEntry };
}

/**
 * Env overrides for the state dir and audit log win over defaults and the config
 * file, so concurrent runs (e.g. an A/B harness launching many sessions at once)
 * can each isolate their ledger state and audit log. Applied at every exit of
 * loadConfig. The audit log tracks stateDir unless it was set explicitly (via the
 * config file, signalled by `auditSet`, or the env var), so overriding stateDir
 * alone still relocates the audit log with it.
 */
function applyEnvOverrides(cfg: LedgerpiConfig, auditSet: boolean): LedgerpiConfig {
	const envDir = process.env.LEDGERPI_STATE_DIR;
	if (envDir && envDir.trim() !== "") cfg.stateDir = envDir;
	const envAudit = process.env.LEDGERPI_AUDIT_LOG;
	if (envAudit && envAudit.trim() !== "") cfg.auditLog = envAudit;
	else if (!auditSet) cfg.auditLog = join(cfg.stateDir, "runs.jsonl");
	return cfg;
}

/**
 * One-time pointer for users still on the retired `~/.pi/agent/ledgerpi.json`. That
 * JSON file is no longer honored -- fail-closed is the point -- so this only nudges a
 * migration when the new TOML is absent, rather than letting an existing user
 * silently go inert with no explanation.
 */
let legacyWarned = false;
function warnLegacy(warnings: string[]): void {
	if (legacyWarned) return;
	const legacy = join(agentDir(), "ledgerpi.json");
	if (existsSync(legacy)) {
		legacyWarned = true;
		warnings.push(`[ledgerpi] ${legacy} is no longer read; move config to ${configPath()} (TOML). See the README.`);
	}
}

/** A full Claude model id: an alias such as `opus` floats between models, so it is refused. */
const CLAUDE_MODEL_ID = /^claude-[a-z0-9.[\]-]*\d[a-z0-9.[\]-]*$/;

/** One `[claude]` role: the configured id when valid, else the default with a warning. */
function claudeRole(
	table: Record<string, unknown>,
	role: keyof ClaudeRoles,
	fallback: string,
	warnings: string[],
): { id: string; source: "config" | "default" } {
	const value = table[role];
	if (typeof value === "string" && CLAUDE_MODEL_ID.test(value)) return { id: value, source: "config" };
	if (value !== undefined) {
		warnings.push(`[ledgerpi] [claude] ${role} must be a full claude-* model id; using ${fallback}`);
	}
	return { id: fallback, source: "default" };
}

/**
 * Parse the `[claude]` table. Absent returns null, keeping Claude Code inert; a value
 * that is not a table warns and does the same. A bad role falls back to its default
 * rather than disabling the loop, and never affects pi.
 */
function parseClaude(value: unknown, path: string, warnings: string[]): ClaudeConfig | null {
	if (value === undefined) return null;
	if (!isPlainTable(value)) {
		warnings.push(`[ledgerpi] ${path} has a malformed [claude]; inert under Claude Code`);
		return null;
	}
	const table = value as Record<string, unknown>;
	warnUnknownRoleSubKeys(table, "[claude]", warnings);
	const manager = claudeRole(table, "manager", CLAUDE_MANAGER_DEFAULT, warnings);
	const worker = claudeRole(table, "worker", CLAUDE_WORKER_DEFAULT, warnings);
	return {
		manager: manager.id,
		worker: worker.id,
		sources: { manager: manager.source, worker: worker.source },
	};
}

const KNOWN_KEYS = new Set([
	"enabled",
	"providers",
	"allowlist",
	"gate",
	"maxIters",
	"workerThinking",
	"managerThinking",
	"workerModel",
	"workerMaxTokens",
	"roleModel",
	"classifier",
	"trigger",
	"autoTrigger",
	"fanout",
	"fanoutMax",
	"redirectSkills",
	"claude",
	"stateDir",
	"auditLog",
	"callTimeoutMs",
	"gateTimeoutMs",
	"notesMaxChars",
	"planMaxChars",
]);

/**
 * Reads the tracked TOML config over the operational defaults. Fail-closed: an
 * absent, non-regular (a directory or FIFO), or unreadable path, a malformed file,
 * or one that names no providers and has no `[claude]` table returns an INERT config
 * (disabled, no providers) rather than a built-in provider list, so a missing or broken config never
 * silently activates the loop. A malformed file is reported once and ignored,
 * because failing to load config must never take the session down with it.
 * Unrecognized keys are skipped. Every problem is recorded in `warnings` rather
 * than printed, so loading writes nothing to the terminal. A file with a `[claude]`
 * table and no providers keeps pi inert while its operational knobs still apply.
 */
export function loadConfig(): LedgerpiConfig {
	const ops = operationalDefaults();
	const path = configPath();
	const warnings: string[] = [];

	const text = readRegularFile(path);
	if (text === undefined) {
		warnLegacy(warnings);
		warnings.push(`[ledgerpi] no usable ${path}; inert`);
		return applyEnvOverrides(inertConfig(ops, warnings), false);
	}

	let raw: Record<string, unknown>;
	try {
		raw = parseToml(text) as Record<string, unknown>;
	} catch (err) {
		warnings.push(`[ledgerpi] ignoring malformed ${path}: ${(err as Error).message}; inert`);
		return applyEnvOverrides(inertConfig(ops, warnings), false);
	}

	const providers =
		Array.isArray(raw.providers) && raw.providers.every((p) => typeof p === "string")
			? (raw.providers as string[])
			: [];
	const claude = parseClaude(raw.claude, path, warnings);
	if (providers.length === 0 && claude === null) {
		warnings.push(`[ledgerpi] ${path} defines no providers; inert`);
		return applyEnvOverrides(inertConfig(ops, warnings), false);
	}

	// The retired `[blocklist]` table is a scope policy with inverted meaning, so a
	// stale one must not silently widen access: its presence fails closed with the
	// migration path rather than reading as an absent (unrestricted) allowlist.
	const retiredPolicy = raw.blocklist !== undefined;
	if (retiredPolicy) {
		warnings.push(
			`[ledgerpi] ${path} uses the retired [blocklist]; rename it to [allowlist] -- a listed provider now runs only the models listed, and a provider with no entry runs all of them. Inert until migrated.`,
		);
		if (claude === null) return applyEnvOverrides(inertConfig(ops, warnings), false);
	}

	for (const key of Object.keys(raw)) {
		if (!KNOWN_KEYS.has(key)) warnings.push(`[ledgerpi] ignoring unknown config key "${key}"`);
	}

	// A malformed [allowlist] is a malformed activation policy: fail closed rather
	// than silently drop the user's restriction and run a model they meant to bar.
	const allowlist = parseAllowlist(raw.allowlist);
	if (allowlist === null) {
		warnings.push(`[ledgerpi] ${path} has a malformed [allowlist]; inert`);
		if (claude === null) return applyEnvOverrides(inertConfig(ops, warnings), false);
	}

	// A valid file with providers is the single source of truth for activation:
	// enabled/providers/allowlist come from the file only (enabled defaults true),
	// and the operational knobs take field-level overrides over the defaults. A
	// provider-less file, or one whose pi policy failed closed, reaches here only for
	// its [claude] table, which those policies do not govern, so pi stays inert.
	const piProviders = retiredPolicy || allowlist === null ? [] : providers;
	const cfg: LedgerpiConfig = {
		...ops,
		enabled: piProviders.length > 0,
		providers: piProviders,
		allowlist: allowlist ?? (Object.create(null) as Record<string, string[]>),
		warnings,
	};
	cfg.switchedOff = raw.enabled === false;
	if (cfg.switchedOff) cfg.enabled = false;
	cfg.claude = cfg.switchedOff ? null : claude;
	if (typeof raw.gate === "string" || raw.gate === null) cfg.gate = raw.gate as string | null;
	if (typeof raw.maxIters === "number" && raw.maxIters > 0) cfg.maxIters = Math.floor(raw.maxIters);
	cfg.workerThinking = coerceThinking(raw.workerThinking, cfg.workerThinking);
	cfg.managerThinking = coerceThinking(raw.managerThinking, cfg.managerThinking);
	cfg.workerModel = parseWorkerModel(raw.workerModel, path, warnings);
	cfg.workerMaxTokens = parseWorkerMaxTokens(raw.workerMaxTokens, path, warnings);
	if (raw.workerModel !== undefined) {
		warnings.push(
			`[ledgerpi] [workerModel] is deprecated and will be removed in a later release; move each entry to [roleModel] as { manager = <session model>, worker = <mapped model> }`,
		);
	}
	const roleModel = parseRoleModel(raw.roleModel, path, warnings, new Set(Object.keys(cfg.workerModel)));
	cfg.roleModel = roleModel.table;
	cfg.roleModelDefault = roleModel.defaultEntry;
	cfg.roleModelMalformed = roleModel.malformed;
	// The both-tables conflict is computed on the parsed tables, so it names only the
	// keys where a [roleModel] entry actually survives to take precedence over the
	// alias. A key whose [roleModel] entry was dropped stays served by its alias.
	if (cfg.roleModel !== null) {
		for (const key of Object.keys(cfg.workerModel)) {
			if (key in cfg.roleModel) {
				warnings.push(`[ledgerpi] "${key}" is in both [workerModel] and [roleModel]; [roleModel] wins`);
			}
		}
	}
	if (typeof raw.classifier === "boolean") cfg.classifier = raw.classifier;
	cfg.trigger = coerceInputTrigger(raw.trigger, cfg.trigger);
	cfg.autoTrigger = coerceAutoTrigger(raw.autoTrigger, cfg.autoTrigger);
	cfg.fanout = coerceFanout(raw.fanout, cfg.fanout);
	cfg.fanoutMax = coerceFanoutMax(raw.fanoutMax, cfg.fanoutMax, warnings);
	if (Array.isArray(raw.redirectSkills) && raw.redirectSkills.every((s) => typeof s === "string")) {
		cfg.redirectSkills = raw.redirectSkills as string[];
	}
	if (typeof raw.stateDir === "string" && raw.stateDir.trim() !== "") cfg.stateDir = raw.stateDir;
	const auditSet = typeof raw.auditLog === "string" && raw.auditLog.trim() !== "";
	if (auditSet) cfg.auditLog = raw.auditLog as string;
	if (typeof raw.callTimeoutMs === "number" && raw.callTimeoutMs > 0) cfg.callTimeoutMs = raw.callTimeoutMs;
	if (typeof raw.gateTimeoutMs === "number" && raw.gateTimeoutMs > 0) cfg.gateTimeoutMs = raw.gateTimeoutMs;
	if (typeof raw.notesMaxChars === "number" && raw.notesMaxChars > 0) cfg.notesMaxChars = raw.notesMaxChars;
	if (typeof raw.planMaxChars === "number" && raw.planMaxChars > 0) cfg.planMaxChars = raw.planMaxChars;

	return applyEnvOverrides(cfg, auditSet);
}

/**
 * Whether the `[allowlist]` permits `modelId` on `provider`: a provider with no
 * entry is unrestricted, a provider with an entry is limited to exactly the ids
 * listed (an empty entry permits none).
 */
export function modelAllowlisted(cfg: LedgerpiConfig, provider: string, modelId: string | undefined): boolean {
	const allowed = cfg.allowlist[provider];
	if (allowed === undefined) return true;
	return allowed.includes(modelId ?? "");
}

/**
 * Whether the loop should activate for this provider+model: enabled, the provider
 * in scope, the model permitted by that provider's allowlist, and -- when a
 * `[roleModel]` table is present -- the session model opted in by a `[roleModel]`
 * entry, a `[workerModel]` alias entry, or (via the reserved `default` entry) the
 * table's default fallback. This is the single activation gate.
 */
export function inScope(cfg: LedgerpiConfig, provider: string | undefined, modelId: string | undefined): boolean {
	return scopeReason(cfg, provider, modelId) === "in-scope";
}

/**
 * The first failing scope predicate for this provider+model, or "in-scope": a
 * disabled config, a provider outside the config, a model the provider allowlist
 * denies, then -- under a present `[roleModel]` table -- a session model no entry
 * names (a dropped entry reads as malformed before the no-entry catch-all). A
 * present `[roleModel] default` opts every allowlisted model in, but only after the
 * malformed check, so a model whose own entry was dropped stays inactive. The
 * ordered decision list behind `inScope`, shared by the status output and the
 * tests instead of re-deriving the gate.
 */
export function scopeReason(
	cfg: LedgerpiConfig,
	provider: string | undefined,
	modelId: string | undefined,
): "disabled" | "out-of-scope" | "not-allowlisted" | "no-role-entry" | "malformed-role-entry" | "in-scope" {
	if (!cfg.enabled) return "disabled";
	if (!provider || !cfg.providers.includes(provider)) return "out-of-scope";
	if (!modelAllowlisted(cfg, provider, modelId)) return "not-allowlisted";
	const ref = modelRef(provider, modelId);
	if (cfg.roleModel === null) return "in-scope";
	if (ref === null) return "no-role-entry";
	if (ref in cfg.roleModel) return "in-scope";
	if (ref in cfg.workerModel) return "in-scope";
	if (cfg.roleModelMalformed.includes(ref)) return "malformed-role-entry";
	// The default re-widens activation to every allowlisted model, but the malformed
	// check above outranks it: a model whose own entry was dropped stays inactive.
	// Once a default is present this catch-all is therefore unreachable for any
	// non-null ref (the null ref returned above), and it stays reachable only for a
	// table with no entry, no alias, no malformed entry, and no default -- intended,
	// not a dead branch.
	if (cfg.roleModelDefault !== null) return "in-scope";
	return "no-role-entry";
}

/** The canonical `provider/modelId` reference for a model, or null when either part is unknown. */
export function modelRef(provider: string | undefined, modelId: string | undefined): string | null {
	return provider && modelId ? `${provider}/${modelId}` : null;
}

/**
 * The model each role spawns on for this session model, or null when the scope
 * gate denies activation. `source "roleModel"`: both roles take the `[roleModel]`
 * entry for `provider/modelId`. `source "workerModel"`: the table is present but
 * names no entry for the session model while the deprecated `[workerModel]` alias
 * does, so the manager stays on the session model (null) and the worker takes the
 * alias value. `source "roleModelDefault"`: nothing else names the session model and
 * the table has a reserved `default` entry, whose roles apply (a role it omits is
 * null). `source "session"`: nothing names either role; both are null, which means
 * the session model.
 */
export function roleModelsFor(
	cfg: LedgerpiConfig,
	provider: string | undefined,
	modelId: string | undefined,
): (RolePin & { source: RoleSource }) | null {
	if (!inScope(cfg, provider, modelId)) return null;
	const ref = modelRef(provider, modelId);
	const entry = cfg.roleModel !== null && ref !== null && ref in cfg.roleModel ? cfg.roleModel[ref] : undefined;
	if (entry !== undefined) return { manager: entry.manager, worker: entry.worker, source: "roleModel" };
	const alias = workerModelFor(cfg, provider, modelId);
	if (alias !== null) return { manager: null, worker: alias, source: "workerModel" };
	if (cfg.roleModelDefault !== null) {
		return {
			manager: cfg.roleModelDefault.manager,
			worker: cfg.roleModelDefault.worker,
			source: "roleModelDefault",
		};
	}
	return { manager: null, worker: null, source: "session" };
}

/**
 * The deprecated `[workerModel]` alias entry for this session model, or null to
 * run the worker on the session model. A plain alias-table lookup with no scope
 * gate: `roleModelsFor` is the gated role lookup, prefers a `[roleModel]` entry
 * when both tables name the session model, and reads the alias through here.
 */
export function workerModelFor(
	cfg: LedgerpiConfig,
	provider: string | undefined,
	modelId: string | undefined,
): string | null {
	const ref = modelRef(provider, modelId);
	return ref !== null ? (cfg.workerModel[ref] ?? null) : null;
}

/**
 * Whether the `redirect` mechanism should arm for a session launched by `command`
 * (a slash-command name without the leading `/`, or undefined when none was seen).
 * pi's `skill:` command prefix is ignored on both sides, so `/skill:review-task` and
 * `/review-task` both match a `"review-task"` entry. Fail-closed: an empty
 * `redirectSkills` arms nothing. `"*"` arms every session.
 */
export function redirectSkillAllowed(cfg: LedgerpiConfig, command: string | undefined): boolean {
	if (cfg.redirectSkills.includes("*")) return true;
	if (command === undefined) return false;
	const bare = (name: string) => name.replace(/^skill:/, "");
	return cfg.redirectSkills.some((entry) => bare(entry) === bare(command));
}

/** True when this process should stay out of the way regardless of config (the A/B off switch). */
export function disabledByEnv(): boolean {
	return process.env.LEDGERPI === "0";
}
