import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeRoles } from "../../core/src/config.ts";
import { report } from "../../core/src/report.ts";
import type { SpawnFailureDetail, SpawnFn, SpawnResult } from "../../core/src/spawn.ts";
import type { LedgerEvent, StepReply, StepStatus } from "./protocol.ts";

/** How often a pending step's reply file is checked. */
const POLL_MS = 200;

/** How long a stopped step waits for the mod to confirm the sub-agent has ended. */
const STOP_WAIT_MS = 5000;

/** The plugin that namespaces the role agents. */
const PLUGIN = "ledgerpi";

/** What a run's steps cost and which models answered, for the audit row and the hand-off. */
export interface RoleTally {
	tokens: { manager: number; worker: number };
	/** The model that last answered each role, or null when none did. */
	models: { manager: string | null; worker: string | null };
}

/** The `SpawnFailureDetail` for each way a step can end without an answer. */
const FAILURE_DETAIL: Record<Exclude<StepStatus, "answer">, SpawnFailureDetail> = {
	aborted: "aborted",
	error: "agent-error",
	refused: "refused",
};

/** Read a reply file, or undefined until a complete one exists: the mod writes it in place. */
function readReply(path: string): StepReply | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as StepReply;
	} catch {
		return undefined;
	}
}

function totalTokens(usage: StepReply["usage"]): number {
	return (
		(usage?.input_tokens ?? 0) +
		(usage?.output_tokens ?? 0) +
		(usage?.cache_read_input_tokens ?? 0) +
		(usage?.cache_creation_input_tokens ?? 0)
	);
}

/**
 * A `SpawnFn` that hands each spawn to the mod: it prints a `step` event, then waits
 * for the step's reply file. Time running out or the signal aborting prints a `stop`
 * event and waits up to `stopWaitMs` for the mod to confirm the sub-agent ended, so
 * the gate and the lock release do not overlap it; a stop left unconfirmed is reported
 * as a diagnostic. A later reply is ignored. A manager step that answers with nothing
 * fails as an agent error, since a read-only role has no edits to keep. Never rejects.
 * `tally` accumulates as steps finish.
 */
export function rendezvous(
	stepsDir: string,
	roles: ClaudeRoles,
	emit: (event: LedgerEvent) => void,
	stopWaitMs: number = STOP_WAIT_MS,
): { spawn: SpawnFn; tally: RoleTally } {
	mkdirSync(stepsDir, { recursive: true, mode: 0o700 });
	const tally: RoleTally = { tokens: { manager: 0, worker: 0 }, models: { manager: null, worker: null } };
	let lastId = 0;

	const spawn: SpawnFn = (opts) =>
		new Promise<SpawnResult>((resolve) => {
			if (opts.signal?.aborted) {
				resolve({ ok: false, error: "aborted", detail: "aborted" });
				return;
			}
			lastId += 1;
			const id = lastId;
			const role = opts.type === "ledger-worker" ? "worker" : "manager";
			const replyFile = join(stepsDir, `${id}.reply.json`);
			const stoppedFile = join(stepsDir, `${id}.stopped.json`);
			const startedAt = Date.now();

			const stopWaiting = () => {
				clearInterval(poll);
				clearTimeout(timer);
				opts.signal?.removeEventListener("abort", onAbort);
			};
			const finish = (result: SpawnResult) => {
				stopWaiting();
				resolve(result);
			};
			const giveUp = (detail: "aborted" | "timeout") => {
				stopWaiting();
				emit({ type: "stop", id, stoppedFile });
				const deadline = Date.now() + stopWaitMs;
				const confirm = setInterval(() => {
					const confirmed = existsSync(stoppedFile);
					if (!confirmed && Date.now() < deadline) return;
					clearInterval(confirm);
					if (!confirmed)
						report(`[ledgerpi] the ${role} in step ${id} did not confirm it stopped; it may still be running`);
					resolve({ ok: false, error: detail, detail });
				}, POLL_MS);
			};
			const onAbort = () => giveUp("aborted");

			const poll = setInterval(() => {
				const reply = readReply(replyFile);
				if (!reply) return;
				const tokens = totalTokens(reply.usage);
				tally.tokens[role] += tokens;
				if (reply.usage?.model) tally.models[role] = reply.usage.model;
				const durationMs = reply.durationMs ?? Date.now() - startedAt;
				const usage = { input: reply.usage?.input_tokens, output: reply.usage?.output_tokens, total: tokens };
				if (reply.status === "answer" && (role === "worker" || reply.text?.trim())) {
					finish({ ok: true, text: reply.text ?? "", tokens: usage, durationMs });
					return;
				}
				if (reply.status === "answer") {
					finish({
						ok: false,
						error: "the manager returned no answer",
						detail: "agent-error",
						tokens: usage,
						durationMs,
					});
					return;
				}
				finish({
					ok: false,
					error: reply.error ?? reply.status,
					detail: FAILURE_DETAIL[reply.status],
					tokens: usage,
					durationMs,
				});
			}, POLL_MS);
			const timer = setTimeout(() => giveUp("timeout"), opts.timeoutMs);
			opts.signal?.addEventListener("abort", onAbort, { once: true });

			emit({
				type: "step",
				id,
				role,
				agent: `${PLUGIN}:${opts.type}`,
				model: opts.model ?? roles[role],
				cwd: opts.cwd ?? process.cwd(),
				prompt: opts.prompt,
				description: opts.description,
				replyFile,
				stoppedFile,
			});
		});

	return { spawn, tally };
}
