import type { FanoutSetting } from "./config.ts";
import { type GateVerdict, gateCommandText } from "./gate.ts";
import type { Task, TaskBrief } from "./parse.ts";
import { briefFor, renderTasks } from "./parse.ts";

/**
 * Per-call prompts, adapted from the reference scaffold's role prompts
 * (multiagent.py). The role identity lives in the agent .md (prompt_mode:
 * replace); these carry the dynamic content and the exact `### SECTION` output
 * contract the host parses. The same worker type serves ideate / do-task /
 * finalize, so the contract must travel with the call, not the definition.
 */

const PLAN_CONTRACT =
	"Respond with EXACTLY these sections and nothing else:\n" +
	"### PLAN\n<3-6 sentence overarching strategy>\n" +
	"### TASKS\n<3-6 bullet tasks, each a concrete unit of work, one per line as '- ...'>";

export function planPrompt(task: string): string {
	return `TASK:\n${task}\n\nInspect the repository with your read-only tools first, so the plan is grounded in the code that exists. Produce a short overarching plan, then a task list the workers can pick up; name the files each task touches at the end of its line, e.g. '- add X (src/a.ts, test/a.test.ts)'. Do NOT write code -- a later worker does that.\n\n${PLAN_CONTRACT}`;
}

const IDEATE_CONTRACT =
	"Respond with EXACTLY these sections:\n" +
	"### NOTES\n<your analysis in prose, no code blocks>\n" +
	"### NEXT\n<bullet list of distinct approaches to try next>";

export function ideatePrompt(task: string, plan: string): string {
	return (
		`TASK:\n${task}\n\nPLAN:\n${plan || "(none yet)"}\n\n` +
		"Do NOT change any files and do NOT write code. Identify the core difficulty, then list several genuinely distinct candidate approaches (different algorithms, data structures, or reductions -- not variations of one idea) and the pitfalls of each, in prose only. A later worker implements.\n\n" +
		IDEATE_CONTRACT
	);
}

/**
 * The manager's first "latest worker result" when the caller supplied the plan: no
 * worker has run, so the manager builds the task list from the plan itself.
 */
export const SUPPLIED_PLAN_RESULT =
	"No worker has run yet. The caller supplied the PLAN above. Build the task list from the plan's code changes in this working tree only; the caller owns commits, pushes, review, tracking, installs, and any work in other repositories or outside this tree, so leave those out. Compare the plan with the CURRENT DIFF, mark any step it already completes [done], and name the first unfinished task, or set STATUS done if none remains.";

function gateLine(gate: GateVerdict | null): string {
	if (!gate || !gate.ran) return "(no gate has been run yet)";
	const command = gateCommandText(gate.command ?? "");
	if (gate.passed) return `GATE PASSED: ${command} exited zero. The change looks correct.`;
	return `GATE FAILED: ${command} is still failing. First/last output:\n${gate.output ?? ""}`;
}

const MANAGE_CONTRACT =
	"Respond with EXACTLY these sections:\n" +
	"### STATUS\n<done|continue>\n" +
	"### NEXT\n<required when STATUS is continue: the exact text of the ONE task to do next, on one line; leave NEXT, FILES, ACCEPT, OUT_OF_SCOPE, and VERIFY empty if done, and still curate TASKS>\n" +
	"### FILES\n<the repository paths this task should change, one per line as '- path'>\n" +
	"### ACCEPT\n<observable conditions that mean this task is done, one per line as '- ...'>\n" +
	"### OUT_OF_SCOPE\n<files, areas, or changes the worker must leave alone, one per line as '- ...'>\n" +
	"### VERIFY\n<one targeted command that checks this task, or 'none'>\n" +
	"### TASKS\n<curated list, one per line, each '- [done] ...' or '- [todo] ...'>";

const MODE_SECTION =
	"### MODE\n<serial, best-of-n, or fleet, then ': ' and a short reason. serial when the next task depends on the last result or the open tasks share files; best-of-n for a small self-contained task with an uncertain approach or a retry after a failed gate; fleet for 2 or more open tasks on disjoint files. NEXT, FILES, ACCEPT, OUT_OF_SCOPE, and VERIFY still brief the single next task, whatever mode you recommend>\n";

/** The manage contract, with the `### MODE` section ahead of TASKS when the fan-out setting asks for a recommendation. */
function manageContract(fanout: FanoutSetting | undefined): string {
	if (fanout !== "advise" && fanout !== "ask" && fanout !== "on") return MANAGE_CONTRACT;
	return MANAGE_CONTRACT.replace("### TASKS\n", `${MODE_SECTION}### TASKS\n`);
}

export function managePrompt(args: {
	task: string;
	plan: string;
	notes: string;
	diff: string;
	tasks: Task[];
	lastResult: string;
	gate: GateVerdict | null;
	/** The full gate command the host runs after each worker round, when there is one. */
	gateHint?: string;
	/** When `advise`, `ask` or `on`, the contract also asks for a `### MODE` fan-out recommendation. */
	fanout?: FanoutSetting;
}): string {
	const verifyRule = args.gateHint
		? ` The host runs the full gate, ${gateCommandText(args.gateHint)}, after each worker round, so VERIFY must be a check narrower than the full gate, or 'none' when the gate is already the narrowest check.`
		: "";
	return (
		`TASK:\n${args.task}\n\nPLAN:\n${args.plan || "(none)"}\n\nNOTES:\n${args.notes || "(none)"}\n\n` +
		`CURRENT DIFF (git diff in the working tree):\n${args.diff || "(no changes yet)"}\n\n` +
		`CURRENT TASK LIST:\n${renderTasks(args.tasks)}\n\n` +
		`LATEST WORKER RESULT: ${args.lastResult || "(none)"}\n\n` +
		`${gateLine(args.gate)}\n\n` +
		"You own the task list and decide when the problem is solved. The GATE verdict is ground truth: set STATUS 'done' only if the gate PASSED (or there is no gate and the change is complete and correct); if it FAILED you MUST set STATUS 'continue' and choose a task that fixes the failing case or switches approach. If the current approach keeps failing, switch to a DIFFERENT one from the notes rather than polishing a stuck one. Curate the list: merge duplicates, mark completed items [done], add only genuinely new sub-tasks, then name the single most valuable next task. Brief the worker on that one task only: inspect the repository with your read-only tools before naming files, list only paths that exist or that the task creates, and keep the acceptance criteria and the out-of-scope list to this task." +
		`${verifyRule}\n\n` +
		manageContract(args.fanout)
	);
}

