import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isAlive } from "./proc.ts";

/** Runs a git command in cwd and returns stdout, or "" on any failure. Read-only callers only. */
function git(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return "";
	}
}

/** True when cwd is inside a git work tree. */
export function isGitRepo(cwd: string): boolean {
	return git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
}

/** The root of the work tree holding cwd, or null outside one. */
export function workTreeRoot(cwd: string): string | null {
	return git(cwd, ["rev-parse", "--show-toplevel"]).trim() || null;
}

/** The repository identity at one instant, each field null when git cannot say. */
export interface HeadInfo {
	/** The `origin` remote URL, userinfo stripped from an http(s) one; null without an origin. */
	repoUrl: string | null;
	/** The checked-out branch (an unborn one included); null on a detached HEAD. */
	branch: string | null;
	/** The commit HEAD resolves to; null on an unborn branch. */
	sha: string | null;
}

/**
 * Strip userinfo from an http(s) remote so a token-bearing origin is never logged.
 * ssh, scp-style, and local-path remotes are returned verbatim: their login is not
 * a secret and is part of the URL a join must match.
 */
function redactRemote(url: string): string {
	return url.replace(/^(https?:\/\/)[^/?#]*@/i, "$1");
}

/** Read origin, branch, and HEAD for cwd. Never throws: any git failure is a null field. */
export function headInfo(cwd: string): HeadInfo {
	const read = (args: string[]) => git(cwd, args).trim() || null;
	const repoUrl = read(["remote", "get-url", "origin"]);
	return {
		repoUrl: repoUrl === null ? null : redactRemote(repoUrl),
		branch: read(["symbolic-ref", "-q", "HEAD"])?.replace(/^refs\/heads\//, "") ?? null,
		sha: read(["rev-parse", "--verify", "-q", "HEAD"]),
	};
}

/** The Unicode space characters pi's file tools normalize to a plain space. */
const UNICODE_SPACES = /[  -   　]/g;

const MAX_LINK_HOPS = 40;

/**
 * Resolve an `edit`/`write` tool path the way pi's file tools do: normalize Unicode
 * spaces, strip a leading `@`, expand `~` and `~/` against the home directory, accept
 * a `file://` URL, and resolve anything relative against `cwd`.
 */
function resolveToolPath(cwd: string, path: string): string {
	let p = path.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = homedir();
	else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	else if (p.startsWith("file://")) p = fileURLToPath(p);
	return resolve(cwd, p);
}

/**
 * The file a write to `target` reaches, following leaf symlinks (including a
 * dangling one whose destination the write would create). A relative destination is
 * joined to the link's directory without normalizing it, so the filesystem resolves
 * every `..` and directory symlink physically when the result is later used.
 */
function writeDestination(target: string): string {
	let p = target;
	for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
		if (!lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) return p;
		const dest = readlinkSync(p);
		p = isAbsolute(dest) ? dest : `${dirname(p)}${sep}${dest}`;
	}
	return p;
}

/**
 * True when an `edit`/`write` target (see `resolveToolPath`) lands inside a git work
 * tree, judged at the file the write reaches (see `writeDestination`). The check runs
 * from the nearest existing ancestor directory, since a write may target a file in
 * directories it has yet to create. False for a path that cannot be resolved (a
 * malformed `file://` URL).
 */
export function isInWorkTree(cwd: string, path: string): boolean {
	let dir: string;
	try {
		dir = dirname(writeDestination(resolveToolPath(cwd, path)));
	} catch {
		return false;
	}
	while (!existsSync(dir)) {
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
	return isGitRepo(dir);
}

const DIFF_MAX_CHARS = 12_000;

/**
 * The current working-tree diff (tracked changes plus untracked file names),
 * capped so a large change cannot blow out the manager/worker prompt. The
 * workers can always read a file in full themselves; this is orientation.
 */
export function workingDiff(cwd: string): string {
	const tracked = git(cwd, ["diff", "--no-color"]);
	const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]).trim();
	let out = tracked;
	if (untracked) out += `\n\nUntracked files:\n${untracked}`;
	return out.length > DIFF_MAX_CHARS ? `${out.slice(0, DIFF_MAX_CHARS)}\n[diff truncated]` : out;
}

/** `git diff --stat` for the hand-off summary. */
export function diffStat(cwd: string): string {
	return git(cwd, ["diff", "--stat"]).trim();
}

const WRITE_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Runs a git command in cwd and returns raw stdout. Unlike the read-only `git()`,
 * a failure throws an Error naming the command and git's stderr.
 */
function gitRun(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: Buffer } = {}): Buffer {
	try {
		return execFileSync("git", args, {
			cwd,
			maxBuffer: WRITE_MAX_BUFFER,
			stdio: ["pipe", "pipe", "pipe"],
			env: opts.env ? { ...process.env, ...opts.env } : process.env,
			input: opts.input,
		});
	} catch (err) {
		const stderr = (err as { stderr?: Buffer }).stderr?.toString("utf8").trim();
		throw new Error(`git ${args.join(" ")} failed: ${stderr || (err as Error).message}`);
	}
}

