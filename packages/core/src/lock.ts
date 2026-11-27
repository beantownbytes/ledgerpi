import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAlive } from "./proc.ts";

/** Who holds a repository's run lock. */
export interface LockHolder {
	pid: number;
	/** Set when `pid` is a long-lived host process, which must not be signaled to stop the loop. */
	shared?: true;
}

const SHARED_SUFFIX = ".shared";

// Claim file names this process made, shared by every copy of this module in it. Names rather
// than paths, so the state directory may be spelled in more than one way.
const OWN_CLAIMS_KEY = Symbol.for("ledgerpi.lockClaims");
const registry = globalThis as { [OWN_CLAIMS_KEY]?: Set<string> };
registry[OWN_CLAIMS_KEY] ??= new Set<string>();
const ownClaims: Set<string> = registry[OWN_CLAIMS_KEY];

/**
 * The directory of claims on work tree `root`. A claim is an empty file named
 * `<pid>.<uuid>`, with `.shared` appended when the process is a long-lived host.
 */
export function lockDir(stateDir: string, root: string): string {
	return join(stateDir, "locks", createHash("sha1").update(root).digest("hex"));
}

function claimPid(claim: string): number {
	return Number.parseInt(claim, 10);
}

function claimsIn(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
}

/**
 * Whether `claim` still holds. One that names this process but that this process did
 * not make is left over from an earlier process with the same pid.
 */
function isLiveClaim(claim: string): boolean {
	const pid = claimPid(claim);
	return isAlive(pid) && (pid !== process.pid || ownClaims.has(claim));
}

/** The live holder of the lock on work tree `root`, or null when free or stale. */
export function lockHolder(stateDir: string, root: string): LockHolder | null {
	const live = claimsIn(lockDir(stateDir, root)).filter(isLiveClaim);
	const claim = live.find((name) => name.endsWith(SHARED_SUFFIX)) ?? live[0];
	if (claim === undefined) return null;
	return claim.endsWith(SHARED_SUFFIX) ? { pid: claimPid(claim), shared: true } : { pid: claimPid(claim) };
}

/**
 * Claim the lock on work tree `root` for this process, so two loops never edit one
 * tree. Each process publishes its own claim and only then lists the others, so of
 * two that race the later one always sees the earlier: two never both hold the lock,
 * though both may refuse. No process touches a live claim, and a claim left by a dead
 * process, or by an earlier one with this pid, is ignored and removed. Returns a
 * release function, or null when another live claim exists.
 *
 * @param options.sharedProcess marks this process as one that must not be signaled.
 */
export function acquireLock(
	stateDir: string,
	root: string,
	options: { sharedProcess?: boolean } = {},
): (() => void) | null {
	const dir = lockDir(stateDir, root);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const own = `${process.pid}.${randomUUID()}${options.sharedProcess ? SHARED_SUFFIX : ""}`;
	const ownPath = join(dir, own);
	writeFileSync(ownPath, "", { mode: 0o600 });
	ownClaims.add(own);
	const release = () => {
		rmSync(ownPath, { force: true });
		ownClaims.delete(own);
	};
	for (const claim of claimsIn(dir)) {
		if (claim === own) continue;
		if (isLiveClaim(claim)) {
			release();
			return null;
		}
		rmSync(join(dir, claim), { force: true });
	}
	return release;
}
