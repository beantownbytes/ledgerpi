import { spawn } from "node:child_process";
import { pinRepo, type RepoPin } from "../packages/core/src/git.ts";
import type { RoleTiming } from "../packages/core/src/loop.ts";

/** The pid of a process that has exited. */
export async function deadPid(): Promise<number> {
	const dead = spawn(process.execPath, ["-e", ""]);
	await new Promise((done) => dead.on("close", done));
	return dead.pid ?? 0;
}

/** The pin of the work tree holding `cwd`; throws outside one. */
export function pinned(cwd: string): RepoPin {
	const repo = pinRepo(cwd);
	if (repo === null) throw new Error(`${cwd} is not inside a git work tree`);
	return repo;
}

/** The audit-row keys that carry per-role timing, one per `RoleTiming` field. */
export const TIMING_KEYS = [
	"managerMs",
	"workerMs",
	"gateMs",
	"managerCalls",
	"workerCalls",
	"gateRuns",
] as const satisfies readonly (keyof RoleTiming)[];