/** `gitRun` as trimmed UTF-8 text. */
function gitLine(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: Buffer } = {}): string {
	return gitRun(cwd, args, opts).toString("utf8").trim();
}

/** The work tree root holding cwd; throws outside a work tree. */
function requireRoot(cwd: string): string {
	const root = workTreeRoot(cwd);
	if (root === null) throw new Error(`${cwd} is not inside a git work tree`);
	return root;
}

const SNAPSHOT_IDENTITY = {
	GIT_AUTHOR_NAME: "ledgerpi",
	GIT_AUTHOR_EMAIL: "ledgerpi@localhost",
	GIT_COMMITTER_NAME: "ledgerpi",
	GIT_COMMITTER_EMAIL: "ledgerpi@localhost",
};

/**
 * The tree object id of cwd's whole working state (tracked, staged, unstaged, and
 * untracked-but-not-ignored files), built in a throwaway copy of the index so the
 * real index is never touched.
 */
function workingTree(cwd: string, trackedOnly = false): string {
	const root = requireRoot(cwd);
	const scratch = mkdtempSync(join(tmpdir(), "ledgerpi-index-"));
	try {
		const indexFile = join(scratch, "index");
		const realIndex = resolve(root, gitLine(root, ["rev-parse", "--git-path", "index"]));
		if (existsSync(realIndex)) copyFileSync(realIndex, indexFile);
		const env = { GIT_INDEX_FILE: indexFile };
		gitRun(root, ["add", trackedOnly ? "-u" : "-A"], { env });
		return gitLine(root, ["write-tree"], { env });
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * The tree id of cwd's working state, or of `commit` when given. Two equal ids mean
 * identical file contents and modes.
 */
export function treeId(cwd: string, commit?: string): string {
	if (commit !== undefined) return gitLine(cwd, ["rev-parse", "--verify", `${commit}^{tree}`]);
	return workingTree(cwd);
}

/**
 * The tree id of cwd's tracked files only, as they are on disk. Unlike `treeId`, files a
 * process creates without git knowing them (build output, caches) do not change it.
 */
export function trackedTreeId(cwd: string): string {
	return workingTree(cwd, true);
}

/**
 * Commit the working state of cwd (staged, unstaged, and untracked files alike) as a
 * dangling commit on top of HEAD, and return its id. No ref, index, or file changes.
 */
export function snapshotTree(cwd: string): string {
	const tree = workingTree(cwd);
	const root = requireRoot(cwd);
	const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]).trim();
	const parent = head ? ["-p", head] : [];
	return gitLine(root, ["-c", "commit.gpgsign=false", "commit-tree", tree, ...parent, "-m", "ledgerpi snapshot"], {
		env: SNAPSHOT_IDENTITY,
	});
}

/** The directory `addCandidateWorktree` creates for round `iter`, candidate `index`. */
export function candidatePath(ledgerDir: string, iter: number, index: number): string {
	return join(ledgerDir, "candidates", `${iter}-${index}`);
}

/**
 * Create a detached worktree of cwd's repository at `commit`, locked with reason
 * `ledgerpi:<pid>` so a later run can tell a dead owner from a live one. Returns the
 * worktree path, `<ledgerDir>/candidates/<iter>-<index>`.
 */
