import type { EngineInterface, Register } from "claude-code";
import { Dispatcher, type Engine, ROLE_AGENTS } from "../src/dispatch.ts";

const TOOL_NAME = "ledger_solve";
const TOOL = `mcp__ledgerpi__${TOOL_NAME}`;

const DESCRIPTION =
	"Delegate a bounded, self-contained implementation task to a ledger-based manager-worker loop " +
	"in fresh contexts. The loop plans, decomposes the work, edits files in the working tree, and " +
	"runs the project's test gate as ground truth, then returns a summary of what it did, the gate " +
	"verdict, and the changed files. The edits are ALREADY APPLIED to the working tree when it " +
	"returns: do not redo them; read the summary, verify, and continue. If it stopped without a " +
	"passing gate, finish the remaining tasks it lists. Call this only when the user or a skill " +
	"asks for it.";

const INPUT_SCHEMA = {
	type: "object",
	properties: {
		task: {
			type: "string",
			description:
				"The self-contained implementation task, phrased as a concrete instruction: what to build " +
				"or fix and the success criterion.",
		},
		gate: {
			type: "string",
			description:
				"Optional override for the test command used as the success gate. Omit to auto-detect " +
				"(the repo's .ledgerpi-gate file, Makefile test target, pytest, npm/bun test, cargo, go).",
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
				"other value is ignored. Under Claude Code 'ask' runs as no-ui: there is no dialog, so a " +
				"best-of-n recommendation runs serially.",
		},
	},
	required: ["task"],
};

function engineOf($: EngineInterface): Engine {
	return {
		spawn: (step) => $.agent.spawn({ subagentType: step.agent, prompt: step.prompt, description: step.description }),
		stop: async (agentId) => {
			await $.tool.call({ tool: "TaskStop", task_id: agentId }).catch(() => undefined);
		},
		status: async (agentId) => (await $.agent.list()).find((a) => a.id === agentId)?.status,
		write: async (path, text) => {
			await $.fs.write(path, text);
		},
		setStatus: async (text) => {
			await $.ui.status(text);
		},
		sessionId: () => $.session.id(),
		stream: (request) => $.process.spawn(request),
	};
}

export const register: Register = (on) => {
	const dispatcher = new Dispatcher();

	on("session.start", async ($, e, next) => {
		const result = await next(e);
		try {
			const { exitCode, stdout } = await $.process.run(["ledgerctl", "status", "--json"]);
			if (exitCode === 0 && (JSON.parse(stdout) as { active: boolean }).active) {
				await $.tool.register({
					name: TOOL_NAME,
					description: DESCRIPTION,
					inputSchema: INPUT_SCHEMA,
					isDeferred: false,
				});
			}
		} catch {
			// No ledgerctl on PATH reads as not configured: the tool stays unregistered.
		}
		return result;
	});

	for (const agent of ROLE_AGENTS) on("agent.offer", { agent }, () => ({ isOffered: false }));

	on("agent.spawn", (_$, e, next) => {
		const step = dispatcher.spawning;
		if (step === null || !ROLE_AGENTS.includes(e.subagentType ?? "")) return next(e);
		return next({ ...e, model: step.model, cwd: step.cwd });
	});

	on("prompt.submit", (_$, e, next) => {
		const sender = /^<agent-message from="([^"]+)"/.exec(e.text)?.[1];
		return sender !== undefined && dispatcher.isOwnAgent(sender) ? { text: e.text } : next(e);
	});

	on("tool.check", { tool: "Agent" }, async (_$, e, next) => {
		const verdict = await next(e);
		const agent = (e.input as { subagent_type?: string }).subagent_type ?? "";
		const isOwnSpawn = dispatcher.spawning?.agent === agent && next.origin.plugin === "ledgerpi";
		return isOwnSpawn && verdict.decision === "ask" ? { decision: "allow" } : verdict;
	});

	on("turn.complete", async ($, e, next) => {
		const result = await next(e);
		if (e.agentId !== undefined) {
			const { answer, reason, durationMs, usage } = e;
			await dispatcher.turnComplete(engineOf($), e.agentId, { answer, reason, durationMs, usage });
		}
		return result;
	});

	on("tool.call", { tool: TOOL }, async ($, e, next) => ({
		result: await dispatcher.run(
			engineOf($),
			{ task: e.task, cwd: e.cwd, gate: e.gate, plan_file: e.plan_file, fanout: e.fanout },
			next.signal,
		),
	}));
};
