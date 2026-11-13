import { gateCommandText } from "./gate.ts";
import { diffStat } from "./git.ts";
import type { FanoutSummary, LoopResult } from "./loop.ts";
import { renderTasks } from "./parse.ts";

function fanoutLine(f: FanoutSummary): string {
	const a = f.advised;
	const parts = [
		`Fan-out: ${f.setting} (max ${f.max}).`,
		`Best-of-N rounds: ${f.rounds}.`,
		`Recommended: serial ${a.serial}, best-of-n ${a["best-of-n"]}, fleet ${a.fleet}, none ${a.none}.`,
	];
	if (f.downgrades.length) parts.push(`Downgrades: ${f.downgrades.join(", ")}.`);
	if (f.setting === "ask") parts.push(`Asked: ${f.asked}.`);
	if (f.escapes.length) parts.push(`Escapes: ${f.escapes.join(", ")}.`);
	return parts.join(" ");
}

/**
 * The block appended to the user's prompt after the loop runs. It tells the main
 * session that the work is already applied to the working tree and it should
 * verify briefly and answer, not redo it. On a non-converged run the block says
 * so and carries the notes and the remaining tasks, so the main model continues
 * from where the loop left off rather than starting over.
 */
export function handoffBlock(cwd: string, result: LoopResult): string {
	const stat = diffStat(cwd);
	const command = result.gate?.command ?? "";
	const multiLine = command.includes("\n");
	const verdict = result.gate?.ran ? (result.gate.passed ? "passed" : "FAILED") : "not run";
	const gate = result.gate?.ran && !multiLine ? `${verdict} (\`${command}\`)` : verdict;
	const gateBlock = result.gate?.ran && multiLine ? [`Gate command:${gateCommandText(command).trimEnd()}`] : [];

	const header = result.converged
		? "A ledger-based manager-worker loop ran under this request and converged. The changes are already in the working tree."
		: result.gate?.ran && result.gate.passed
			? `A ledger-based manager-worker loop ran under this request and stopped (${result.stop}) with a passing gate, but the task was not confirmed done. The changes are in the working tree and may be incomplete.`
			: `A ledger-based manager-worker loop ran under this request and stopped (${result.stop}) without a passing gate. Partial changes are in the working tree.`;

	const guidance = result.converged
		? "Verify the change briefly (read the diff, trust the gate result), then answer the user. Do not redo the work."
		: "Review what was done, then finish the remaining work below or explain the blocker. Do not start over -- build on the diff and notes.";

	return [
		"\n\n<ledgerpi-result>",
		header,
		"",
		`Gate: ${gate}. Rounds: ${result.iters}. Sub-agent calls: ${result.calls}. Tokens: ${result.tokens}.`,
		...gateBlock,
		...(result.fanout ? [fanoutLine(result.fanout)] : []),
		`Manager model: ${result.managerModel ?? "session model"}.`,
		`Worker model: ${result.workerModel ?? "session model"}.`,
		"",
		"Changed files:",
		stat || "(none)",
		"",
		"Remaining tasks:",
		renderTasks(result.tasks.filter((t) => t.status !== "done")),
		"",
		"Ledger notes:",
		result.notes || "(none)",
		"",
		guidance,
		"</ledgerpi-result>",
	].join("\n");
}