export function addCandidateWorktree(
	cwd: string,
	ledgerDir: string,
	iter: number,
	index: number,
	commit: string,
): string {
	const path = candidatePath(ledgerDir, iter, index);
	mkdirSync(dirname(path), { recursive: true });
	gitRun(
		requireRoot(cwd),
		[
			"-c",
			"core.hooksPath=/dev/null",
			"worktree",
			"add",
			"--detach",
			"--lock",
			"--reason",
			`ledgerpi:${process.pid}`,
			path,
			commit,
		],
		{ env: { GIT_LFS_SKIP_SMUDGE: "1" } },
	);
	return path;
}

/** The administrative directory git keeps for the linked worktree at `path`, or null when it cannot be read. */
function worktreeAdminDir(path: string): string | null {
	try {
		const pointer = readFileSync(join(path, ".git"), "utf8").match(/^gitdir: (.+)$/m)?.[1];
		return pointer === undefined ? null : resolve(path, pointer.trim());
	} catch {
		return null;
	}
}

/**
 * Remove a candidate worktree and its metadata, locked or not. Never throws: cleanup
 * must not mask the error that sent the caller here.
 */
export function removeCandidateWorktree(cwd: string, path: string): void {
	const root = workTreeRoot(cwd) ?? cwd;
	const attempt = (args: string[]) => {
		try {
			gitRun(root, args);
		} catch {}
	};
	const remove = (target: string) => {
		try {
			rmSync(target, { recursive: true, force: true });
		} catch {}
	};
	const admin = worktreeAdminDir(path);
	attempt(["worktree", "unlock", path]);
	attempt(["worktree", "remove", "--force", path]);
	remove(path);
	if (admin !== null && basename(dirname(admin)) === "worktrees") remove(admin);
}

/**
 * Remove the stale candidate worktrees of cwd's repository that live under `stateDir`,
 * in any `<session>/<turn>/candidates/` directory: a crashed run's leftovers sit under
 * a ledger directory no later run reuses. A worktree is stale when its lock reason names
 * a dead `ledgerpi:<pid>`; one held by a live process, an unlocked one, and a worktree
 * elsewhere are left alone. Returns the removed paths.
 */
export function pruneStaleCandidates(cwd: string, stateDir: string): string[] {
	const root = workTreeRoot(cwd);
	if (root === null) return [];
	let base: string;
	try {
		base = realpathSync(stateDir) + sep;
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const entry of git(root, ["worktree", "list", "--porcelain"]).split("\n\n")) {
		const path = entry.match(/^worktree (.+)$/m)?.[1];
		const pid = entry.match(/^locked ledgerpi:(\d+)$/m)?.[1];
		if (path === undefined || pid === undefined || isAlive(Number(pid))) continue;
		if (!path.startsWith(base) || basename(dirname(path)) !== "candidates") continue;
		removeCandidateWorktree(root, path);
		removed.push(path);
	}
	return removed;
}

/**
 * The changes a candidate worktree made since `base` (a snapshot commit), as a binary
 * patch applicable at the root of the tree `base` was taken from. Empty when nothing changed.
 */
export function candidatePatch(worktree: string, base: string): Buffer {
	const candidate = snapshotTree(worktree);
	return gitRun(requireRoot(worktree), [
		"diff",
		"--binary",
		"--full-index",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		"--src-prefix=a/",
		"--dst-prefix=b/",
		base,
		candidate,
	]);
}

/** Apply `patch` to the work tree of cwd, all or nothing; throws, changing nothing, when it does not apply. An empty patch is a no-op. */
export function applyPatch(cwd: string, patch: Buffer): void {
	if (patch.length === 0) return;
	gitRun(requireRoot(cwd), ["apply", "--binary", "--whitespace=nowarn"], { input: patch });
}

/** Undo `applyPatch(cwd, patch)`, all or nothing; throws, changing nothing, when the tree no longer matches. */
export function revertPatch(cwd: string, patch: Buffer): void {
	if (patch.length === 0) return;
	gitRun(requireRoot(cwd), ["apply", "-R", "--binary", "--whitespace=nowarn"], { input: patch });
}
