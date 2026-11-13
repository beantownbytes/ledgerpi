import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAlive } from "../../core/src/proc.ts";

/** Who holds a repository's run lock. */
export interface LockHolder {
	pid: number;
}

/** The directory of claims on work tree `root`. A claim is an empty file named `<pid>.<uuid>`. */
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

/** The live holder of the lock on work tree `root`, or null when free or stale. */
export function lockHolder(stateDir: string, root: string): LockHolder | null {
	const pid = claimsIn(lockDir(stateDir, root)).map(claimPid).find(isAlive);
	return pid === undefined ? null : { pid };
}

/**
 * Claim the lock on work tree `root` for this process, so two loops never edit one
 * tree. Each process publishes its own claim and only then lists the others, so of
 * two that race the later one always sees the earlier: two never both hold the lock,
 * though both may refuse. No process touches a live claim, and a dead process's claim
 * is ignored and removed. Returns a release function, or null when another live
 * claim exists.
 */
export function acquireLock(stateDir: string, root: string): (() => void) | null {
	const dir = lockDir(stateDir, root);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const own = `${process.pid}.${randomUUID()}`;
	const ownPath = join(dir, own);
	writeFileSync(ownPath, "", { mode: 0o600 });
	for (const claim of claimsIn(dir)) {
		if (claim === own) continue;
		if (isAlive(claimPid(claim))) {
			rmSync(ownPath, { force: true });
			return null;
		}
		rmSync(join(dir, claim), { force: true });
	}
	return () => rmSync(ownPath, { force: true });
}
