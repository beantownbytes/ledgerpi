import type { EventBus } from "@earendil-works/pi-coding-agent";

/**
 * A minimal client for the cooperative `workflow:mutex:v1` protocol that pi-goal
 * and pi plan-mode participate in. Acquiring emits a synchronous in-process
 * attempt; any current holder flips `busy` to true before the emit returns, so
 * `busy === false` afterwards means the group is free and we may claim it. We
 * hold it for the duration of a loop so a concurrent goal or plan-mode run
 * defers, and answer other participants' attempts while we hold it. The shared
 * identity every participant agrees on is the session-manager object.
 *
 * Cooperative only: it guarantees mutual exclusion just against contenders that
 * also implement v1 and share the event bus and session identity.
 */
const CHANNEL = "workflow:mutex:v1";
const GROUP = "agent-workflow";

interface Attempt {
	session: object;
	group: string;
	busy: boolean;
}

export class WorkflowMutex {
	private session: object | undefined;
	private held = false;
	private readonly events: EventBus;

	constructor(events: EventBus) {
		this.events = events;
		events.on(CHANNEL, (payload) => this.answer(payload));
	}

	bind(session: object): void {
		this.session = session;
		this.held = false;
	}

	/** Attempt to claim the group. Returns true on success; the caller must release. */
	acquire(): boolean {
		const session = this.session;
		if (!session || this.held) return false;
		const attempt: Attempt = { session, group: GROUP, busy: false };
		try {
			this.events.emit(CHANNEL, attempt);
		} catch {
			return false;
		}
		if (attempt.busy || attempt.session !== session) return false;
		this.held = true;
		return true;
	}

	release(): void {
		this.held = false;
	}

	private answer(payload: unknown): void {
		try {
			if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
			const attempt = payload as Partial<Attempt>;
			if (attempt.session !== this.session || attempt.group !== GROUP) return;
			if (typeof attempt.busy !== "boolean") return;
			if (this.held) attempt.busy = true;
		} catch {
			// Protocol listeners must never throw into sibling listeners.
		}
	}
}
