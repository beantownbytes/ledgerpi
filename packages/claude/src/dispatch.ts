import type { LedgerEvent, StepEvent, StepReply, StepStatus } from "./protocol.ts";

/** The plugin's two role agents, as the engine names them. */
export const ROLE_AGENTS = ["ledgerpi:ledger-manager", "ledgerpi:ledger-worker"];

/** What the dispatcher needs from Claude Code. */
export interface Engine {
	spawn(step: StepEvent): Promise<{ agentId?: string; deny?: string }>;
	/** Stop an agent. One that already finished is not an error. */
	stop(agentId: string): Promise<void>;
	/** An agent's status, or undefined when the engine no longer lists it. */
	status(agentId: string): Promise<string | undefined>;
	write(path: string, text: string): Promise<void>;
	setStatus(text: string | undefined): Promise<void>;
	sessionId(): Promise<string>;
	/** Start ledgerctl and yield its output; rejects on the first pull if it cannot start. */
	stream(request: { argv: string[]; input: string }): AsyncIterable<{ stream: "stdout" | "stderr"; text: string }>;
}

/** How one agent's turn ended. */
export interface StepTurn {
	answer: string;
	reason: string;
	durationMs: number;
	usage?: StepReply["usage"];
}

/** A `ledger_solve` call. Fields are the model's, so they are checked here. */
export interface SolveRequest {
	task?: unknown;
	cwd?: unknown;
	gate?: unknown;
	plan_file?: unknown;
	fanout?: unknown;
}

const REPLY_STATUS: Record<string, StepStatus> = {
	answer: "answer",
	aborted: "aborted",
	refusal: "refused",
	error: "error",
};

/** The agent statuses that mean it may still act. */
const LIVE_STATUSES = new Set(["pending", "running", "waiting"]);

function punt(why: string): string {
	return `${why} Implement the task directly.`;
}

function replyFor(turn: StepTurn): StepReply {
	const status = REPLY_STATUS[turn.reason] ?? "error";
	return {
		status,
		text: turn.answer,
		error: status === "answer" ? undefined : turn.reason,
		durationMs: turn.durationMs,
		usage: turn.usage,
	};
}

/**
 * Write a step's reply. A reply too large to write still ends the step, as an error;
 * one that cannot be written at all leaves the step to time out in ledgerctl.
 */
async function deliver(engine: Engine, path: string, reply: StepReply): Promise<void> {
	try {
		await engine.write(path, JSON.stringify(reply));
	} catch (err) {
		const failed: StepReply = { status: "error", error: String(err) };
		await engine.write(path, JSON.stringify(failed)).catch(() => undefined);
	}
}

/** Tell ledgerctl a sub-agent has ended. A failed write leaves it to report that. */
async function confirmStopped(engine: Engine, path: string): Promise<void> {
	await engine.write(path, "{}").catch(() => undefined);
}

/** Stop an agent and confirm it, unless the engine still lists it as live: ledgerctl then reports it. */
async function stopAndConfirm(engine: Engine, agentId: string, stoppedFile: string): Promise<void> {
	await engine.stop(agentId);
	const status = await engine.status(agentId).catch(() => undefined);
	if (status === undefined || !LIVE_STATUSES.has(status)) await confirmStopped(engine, stoppedFile);
}

/** Update the status line, which is display only: a failure never touches the run. */
async function showStatus(engine: Engine, text: string | undefined): Promise<void> {
	await engine.setStatus(text).catch(() => undefined);
}

function optionalText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function solveArgv(sessionId: string, request: SolveRequest): string[] {
	const argv = ["ledgerctl", "solve", `--session=${sessionId}`];
	const cwd = optionalText(request.cwd);
	const gate = optionalText(request.gate);
	const planFile = optionalText(request.plan_file);
	if (cwd !== undefined) argv.push(`--cwd=${cwd}`);
	if (gate !== undefined) argv.push(`--gate=${gate}`);
	const fanout = optionalText(request.fanout);
	if (planFile !== undefined) argv.push(`--plan-file=${planFile}`);
	if (fanout !== undefined) argv.push(`--fanout=${fanout}`);
	return argv;
}

/**
 * Runs `ledgerctl solve` for one session: starts a sub-agent for each step it asks for,
 * writes each answer to the step's reply file, and stops whatever is still running
 * when the run ends. One run at a time; a second call is refused.
 */
export class Dispatcher {
	/** The step between `Engine.spawn` and its `agent.spawn` hook; spawns are serial. */
	private spawningStep: StepEvent | null = null;
	/** Started steps awaiting their answer, by agent id. */
	private readonly awaited = new Map<string, StepEvent>();
	/** Agent ids by step id, kept after the answer for a `stop` that crosses it. */
	private readonly agentOfStep = new Map<number, string>();
	/** Turns that ended before `Engine.spawn` resolved. */
	private readonly early = new Map<string, StepTurn>();
	/** Every role agent this session started; their hand-backs arrive after the run ends. */
	private readonly ownAgents = new Set<string>();
	/** Claimed synchronously, so a second call in the session is refused. */
	private running = false;

