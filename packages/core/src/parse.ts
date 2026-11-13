/**
 * Reply parsing, ported from the reference scaffold's `_sections` / `_bullets`
 * (github.com/slee-persis/GVS5H, multiagent.py). The manager and worker roles
 * answer in a fixed `### SECTION` format and the host parses it, rather than
 * relying on a structured-output tool the RPC boundary cannot force. A missing
 * section reads as empty, never as an error, so a slightly off-format reply
 * still yields whatever it did produce.
 */

/**
 * The most entries kept from any one list a reply carries (the task list, a brief
 * list, the lines of VERIFY), so a runaway reply cannot add entries to a prompt
 * without limit.
 */
export const LIST_CAP = 12;

/** Strips a leading provider-thinking block so it is never parsed as content. */
function stripThink(text: string): string {
	return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Replaces fenced code blocks with a placeholder, for sections that must stay prose. */
export function stripCode(text: string): string {
	return text.replace(/```[\s\S]*?```/g, "[code omitted -- approach only]").trim();
}

/**
 * Splits a reply into its `### HEADER` sections. Accepts three header spellings
 * the models drift between: `### NAME`, `**NAME**` on its own line, and
 * `NAME:` in caps. Keys are uppercased. Everything before the first header is
 * discarded.
 */
export function sections(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	let cur: string | null = null;
	let buf: string[] = [];
	const flush = () => {
		if (cur !== null) out[cur] = buf.join("\n").trim();
	};
	for (const line of stripThink(text).split("\n")) {
		const s = line.trim();
		const m =
			s.match(/^#{1,3}\s*([A-Za-z_]+)\s*$/) ||
			s.match(/^\*\*([A-Za-z_]+)\*\*\s*:?\s*$/) ||
			s.match(/^([A-Z_]{3,})\s*:\s*$/);
		if (m) {
			flush();
			cur = m[1].toUpperCase();
			buf = [];
		} else {
			buf.push(line);
		}
	}
	flush();
	return out;
}

const MANAGE_HEADERS: [RegExp, string][] = [
	["out[ _-]of[ _-]scope", "OUT_OF_SCOPE"],
	["files[ _-]to[ _-]change", "FILES"],
	["acceptance(?:[ _-]criteria)?", "ACCEPT"],
].map(([name, key]) => [
	new RegExp(`^(?:#{1,3}\\s*${name}\\s*:?|\\*\\*${name}\\*\\*\\s*:?|${name}\\s*:)\\s*$`, "i"),
	key,
]);

/**
 * Splits a manage reply into its sections, like `sections()`, and also reads the
 * brief headers spelled as the worker prompt labels them -- OUT OF SCOPE, FILES TO
 * CHANGE, ACCEPTANCE (CRITERIA) -- with spaces or hyphens, in any case, as a `###`
 * heading, a bold line, or a line ending in a colon. A manage reply has only list
 * sections, so such a line is the header; other roles' replies use `sections()`,
 * so the same line inside their prose stays content.
 */
export function manageSections(text: string): Record<string, string> {
	return sections(
		text
			.split("\n")
			.map((line) => {
				const key = MANAGE_HEADERS.find(([header]) => header.test(line.trim()))?.[1];
				return key ? `### ${key}` : line;
			})
			.join("\n"),
	);
}

/** Extracts `- ` / `* ` / `1. ` bullet bodies from a block. */
export function bullets(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)/);
		if (m) out.push(m[1].trim());
	}
	return out;
}

export type TaskStatus = "todo" | "done";
export interface Task {
	desc: string;
	status: TaskStatus;
}

/**
 * Parses a curated task list. A bullet may carry a `[done]` / `[todo]` marker;
 * anything else is treated as `todo`. Capped so a runaway list cannot grow the
 * manager prompt without bound.
 */
export function parseTasks(text: string, cap: number): Task[] {
	const out: Task[] = [];
	for (const b of bullets(text)) {
		const m = b.match(/^\[\s*([a-z_ ]+?)\s*\]\s*(.*)/i);
		let desc = b;
		let status: TaskStatus = "todo";
		if (m) {
			const raw = m[1].toLowerCase().replace(/[ _]/g, "");
			desc = m[2].trim();
			status = raw === "done" ? "done" : "todo";
		}
		if (desc) out.push({ desc, status });
		if (out.length >= cap) break;
	}
	return out;
}

