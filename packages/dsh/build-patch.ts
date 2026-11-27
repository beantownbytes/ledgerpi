import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DshRole, LEDGER_PRESETS } from "./src/dsh.ts";

interface PluginRow {
	id: string;
	name: string;
	group?: boolean;
	isolate?: Record<string, boolean>;
	config?: object;
}

const WORKER_RULES = [
	"Edit the repository in place: never create a branch or a worktree, and never commit, push, or open a PR.",
	"Run every command in the foreground: never start a background job.",
].join("\n");

const FS_SEARCH: PluginRow = {
	id: "tool-fs-search",
	name: "@deepseek-ai/dsh-tool-fs-search",
	// Required by the plugin's config schema: the row does not load without it.
	config: { sampleOverCapGlobResults: false },
};

/** Context compaction, isolated so that each preset runs its own. */
const COMPACTION: PluginRow = {
	id: "compaction",
	name: "cordis:group",
	group: true,
	isolate: { compaction: true, toolResultPruner: true },
	config: [
		{ id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
		{
			id: "tool-result-pruner",
			name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
			config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
		},
	],
};

const PRESET_TOOLS: Readonly<Record<DshRole, readonly PluginRow[]>> = {
	manager: [
		{
			id: "tool-fs",
			name: "@deepseek-ai/dsh-tool-fs",
			config: { write: false, edit: false, applyPatch: false, readImage: false },
		},
		FS_SEARCH,
	],
	worker: [
		{ id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs" },
		FS_SEARCH,
		{
			id: "tool-bash",
			name: "@deepseek-ai/dsh-tool-bash",
			// A ledger child ends with its turn, so it could never collect a background job.
			config: { enableRunInBackground: false, promoteOnTimeout: false },
		},
	],
};

/** The text of an agent file after its front matter, trimmed. */
export function personaBody(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

/** The persona body of each role's agent file under `extensions/ledgerpi/agents`. */
export function agentBodies(): Record<DshRole, string> {
	const body = (role: DshRole): string => {
		const file = new URL(`../../extensions/ledgerpi/agents/${LEDGER_PRESETS[role]}.md`, import.meta.url);
		return personaBody(readFileSync(file, "utf8"));
	};
	return { manager: body("manager"), worker: body("worker") };
}

function presetRow(role: DshRole, body: string): PluginRow {
	const id = LEDGER_PRESETS[role];
	if (body.includes("{{")) {
		throw new Error(`the ${id} persona body contains "{{", which dsh reads as a prompt variable reference`);
	}
	const prefix = role === "worker" ? `${body}\n\n${WORKER_RULES}` : body;
	return {
		id: `preset-${id}`,
		name: "@deepseek-ai/dsh-agent-preset",
		config: {
			id,
			plugins: [
				{ id: "persona", name: "@deepseek-ai/dsh-persona", config: { prefix, complete: true } },
				...PRESET_TOOLS[role],
				COMPACTION,
			],
		},
	};
}

/**
 * The dsh bundle patch: the `ledgerpi` root plugin row and the two ledger presets.
 *
 * @param bodies the persona text of each role; the worker's gets its working rules appended.
 * @returns the patch list as JSON, which is also YAML.
 * @throws when a body contains `{{`.
 */
export function renderPatch(bodies: Readonly<Record<DshRole, string>>): string {
	const insert: PluginRow[] = [
		{ id: "ledgerpi", name: "./service.js" },
		presetRow("manager", bodies.manager),
		presetRow("worker", bodies.worker),
	];
	return `${JSON.stringify([{ insert }], null, "\t")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const dist = new URL("./dist/", import.meta.url);
	const patch = renderPatch(agentBodies());
	mkdirSync(dist, { recursive: true });
	writeFileSync(new URL("cordis.patch.yml", dist), patch);
}
