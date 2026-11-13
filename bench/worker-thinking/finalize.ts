import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runGate } from "../../packages/core/src/gate.ts";
import { diffStat } from "../../packages/core/src/git.ts";
import {
	type AuditRow,
	attachSessionFailures,
	classifyRun,
	countLimitEvents,
	type FinalGate,
	lastFailureText,
	type RunResult,
	type SessionFailure,
	type TranscriptRow,
} from "./analyze.ts";

/**
 * Finishes one attempt: reruns the gate independently on the final tree, flattens the
 * worker's edits into a diff against the base commit, classifies the run, and writes
 * `attempt.json` in the attempt directory.
 *
 * With `--reuse-diff` the tree is left alone and only the gate and classification are
 * redone, which is how an `unverified` run retries its gate. With `--harness-failure
 * <reason>` neither the gate nor the tree is touched and the attempt is recorded as
 * harness-failed, for an attempt whose setup or finalize step failed.
 *
 * `--sessions` names the arm's pi session root, which supplies the error text of workers
 * that died on a provider error.
 */

const { values } = parseArgs({
	options: {
		dir: { type: "string" },
		repo: { type: "string" },
		base: { type: "string" },
		gate: { type: "string" },
		"gate-timeout-ms": { type: "string" },
		"run-id": { type: "string" },
		arm: { type: "string" },
		task: { type: "string" },
		rep: { type: "string" },
		attempt: { type: "string" },
		sessions: { type: "string" },
		"reuse-diff": { type: "boolean", default: false },
		"harness-failure": { type: "string" },
	},
});

const { dir, repo, base, gate, arm, task } = values;
const runId = values["run-id"];
const gateTimeoutMs = Number(values["gate-timeout-ms"]);
const rep = Number(values.rep);
const attempt = Number(values.attempt);
if (!dir || !repo || !base || !gate || !runId || !arm || !task || !gateTimeoutMs || !rep || !attempt) {
	console.error(
		"usage: finalize.ts --dir D --repo R --base SHA --gate CMD --gate-timeout-ms N --run-id ID --arm A --task T --rep N --attempt N [--sessions DIR] [--reuse-diff] [--harness-failure REASON]",
	);
	process.exit(2);
}

const GATE_TIMED_OUT = "[gate timed out]";

interface SessionEntry {
	message?: { role?: string; stopReason?: string; errorMessage?: string; timestamp?: number };
}

/** Parses a JSONL file, skipping a truncated last line from a killed writer. */
function readJsonl<T>(path: string): T[] {
	if (!existsSync(path)) return [];
	const rows: T[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			rows.push(JSON.parse(line) as T);
		} catch {}
	}
	return rows;
}

/** Every per-call row under the attempt's ledger state dir, grouped by sorted path (not chronological across files). */
function readTranscripts(stateDir: string): TranscriptRow[] {
	if (!existsSync(stateDir)) return [];
	const rows: TranscriptRow[] = [];
	const paths = readdirSync(stateDir, { recursive: true, encoding: "utf8" })
		.filter((p) => p.endsWith("transcript.jsonl"))
		.sort();
	for (const path of paths) rows.push(...readJsonl<TranscriptRow>(join(stateDir, path)));
	return rows;
}

/** The provider error each of this attempt's sessions closed on, if any. */
function readSessionFailures(sessionsRoot: string, repoPath: string): SessionFailure[] {
	const sessionDir = join(sessionsRoot, `--${repoPath.slice(1).replaceAll("/", "-")}--`);
	if (!existsSync(sessionDir)) return [];
	const failures: SessionFailure[] = [];
	for (const file of readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"))) {
		const entries = readJsonl<SessionEntry>(join(sessionDir, file));
		const last = entries.flatMap((e) => (e.message?.role === "assistant" ? [e.message] : [])).at(-1);
		if (last?.stopReason === "error" && last.errorMessage && last.timestamp !== undefined) {
			failures.push({ t: last.timestamp, error: last.errorMessage });
		}
	}
	return failures;
}

const git = (args: string[]): string =>
	execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Reruns the gate on the final tree and, unless reusing a diff, flattens the worker's edits. */
const verifyTree = async (): Promise<FinalGate> => {
	const verdict = await runGate(gate, repo, gateTimeoutMs);
	writeFileSync(join(dir, "final-gate.txt"), `${verdict.command}\n\n${verdict.output ?? ""}\n`);

	// Workers leave edits uncommitted but may commit; the reset folds both into one diff,
	// and intent-to-add makes new files visible to it.
	if (!values["reuse-diff"]) {
		git(["reset", "--mixed", "--quiet", base]);
		git(["add", "--intent-to-add", "."]);
		writeFileSync(join(dir, "diff.patch"), git(["diff"]));
		writeFileSync(join(dir, "diffstat.txt"), diffStat(repo));
	}
	const timedOut = verdict.output?.endsWith(GATE_TIMED_OUT) ?? false;
	return { ran: verdict.ran && !timedOut, passed: verdict.passed };
};

const harnessFailure = values["harness-failure"] ?? null;
const finalGate = harnessFailure === null ? await verifyTree() : null;

const rows = readJsonl<AuditRow & { event?: string }>(join(dir, "runs.jsonl")).filter((r) => r.event === "run");
const row = rows.at(-1) ?? null;
const transcript = attachSessionFailures(
	readTranscripts(join(dir, "state")),
	values.sessions ? readSessionFailures(values.sessions, repo) : [],
);
const result: RunResult = {
	runId,
	arm,
	task,
	rep,
	attempts: attempt,
	class: harnessFailure === null ? classifyRun(row, transcript, finalGate) : "harness-failed",
	stop: row?.stop ?? null,
	lastFailure: harnessFailure ?? lastFailureText(transcript),
	...countLimitEvents(transcript),
	tokens: row?.tokens ?? 0,
	durationMs: row?.durationMs ?? 0,
	diffStat: existsSync(join(dir, "diffstat.txt")) ? readFileSync(join(dir, "diffstat.txt"), "utf8") : "",
	finalGate,
};
writeFileSync(join(dir, "attempt.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(result.class);
