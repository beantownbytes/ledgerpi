import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { type SpawnOptions, type SpawnResult, WORKER_SENTINEL } from "../../packages/core/src/spawn.ts";

/**
 * A thin client for the `@tintinweb/pi-subagents` cross-extension RPC bus. The
 * bus is in-process and synchronous (docs/rpc.md): emit a spawn, get an id back
 * on a per-request reply channel, then join the agent on the top-level
 * `subagents:completed` / `subagents:failed` events and consume its result so
 * the completion notification never lands on top of an answer we already gave.
 */

interface SpawnReply {
	success: boolean;
	data?: { id: string };
	error?: string;
}

interface CompletionPayload {
	id: string;
	status?: string;
	result?: string;
	error?: string;
	tokens?: { input?: number; output?: number; total?: number };
	durationMs?: number;
}

/**
 * Actively probes whether the pi-subagents RPC is available in this session by
 * pinging it and awaiting the reply. This is used instead of listening for the
 * one-shot `subagents:ready` event, which fires once at session start -- before
 * an `input`-time listener could subscribe -- and would always be missed. The
 * ping handler is armed on that same session start, so by the first user input
 * it answers immediately; a session without pi-subagents never replies and the
 * bounded wait expires as "not available here".
 */
export function ping(events: EventBus, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const requestId = randomUUID();
		let done = false;
		let off: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout>;
		const finish = (v: boolean) => {
			if (done) return;
			done = true;
			off?.();
			clearTimeout(timer);
			resolve(v);
		};
		off = events.on(`subagents:rpc:ping:reply:${requestId}`, () => finish(true));
		timer = setTimeout(() => finish(false), timeoutMs);
		events.emit("subagents:rpc:ping", { requestId });
	});
}

/** Fire-and-forget: tell pi-subagents we handled this agent's result, suppressing its notification. */
function consume(events: EventBus, agentId: string): void {
	events.emit("subagents:rpc:consume", { requestId: randomUUID(), agentId });
}

/**
 * Fire-and-forget: ask pi-subagents to abort a still-running agent. Used when we
 * stop waiting on our side (abort or timeout) so the worker does not keep editing
 * the tree after the loop has moved on and released its guards.
 */
function stop(events: EventBus, agentId: string): void {
	events.emit("subagents:rpc:stop", { requestId: randomUUID(), agentId });
}

/**
 * Fire-and-forget: stop a still-running agent, then consume its result so the
 * completion notification never lands on top of an answer we already gave.
 *
 * The order is load-bearing and must not be reversed, swapped, or collapsed into
 * one call: pi-subagents' `consumeResult` refuses a record whose status is still
 * `running` or `queued` (`@tintinweb/pi-subagents` `src/index.ts:811-821`; the RPC
 * handler at `src/cross-extension-rpc.ts:191-195` throws "Agent not found or still
 * running"), while `manager.abort()` sets `record.status = "stopped"` synchronously
 * (`src/agent-manager.ts:1407-1426`) and the RPC bus dispatches synchronously. So
 * `stop` must precede `consume` within the same tick, otherwise the consume is
 * refused and the raw per-worker notification leaks to the parent session.
 */
function stopAndConsume(events: EventBus, agentId: string): void {
	stop(events, agentId);
	consume(events, agentId);
}

/**
 * How long to keep the spawn-reply listener alive after we abort or time out
 * before the id arrives, so a late reply can still name the agent to stop. Bounds
 * the listener's lifetime so a reply that never comes cannot leak it.
 */
const LATE_REPLY_GRACE_MS = 10_000;

/**
 * `SpawnOptions` as the RPC accepts them: `model` may also be a pi `Model` object,
 * which pi-subagents uses as given. `maxOutputTokens` is not part of the payload; the
 * caller applies it by passing a `Model` copy with its `maxTokens` set.
 */
export type RpcSpawnOptions = Omit<SpawnOptions, "model" | "maxOutputTokens"> & {
	model?: string | Model<Api> | null;
};

/**
 * Spawn one sub-agent and resolve with its result. Never rejects: every failure
 * path (spawn refused, agent failed, timeout, abort) resolves with `ok: false`,
 * because the loop must treat a broken spawn as a distinct outcome from a failed
 * gate rather than throwing through the input handler.
 */
