import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LedgerpiConfig } from "./config.ts";
import { appendRegularFile, readRegularFile, writeRegularFile } from "./files.ts";
import { report } from "./report.ts";

/**
 * The on-disk ledger for one loop run, the paper's shared workspace. Every file
 * here is written by the host, never by a spawned agent: a sub-agent session
 * loads its own autopi with an empty scratch-dir registry, so an agent write to
 * a host-minted scratch path is ask-first and would stall a background worker.
 * The host has no such gate, so the host owns the files and the agents only read
 * them (their prompts carry the content inline). The one exception is
 * `candidates/`: a best-of-N round gives each candidate worker a git worktree
 * there, which the worker edits.
 */
export class Ledger {
	readonly dir: string;
	private readonly cfg: LedgerpiConfig;

	constructor(cfg: LedgerpiConfig, sessionId: string, turnId: string) {
		this.cfg = cfg;
		this.dir = join(cfg.stateDir, sessionId, turnId);
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
	}

	private path(name: string): string {
		return join(this.dir, name);
	}

	private write(name: string, body: string): void {
		try {
			writeRegularFile(this.path(name), body, 0o600);
		} catch (err) {
			report(`[ledgerpi] write ${name} failed: ${(err as Error).message}`);
		}
	}

	private read(name: string): string {
		return readRegularFile(this.path(name)) ?? "";
	}

	setTask(text: string): void {
		this.write("task.md", text);
	}
	task(): string {
		return this.read("task.md");
	}

	/** Records the manager's own plan, capped to `planMaxChars`. */
	setPlan(text: string): void {
		this.write("plan.md", text.slice(0, this.cfg.planMaxChars));
	}
	/** Records a caller-supplied approved plan whole; `planMaxChars` does not apply to it. */
	setSuppliedPlan(text: string): void {
		this.write("plan.md", text);
	}
	plan(): string {
		return this.read("plan.md");
	}

	/** Replaces notes.md wholesale (the worker returns a curated whole), capped to budget. */
	setNotes(text: string): void {
		this.write("notes.md", text.slice(0, this.cfg.notesMaxChars));
	}
	/** Appends to notes.md, used by the ideation pass; still capped. */
	appendNotes(text: string): void {
		const merged = `${this.read("notes.md")}\n${text}`.trim();
		this.setNotes(merged);
	}
	notes(): string {
		return this.read("notes.md");
	}

	setTasksJson(value: unknown): void {
		this.write("tasks.json", JSON.stringify(value, null, 2));
	}

	/** One JSONL row per model call, gate run, or worker brief, for the A/B token and scope accounting. */
	record(rec: Record<string, unknown>): void {
		try {
			appendRegularFile(this.path("transcript.jsonl"), `${JSON.stringify({ t: Date.now(), ...rec })}\n`, 0o600);
		} catch (err) {
			report(`[ledgerpi] transcript append failed: ${(err as Error).message}`);
		}
	}
}
