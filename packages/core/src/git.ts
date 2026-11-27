import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isAlive } from "./proc.ts";

/** Where one work tree's git data lives, resolved once so no later call follows a `.git` file. */
export interface RepoPin {
	readonly workTree: string;
	readonly gitDir: string;
	readonly commonDir: string;
}

/** A directory git discovers the repository from (discovery calls only), or a pinned repository. */
type GitLocation = string | RepoPin;

/** Overrides on every git call that keep commands set in repository config from running; filters are not covered. */
const HARDENING = [
	"core.fsmonitor=false",
	"core.hooksPath=/dev/null",
	"hook.post-index-change.enabled=false",
	"hook.post-checkout.enabled=false",
	"hook.reference-transaction.enabled=false",
].flatMap((setting) => ["-c", setting]);

/** The working directory and full argument list of a git call at `at`. */
function invocation(at: GitLocation, args: string[]): { cwd: string; argv: string[] } {
	if (typeof at === "string") return { cwd: at, argv: [...HARDENING, ...args] };
	return { cwd: at.workTree, argv: ["--git-dir", at.gitDir, "--work-tree", at.workTree, ...HARDENING, ...args] };
}

/** Runs a git command at `at` and returns stdout, or "" on any failure. Read-only callers only. */
function git(at: GitLocation, args: string[]): string {
	try {
		const { cwd, argv } = invocation(at, args);
		return execFileSync("git", argv, {
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

/** Read origin, branch, and HEAD of `repo`. Never throws: any git failure is a null field. */
export function headInfo(repo: RepoPin): HeadInfo {
	const read = (args: string[]) => git(repo, args).trim() || null;
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

/** Keeps a diff from running a configured diff command or textconv driver, or starting git inside a submodule. */
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--ignore-submodules=dirty", "--submodule=short"];

/**
 * The current working-tree diff (tracked changes plus untracked file names),
 * capped so a large change cannot blow out the manager/worker prompt. The
 * workers can always read a file in full themselves; this is orientation.
 */
export function workingDiff(repo: RepoPin): string {
	const tracked = git(repo, ["diff", "--no-color", ...DIFF_FLAGS]);
	const untracked = git(repo, ["ls-files", "--others", "--exclude-standard"]).trim();
	let out = tracked;
	if (untracked) out += `\n\nUntracked files:\n${untracked}`;
	return out.length > DIFF_MAX_CHARS ? `${out.slice(0, DIFF_MAX_CHARS)}\n[diff truncated]` : out;
}

/** `git diff --stat` for the hand-off summary. */
export function diffStat(repo: RepoPin): string {
	return git(repo, ["diff", "--stat", ...DIFF_FLAGS]).trim();
}

const WRITE_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Runs a git command at `at` and returns raw stdout. Unlike the read-only `git()`,
 * a failure throws an Error naming the command and git's stderr.
 */
function gitRun(at: GitLocation, args: string[], opts: { env?: Record<string, string>; input?: Buffer } = {}): Buffer {
	try {
		const { cwd, argv } = invocation(at, args);
		return execFileSync("git", argv, {
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
function gitLine(at: GitLocation, args: string[], opts: { env?: Record<string, string>; input?: Buffer } = {}): string {
	return gitRun(at, args, opts).toString("utf8").trim();
}

/**
 * Pin the repository of the work tree holding `cwd`.
 *
 * @returns the pin, or null when cwd is not inside a work tree git will operate on.
 */
export function pinRepo(cwd: string): RepoPin | null {
	try {
		const out = gitRun(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
		const lines = out.toString("utf8").replace(/\n$/, "").split("\n");
		const [workTree, gitDir, commonDir] = lines;
		if (lines.length !== 3 || !workTree || !gitDir || !commonDir) return null;
		return { workTree, gitDir, commonDir: resolve(realpathSync(cwd), commonDir) };
	} catch {
		return null;
	}
}

const SNAPSHOT_IDENTITY = {
	GIT_AUTHOR_NAME: "ledgerpi",
	GIT_AUTHOR_EMAIL: "ledgerpi@localhost",
	GIT_COMMITTER_NAME: "ledgerpi",
	GIT_COMMITTER_EMAIL: "ledgerpi@localhost",
};

/**
 * The git dir of the repository checked out at `path`, relative to the work tree of `repo`,
 * or null when `path` is not a real directory inside that work tree holding one.
 */
function submoduleGitDir(repo: RepoPin, path: string): string | null {
	const dir = join(repo.workTree, path);
	try {
		if (realpathSync(dir) !== join(realpathSync(repo.workTree), path) || !statSync(dir).isDirectory()) return null;
	} catch {
		return null;
	}
	return git(repo.workTree, ["rev-parse", "--resolve-git-dir", join(dir, ".git")]).replace(/\n$/, "") || null;
}

/**
 * Mark each checked-out submodule skip-worktree in the index named by `env`, so that `git add`
 * starts no git process inside it, after recording its HEAD there. A submodule with no commit
 * checked out keeps the entry the index already has.
 *
 * @returns the marked paths.
 * @throws when a submodule path is not valid UTF-8, or an unmerged submodule has no commit checked out.
 */
function recordSubmodules(repo: RepoPin, env: Record<string, string>): string[] {
	const entries = gitRun(repo, ["ls-files", "-s", "-z"], { env }).toString("latin1").split("\0");
	const gitlinks = new Set(
		entries.filter((entry) => entry.startsWith("160000 ")).map((entry) => entry.slice(entry.indexOf("\t") + 1)),
	);
	const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	const marked: string[] = [];
	for (const listed of gitlinks) {
		const bytes = Buffer.from(listed, "latin1");
		let path: string;
		try {
			path = utf8.decode(bytes);
		} catch {
			throw new Error(`submodule path is not valid UTF-8: ${bytes.toString("utf8")}`);
		}
		const gitDir = submoduleGitDir(repo, path);
		if (gitDir === null) continue;
		const sha = git(repo.workTree, [`--git-dir=${gitDir}`, "rev-parse", "--verify", "-q", "HEAD"]).trim();
		if (sha) gitRun(repo, ["update-index", "--add", "--cacheinfo", `160000,${sha},${path}`], { env });
		marked.push(path);
	}
	if (marked.length > 0) {
		const input = Buffer.from(marked.map((path) => `${path}\0`).join(""));
		gitRun(repo, ["update-index", "--skip-worktree", "-z", "--stdin"], { env, input });
	}
	return marked;
}

/**
 * The tree object id of the whole working state of `repo` (tracked, staged, unstaged, and
 * untracked-but-not-ignored files), built in a throwaway copy of the index so the
 * real index is never touched.
 */
function workingTree(repo: RepoPin, trackedOnly = false): string {
	const scratch = mkdtempSync(join(tmpdir(), "ledgerpi-index-"));
	try {
		const indexFile = join(scratch, "index");
		const realIndex = resolve(repo.workTree, gitLine(repo, ["rev-parse", "--git-path", "index"]));
		if (existsSync(realIndex)) copyFileSync(realIndex, indexFile);
		const env = { GIT_INDEX_FILE: indexFile };
		// A sparse checkout otherwise drops skip-worktree from every path present on disk. The index
		// writes in recordSubmodules have already saved that drop for all other paths.
		const keepSkipped =
			recordSubmodules(repo, env).length > 0 ? ["-c", "sparse.expectFilesOutsideOfPatterns=true"] : [];
		gitRun(repo, [...keepSkipped, "add", trackedOnly ? "-u" : "-A"], { env });
		return gitLine(repo, ["write-tree"], { env });
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * The tree id of the working state of `repo`, or of `commit` when given. Two equal ids mean
 * identical file contents and modes.
 */
export function treeId(repo: RepoPin, commit?: string): string {
	if (commit !== undefined) return gitLine(repo, ["rev-parse", "--verify", `${commit}^{tree}`]);
	return workingTree(repo);
}

/**
 * The tree id of the tracked files only of `repo`, as they are on disk. Unlike `treeId`, files a
 * process creates without git knowing them (build output, caches) do not change it.
 */
export function trackedTreeId(repo: RepoPin): string {
	return workingTree(repo, true);
}

/**
 * Commit the working state of `repo` (staged, unstaged, and untracked files alike) as a
 * dangling commit on top of HEAD, and return its id. No ref, index, or file changes.
 */
export function snapshotTree(repo: RepoPin): string {
	const tree = workingTree(repo);
	const head = git(repo, ["rev-parse", "--verify", "-q", "HEAD"]).trim();
	const parent = head ? ["-p", head] : [];
	return gitLine(repo, ["-c", "commit.gpgsign=false", "commit-tree", tree, ...parent, "-m", "ledgerpi snapshot"], {
		env: SNAPSHOT_IDENTITY,
	});
}

/** The directory `addCandidateWorktree` creates for round `iter`, candidate `index`. */
export function candidatePath(ledgerDir: string, iter: number, index: number): string {
	return join(ledgerDir, "candidates", `${iter}-${index}`);
}

/**
 * The administrative directory under the common git dir whose `gitdir` file names the
 * worktree at `path`, or null when there is none. The worktree's own `.git` is not read.
 */
function worktreeAdminDir(repo: RepoPin, path: string): string | null {
	let parent = dirname(path);
	try {
		parent = realpathSync(parent);
	} catch {}
	const link = resolve(parent, basename(path), ".git");
	const admins = join(repo.commonDir, "worktrees");
	let ids: string[];
	try {
		ids = readdirSync(admins);
	} catch {
		return null;
	}
	for (const id of ids) {
		const admin = join(admins, id);
		try {
			const recorded = readFileSync(join(admin, "gitdir"), "utf8").replace(/\r?\n$/, "");
			if (resolve(realpathSync(admin), recorded) === link) return admin;
		} catch {}
	}
	return null;
}

/** Best-effort removal of a linked worktree, its directory and its administrative directory. Never throws. */
function discardWorktree(repo: RepoPin, workTree: string, adminDir: string | null): void {
	const attempt = (step: () => void) => {
		try {
			step();
		} catch {}
	};
	attempt(() => gitRun(repo, ["worktree", "unlock", workTree]));
	attempt(() => gitRun(repo, ["worktree", "remove", "--force", workTree]));
	attempt(() => rmSync(workTree, { recursive: true, force: true }));
	if (adminDir !== null && dirname(adminDir) === join(repo.commonDir, "worktrees")) {
		attempt(() => rmSync(adminDir, { recursive: true, force: true }));
	}
}

/**
 * Create a detached worktree of `repo` at `commit`, under
 * `<ledgerDir>/candidates/<iter>-<index>`, locked with reason `ledgerpi:<pid>` so a
 * later run can tell a dead owner from a live one.
 *
 * @returns the new worktree's pin.
 * @throws when the worktree cannot be created or pinned; what this call created is removed first.
 */
export function addCandidateWorktree(
	repo: RepoPin,
	ledgerDir: string,
	iter: number,
	index: number,
	commit: string,
): RepoPin {
	const path = candidatePath(ledgerDir, iter, index);
	mkdirSync(dirname(path), { recursive: true });
	const taken = existsSync(path) || worktreeAdminDir(repo, path) !== null;
	try {
		gitRun(repo, ["worktree", "add", "--detach", "--lock", "--reason", `ledgerpi:${process.pid}`, path, commit], {
			env: { GIT_LFS_SKIP_SMUDGE: "1" },
		});
		const gitDir = worktreeAdminDir(repo, path);
		if (gitDir === null) throw new Error(`no worktree metadata for ${path} under ${repo.commonDir}`);
		return { workTree: path, gitDir, commonDir: repo.commonDir };
	} catch (err) {
		if (!taken) discardWorktree(repo, path, worktreeAdminDir(repo, path));
		throw err;
	}
}

/**
 * Remove a candidate worktree of `repo` and its metadata, locked or not. Never throws:
 * cleanup must not mask the error that sent the caller here.
 */
export function removeCandidateWorktree(repo: RepoPin, candidate: RepoPin): void {
	discardWorktree(repo, candidate.workTree, candidate.gitDir);
}

/**
 * Remove the stale candidate worktrees of `repo` that live under `stateDir`,
 * in any `<session>/<turn>/candidates/` directory: a crashed run's leftovers sit under
 * a ledger directory no later run reuses. A worktree is stale when its lock reason names
 * a dead `ledgerpi:<pid>`; one held by a live process, an unlocked one, one with no
 * administrative directory, and a worktree elsewhere are left alone. Returns the removed paths.
 */
export function pruneStaleCandidates(repo: RepoPin, stateDir: string): string[] {
	let base: string;
	try {
		base = realpathSync(stateDir) + sep;
	} catch {
		return [];
	}
	const removed: string[] = [];
	for (const entry of git(repo, ["worktree", "list", "--porcelain"]).split("\n\n")) {
		const path = entry.match(/^worktree (.+)$/m)?.[1];
		const pid = entry.match(/^locked ledgerpi:(\d+)$/m)?.[1];
		if (path === undefined || pid === undefined || isAlive(Number(pid))) continue;
		if (!path.startsWith(base) || basename(dirname(path)) !== "candidates") continue;
		const gitDir = worktreeAdminDir(repo, path);
		if (gitDir === null) continue;
		removeCandidateWorktree(repo, { workTree: path, gitDir, commonDir: repo.commonDir });
		removed.push(path);
	}
	return removed;
}

/**
 * The changes a candidate worktree made since `base` (a snapshot commit), as a binary
 * patch applicable at the root of the tree `base` was taken from. Empty when nothing changed.
 */
export function candidatePatch(candidate: RepoPin, base: string): Buffer {
	const snapshot = snapshotTree(candidate);
	return gitRun(candidate, [
		"diff",
		"--binary",
		"--full-index",
		"--no-color",
		...DIFF_FLAGS,
		"--src-prefix=a/",
		"--dst-prefix=b/",
		base,
		snapshot,
	]);
}

/** Apply `patch` to the work tree of `repo`, all or nothing; throws, changing nothing, when it does not apply. An empty patch is a no-op. */
export function applyPatch(repo: RepoPin, patch: Buffer): void {
	if (patch.length === 0) return;
	gitRun(repo, ["apply", "--binary", "--whitespace=nowarn"], { input: patch });
}

/** Undo `applyPatch(repo, patch)`, all or nothing; throws, changing nothing, when the tree no longer matches. */
export function revertPatch(repo: RepoPin, patch: Buffer): void {
	if (patch.length === 0) return;
	gitRun(repo, ["apply", "-R", "--binary", "--whitespace=nowarn"], { input: patch });
}
