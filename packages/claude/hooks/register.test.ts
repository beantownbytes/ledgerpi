import { expect, test } from "claude-code/testing";

const AGENT = "ledgerpi:ledger-worker";
const TOOL = "mcp__ledgerpi__ledger_solve";
const REPLY = "/state/1.reply.json";

const STEP = {
	type: "step",
	id: 1,
	role: "worker",
	agent: AGENT,
	model: "claude-sonnet-5-5",
	cwd: "/repo",
	prompt: "do it",
	description: "ledger worker",
	replyFile: REPLY,
};

function line(event: object) {
	return { stream: "stdout" as const, text: `${JSON.stringify(event)}\n` };
}

const EXITED = { value: { code: 0, signal: null } };

function stream(...events: object[]) {
	return async function* () {
		for (const event of events) yield line(event);
		return EXITED;
	};
}

/** The stand-ins every run needs: the session id, the status line, and the reply files. */
function baseEngine(on: (event: any, hook: (...args: any[]) => unknown) => void, writes: Record<string, string>) {
	on("session.id", () => ({ value: "s1" }));
	on("ui.status", () => ({ value: undefined }));
	on("fs.write", (_, e) => {
		writes[e.path] = e.text;
		return { value: undefined };
	});
}

test("the tool is left unregistered when ledgerctl says inactive", async ($, on) => {
	const registered: string[] = [];
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	on("tool.register", (_, e) => {
		registered.push(e.name);
		return { value: { tool: e.name } };
	});
	on("process.run", () => ({
		value: {
			exitCode: 0,
			stdout: '{"active":false}',
			stderr: "",
			isStdoutTruncated: false,
			isStderrTruncated: false,
		},
	}));

	await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
	expect(registered).toEqual([]);
});

test("a denied spawn is written back as a refused reply", async ($, on) => {
	const writes: Record<string, string> = {};
	baseEngine(on, writes);
	on("agent.spawn", () => ({ deny: "no" }));
	on("process.spawn", stream(STEP, { type: "done", handoff: "stopped" }));

	await $.tool.call({ tool: TOOL, task: "fix it" });
	const reply = JSON.parse(writes[REPLY] ?? "{}");
	expect(reply.status).toBe("refused");
	expect(reply.error).toContain("no");
});

test("a refused run hands its reason to the model", async ($, on) => {
	baseEngine(on, {});
	on("process.spawn", stream({ type: "refused", reason: "ledgerpi is inactive. Implement the task directly." }));

	const out = await $.tool.call({ tool: TOOL, task: "fix it" });
	expect(out.result).toContain("Implement the task directly.");
});

test("a run with no result warns of partial edits once a step has run", async ($, on) => {
	baseEngine(on, {});
	on("agent.spawn", () => ({ deny: "no" }));
	on("process.spawn", stream(STEP));

	const out = await $.tool.call({ tool: TOOL, task: "fix it" });
	expect(out.result).toContain("partial edits");
});

test("a run that ends before any step tells the model to do the work", async ($, on) => {
	baseEngine(on, {});
	on("process.spawn", stream());

	const out = await $.tool.call({ tool: TOOL, task: "fix it" });
	expect(out.result).toContain("Implement the task directly.");
	expect(out.result).not.toContain("partial edits");
});

test("ledgerctl failing to start tells the model to do the work", async ($, on) => {
	baseEngine(on, {});

	const out = await $.tool.call({ tool: TOOL, task: "fix it" });
	expect(out.result).toContain("Implement the task directly.");
});

test("arguments reach ledgerctl and the task goes on stdin", async ($, on) => {
	baseEngine(on, {});
	let request: { argv: readonly string[]; input?: string } = { argv: [] };
	on("process.spawn", async function* (_, e) {
		request = e;
		yield line({ type: "done", handoff: "done" });
		return EXITED;
	});

	await $.tool.call({ tool: TOOL, task: "fix it", cwd: "/wt", gate: "--flaky make" });
	expect(request.input).toBe("fix it");
	expect(request.argv).toEqual(["ledgerctl", "solve", "--session=s1", "--cwd=/wt", "--gate=--flaky make"]);
});

test("plan_file reaches ledgerctl as --plan-file", async ($, on) => {
	baseEngine(on, {});
	let request: { argv: readonly string[]; input?: string } = { argv: [] };
	on("process.spawn", async function* (_, e) {
		request = e;
		yield line({ type: "done", handoff: "done" });
		return EXITED;
	});

	await $.tool.call({ tool: TOOL, task: "fix it", plan_file: "/plans/p.md" });
	expect(request.argv).toEqual(["ledgerctl", "solve", "--session=s1", "--plan-file=/plans/p.md"]);
});

test("a message from another agent still enters the session", async ($, on) => {
	on("prompt.submit", (_, e) => ({ text: `entered: ${e.text}` }));

	const message = { text: '<agent-message from="stranger">hi</agent-message>' } as never;
	const out = await $.prompt.submit(message);
	expect(out).toMatchObject({ text: expect.stringContaining("entered:") });
});

test("both role agents are hidden from the model", async ($) => {
	for (const agent of ["ledgerpi:ledger-manager", AGENT]) {
		const out = await $.agent.offer({ agent } as never);
		expect(out).toMatchObject({ isOffered: false });
	}
});

test("the permission answer covers no agent outside a run", async ($, on) => {
	on("tool.check", () => ({ decision: "ask" }));

	const verdict = await $.tool.check({ tool: "Agent", input: { subagent_type: AGENT } });
	expect(verdict.decision).toBe("ask");
});
