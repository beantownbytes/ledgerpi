import { isToolCallEventType, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

/** The file an `edit`/`write` tool call targets, or undefined for any other tool. */
export function mutatingTarget(event: ToolCallEvent): string | undefined {
	if (isToolCallEventType("edit", event)) return event.input.path;
	if (isToolCallEventType("write", event)) return event.input.path;
	return undefined;
}

/**
 * The message returned to the model when its inline edit is redirected into the loop.
 * Terse and imperative in the deny+reason style of the enforcer floor: state what is
 * denied and what to use instead. The task hint is capped; the model holds the real
 * task in context. The final line documents the retry-cap escape hatch honestly -- the
 * cap counts blocks session-wide, so the interception relents after a couple of tries,
 * not on the first re-issue.
 */
export function redirectReason(path: string, instruction?: string): string {
	const hint = instruction?.trim() ? ` Task in play: ${instruction.trim().slice(0, 300)}.` : "";
	return (
		`ledgerpi: inline edits are redirected in this session; \`${path}\` was NOT written. ` +
		"Call ledger_solve({ task, cwd }) with a concrete, self-contained description of the change " +
		"you were about to make -- the loop plans, decomposes, edits the working tree, and gates on the " +
		"tests, returning with the edits already applied. Pass cwd only when the change must land in a " +
		`carved worktree rather than this checkout.${hint} ` +
		"If this genuinely must be a direct inline edit, keep editing and ledgerpi will stop intercepting after a couple of attempts."
	);
}