/**
 * A command reduced to what it runs: each line trimmed with inner whitespace
 * collapsed, blank lines dropped, and a leading `cd <dir> &&` removed.
 */
function commandCore(command: string): string {
	return command
		.split("\n")
		.map((l) => l.trim().replace(/\s+/g, " "))
		.filter(Boolean)
		.join("\n")
		.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, "");
}

const WORKER_CONTRACT =
	"Respond with EXACTLY these sections:\n" +
	"### NOTES\n<the COMPLETE notes file, rewritten: fold your findings in, keep what still matters, DELETE what is superseded. This REPLACES the file. Use '- **Topic:** ...' bullets, under ~800 words. No markdown headings, bold-only lines, or ALLCAPS: lines inside this section.>\n" +
	"### NEXT\n<bullet list of remaining steps, or 'none'>\n" +
	"### STATUS\n<solved|continue>";

export function workerPrompt(args: {
	task: string;
	plan: string;
	notes: string;
	diff: string;
	brief: TaskBrief;
	gateHint?: string;
	/** The private repository copy this worker edits, when it runs as one of several concurrent candidates. */
	worktree?: string;
}): string {
	const { brief } = args;
	const gate = args.gateHint?.includes("\n") ? gateCommandText(args.gateHint) : args.gateHint;
	const targeted = args.gateHint && commandCore(brief.verify) === commandCore(args.gateHint) ? "" : brief.verify;
	const verify = targeted
		? `\n\nAfter editing, verify by running: ${targeted.includes("\n") ? gateCommandText(targeted) : targeted}${gate ? `\nThis is the targeted check for this task. Do not run the full gate yourself; the host runs it afterward: ${gate}` : ""}`
		: gate
			? `\n\nAfter editing, verify by running: ${gate} (run only the targeted test, not the whole suite -- the host runs the full gate).`
			: "";
	const list = (label: string, items: string[]) =>
		items.length ? `\n\n${label}:\n${items.map((i) => `- ${i}`).join("\n")}` : "";
	const scope = brief.files.length
		? "\n\nKeep your edits to the files listed; if the task truly needs another file, edit it and say why in NOTES."
		: "";
	const fields =
		list("FILES TO CHANGE", brief.files) +
		list("ACCEPTANCE CRITERIA", brief.accept) +
		list("OUT OF SCOPE", brief.outOfScope) +
		scope;
	const sandbox = args.worktree
		? `\n\nYou are working in a private copy of the repository at ${args.worktree}, one of several candidates attempting this task; the best one is kept. Edit files ONLY inside ${args.worktree}, never in any other directory. It has no installed dependencies (node_modules and similar), so a targeted check may fail here for that reason alone; the host gates the kept result.`
		: "";
	const goal = `${brief.task}${fields}${verify}${sandbox}`;
	return (
		`TASK:\n${args.task}\n\nPLAN:\n${args.plan || "(none)"}\n\nNOTES:\n${args.notes || "(none)"}\n\n` +
		`CURRENT DIFF:\n${args.diff || "(none yet)"}\n\n` +
		`YOUR ONE TASK: ${goal}\n\n` +
		"Edit the repository files directly to complete this one task. Build on the current work where useful, but if your task is to try a different approach, write a fresh implementation for it. Then report:\n\n" +
		WORKER_CONTRACT
	);
}

export function finalizePrompt(args: {
	task: string;
	plan: string;
	notes: string;
	diff: string;
	gateHint?: string;
}): string {
	return workerPrompt({
		...args,
		brief: briefFor(
			"Produce the definitive final solution now, using all notes and current work. Make the repository changes complete and correct.",
		),
	});
}

/** The code-vs-chat classifier prompt. Answered in one word by the session model. */
export function classifierPrompt(text: string): string {
	return (
		"Classify the following user request. Answer with exactly one lowercase word and nothing else:\n" +
		"- 'code' if fulfilling it requires editing files in this repository (a bug fix, a feature, a refactor, making a test pass).\n" +
		"- 'chat' for anything else (a question, an explanation, a search, a discussion, a one-off command).\n" +
		"Return code only when this message specifies a concrete repository-editing task that can be understood using this request and repository inspection alone, without previous conversation. Return chat for continuation/resume requests, references to prior work, or requests whose task or intended worktree depends on missing conversation. Do not infer the task from the latest commits. When uncertain, return chat.\n" +
		"Examples: 'please continue -- i had to close my laptop' -> chat (a continuation request with no standalone task). 'fix parser.ts so empty input returns []' -> code (a standalone coding request).\n\n" +
		`REQUEST:\n${text}\n\nAnswer (code or chat):`
	);
}
