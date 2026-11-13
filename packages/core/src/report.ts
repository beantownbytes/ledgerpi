export type ReportLevel = "info" | "warning" | "error";

interface UISink {
	owner: object;
	notify: (msg: string, type: ReportLevel) => void;
}

/**
 * The process-wide slot for the UI-owning session's notifier. It lives on
 * `globalThis` rather than in module state because pi-subagents loads a fresh
 * copy of every extension for each in-process sub-agent session, and those
 * copies share the process (and its terminal) but not this module.
 */
const SINK_KEY = Symbol.for("ledgerpi.uiSink");

type SinkHolder = { [SINK_KEY]?: UISink };

const holder = globalThis as SinkHolder;

/** Route this process's ledgerpi diagnostics to `ctx`'s UI notices on behalf of `owner`. */
export function bindUISink(owner: object, ctx: { ui: { notify: UISink["notify"] } }): void {
	holder[SINK_KEY] = { owner, notify: (msg, type) => ctx.ui.notify(msg, type) };
}

/** Clear the sink if `owner` holds it; a no-op for any other owner. */
export function releaseUISink(owner: object): void {
	if (holder[SINK_KEY]?.owner === owner) delete holder[SINK_KEY];
}

/** Whether a UI-owning session in this process is receiving diagnostics. */
export function uiSinkBound(): boolean {
	return holder[SINK_KEY] !== undefined;
}

/**
 * Report a diagnostic: a notice in the UI-owning session when one is live in this
 * process (the TUI owns the terminal, so a raw write would corrupt its frame),
 * else stderr, which print mode keeps free of pi's own output. A sink whose
 * session went stale is dropped and the message falls back to stderr.
 */
export function report(msg: string, type: ReportLevel = "warning"): void {
	const sink = holder[SINK_KEY];
	if (sink) {
		try {
			sink.notify(msg, type);
			return;
		} catch {
			releaseUISink(sink.owner);
		}
	}
	console.error(msg);
}
