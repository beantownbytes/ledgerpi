/**
 * The JSONL contract between `ledgerctl solve` and the plugin's mod. `ledgerctl`
 * runs the loop and prints one event per line on stdout. The mod spawns each `step`
 * as a native sub-agent and writes its `StepReply` to `replyFile`, because a process
 * started by the mod has no stdin left to read once its input is written.
 */

/** Ask the mod to start one sub-agent. */
export interface StepEvent {
	type: "step";
	id: number;
	role: "manager" | "worker";
	/** The agent type, as the mod passes it to `$.agent.spawn`. */
	agent: string;
	/** The full model id, which only an `agent.spawn` hook can apply. */
	model: string;
	/** The directory the sub-agent runs in, likewise applied by the hook. */
	cwd: string;
	prompt: string;
	description: string;
	replyFile: string;
	/** Written by the mod once the step's sub-agent has been stopped. */
	stoppedFile: string;
}

/** Ask the mod to stop a running step: its time ran out, or the loop was canceled. */
export interface StopEvent {
	type: "stop";
	id: number;
	/** Written by the mod once the stop has landed; see `StepEvent.stoppedFile`. */
	stoppedFile: string;
}

export interface ProgressEvent {
	type: "progress";
	text: string;
}

/** The run finished, converged or not; `handoff` is the tool result. */
export interface DoneEvent {
	type: "done";
	handoff: string;
}

/** Nothing ran; `reason` is the tool result, telling the model to do the work itself. */
export interface RefusedEvent {
	type: "refused";
	reason: string;
}

export type LedgerEvent = StepEvent | StopEvent | ProgressEvent | DoneEvent | RefusedEvent;

/** How a step ended: the sub-agent answered, stopped short, or was never started. */
export type StepStatus = "answer" | "aborted" | "error" | "refused";

/** What the mod writes to a step's `replyFile`. */
export interface StepReply {
	status: StepStatus;
	/** The sub-agent's final text. */
	text?: string;
	/** Why it failed, when `status` is not `answer`. */
	error?: string;
	durationMs?: number;
	/** The answering model and token counts, as `turn.complete` reports them. */
	usage?: {
		model?: string;
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}
