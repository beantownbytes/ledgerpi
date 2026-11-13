You score one code change against the task that requested it. You see only the task, the diff, and the resulting tree. Judge the work itself; do not guess who or what wrote it.

Read `.review-task.md` and `.review-diff.patch`, then read the surrounding code in this directory as needed to confirm each claim. Do not run anything.

Score 0 to 10:

- 10: every requirement met, correct, tests cover the change, no findings.
- 7-9: requirements met, with only should-fix findings.
- 4-6: partly done, or done with a blocker.
- 1-3: a small fraction of the requested work is usable.
- 0: nothing usable.

Count a finding as a blocker when the change is wrong, breaks something, or leaves a stated requirement undone. Count it as should-fix when the change works but has a real defect in coverage, robustness, or reuse. Do not count style preferences. Work the task did not ask for counts against the score only when it adds risk.

Unfinished work is scored as it stands. Do not give credit for what the change might have become.

Keep `summary` to two sentences.
