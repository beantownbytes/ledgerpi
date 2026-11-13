import { spawn as spawnProc } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LedgerpiConfig } from "./config.ts";
import { readRegularFile } from "./files.ts";

export interface GateVerdict {
	/** Whether a gate was run at all. When false the manager's own verdict stands. */
	ran: boolean;
	/** True only when the gate command exited zero. */
	passed: boolean;
	/** The command that was run, for the record and the worker prompt. */
	command?: string;
	/** A tail of combined stdout/stderr on failure, for the manager to act on. */
	output?: string;
}

/** A gate command for prose: inline code for one line, a fenced block for several. */
export function gateCommandText(command: string): string {
	return command.includes("\n") ? `\n\`\`\`sh\n${command}\n\`\`\`\n` : `\`${command}\``;
}

/** Whether a Makefile in cwd declares a `test` target. */
function makefileHasTest(cwd: string): boolean {
	for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
		const text = readRegularFile(join(cwd, name));
		if (text === undefined) continue;
		return /^test\s*:/m.test(text);
	}
	return false;
}

/** Whether package.json declares a `test` script. */
function npmHasTest(cwd: string): boolean {
	const text = readRegularFile(join(cwd, "package.json"));
	if (text === undefined) return false;
	try {
		const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
		return typeof pkg.scripts?.test === "string" && pkg.scripts.test.trim() !== "";
	} catch {
		return false;
	}
}

/**
 * The command in a repo-local `.ledgerpi-gate` file in cwd, with CRLF line endings
 * normalized and outer whitespace trimmed. A file of more than one line runs under
 * `set -e`. Undefined when the file is absent, not a regular file, unreadable,
 * blank, or holds only `#` comment lines.
 */
function repoGateFile(cwd: string): string | undefined {
	const text = readRegularFile(join(cwd, ".ledgerpi-gate"));
	if (text === undefined) return undefined;
	const command = text.replace(/\r\n?/g, "\n").trim();
	const lines = command.split("\n").map((line) => line.trim());
	if (lines.every((line) => line === "" || line.startsWith("#"))) return undefined;
	return lines.length > 1 ? `set -e\n${command}` : command;
}

/**
 * Detects the gate command for a project. Explicit config wins; otherwise a
 * repo-local `.ledgerpi-gate` file, then a Makefile `test` target, then the
 * language manifest. Returns undefined when no gate can be found -- the loop then
 * runs without a verifier and the manager's verdict is trusted as-is.
 */
export function detectGate(cfg: LedgerpiConfig, cwd: string): string | undefined {
	if (cfg.gate && cfg.gate.trim() !== "") return cfg.gate;
	const repoGate = repoGateFile(cwd);
	if (repoGate) return repoGate;
	if (makefileHasTest(cwd)) return "make test";
	if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) return "python3 -m pytest -q";
	if (npmHasTest(cwd)) return existsSync(join(cwd, "bun.lockb")) ? "bun test" : "npm test";
	if (existsSync(join(cwd, "Cargo.toml"))) return "cargo test";
	if (existsSync(join(cwd, "go.mod"))) return "go test ./...";
	return undefined;
}

const OUTPUT_TAIL_CHARS = 3_000;

/** Runs the gate command in cwd and reports the verdict. Never throws. */
export function runGate(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<GateVerdict> {
	return new Promise((resolve) => {
		let out = "";
		let done = false;
		const finish = (v: GateVerdict) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(v);
		};

		let child: ReturnType<typeof spawnProc>;
		try {
			// `detached` puts the shell and its descendants (make -> pytest -> ...) in
			// their own process group, so a timeout or abort can kill the whole tree,
			// not just the shell, and never orphan a heavy test run.
			child = spawnProc("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
		} catch (err) {
			finish({ ran: false, passed: false, command, output: (err as Error).message });
			return;
		}

		// Kill the child's whole process group (negative pid), falling back to the
		// child alone if the group signal fails.
		const killTree = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};

		const onData = (d: Buffer) => {
			out += d.toString();
			if (out.length > OUTPUT_TAIL_CHARS * 4) out = out.slice(-OUTPUT_TAIL_CHARS * 4);
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);

		const timer = setTimeout(() => {
			killTree();
			finish({ ran: true, passed: false, command, output: `${out.slice(-OUTPUT_TAIL_CHARS)}\n[gate timed out]` });
		}, timeoutMs);

		if (signal) {
			if (signal.aborted) {
				killTree();
				finish({ ran: false, passed: false, command, output: "aborted" });
				return;
			}
			signal.addEventListener(
				"abort",
				() => {
					killTree();
					finish({ ran: false, passed: false, command, output: "aborted" });
				},
				{ once: true },
			);
		}

		child.on("error", (err) => finish({ ran: false, passed: false, command, output: err.message }));
		child.on("close", (code) => {
			finish({
				ran: true,
				passed: code === 0,
				command,
				output: code === 0 ? undefined : out.slice(-OUTPUT_TAIL_CHARS),
			});
		});
	});
}