/** Renders a task list back to the `- [todo] ...` lines the manager prompt shows. */
export function renderTasks(tasks: Task[]): string {
	if (tasks.length === 0) return "(none)";
	return tasks.map((t) => `- [${t.status === "done" ? "done" : "todo"}] ${t.desc}`).join("\n");
}

/** The first bullet of a block, marker stripped -- the manager's single next task. */
export function firstBullet(text: string): string {
	const bs = bullets(text);
	const raw = bs[0] ?? text.trim();
	return raw.replace(/^[-*]\s*/, "").trim();
}

/** The manager's brief for one worker round. An empty list or string means the manager gave none. */
export interface TaskBrief {
	task: string;
	/** Repository paths the task should change. */
	files: string[];
	/** Observable conditions that mean the task is done. */
	accept: string[];
	/** Files, areas, or changes the worker must leave alone. */
	outOfScope: string[];
	/** A targeted verification command for the worker to run. */
	verify: string;
}

/** A brief that carries only the task, for fallbacks where the manager wrote no brief. */
export function briefFor(task: string): TaskBrief {
	return { task, files: [], accept: [], outOfScope: [], verify: "" };
}

/**
 * Reads a manage reply's brief from its parsed sections: NEXT (the task), FILES,
 * ACCEPT, OUT_OF_SCOPE, and VERIFY. A missing section reads as empty, and each list
 * and VERIFY keep at most `LIST_CAP` entries or lines.
 */
export function parseBrief(sec: Record<string, string>): TaskBrief {
	return {
		task: firstBullet(sec.NEXT ?? ""),
		files: briefList(sec.FILES ?? ""),
		accept: briefList(sec.ACCEPT ?? ""),
		outOfScope: briefList(sec.OUT_OF_SCOPE ?? ""),
		verify: verifyText(sec.VERIFY ?? ""),
	};
}

export type FanoutMode = "serial" | "best-of-n" | "fleet";

const MODE_LINE = /^(serial|best-of-n|fleet)\s*(?::\s*(.*))?$/i;

/**
 * Reads the manager's `### MODE` recommendation, written `<mode>: <reason>`. A
 * missing section or an unknown mode word reads as `mode: null`; the reason is the
 * text after the colon, empty when there is none.
 */
export function parseMode(sec: Record<string, string>): { mode: FanoutMode | null; reason: string } {
	const line = firstBullet(sec.MODE ?? "");
	const m = line.match(MODE_LINE);
	if (!m) return { mode: null, reason: "" };
	return { mode: m[1].toLowerCase() as FanoutMode, reason: (m[2] ?? "").trim() };
}

const NONE_ANSWER = /^\(?\s*(none|n\/a)\s*\)?\.?$/i;
/** A line that opens with a `none` or `n/a` answer, whatever explanation follows it. */
const NONE_LEAD = /^\(?\s*(none|n\/a)(?=$|[\s.,;:)])/i;

/** A brief list's bullets, capped, without an entry that is only a `none` or `n/a` answer. */
function briefList(text: string): string[] {
	return bullets(text)
		.filter((b) => !NONE_ANSWER.test(b))
		.slice(0, LIST_CAP);
}

/**
 * The targeted check in a VERIFY section, forwarded as written for the worker to
 * read. Code-fence markers and leading intro lines ending in a colon are dropped
 * (a `None:` line is the answer, not an intro), and at most `LIST_CAP` lines are kept, followed by a `#` comment line saying so
 * when more were cut. When the first remaining line is a `none`
 * or `n/a` answer there is no check, whatever follows it. A single remaining line
 * also loses its bullet marker and a wrapping pair of backticks.
 */
function verifyText(text: string): string {
	const lines = text
		.split("\n")
		.map((l) =>
			l
				.trim()
				.replace(/^```(.*?)```$/, "$1")
				.replace(/^```\w*$/, "")
				.trim(),
		)
		.filter(Boolean);
	const start = lines.findIndex((l) => !l.endsWith(":") || bullets(l).length > 0 || NONE_LEAD.test(l));
	const body = start < 0 ? [] : lines.slice(start, start + LIST_CAP);
	const first = (body[0] ?? "")
		.replace(/^[-*]\s+/, "")
		.replace(/^(`+)([^`]+)\1$/, "$2")
		.trim();
	if (!first || NONE_LEAD.test(first)) return "";
	if (body.length === 1) return first;
	const cut = lines.length - start > LIST_CAP;
	return [...body, ...(cut ? [`# (truncated: only the first ${LIST_CAP} lines are shown)`] : [])].join("\n");
}
