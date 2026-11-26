import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";

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
	const appending = placement === constants.O_APPEND;
	const fd = openSync(
		p,
		(appending ? constants.O_RDWR : constants.O_WRONLY) | constants.O_CREAT | constants.O_NONBLOCK | placement,
		mode,
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error(`${p} is not a regular file`);
		let payload = body;
		if (appending && stat.size > 0) {
			const last = Buffer.alloc(1);
			const read = readSync(fd, last, 0, 1, stat.size - 1);
			if (read !== 1 || last[0] !== 0x0a) payload = `\n${body}`;
		}
		writeFileSync(fd, payload, "utf8");
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
 * Append UTF-8 `body` to `p`, creating it with `mode` when absent. As in
 * {@link writeRegularFile} the open never blocks and the regular-file check runs on
 * the open descriptor, but the descriptor is opened read-write so the last byte can
 * be read: a FIFO, reader or not, opens and is refused before a byte is written, and
 * a target the caller cannot read fails at open. Every record starts on a fresh
 * line: when the file ends without a newline, one is restored before `body` is
 * written, so a missing trailing newline left by an earlier torn write costs only
 * that torn fragment instead of swallowing this record into its line.
 *
 * @throws when `p` cannot be opened, is not a regular file, or the read or write
 * fails.
 */
export function appendRegularFile(p: string, body: string, mode: number): void {
	writeRegular(p, body, mode, constants.O_APPEND);
}