	/** The step being spawned right now, if any. */
	get spawning(): StepEvent | null {
		return this.spawningStep;
	}

	/** Whether `agentId` is a role agent this dispatcher started. */
	isOwnAgent(agentId: string): boolean {
		return this.ownAgents.has(agentId);
	}

	/** Record a sub-agent's finished turn. */
	async turnComplete(engine: Engine, agentId: string, turn: StepTurn): Promise<void> {
		const step = this.awaited.get(agentId);
		if (step === undefined) {
			if (this.spawningStep !== null) this.early.set(agentId, turn);
			return;
		}
		this.awaited.delete(agentId);
		await this.finishStep(engine, step, agentId, turn);
	}

	/** Run the loop to its end and return the text for the model. */
	async run(engine: Engine, request: SolveRequest, signal: AbortSignal): Promise<string> {
		if (this.running) return "A ledger loop is already running in this session. Wait for its result before editing.";
		this.running = true;
		let abortStop: Promise<void> | undefined;
		const stopOnAbort = () => {
			abortStop = this.stopOutstanding(engine);
		};
		signal.addEventListener("abort", stopOnAbort, { once: true });

		let outcome: string | undefined;
		let failure: string | undefined;
		let stepsSeen = 0;
		let stderr = "";
		const handle = async (event: LedgerEvent) => {
			switch (event.type) {
				case "step":
					stepsSeen += 1;
					await this.startStep(engine, event, signal);
					break;
				case "stop": {
					const agentId = this.agentOfStep.get(event.id);
					if (agentId === undefined) await confirmStopped(engine, event.stoppedFile);
					else await stopAndConfirm(engine, agentId, event.stoppedFile);
					break;
				}
				case "progress":
					await showStatus(engine, event.text);
					break;
				case "done":
					outcome = event.handoff;
					break;
				case "refused":
					outcome = event.reason;
					break;
			}
		};

		try {
			const argv = solveArgv(await engine.sessionId(), request);
			const input = typeof request.task === "string" ? request.task : "";
			let buffer = "";
			for await (const { stream, text } of engine.stream({ argv, input })) {
				if (stream === "stderr") {
					stderr = (stderr + text).slice(-2000);
					continue;
				}
				buffer += text;
				for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
					const line = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					await handle(JSON.parse(line) as LedgerEvent);
				}
			}
		} catch (err) {
			failure = String(err);
		} finally {
			signal.removeEventListener("abort", stopOnAbort);
			await abortStop;
			await this.stopOutstanding(engine);
			this.agentOfStep.clear();
			this.early.clear();
			this.running = false;
			await showStatus(engine, undefined);
		}

		const diagnostics = stderr.trim();
		if (outcome !== undefined) return diagnostics ? `${outcome}\n\nledgerctl reported:\n${diagnostics}` : outcome;
		if (signal.aborted) return "The ledger loop was aborted before completing.";
		const detail = failure?.trim() ?? diagnostics;
		return stepsSeen > 0
			? `The ledger loop exited without a result, so the working tree may hold partial edits. ${detail}`.trim()
			: punt(`ledgerctl could not run: ${detail || "it exited without a result"}.`);
	}

	private async startStep(engine: Engine, step: StepEvent, signal: AbortSignal): Promise<void> {
		if (signal.aborted) {
			await deliver(engine, step.replyFile, { status: "aborted", error: "aborted" });
			return;
		}
		this.spawningStep = step;
		try {
			const started = await engine.spawn(step);
			if (started.agentId === undefined) {
				await deliver(engine, step.replyFile, { status: "refused", error: started.deny ?? "spawn refused" });
				return;
			}
			this.ownAgents.add(started.agentId);
			this.agentOfStep.set(step.id, started.agentId);
			const turn = this.early.get(started.agentId);
			if (turn === undefined) {
				this.awaited.set(started.agentId, step);
			} else {
				this.early.delete(started.agentId);
				await this.finishStep(engine, step, started.agentId, turn);
			}
		} catch (err) {
			await deliver(engine, step.replyFile, { status: "refused", error: String(err) });
		} finally {
			this.spawningStep = null;
		}
	}

	/** Deliver a turn. A worker that backgrounded a command ends it `waiting` and may never resume. */
	private async finishStep(engine: Engine, step: StepEvent, agentId: string, turn: StepTurn): Promise<void> {
		const status = await engine.status(agentId).catch(() => undefined);
		if (status === "waiting") await engine.stop(agentId);
		await deliver(engine, step.replyFile, replyFor(turn));
	}

	private async stopOutstanding(engine: Engine): Promise<void> {
		const running = [...this.awaited];
		this.awaited.clear();
		await Promise.all(running.map(([agentId, step]) => stopAndConfirm(engine, agentId, step.stoppedFile)));
	}
}
