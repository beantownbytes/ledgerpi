import { spawn } from "node:child_process";
import type { RoleTiming } from "../packages/core/src/loop.ts";

/** The pid of a process that has exited. */
export async function deadPid(): Promise<number> {
	const dead = spawn(process.execPath, ["-e", ""]);
	await new Promise((done) => dead.on("close", done));
	return dead.pid ?? 0;
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
