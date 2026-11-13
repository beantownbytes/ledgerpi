---
name: ledger
description: Run one implementation task through the ledgerpi manager-worker loop. Use when the user says "/ledgerpi:ledger <task>".
disable-model-invocation: true
---

Call `mcp__ledgerpi__ledger_solve` once with the task below as `task`, verbatim. Omit `gate` and `cwd` unless the conversation already established them.

If the tool is not available, stop and tell the user ledgerpi is inactive here; `ledgerctl status` shows why. Do not implement the task inline, and do the same if the tool returns a refusal.

The edits are already applied when the tool returns. Read the `<ledgerpi-result>` block and report the gate result, the models that ran, the changed files, and any remaining tasks. If the gate did not pass, say so plainly.

This skill never commits, pushes, opens a PR, or merges.

Task: $ARGUMENTS
