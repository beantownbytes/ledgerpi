# ledgerpi

Ledger-based manager-worker coding for [pi](https://pi.dev) and
[Claude Code](#claude-code). ledgerpi runs the
zero-shot self-orchestration scaffold from
[arXiv 2608.26480](https://arxiv.org/abs/2608.26480) invisibly under the session
on a local model: a manager plans, fresh-context workers each take one task, and
the work is coordinated through a ledger on disk with the repository's own test
suite as ground truth. You type a request, confirm the loop when asked, and get an
answer; `/ledger <task>` starts it explicitly.

## The idea

The paper measures that scaffold at +23.2 pass@1 over a single call on a local
Qwen3.8-27B (five paired passes on the 100 hardest LiveCodeBench problems), at
roughly triple the tokens. The gains come from three mechanisms: reasoning is
committed to disk before code is written, coupled objectives are decomposed
across calls, and every call is bounded so a small model cannot run its output
off a cliff. The gains shrink to nothing on frontier models that already plan
and stop on their own, so ledgerpi runs only under the providers you list.

## What it does

On a user prompt, ledgerpi:

1. **Classifies** the request `code` or `chat` with one short call on the
   session model. Only `code` enters the loop; everything else passes straight
   through.
2. **Asks** (under the default `trigger = "ask"`) whether to run the loop on this
   prompt: Run, Skip (this prompt), or Skip for this session. Anything but Run
   passes the turn through untouched; `/ledger <task>` runs it explicitly later.
   With no UI to ask (print mode, `pi -p`) the prompt passes through. RPC mode
   has a UI: the dialog reaches the client as an `extension_ui_request`, so an
   unattended RPC client must answer it or set `trigger = "auto"` or `"manual"`.
3. **Runs the loop.** A `ledger-manager` sub-agent writes a plan and a task
   list; an ideation `ledger-worker` lists approaches; then, each round, the
   manager briefs one task (the task, the files to change, acceptance criteria,
   what is out of scope, and a targeted check), a fresh worker implements it in
   the working tree, and the host runs the repo's test gate. The brief scopes the
   worker by instruction only; nothing rejects an edit outside its files. A
   failing gate overrides a "done". By default each round runs one worker. With
   `fanout = "on"` and a gate, a round the manager marks `best-of-n` instead runs up
   to `fanoutMax` workers at once in candidate worktrees and keeps the first whose
   gate passes (see [Fan-out](#fan-out)). The
   manager and worker render in pi's sub-agent widget while they
   run, so the work is visible there; the chat stays a single hand-off. Each
   row names the model its role runs on and the phase, the pass the role is
   running, e.g. `ledger worker (local/qwen3.8-27b, work)`.
4. **Hands back** one compact result: the changes are already in the working
   tree, so the main session verifies briefly and answers rather than redoing
   the work. A non-converged run hands back its notes and remaining tasks so the
   main model continues from there.

The manager and worker are the same underlying model in fresh contexts by
default, spawned through the `@tintinweb/pi-subagents` cross-extension RPC as agent
types named `ledger-manager` and `ledger-worker` (see
[Requirements](#requirements)).

### Cross-model roles

`[roleModel]` pins both roles per session model, so a fast model can plan and
review while a stronger one implements. Each entry names both a `manager` and
a `worker`. With no table at all, an allowlisted session model runs every role on
the session model, or on its deprecated `[workerModel]` alias for the worker.
A present table without a reserved `default` also narrows activation to the
session models it lists (or the deprecated `[workerModel]` alias), so an
allowlisted model with no entry passes through; with no table, every allowlisted
model is in scope.

The reserved `default` key is the fallback for session models the table does not
name. It may name a `manager` and/or a `worker`, at least one, each a
`"provider/modelId"`. A default present counts as an activation opt-in, so the
table stops narrowing: every allowlisted model is in scope again, while the
worker (and the manager, when named) stays pinned. A named entry wins over the
default, and the default wins over the session model. A deprecated `[workerModel]`
alias entry outranks the default too, and takes both roles: an aliased session
model keeps its manager on the session model even when the default names one.

```toml
[roleModel]
"remote/qwen3.8-flash-next" = { manager = "remote/qwen3.8-flash-next", worker = "local/qwen3.8-27b" }
default = { worker = "local/qwen3.8-27b" }
```

Every session-model key is a quoted `"provider/modelId"`; the reserved `default` key
is written bare. Each pinned model is passed as the RPC spawn's `model`, so it must
resolve in the
session's model registry, and when pi-subagents' Model Scope is on it must also
be in `enabledModels`, or the spawn is refused and the run stops with
`stop: "spawn-failure"`. There is no fallback to the session model for a pinned
model that does not resolve. The hand-off block and the audit row name both role
models.

`[workerModel]` is a deprecated alias that pins only the worker:
`"remote/qwen3.8-flash-next" = "local/qwen3.8-27b"` spawns the ideation,
implementation, and finalize workers on the mapped model and leaves the manager
on the session model. It still works and warns at config load; a `[roleModel]`
entry for the same session model wins.

## Three entry points

The same loop runs from any of three entry points, sharing one re-entrancy
guard and one token tally (both show in `/ledgerpi`):

1. **The `input` hook** -- a natural-language coding prompt submitted to the
   session (an `interactive` or `rpc` source). This is the seamless path:
   classify, ask (per `trigger`), run the loop, hand back one transformed turn. It
   fires only on such a submitted prompt, never on a slash command. `trigger`
   picks how it starts: `ask` (default) shows the Run / Skip / Skip-for-session
   dialog, `auto` runs without asking, and `manual` never runs from the hook (and
   skips the classifier call). While the dialog is open ledgerpi emits
   `herdr:blocked`, so a herdr pane reads as waiting on a question.
2. **The `/ledger <task>` command** -- an explicit run on the task you name, with
   no classifier and no dialog (typing it is the consent). It needs an idle
   session, an in-scope model, a git repo, and pi-subagents, and notifies instead
   of running when any is missing or a loop is already running. When the loop
   finishes, the task plus the hand-off block is sent as a user message, so the
   main model verifies and answers as it does after an `input`-hook run. In print
   mode (`pi -p "/ledger <task>"`) the hand-off block is written to stderr
   instead, since print mode exits once the command returns; pi reserves stdout
   there for its own text or JSON output and routes extension output to stderr.

   **Cancelling.** An `input`-hook or `/ledger` loop runs while the session is
   idle, where pi offers no abort signal, so ledgerpi gives it its own. Press
   Escape (the literal key; a rebound `app.interrupt` is not followed) to cancel
   it in interactive mode -- the status line shows `(esc to stop)`, and while the
   gate runs it counts the elapsed gate time against `gateTimeoutMs`. An RPC client
   sends `/ledger-stop`; typed in interactive mode it would queue behind the
   running loop, so use Escape there. Quitting, reloading, or switching sessions
   cancels it too. A cancelled loop stops its workers, is audited
   `stop: "aborted"`, and sends no hand-off; for an `input`-hook run the prompt
   is dropped rather than re-run inline.
3. **The `ledger_solve` tool** -- a tool the model itself calls mid-run. A
   slash-command or agent-driven session (`/review-task`, `/drive-*`) never
   reaches the `input` hook: the launching command is escaped, and the coding
   then happens across the agent's own tool turns, not a fresh user input. So
   ledgerpi also registers `ledger_solve({ task, gate?, cwd?, plan_file?, fanout? })`,
   which a skill points its implementation phase at. `cwd` targets a carved
   worktree when the change must land there rather than in the session's
   checkout. `plan_file` is the absolute path to an approved implementation
   plan: with it the loop skips its own planning and ideation calls, and the
   manager builds the task list from that plan (the caller keeps ownership of
   commits, pushes, review, and tracking). A file that cannot be read, is not a
   regular file, or is empty gets a plain-text refusal naming the path. `fanout`
   (`off`, `advise`, `ask`, or `on`) can only lower the configured `fanout` setting
   (off < advise < ask < on), never raise it; an invalid value is ignored. It runs
   the same loop and returns the same hand-off block as a tool result; the edits
   are already applied when it returns. Every guard failure (disabled,
   out-of-scope provider, no git repo, no pi-subagents, an empty task, an
   unusable plan file) returns a plain-text result telling the agent to
   implement the task itself. The tool is registered only when the extension
   is enabled and not disabled by `LEDGERPI=0`.

The `ledger_solve` path still depends on the model choosing to call it. To bridge
a skill/slash session into the loop without that choice, set `autoTrigger =
"redirect"` (opt-in, off by default) and list the skills to arm for in
`redirectSkills`. ledgerpi then arms on each agent run the `input` hook did not
own **whose launching slash command is in `redirectSkills`**, and blocks the first
inline `edit`/`write` whose target is inside a git work tree, steering the model to
`ledger_solve` instead. A write outside any work tree (a skill's scratch `plan.md`
under `$TMPDIR`) passes without asking and leaves the run armed for the first
in-repo edit, which may be in a carved worktree rather than the session cwd. Under
`trigger = "ask"` with a UI, that first block asks the same Run / Skip /
Skip-for-session question first: Run blocks and steers, Skip disarms the run and
lets the edit through inline, and a session skip from either path stops both from
asking. A decline is audited as a `passthrough` row with `entry: "redirect"`.
`trigger = "auto"`, or no UI, redirects without asking. Gating on the
command keeps the redirect off non-coding skills (`/create-worktree`,
`/report-task`, ...) that legitimately write files: the launching `/command` is
captured from the raw input the hook sees before expansion, so the match is exact,
not a guess. This matches markdown skill/prompt-template commands (what you list),
not extension-registered commands, which pi dispatches before any input event.
List skills by their bare name: pi's `skill:` prefix is ignored on both sides, so
`"review-task"` matches `/skill:review-task` as well as a `/review-task` template.
`redirectSkills` is fail-closed -- empty arms nothing. For a named list, eligibility
is consumed per run: `before_agent_start` reads the launching command and clears it,
so it binds to exactly the run that command started and a follow-on run with no
fresh command does not arm. `"*"` is the deliberate exception -- it arms every
qualifying skill run regardless of the launching command (unrestricted redirect),
so use it only when you want the broad, pre-allowlist behavior. Eligibility is
scoped to a single run: `agent_end` disarms, and each new input submission resets
the pending command, so an armed run never leaks its authorization to a later run.
The one residual is a command steered or queued into an already-running turn (pi's
`steer`/`follow_up` inject without a fresh `input` or `before_agent_start`, so there
is nothing to re-evaluate on): the run stays armed for its launching command,
bounded by the block cap. It disarms as soon as a run is recorded, so the loop runs
once; it fails open (out of scope, no git repo, no pi-subagents) and relents after
a couple of blocked edits, so it is never worse than not being installed (see
"Failure is always a fallback"). A sentinel prepended to the spawned manager and
worker prompts keeps a ledger sub-agent from re-entering the loop: both the
redirect and the `input` hook ignore a sentinel-tagged run, so a worker never
blocks its own edits nor starts a nested loop.

### Continuing a session in the loop

When a session is already implementing inline (the redirect was off, declined, or
relented), `/skill:ledger-continue [notes]` hands the remaining work to the loop.
The skill ships in this package (`skills/`, listed in the `pi` manifest) and only
runs when you invoke it. It finds the checkout the change lives in (a carved
worktree or the session cwd), writes a self-contained task from the approved plan's
remaining steps and the current diff, and calls `ledger_solve` with that `cwd`. The
models are ledgerpi's: the manager on its `[roleModel]` pin when the session
model has a `[roleModel]` entry, else on the `[roleModel] default` manager, else
the session model, and the worker on its `[roleModel]` pin, its deprecated
`[workerModel]` alias, the `[roleModel] default` worker, or the session model. An
`[workerModel]` alias takes both roles, so an aliased session model keeps its
manager on the session model even when the default names one.
After the hand-off it verifies the diff and the gate, then
returns to the workflow that was running. If ledgerpi is inactive it stops and
says so rather than editing inline.

## The continuation guard

A bare "go on" names no task, so it is never promoted into a fresh run. Before
any scope, readiness, classification, or run launch, the `input` hook
recognizes a closed set of continuation-only prompts and passes the turn
through untouched: the parent session keeps ownership and continues in its own
conversation, with no classifier call, no spawn, no audit row, and no ledger
state. The guard is unconditional -- it runs with `classifier = true` and
`classifier = false` alike -- and a continuation-only turn never arms the edit
redirect, so a wildcard `redirectSkills` cannot pull a bare "continue" into the
loop. An explicit `ledger_solve` call with a concrete `task` and `cwd` is a
separate entry point and stays fully available.

The matcher works on a trimmed, case- and whitespace-insensitive copy of the
input and anchors the **entire** message, so a standalone request that merely
begins with "continue" or "resume" proceeds as a normal coding task. Recognized
forms, in their entirety:

- the bare heads: `continue`, `resume`, `go on`, `keep going`, `carry on`,
  `pick up where we left off`, `pick up where you left off`;
- an optional leading and/or trailing `please` and an optional terminal `.` or `!`;
- for `continue`/`resume` only, a context-only suffix: `where we left off`,
  `where you left off`, `from where we left off`, `from where you left off`,
  `the previous task`, `the last task`;
- at most one interruption clause after a single separator (`--`, `-`, `,`,
  `:`, `;`, `.`), drawn from the closed set: `i had to close my laptop`,
  `i closed my laptop`, `my laptop went to sleep`, `i got disconnected`,
  `the connection dropped`.

The trailing clause is a closed set, not free text: any additional sentence,
concrete instruction, or code block makes the message a task, not a
continuation (e.g. `continue -- fix parser.ts so empty input returns []`
proceeds normally).

## The host owns the ledger

Every ledger file (`task.md`, `plan.md`, `notes.md`, `tasks.json`) is written by
the extension, never by a spawned agent. A sub-agent session loads its own
permission judge with an empty scratch-dir registry, so an agent write to a
host-minted scratch path would prompt and stall a background worker. The host
has no such gate, so it owns the files and the agents only read them (their
prompts carry the content inline). The gate command is likewise run by the host,
not by a `gate:` on a worker, so the pass/fail verdict is one deterministic
signal in one place.

## Failure is always a fallback

Every guard and every error path returns the turn untouched. Not a git repo, a
provider outside the list, no pi-subagents in the session, a classifier that
will not answer, a spawn that never replies, an exception anywhere in the loop:
each one lets the normal turn proceed. ledgerpi must never make a turn worse
than not being installed.

## Fan-out

By default a round runs one worker. `fanout` is an opt-in, default-off setting
(`off`, `advise`, `ask`, `on`, in increasing order of permissiveness) that lets the
loop run several workers at once on one task.
`fanoutMax` (2 to 8, default 2) is how many. A per-call `fanout` on `ledger_solve`
or `ledgerctl solve --fanout` can only lower the configured setting, never raise it,
so a model-written argument cannot switch on what the config left off.

**The recommendation.** When the setting is not `off`, each manage and review reply
also carries a `### MODE` section: `serial|best-of-n|fleet: <reason>`. The manager
suggests `serial` when the next task depends on the last result or the tasks share
files, `best-of-n` for a small self-contained task with an uncertain approach or a
retry after a red gate, and `fleet` for two or more open tasks on disjoint files.
The brief itself (the next task, files, acceptance criteria, out of scope, check)
is unchanged, so a serial round always has a full brief. With `fanout = "off"` the
manage prompt is exactly what it was before the setting existed. A reply with no
valid `### MODE` is recorded as no recommendation.

**What each setting does.**

- `off`: serial, no recommendation asked.
- `advise`: the recommendation is asked for and recorded (transcript, hand-off, audit),
  but every round runs serially. This is how to see what the manager would do before
  turning `on`.
- `ask`: like `on`, but a `best-of-n` recommendation is only a proposal. pi shows a
  dialog before the round with four choices: yes (this round), no (run this round
  serially), yes for the rest of this run, and no for the rest of this run. The
  "rest of this run" answers are remembered until the loop ends and are not asked
  again; a plain yes or no is asked again on the next best-of-N recommendation.
  Esc dismisses the dialog and counts as no; it does not stop the run. A round the
  manager recommends as `serial` or `fleet`, or that has no gate, never asks. The
  round runs serially, with a recorded reason, when it is not confirmed:
  `declined` (the user said no, by choice, Esc, or a remembered no), `no-ui`
  (there is no way to ask: headless pi, `ledger_solve` without a UI, `ledgerctl`
  and so Claude Code, which has no dialog yet; `ask` there behaves like `advise`
  and never blocks), or `ask-failed` (the dialog could not be shown; this is not
  remembered, so the next best-of-N round asks again). A `latched` run stays
  serial even after a remembered yes.
- `on`: a `best-of-n` recommendation runs the round as best-of-N without asking.
  Every other round runs serially. The round falls back to serial with a recorded
  reason when it cannot fan out: `no-gate` (no gate to pick a winner), `latched` (an
  earlier escape turned fan-out off for the rest of the run), `setup-failed` (the
  snapshot or a worktree could not be made; this also latches), or
  `fleet-unavailable` (the manager recommended `fleet`, which is not built yet, so
  nothing runs as a fleet).

**Best-of-N.** The host snapshots the working tree, including uncommitted and
untracked files, without touching the index, and adds `fanoutMax` detached git
worktrees at that snapshot under `<stateDir>/<session-id>/<turn-id>/candidates/`.
Each is locked with the reason `ledgerpi:<pid>`. The workers run concurrently, one per
worktree, and their prompts name the worktree as the only place to edit. As each
finishes, the host applies its changes as a patch to the real tree and runs the
gate there. Gates run one at a time on the real tree, never in the worktrees, so
they see the real dependencies and ports. The first candidate whose gate passes is
kept, its patch stays, and the others are aborted; a candidate whose gate fails is
reverted and the next one is tried. If none passes, the first candidate to finish is
re-applied so the manager sees a real failure and its gate output. If every worker
failed, the tree is untouched and the round counts as one worker failure. The
winning round's gate verdict is the round's gate; the loop does not run it twice.

**Escapes.** If a worker edits the real tree instead of its worktree (the tree no
longer matches the snapshot, or a tracked file changes while a candidate's gate runs),
or a revert fails, the host keeps the tree as it is,
runs the normal gate on it, and latches fan-out off for the rest of the run. The
reason (`tree-changed`, `revert-failed`, `reapply-failed`, or `git-error: ...`) is
recorded as an escape.

**Cleanup.** Worktrees are removed when the round ends on every path. On abort,
every worker is stopped, any unkept patch is reverted, and the tree is left as the
snapshot. At loop start (when the setting is not `off`) the host prunes leftover
candidate worktrees under the state dir whose lock names a dead pid, and leaves
live ones alone, so concurrent sessions do not disturb each other.

**Limits.**

- A candidate worktree is a fresh checkout of the snapshot, so it lacks ignored
  dependencies such as `node_modules`. A worker's own targeted check can fail
  inside one; the host's gate on the real tree is unaffected.
- The escape check compares the real tree with the snapshot. A gate that writes
  untracked files that are not ignored changes the tree between candidates, which
  can raise a false `tree-changed` escape (and latch fan-out off). Ignore such
  files in git.
- The escape check during a gate compares tracked files only, so a worker that
  creates a new untracked file in the real tree while a gate runs is not detected.
- The candidate worktrees live under the state directory, where a sub-agent's file
  write may be ask-first on a harness. Whether workers can edit there without a
  prompt has not been verified on a live pi or Claude Code run; if they stall, each
  worker costs `callTimeoutMs` and two such rounds end the run with
  `spawn-failure`. Try `fanout = "advise"` first, then `"ask"` or `"on"` on a scratch repo.
- A worker queued behind the sub-agent concurrency limit counts its wait against
  `callTimeoutMs`.
- Fleet execution (several workers on disjoint parts of one problem) is not built:
  a `fleet` recommendation is recorded but runs serially.

**Where it shows.** `/ledgerpi` and `ledgerctl status` print `fanout: <setting>
(max N)`, and `ledgerctl status --json` has `fanout` and `fanoutMax`. The progress
label reads `working (best-of-N)` and the sub-agents are labeled `work 1/N`. The
transcript's `brief` row gains `mode` (and, when the setting is not `off`,
`advised`, `reason`, and `downgrade`), and each best-of-N round adds a `fanout` row
with every candidate's outcome. The hand-off block gains a `Fan-out:` line when the
setting is not `off` (under `ask` it also says `Asked: k.`, the number of questions
put to the user), and the audit row a `fanout` object (see [State](#state)).

## Measured results

Only what was benchmarked is claimed here; everything else is untested. Figures are
as recorded in the source named in each row, and a re-run can differ.

- **Worker output cap (the only measured improvement).** Raising the `qwen3.8-27b`
  worker's `maxTokens` from 32768 to 65536 at `thinking=high`, 6 tasks x 2 reps per
  arm, 8 runs in flight, fixed manager. 65536 against 32768: converged-green 10 against
  8 of 12; output-limit events 0 against 3; limit rate (events per worker call) 0
  against 0.039; mean blind score 6.83 against 6.46; tokens 14.46M against 12.39M, about
  17% more. Directional only: the sample is small and the result's own caveats (a
  mid-run timeout change, mixed revisions) are not quantified. As recorded in
  `bench/worker-thinking/RESULT.md`; the harness is `bench/worker-thinking/`.
- **`workerThinking` level.** Not measured: the stage 1 run was never completed or
  scored. As recorded in `bench/worker-thinking/RESULT.md`.
- **Fan-out (`fanoutMax`).** One N=2 calibration probe: 7 valid runs, 0 best-of-n
  rounds (state `no-engagement`), one run hit the 1800 s timeout, mean 752 s per run.
  The manager never chose best-of-n, so `fanoutMax` has no measured effect and no
  sweep was run. As recorded in `bench/fanout/README.md`.
- **Concurrency.** `bench/concurrency/` measures local inference throughput at 1-20
  concurrent requests, to help choose `fanoutMax`. It is a tool only; no results are
  published.
- **The +23.2 pass@1** in [The idea](#the-idea) is cited from the paper. It was not
  measured here.

## Install

### Requirements

- [pi](https://pi.dev) and a Node.js runtime (pi runs the TypeScript directly), plus
  `git`: the loop works in a git working tree.
- `@tintinweb/pi-subagents`, installed in pi. It is required for the pi adapter and
  for the fan-out and worker-thinking benches (they run a real `pi -p`). Every
  manager and worker spawn goes through its cross-extension RPC. Without it,
  `/ledger` says "the pi-subagents RPC is unavailable in this session", the automatic
  input and redirect paths skip silently, and `/ledgerpi` status shows
  `subagents RPC: <state>`.
- The agent types `ledger-manager` and `ledger-worker`. Copy
  `extensions/ledgerpi/agents/ledger-manager.md` and `ledger-worker.md` into
  `$PI_CODING_AGENT_DIR/agents` (default `~/.pi/agent/agents`) so they resolve.
- A model provider. `providers`, `allowlist`, `[roleModel]` and `[workerModel]` name
  models as `provider/modelId`, where each provider id is a key of `providers` in pi's
  `models.json`. See [Configure](#configure).

`packages/core`, the Claude Code adapter (native sub-agents), the concurrency bench
(plain HTTP) and the test suite (a stub bus) do not need pi-subagents.

pi loads the extension's TypeScript directly via jiti; there is no build step.
The extension has one runtime dependency (`smol-toml`), so when you load it from a
local path or file, install dependencies first with `make bootstrap` (or `npm ci`)
in the checkout, or the config loader's import fails. A pi git source installs the
dependencies for you.

```jsonc
// ~/.pi/agent/settings.json
{
	"packages": ["/path/to/ledgerpi"]
}
```

Or point at the extension file directly with
`"extensions": [".../extensions/ledgerpi/index.ts"]`, or load it for one session
with `pi -e extensions/ledgerpi/index.ts`.

## Claude Code

The same loop, ledger, gate, and audit log run under Claude Code, with an Opus 5.5
manager and Sonnet 5.5 workers as native sub-agents. It is explicit only: there is no
classifier, no auto-trigger, and no edit redirect. A run starts from
`/ledgerpi:ledger <task>`, from `/ledgerpi:ledger-continue`, or from a skill calling the
`mcp__ledgerpi__ledger_solve` tool, and the main session makes that one tool call.

```bash
make bootstrap install    # needs npm and bun; compiles ledgerctl into ~/.local/bin
claude plugin marketplace add ./packages/claude
claude plugin install ledgerpi@ledgerpi-local
```

Then add a `[claude]` table to the config. It is the opt-in: without it the plugin
registers no tool. `ledgerctl status` reports whether the loop is active and why not.

| Key | Default | Meaning |
| --- | --- | --- |
| `claude.manager` | `claude-opus-5-5` | Full model id for the manager role. |
| `claude.worker` | `claude-sonnet-5-5` | Full model id for the worker role. |

`maxIters`, `gate`, `callTimeoutMs`, `gateTimeoutMs`, `stateDir`, `auditLog`, `fanout`, and
`fanoutMax` are shared with pi. `providers`, `allowlist`, `roleModel`, and the `*Thinking` keys are not;
role effort comes from the agent definitions in `packages/claude/agents/`.

How a run works: the plugin's mod starts `ledgerctl solve`, which runs the shared loop
and prints JSONL on stdout (`step`, `stop`, `progress`, `done`, `refused`). The mod starts
each `step` as a sub-agent and writes its answer to the step's reply file. `ledgerctl`
owns the ledger, the gate, a per-work-tree lock under `<stateDir>/locks/`, and the audit
row. The lock is per work tree, so `ledgerctl stop --cwd <dir>` ends the loop on that tree
and `ledgerctl status --json --cwd <dir>` reports it under `lock`, as `null` when free,
`{ root, pid }` when held, or `{ error }` when the lock cannot be read; Escape in the session
ends the loop too.

`ledgerctl solve --plan-file <path>` is what the mod passes when `ledger_solve` gets
`plan_file`. It has the same effect: the loop skips its planning and ideation steps and the
first step is the manager building the task list from the plan. An unreadable or empty file
exits 3 with a refusal naming the path.

`ledgerctl solve --fanout off|advise|ask|on` is what the mod passes when `ledger_solve` gets
`fanout`. It can only lower the configured `fanout` setting, never raise it. `ledgerctl`
has no way to ask, so `ask` runs as `no-ui` there: a best-of-N recommendation runs
serially. An invalid or
blank value prints one `[ledgerpi] ignoring --fanout` warning on stderr and keeps the
configured setting; it does not fail the run.

What to expect from the sub-agents:

- **Permissions.** The mod answers `tool.check` for its own spawn of the two role agents,
  turning an `ask` into `allow` while a run is live, because auto mode's classifier does
  not judge a spawn no model request produced. A deny rule still wins. It covers the spawn
  only: every tool call a sub-agent makes goes through the session's own permissions and
  hooks, so outside auto mode its prompts appear in the main session, and time spent on a
  prompt counts against `callTimeoutMs`. The test gate is the exception: `ledgerctl` runs
  it directly through `/bin/sh`, as the loop does under pi, so no permission rule, hook, or
  classifier sees it. That covers a `gate` argument, `.ledgerpi-gate`, and any Makefile
  target a worker has just edited.
- **Context.** Both roles run without CLAUDE.md, as pi's run without context files; the
  role prompts carry the quality rules and point at the repository's own CLAUDE.md or
  AGENTS.md. The session's reports from them are swallowed, so the main session reads only
  the hand-off.
- **Turn limits.** A worker that hits `maxTurns` keeps its edits and the gate decides. A
  worker that backgrounds a command is stopped when its turn ends.

## Configure

**Required.** ledgerpi reads a tracked TOML file and is fail-closed: on pi, without a
config file that names at least one provider, it is **inert** -- every input and
every `ledger_solve` call passes straight through. Under Claude Code the `[claude]`
table is the opt-in instead. There is no built-in provider fallback, so a missing or
malformed config never silently runs the loop.

Copy `ledgerpi.example.toml` to `~/.config/ledgerpi/config.toml`. The path is
`$LEDGERPI_CONFIG` if set, else `$XDG_CONFIG_HOME/ledgerpi/config.toml`, else
`~/.config/ledgerpi/config.toml`. A malformed file, or a path that is not a regular
file (a directory or FIFO) or cannot be read, is reported once and treated as inert. The operational knobs each fall back to their default; `enabled`,
`providers`, and `allowlist` come only from the file. (The retired
`~/.pi/agent/ledgerpi.json` is no longer read; a one-time pointer is logged if it
is still present. The retired `[blocklist]` table is likewise not read: its
meaning is inverted, so its presence fails the config closed with a migration
message instead of silently widening scope.)

```toml
enabled = true
providers = ["cerebras", "local"]
maxIters = 8            # optional operational overrides
workerThinking = "high"
[allowlist]
cerebras = ["gemma-4-31B"]   # restrict cerebras to this model; omit the entry to allow all
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` (in a valid file) | Master switch. |
| `providers` | none (required) | Provider ids the loop runs under. No default; absent/empty means inert. A frontier cloud provider is deliberately left off. |
| `allowlist` | `{}` | Per-provider permitted model ids. A provider in `providers` with no entry runs every one of its models; with an entry it runs only the ids listed (an empty entry permits none). |
| `gate` | `null` | Explicit test command, applied to every repo. Unset detects it per repo: a `.ledgerpi-gate` file in the working directory (its trimmed content is the shell command, CRLF line endings accepted; a file of several lines runs under `set -e`, so a failing command fails the gate, except one before the last stage of a pipeline such as `make test \| tail`; a blank or comment-only file, one that is not a regular file, or one that cannot be read is ignored), then a Makefile `test` target, then the language manifest (`pytest`, `npm`/`bun test`, `cargo test`, `go test`). Use `.ledgerpi-gate` for a repo whose CI entry point none of the probes find; committing it is what carries it into every worktree cut from that branch. |
| `maxIters` | `8` | Manager to worker round budget. |
| `workerThinking` | `high` | Thinking level for the worker role. |
| `managerThinking` | `high` | Thinking level for the manager role. |
| `roleModel` | `null` (absent) | Per-session-model role pins and activation narrowing: `"provider/modelId" = { manager = "provider/modelId", worker = "provider/modelId" }`. An absent table leaves activation to the provider and allowlist alone; a present table, even an empty one, narrows activation to the session models it lists (plus `[workerModel]` alias entries), and an entry's session model spawns the two roles on the entry's two models. The reserved key `default = { manager = "provider/modelId", worker = "provider/modelId" }` is the fallback pin for session models with no entry: it names at least one of the two roles, and its presence widens activation back to every allowlisted model; a named entry wins over it. A malformed table, entry, or default is reported and dropped (a malformed entry's session model stays inactive); it never makes the config inert. |
| `workerModel` | `{}` | Deprecated alias of `[roleModel]` that pins only the worker: `"provider/modelId" = "provider/modelId"`. An unmapped session model runs the worker on the `[roleModel] default` worker, or on the session model when the table sets no default; the alias takes both roles, so it also keeps the manager off the default. Warns at load; a `[roleModel]` entry for the same session model wins. A malformed table or entry is reported and dropped; it never makes the config inert. |
| `workerMaxTokens` | `{}` | Output-token cap for worker spawns only: `"provider/modelId" = <positive integer>`, e.g. `"local-router/qwen3.8-27b" = 65536`. The key is the worker's effective model (the `[roleModel]` or `[workerModel]` worker, else the session model); a worker whose model has no entry keeps the model's default cap, and the manager is never capped. A malformed table or entry (a key that is not `provider/modelId`, a value that is not a positive integer) is reported and dropped; it never makes the config inert. A model the pi registry does not know is reported at first use and the worker keeps its default cap. A cap at or above the model's context window warns but still applies. A capped worker is spawned on an explicit model, even when it runs on the session model, so pi-subagents' Model Scope applies to it as it does to a pinned model (the model must be in `enabledModels` when scope is on) and an agent-type `model:` frontmatter no longer picks its model. pi only; the Claude path ignores it. |
| `trigger` | `ask` | How the `input` hook starts the loop on an eligible coding prompt. `ask` shows a Run / Skip / Skip-for-session dialog (print mode, with no UI, passes through; an RPC client receives the dialog and must answer it); `auto` runs without asking; `manual` never runs from the hook and makes no classifier call -- only `/ledger` and `ledger_solve` start runs. |
| `classifier` | `true` | Whether to run the code-vs-chat classifier. False bypasses classification only: every eligible prompt is treated as code and goes on to `trigger` (asked under `ask`, run under `auto`, never under `manual`); it does not bypass the unconditional continuation-only and escape guards. |
| `autoTrigger` | `off` | Trigger mode for skill/slash sessions. `redirect` blocks the first inline edit in such a session and steers the model to `ledger_solve`; `off` leaves the tool as the only such path. |
| `redirectSkills` | `[]` | Slash-command names (no leading `/`; a `skill:` prefix is optional and ignored) the `redirect` mode arms for. Only consulted under `autoTrigger="redirect"`. Empty is fail-closed (arms nothing); `["*"]` arms every skill session. |
| `fanout` | `off` | Concurrent workers per round. `off` runs one worker per round and never asks the manager for a recommendation; `advise` asks the manager for a `### MODE` recommendation each round and records it, but still runs serially; `ask` runs the round as best-of-N only after you confirm it in a dialog (without one, as under `ledgerctl`, headless pi, or `ledger_solve` without a UI, it runs serially as `no-ui`); `on` runs the round as best-of-N without asking when the manager recommends it and the repo has a gate. A per-call `fanout` (`ledger_solve`, `ledgerctl solve --fanout`) can only lower this. An unrecognized value is ignored and the setting stays `off`. See [Fan-out](#fan-out). |
| `fanoutMax` | `2` | Workers a best-of-N round runs at once: an integer from 2 to 8. Out of range or not an integer warns and uses `2`. |
| `callTimeoutMs` | `300000` | Per manager/worker call timeout. A fan-out worker queued behind a full sub-agent concurrency limit counts its wait against this. |
| `gateTimeoutMs` | `180000` | Gate command timeout. |
| `notesMaxChars` / `planMaxChars` | `8000` / `4000` | Ledger file budgets. `planMaxChars` caps the manager's own plan; a plan supplied through `plan_file` is kept whole. |
| `auditLog` | `<stateDir>/runs.jsonl` | Durable audit log path (one JSON row per run and per classifier passthrough). Set an absolute path to relocate it. |

Activation is per model: the provider must be in `providers`, the model must be
permitted by that provider's `[allowlist]` entry, and, under a present
`[roleModel]` table, the session model must also be listed in that table, listed
in the deprecated `[workerModel]` alias, or covered by the table's reserved
`default` entry, which opts every allowlisted model back in. A provider with no
allowlist entry allows every model; a provider with an entry allows only the ids
listed, so `cerebras = ["gemma-4-31B"]` runs that model alone and `cerebras = []`
runs none. An absent `[roleModel]` table adds no further gate.

Config warnings (an unknown key, a malformed table, an inert config) and runtime
failures (a ledger or audit write, a classifier error) show up as pi notices in
the TUI and RPC modes, and on stderr in print mode. Config warnings are reported
once, at session start. The manager and worker sub-agents load their own copy of
ledgerpi in the same process, and while a UI session is live their copies never
write to its terminal.

`LEDGERPI=0` in the environment disables the extension for one process, which is
the A/B off switch. `LEDGERPI_DEBUG=1` logs each input decision to stderr
(which guard bailed, the classifier verdict), for diagnosing a silent
pass-through. `LEDGERPI_STATE_DIR=<dir>` overrides the state dir for one
process, so concurrent runs can isolate their ledgers. `LEDGERPI_AUDIT_LOG=<path>`
overrides the audit log path for one process (otherwise it tracks the state dir).
`LEDGERPI_AUDIT_SOURCE=<label>` overrides the provenance label stamped on every audit
row for one process -- a trimmed, non-empty value (for example `benchmark`) is written
as the row's `source`, and unset, blank, or whitespace-only falls back to `organic`.
ledgerpi only reads the stamp; a harness that launches runs must set it, and automatic
harness stamping is out of scope here. `LEDGERPI_CONFIG=<path>`
overrides the config file path for one process. `/ledgerpi` prints status:
whether the current model is in scope (or not on its provider's allowlist, or the
config is inert, or, under a present `[roleModel]` table, has no `[roleModel]`
entry, no `[roleModel] default`, or a dropped malformed one), the model's roles
(`roles: manager=..., worker=... (via [roleModel]|[roleModel] default|[workerModel]
(deprecated)|session)`), the `[roleModel]` table, `[workerModel]` alias, and
malformed keys together with the `default` entry's roles (or "(no table -- every
allowlisted model is in scope)" when the table is absent), the allowlist, the
detected gate, the `fanout` setting and its cap, and the last run's outcome. It also shows a session total (runs,
calls, tokens, including the classifier); that tally is separate from pi's own
session counter, which does not include the RPC-spawned agents.

## State

```
<stateDir>/<session-id>/<turn-id>/
  task.md         the request
  plan.md         the manager's plan
  notes.md        the curated running notes, rewritten each round
  tasks.json      the task list, for debugging
  transcript.jsonl  one row per model call (role, ok, tokens, durationMs, error), plus
                    a `brief` row per worker round (iter, taskSource, task, files,
                    accept, outOfScope, verify; taskSource is next, task-list,
                    manage-failed, or gate-override; plus mode, and advised, reason
                    and downgrade when `fanout` is not off), a `gate` row per gate
                    run, and a `fanout` row per best-of-N round
  candidates/     best-of-N worktrees; each is removed when its round ends
```

`stateDir` defaults to `<PI_CODING_AGENT_DIR or ~/.pi/agent>/ledgerpi`. State
lives outside any repository, so a checkout is never dirtied. Ledger and audit
files are used only as regular files: one that is a FIFO, directory, socket, or
device reads as empty and its write is logged and skipped, never blocking the turn.

The per-turn dirs above are scratch. The durable record is a single append-only
audit log at `auditLog` (default `<stateDir>/runs.jsonl`), one JSON row per run:

```
{ "t", "event": "run", "source", "entry": "input"|"tool"|"command", "harness": "pi"|"claude",
  "session", "provider", "model", "managerModel", "workerModel", "planSource", "classified",
  "converged", "stop", "stopDetail", "iters", "maxIters", "callTimeoutMs", "calls", "tokens",
  "managerTokens", "workerTokens", "gate": { "command", "ran", "passed" },
  "fanout": { "setting", "max", "rounds", "downgrades", "escapes", "asked", "advised" } | null,
  "cwd", "repoUrl", "branch", "headStart", "headEnd", "durationMs",
  "managerMs", "workerMs", "gateMs", "managerCalls", "workerCalls", "gateRuns", "task" }
```

`managerModel` and `workerModel` are the pinned models the manager and worker ran
on -- the `[roleModel]` entry's `manager` and `worker` for a session model with
an entry, else the `[roleModel] default` role for a session model neither table
names, else the session model. A deprecated `[workerModel]` alias entry outranks
the default for both roles, so an aliased row records the alias as its
`workerModel` and `null` as its `managerModel`, even when the default names a
manager. On a `claude` row they are the models that answered, or the configured id
for a role that never did; `model` is `null`, and `tokens`, `managerTokens`, and
`workerTokens` include cache reads and leave out steps that timed out or were
aborted. `managerTokens` and `workerTokens` are `null` on `pi` rows. Rows from
versions predating a field omit it.

`managerMs`, `workerMs`, and `gateMs` are summed, host-measured busy time per role:
every manager-type spawn (plan, manage, review), every worker-type spawn (ideate, work,
finalize, best-of-N candidates), and every gate run, with failed and timed-out spawns
included. `managerCalls`, `workerCalls`, and `gateRuns` count them. Concurrent best-of-N
candidates and an overlapping gate are summed, so the three times can add up to more
than `durationMs`. On a `pi` `input` run whose classifier ran (`classified` is not
`null`), `managerCalls + workerCalls` is `calls - 1`, because the classifier call is
not a loop spawn; on every other row it equals `calls`. Zero is a real value; a row from a
version predating these fields omits the keys, which means missing, not zero. They are
measured around each spawn by the host, so they can differ from the per-call
`durationMs` in `transcript.jsonl`, which is the duration the spawn itself reports
(and is optional).

`fanout` is `null` when the effective setting (the config lowered by any per-call
override) is `off`. Otherwise `setting` and `max` are that setting and `fanoutMax`,
`rounds` is the number of best-of-N rounds run, `downgrades` and `escapes` list the
distinct reasons rounds ran serially or fan-out latched off, `asked` counts the
fan-out questions put to the user under `ask` (a remembered answer is not asked
again, so it is not counted; `0` for other settings), and `advised` counts
the manager's per-round recommendations as `{ serial, "best-of-n", fleet, none }`.
Rows from versions predating the field omit it, and rows predating `ask` omit `asked`.

`planSource` is `"caller"` when the run was given a plan through `plan_file` /
`--plan-file` and `"manager"` when the loop planned itself.

`repoUrl` is the `origin` remote URL (userinfo stripped from an http(s) one; ssh,
scp-style, and local remotes verbatim), `branch` the
branch checked out when the loop started, and `headStart` / `headEnd` the commit HEAD
pointed at before and after the loop; each is `null` when git cannot say (no origin,
a detached HEAD, an unborn branch). The loop leaves its edits uncommitted, so
`headEnd` usually equals `headStart`: join a run to the PR it fed by `repoUrl` +
`branch`. Rows from versions predating the fields omit them.

`maxIters` and `callTimeoutMs` are the effective budget the loop ran under, so a review
can tell a stop pattern caused by a config change from one that was not. Rows from
versions predating the fields omit them and aggregate as `unknown`.

`source` is the provenance label resolved at write time: `organic` when
`LEDGERPI_AUDIT_SOURCE` was unset or blank, otherwise the caller-supplied label
(`LEDGERPI_AUDIT_SOURCE=<label>`, e.g. `benchmark`). It records where the run came
from so a review can separate real traffic from synthetic A/B activity.

`stop` is why the loop ended. On `stop: "spawn-failure"` rows, `stopDetail` names
the RPC failure branch: `aborted`, `timeout`, `refused`, `agent-error`, or `other`
(an unclassified failure). Every other stop writes `stopDetail: null`; rows from a
version predating the field omit the key and aggregate as `unknown` in the
review-ledgers breakdown.

A `spawn-failure` after the loop has started (the second consecutive worker failure)
re-runs the configured gate, so the row's `gate` is the fresh verdict on the tree as
it stands at the stop, not the verdict from an earlier round. A `spawn-failure` before
the first round (the plan call failing) records `gate: null`.

A prompt the classifier declines is recorded as an `event: "passthrough"` row
(source, entry, session, provider, model, `classified`, `reason`, calls, tokens,
cwd), carrying the same `source` stamp. A prompt you decline at the `trigger =
"ask"` dialog is recorded the same way with `reason: "declined"` (this prompt) or
`"declined-session"` (Skip for this session), or `"ask-error"` when the dialog
itself failed; its `classified` is `"code"`, or `null` with `calls: 0` when the
classifier is off. A decline at the skill-session redirect dialog is written the same
way with `entry: "redirect"`; no classifier runs there, so its `classified` is always
`null` with `calls: 0` and `tokens: 0`. Prompts after a session skip,
and prompts with no UI to ask, write nothing. Both are written only past
every activation guard, so an inert, out-of-scope, or non-git session logs
nothing.

Rows written before the `source` field existed omit the key (or carry a null, blank,
or non-string value). A review normalizes those to `source: "unknown"` -- never to
`organic` -- so legacy activity is never mistaken for real traffic.

`task` is stored as its first 200 chars only (a shorter prompt is kept
whole). This
is the input to a periodic review of the loop's convergence rate, token cost, and
per-model behavior -- the knobs it feeds back into are `providers`, `allowlist`,
`maxIters`, the thinking levels, and `classifier`.

In a container or sandbox the default state dir lives inside it and is ephemeral;
point `auditLog` at a host-mounted path to keep the log on the host across container
lifetimes.

## Reviewing the audit log

The `review-ledgers` skill (in `.claude/skills/`) reads the audit log and produces a
ranked report on the loop's convergence, token cost, stop-reason mix, gate outcomes,
and classifier passthrough mix, mapped back to the knobs. It ships in this repo so the
analysis lives with the extension that writes the log.

Discovery and invocation: Claude Code reads `.claude/skills/` directly and invokes the
skill by name; pi reads it through `.pi/settings.json` (which points `skills` at
`../.claude/skills`) and invokes it as `/skill:review-ledgers`. Either way the skill
takes an optional explicit `runs.jsonl` path or a scope filter (a provider, a model, a
`source` label such as `source benchmark`, or a time window). Its analytical views are
segmented by `source`, so organic use, benchmark activity, and any custom or unknown
labels are reported separately rather than pooled. With no argument it resolves the default path (`LEDGERPI_AUDIT_LOG`,
then the config `auditLog`, then `<stateDir>/runs.jsonl`) and analyzes the whole log.

The skill's aggregations are `jq` recipes, so a working `jq` (1.6+, for `|numbers`) is
required; the recipes are exercised by `test/review-ledgers.test.ts` in the gate. The
skill is read-only -- it edits nothing and writes nothing except an opt-in filing step
that, after explicit confirmation, delegates to the harness's report-task skill against
this repo. It never applies a provider, allowlist, `maxIters`, thinking-level, or
`classifier` change itself.

## Develop

`make check` is the gate: Biome (format, lint, import order) plus a tsc
typecheck plus the test suites, which drive the `input` handler against a stub RPC
bus and `ledgerctl` as the plugin's mod would. `make bootstrap` installs the dev tooling. The `bench/worker-thinking` test also needs `jq`, `procps` and `timeout` on the host.
`make build` compiles `ledgerctl`, and `make test-plugin` validates the plugin, runs its
mod tests, and typechecks the mod. That target needs the `claude` CLI, so CI does not run
it, and the typecheck needs the types a session writes when it first loads the plugin
(`claude --plugin-dir packages/claude`); without them the target says it skipped.

`packages/core` is harness-neutral and imports nothing from pi. `extensions/ledgerpi` is
the pi adapter and `packages/claude` is the Claude Code adapter; each supplies a `SpawnFn`.

## License

MIT.
