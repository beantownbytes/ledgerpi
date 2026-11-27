import type { LockHolder } from "../../core/src/lock.ts";
import { ABORTED_HANDOFF } from "../../core/src/solve.ts";
import type { DshInactiveReason, DshSolveOutcome, LedgerpiService } from "../api.d.ts";
import {
	type DshAgent,
	type DshToolDefinition,
	type DshToolPluginContext,
	type DshToolRunContext,
	LEDGER_TOOL,
} from "./dsh.ts";

const DESCRIPTION =
	"Delegate a bounded, self-contained implementation task to a ledger-based manager-worker loop " +
	"in fresh contexts. The loop plans, decomposes the work, edits files in the working tree, and " +
	"runs the project's test gate as ground truth, then returns a summary of what it did, the gate " +
	"verdict, and the changed files. The edits are ALREADY APPLIED to the working tree when it " +
	"returns: do not redo them; read the summary, verify, and continue. If it stopped without a " +
	"passing gate, finish the remaining tasks it lists. Call this only when the user or a skill " +
	"asks for it. Pass a model argument only when the request names a model for that role; never " +
	"choose one.";

const PARAMETERS = {
	task: {
		type: "string",
		description:
			"The self-contained implementation task, phrased as a concrete instruction: what to build " +
			"or fix and the success criterion.",
	},
	cwd: {
		type: "string",
		description:
			"Absolute path to the repository or worktree to work in. Defaults to the session working " +
			"directory. Pass the worktree path when the change must land in a carved worktree.",
	},
	plan_file: {
		type: "string",
		description:
			"Absolute path to an approved implementation plan. When given, the loop skips its own " +
			"planning and ideation and the manager builds the task list from this plan.",
	},
	fanout: {
		type: "string",
		description:
			"Optional concurrent-worker setting for this call: 'off', 'advise', 'ask' or 'on'. It can " +
			"only lower the configured `fanout` setting (off < advise < ask < on), never raise it; any " +
			"other value is ignored. Here 'ask' runs as no-ui: there is no dialog, so a best-of-n " +
			"recommendation runs serially.",
	},
	manager_model: {
		type: "string",
		description:
			"The `provider/modelId` the manager runs on for this call. Pass it only when the request " +
			"names a model for the manager.",
	},
	worker_model: {
		type: "string",
		description:
			"The `provider/modelId` the workers run on for this call. Pass it only when the request " +
			"names a model for the workers.",
	},
};

type Argument = keyof typeof PARAMETERS;

/** How a tool call ended: as the service's call did, or without one for unusable arguments. */
type ToolOutcome = "bad-arguments" | DshSolveOutcome["kind"];

interface ToolValue {
	outcome: ToolOutcome;
	text: string;
}

const OUTCOMES: readonly ToolOutcome[] = ["bad-arguments", "inactive", "rejected", "canceled", "busy", "ran", "failed"];

const INACTIVE_TEXT: Record<DshInactiveReason, string> = {
	"env-disabled": "disabled by LEDGERPI=0",
	"switched-off": "disabled by enabled = false in the ledgerpi config",
	"no-dsh-table": "no usable [dsh] section in the ledgerpi config",
	"no-preset-registry": "this profile has no agent preset registry",
};

/** The parameter name of each rejected request field that is spelled differently here. */
const FIELD_PARAMETERS: Readonly<Record<string, Argument>> = {
	planFile: "plan_file",
	managerModel: "manager_model",
	workerModel: "worker_model",
};

/** Say why nothing is doing the task, so the work falls back to the caller. */
function punt(reason: string): string {
	return `${/[.!?]$/.test(reason) ? reason : `${reason}.`} Implement the task directly.`;
}

/** A rejection's message, naming the argument at fault as this tool spells it. */
function rejectionText({ message, field }: { message: string; field?: string }): string {
	if (field === undefined) return message;
	const parameter = FIELD_PARAMETERS[field] ?? field;
	const named = message.replaceAll(`\`${field}\``, `\`${parameter}\``);
	return named.includes(`\`${parameter}\``) ? named : `\`${parameter}\`: ${named}`;
}

