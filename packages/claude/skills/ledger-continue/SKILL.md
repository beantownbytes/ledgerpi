---
name: ledger-continue
description: Hand the remaining implementation work of the current session to the ledgerpi manager-worker loop through ledger_solve, on the models the [claude] config section names, then verify the result and resume the workflow that was running. Use when the user says "/ledgerpi:ledger-continue", "continue in the ledger loop", or "hand this to the ledger manager/worker". Optional arguments are extra notes for the task.
disable-model-invocation: true
---

Move the rest of this session's implementation into the ledgerpi loop instead of editing inline. The loop plans with a `ledger-manager`, implements each task with a fresh `ledger-worker`, and gates on the repo's tests. The models come from the `[claude]` section of `~/.config/ledgerpi/config.toml`, not from this skill.

Arguments, if any, are extra notes from the user. Fold them into the task in step 4.

## 1. Preflight

Check that the `mcp__ledgerpi__ledger_solve` tool is available in this session. If it is not,
stop and tell the user ledgerpi is inactive here. `ledgerctl status` shows why: the config has
no `[claude]` section, it says `enabled = false`, or `LEDGERPI=0` is set. Do not fall back to
editing inline; the user invoked this skill to get the loop.

## 2. Pick the target checkout

Use the checkout where the in-flight change lives. For a `/review-task` or other skill that
carved a worktree, that is the worktree path named earlier in the conversation, not the
session cwd. With no worktree, use the session cwd. Confirm it is a git work tree:

```bash
git -C <dir> rev-parse --show-toplevel
```

Use the printed top-level path as `cwd` below.

## 3. Read the current state

```bash
git -C <dir> status --short
git -C <dir> diff HEAD
```

Read the diff and any untracked files `status` lists, and check them against the
approved plan step by step. A file being modified does not make its step done: sort
each step into done, partly done (say what is still missing), or not started. Keep
the existing edits; the loop builds on the working tree as it stands.

## 4. Write the task

Write one self-contained task description. A fresh worker sees only this text and the repo,
so never write "continue" or refer to "the plan above". Include:

- the work item id (if any) and the goal in one or two sentences;
- the approved plan's remaining steps, in order, with the files each one touches,
  including what is still missing from each partly done step (from step 3);
- what is already done, so it is not redone;
- constraints: the repo's conventions that the plan or the user named, files out of scope,
  and that the loop must not commit, push, or open a PR;
- acceptance criteria: the tests to add or make pass, and the behavior to verify.

Append the user's notes, if any.

## 5. Choose the gate

Pass `gate` only when the conversation already established the repo's gate command (for
example `make check` read from the Makefile). Otherwise omit it so ledgerpi detects one.

## 6. Run the loop

Call `mcp__ledgerpi__ledger_solve` once with `{ task, cwd, gate, plan_file }` (omit `gate`
per step 5). Pass `plan_file`, the plan's absolute path, only when the approved plan exists
as a file on disk; the loop then skips its own planning and ideation and builds its task
list from that plan. While it runs, the status line shows the round and the manager and
worker run as sub-agents.

If the result is a plain-text refusal (ledgerpi disabled, not a git repo, a loop already
running in this repository, an unreadable or empty plan file), stop and report it to the
user. Do not implement inline unless the user then says to.

## 7. Verify and resume

The edits are already applied when the tool returns. Do not redo them.

1. Read the `<ledgerpi-result>` block: the gate result, the worker model, the changed
   files, and the remaining tasks. Tell the user which worker model ran.
2. Repeat the step 3 inspection (`git -C <dir> status --short`, `git -C <dir> diff HEAD`,
   and every untracked file `status` lists, since new files are not in the diff) and
   check the result against the task.
3. If the gate did not run or did not pass, run the gate yourself and report the output.
4. If the loop stopped without converging, call the tool once more with exactly the
   remaining tasks and notes it listed, written as a new self-contained task, and the same
   `plan_file` when the first call had one. After that, finish inline only what is still
   left, and say so.
5. Return to the workflow that was running (for `/review-task`, its review and landing
   steps) and follow that workflow's own approval gates.

This skill never commits, pushes, opens a PR, or merges.
