import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The session id as a filesystem-safe slug, degrading to a stable fallback rather than throwing. */
export function sessionSlug(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return "unknown-session";
	}
}