/** The text for a work tree another loop holds. It does not invite the caller to edit beside that loop. */
function busyText(root: string, holder: LockHolder | null): string {
	const pid = holder === null ? "" : ` (pid ${holder.pid})`;
	return `Another ledger loop${pid} is editing \`${root}\`. Wait for it to finish, and leave this tree alone until then.`;
}

/** What the calling model reads for how a call ended, warnings aside. */
function outcomeText(outcome: DshSolveOutcome): string {
	switch (outcome.kind) {
		case "inactive":
			return punt(`ledgerpi is inactive: ${INACTIVE_TEXT[outcome.reason]}`);
		case "rejected":
			return punt(rejectionText(outcome));
		case "failed":
			return punt(`The ledger run failed: ${outcome.message}`);
		case "canceled":
			return ABORTED_HANDOFF;
		case "busy":
			return busyText(outcome.root, outcome.holder);
		case "ran":
			return outcome.handoff;
	}
}

type Arguments = { values: Partial<Record<Argument, string>> } | { problem: string };

const isArgument = (key: string): key is Argument => Object.hasOwn(PARAMETERS, key);

/** The model's arguments, or what is wrong with them. */
function readArguments(args: unknown): Arguments {
	const prototype = typeof args === "object" && args !== null ? Object.getPrototypeOf(args) : undefined;
	if (prototype !== Object.prototype && prototype !== null) return { problem: "The arguments are not an object." };
	const entries = Object.entries(args as object);
	const unknown = entries.find(([key]) => !isArgument(key));
	if (unknown) return { problem: `Unknown argument \`${unknown[0]}\`.` };
	const mistyped = entries.find(([, value]) => typeof value !== "string");
	if (mistyped) return { problem: `Argument \`${mistyped[0]}\` must be a string.` };
	return { values: Object.fromEntries(entries) };
}

/** Run one tool call as a `solve` for the calling agent. */
async function execute(service: LedgerpiService, args: unknown, exec: DshToolRunContext): Promise<ToolValue> {
	const read = readArguments(args);
	if ("problem" in read) return { outcome: "bad-arguments", text: punt(read.problem) };
	const { task = "", cwd, plan_file, fanout, manager_model, worker_model } = read.values;
	const outcome = await service.solve({
		// `solve` rejects a call made outside an agent as `no-parent`.
		parent: exec.agent as DshAgent,
		task,
		cwd,
		planFile: plan_file,
		fanout,
		managerModel: manager_model,
		workerModel: worker_model,
		signal: exec.signal,
		entry: "tool",
	});
	return { outcome: outcome.kind, text: [outcomeText(outcome), ...outcome.warnings].join("\n") };
}

function solveTool(service: LedgerpiService): DshToolDefinition<ToolValue> {
	return {
		name: LEDGER_TOOL,
		description: DESCRIPTION,
		parameters: { type: "object", properties: PARAMETERS, required: ["task"], additionalProperties: false },
		output: {
			schema: {
				type: "object",
				properties: { outcome: { type: "string", enum: OUTCOMES }, text: { type: "string" } },
				required: ["outcome", "text"],
				additionalProperties: false,
			},
			render: (_args, value) => [{ type: "text", text: value.text }],
		},
		execute: (args, exec) => execute(service, args, exec),
	};
}

/** Whether `agent` may call the tool now: the service is active and the agent is not one of its children. */
function offered(service: LedgerpiService, agent: { readonly id: string }): boolean {
	try {
		return service.status().active && !service.isLedgerChild(agent.id);
	} catch {
		return false;
	}
}

/** The preset row plugin: registers `ledger_solve` over the `ledgerpi` service. */
export default {
	name: "ledgerpi-tool",
	inject: ["ledgerpi", "tools"],
	apply(ctx: DshToolPluginContext): void {
		const service = ctx.ledgerpi;
		ctx.tools.register(solveTool(service), { when: ({ agent }) => offered(service, agent) });
	},
};