export function spawn(events: EventBus, opts: RpcSpawnOptions): Promise<SpawnResult> {
	return new Promise((resolve) => {
		const requestId = randomUUID();
		let settled = false;
		let agentId: string | undefined;
		let replyHandled = false;
		let offReply: (() => void) | undefined;
		const cleanups: Array<() => void> = [];

		const finish = (r: SpawnResult) => {
			if (settled) return;
			settled = true;
			for (const c of cleanups) c();
			clearTimeout(timer);
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			// The reply listener is intentionally NOT in `cleanups`: if we terminated
			// before the id arrived, keep it alive briefly so a late reply can still
			// name the agent for `stop`, then drop it so a reply that never comes
			// cannot leak the listener.
			if (!replyHandled && offReply) {
				const late = setTimeout(() => {
					if (!replyHandled) offReply?.();
				}, LATE_REPLY_GRACE_MS);
				late.unref?.();
			}
			resolve(r);
		};

		// On a local termination (abort or timeout) we stop the agent if we already
		// know its id; if it is not known yet the reply handler below stops it once
		// it arrives, closing the abort-before-reply window.
		const onAbort = () => {
			if (agentId) stopAndConsume(events, agentId);
			finish({ ok: false, error: "aborted", detail: "aborted" });
		};
		if (opts.signal) {
			if (opts.signal.aborted) {
				resolve({ ok: false, error: "aborted", detail: "aborted" });
				return;
			}
			opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		const timer = setTimeout(() => {
			if (agentId) stopAndConsume(events, agentId);
			finish({ ok: false, error: "timeout", detail: "timeout" });
		}, opts.timeoutMs);

		// Join completion/failure by agent id. These fire for top-level agents
		// only, which an RPC spawn is, so no workflow/nested filtering is needed.
		const onSettled = (ok: boolean) => (data: unknown) => {
			const p = data as CompletionPayload;
			if (!agentId || p.id !== agentId) return;
			consume(events, p.id);
			const okFinal = ok && p.status !== "failed" && !p.error;
			finish({
				ok: okFinal,
				text: p.result,
				error: p.error || undefined,
				// A settled-not-ok outcome is the agent's own failure (a failed status or a
				// payload error), whatever arbitrary text the payload carried.
				detail: okFinal ? undefined : "agent-error",
				tokens: p.tokens,
				durationMs: p.durationMs,
			});
		};
		cleanups.push(events.on("subagents:completed", onSettled(true)));
		cleanups.push(events.on("subagents:failed", onSettled(false)));

		// Reply carries the spawned id. Register the reply listener before emitting.
		// It self-unsubscribes on fire and is deliberately kept out of `cleanups`
		// (see finish) so it can outlive an abort/timeout and stop a late agent.
		offReply = events.on(`subagents:rpc:spawn:reply:${requestId}`, (data: unknown) => {
			replyHandled = true;
			offReply?.();
			const reply = data as SpawnReply;
			if (!reply.success || !reply.data?.id) {
				// The refusal text is the spawn host's arbitrary string, so the category is
				// tagged here -- not derived from the text, which a failed agent payload
				// could echo verbatim.
				finish({ ok: false, error: reply.error ?? "spawn refused", detail: "refused" });
				return;
			}
			agentId = reply.data.id;
			// If we already gave up (aborted or timed out before the id arrived), the
			// agent is now orphaned -- stop it and consume its result as soon as we
			// can name it.
			if (settled) stopAndConsume(events, agentId);
		});

		events.emit("subagents:rpc:spawn", {
			requestId,
			type: opts.type,
			prompt: `${WORKER_SENTINEL}\n${opts.prompt}`,
			options: {
				description: opts.description,
				model: opts.model ?? null,
				thinkingLevel: opts.thinkingLevel,
				maxTurns: opts.maxTurns,
				cwd: opts.cwd,
				// true so the manager/worker render in pi's sub-agent widget with
				// live activity and per-agent tokens; an explicit false
				// is dropped from the widget's background mode and hides them. Concurrent
				// spawns can queue for a slot, and a queued spawn's wait counts against
				// callTimeoutMs.
				isBackground: true,
			},
		});
	});
}
