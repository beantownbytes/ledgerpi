import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifierPrompt } from "../../packages/core/src/prompts.ts";
import { report } from "../../packages/core/src/report.ts";

export interface Classification {
	kind: "code" | "chat";
	/** Tokens the classifier call itself spent, so the loop can account for it. */
	tokens: number;
	/**
	 * How the verdict was reached: a real model classification, or which safe-default
	 * fallback produced the "chat" result. Lets the audit distinguish a genuine chat
	 * verdict from an outage or an interrupt, which all otherwise pass through as chat.
	 */
	outcome: "classified" | "invalid" | "error" | "aborted" | "no-model";
}

/**
 * One short call on the session model that labels a prompt `code` or `chat`.
 * Runs as its own conversation (fresh sessionId, `cacheRetention: "none"`) so it
 * never writes into the session's shared prefix cache. On any failure it returns
 * "chat" -- the safe default is to leave the turn alone rather than pull a
 * borderline request into the loop. Reports its own token cost so /ledgerpi can
 * include it in the run total.
 */
export async function classify(ctx: ExtensionContext, text: string, signal?: AbortSignal): Promise<Classification> {
	const model = ctx.model;
	if (!model) return { kind: "chat", tokens: 0, outcome: "no-model" };
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: classifierPrompt(text) }], timestamp: Date.now() },
				],
			},
			// Force reasoning off and keep a real answer budget. The session model may
			// default to high/xhigh thinking (e.g. intranet/qwen3.8-27b), where a tiny
			// maxTokens would be spent entirely on reasoning and return no answer text,
			// silently classifying every request as chat and disabling the loop.
			// `reasoning: "off"` is pi's own thinking control, which each provider maps
			// to its own request shape -- unlike raw `samplingParams`, which some
			// OpenAI-compatible servers reject outright (cerebras 400s on an unknown
			// body field, and the classify catch then wrongly returns "chat"). The
			// larger budget covers a provider that ignores the control and still reasons.
			{ maxTokens: 128, reasoning: "off", cacheRetention: "none", sessionId: uuidv7(), signal },
		);
		// pi's complete() resolves failures and interrupts rather than throwing:
		// the terminal state is on response.stopReason ("error"/"aborted"). Treat
		// those as fallbacks, not a genuine chat verdict, so the audit can tell an
		// outage or interrupt apart from a real classification. Usage is preserved.
		const tokens = response.usage?.totalTokens ?? (response.usage?.input ?? 0) + (response.usage?.output ?? 0);
		if (signal?.aborted || response.stopReason === "aborted") return { kind: "chat", tokens, outcome: "aborted" };
		if (response.stopReason === "error") {
			report(`[ledgerpi] classifier response error: ${response.errorMessage ?? "unknown"}`);
			return { kind: "chat", tokens, outcome: "error" };
		}
		const out = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(" ")
			.toLowerCase();
		// An empty or thinking-only answer (e.g. a truncated stopReason:"length"
		// response) names neither label. Default to chat but mark it "invalid", so the
		// audit does not record a non-answer as a real classification.
		const codeVote = out.includes("code");
		if (!codeVote && !out.includes("chat")) return { kind: "chat", tokens, outcome: "invalid" };
		return { kind: codeVote ? "code" : "chat", tokens, outcome: "classified" };
	} catch (err) {
		if (signal?.aborted) return { kind: "chat", tokens: 0, outcome: "aborted" };
		report(`[ledgerpi] classifier failed: ${(err as Error).message}`);
		return { kind: "chat", tokens: 0, outcome: "error" };
	}
}
