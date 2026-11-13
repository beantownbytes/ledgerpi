import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";

/**
 * The UTF-8 contents of `p`, following symlinks. Undefined when it is absent, not a
 * regular file (a directory, FIFO, socket, or device), or unreadable. The open never
 * blocks and the regular-file check runs on the open descriptor, so a caller never
 * blocks on a FIFO, even one swapped in after an earlier check.
 */
export function readRegularFile(p: string): string | undefined {
	try {
		const fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			return fstatSync(fd).isFile() ? readFileSync(fd, "utf8") : undefined;
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

/**
 * The trimmed text of the approved-plan file at `p`.
 *
 * @returns `{ plan }`, or `{ error }` naming `p` when it cannot be read, is not a
 * regular file, or is empty after trimming.
 */
export function readPlanFile(p: string): { plan: string } | { error: string } {
	const text = readRegularFile(p);
	if (text === undefined) return { error: `plan file \`${p}\` cannot be read or is not a regular file` };
	const plan = text.trim();
	return plan ? { plan } : { error: `plan file \`${p}\` is empty` };
}

function writeRegular(p: string, body: string, mode: number, placement: number): void {
	const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK | placement, mode);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`${p} is not a regular file`);
		writeFileSync(fd, body, "utf8");
	} finally {
		closeSync(fd);
	}
}

/**
 * Replace the contents of `p` with UTF-8 `body`, following symlinks and creating it
 * with `mode` when absent. The open never blocks: a FIFO without a reader fails at
 * open, and any other non-regular target (a FIFO with a reader, a directory, socket,
 * or device) throws before a byte is written.
 *
 * @throws when `p` cannot be opened, is not a regular file, or the write fails.
 */
export function writeRegularFile(p: string, body: string, mode: number): void {
	writeRegular(p, body, mode, constants.O_TRUNC);
}

/**
 * Append UTF-8 `body` to `p`, with the same creation, non-blocking open, and
 * regular-file guarantees as {@link writeRegularFile}.
 *
 * @throws when `p` cannot be opened, is not a regular file, or the write fails.
 */
export function appendRegularFile(p: string, body: string, mode: number): void {
	writeRegular(p, body, mode, constants.O_APPEND);
}
