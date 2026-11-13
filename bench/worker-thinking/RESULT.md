# worker-thinking A/B result

Stage 2 on `local-router/qwen3.8-27b`, `thinking=high`, 6 tasks x 2 reps per arm (12 runs each), `AB_CONCURRENCY=8`, seed 26. Baseline `b-high-32k` (`maxTokens` 32768) against challenger `b-high-65k` (`maxTokens` 65536). Every run was scored blind with `score.sh` using `claude-opus-5-5` (blind by convention only, see the caveats).

## Recommendation

**Adopt `b-high-65k`: raise the qwen3.8-27b worker output cap from 32768 to 65536.** `analyze.ts` returns `state: adopt, arm: b-high-65k`. The challenger had a lower limit rate, at least as many green runs, and a mean score within 0.5 of the baseline (it was higher). 65536 is the tested challenger, not a measured optimum: the largest message at 65k was 34129 tokens and no intermediate cap was run on `local-router` (`c-high-41k` exists only as an unscored stage 1 arm on cerebras). The margin is small and the caveats below (timeout change and selective rerun, mixed install and task-repo revisions, load-dependent durations) are not quantified, so treat this as directional evidence for the follow-up config item, not a settled effect size.

Reproduce:

```bash
node --experimental-strip-types bench/worker-thinking/analyze.ts summarize \
  ~/.local/state/ledgerpi-ab/stage2-router b-high-32k b-high-65k
```

## Numbers

| | b-high-32k | b-high-65k |
|---|---|---|
| runs / classified / scored | 12 / 12 / 12 | 12 / 12 / 12 |
| converged-green | 8 | 10 |
| limit-failed | 2 | 0 |
| other-failed | 2 | 2 |
| output-limit events | 3 | 0 |
| worker calls | 76 | 68 |
| limit rate (events / worker calls) | 0.039 | 0 |
| mean blind score | 6.46 | 6.83 |
| tokens | 12,389,589 | 14,462,619 |
| summed `durationMs` | 48,906,265 | 49,848,496 |

Failures:

- `incident-4`, both reps, at 32k: `limit-failed`, stop `spawn-failure` (the last failed worker call hit the output limit). The same task converged green at 65k in both reps.
- `incident-3`, both reps, both arms: `other-failed`, stop `budget`. This task fails with the same class and stop in both arms, so it does not separate them on outcome (its summed score is 1.0 lower at 65k, within the noise of a failed run). Its stored `task.md` points at a plan file under `/tmp/pisession.*` that no longer exists.

Largest single assistant message `usage.output` in the arm's pi sessions: 32768 (the cap; 4 messages at the cap) at 32k, and 34129 at 65k (1 message at or above 32768). So at 65k a call in the arm's sessions produced more than the old cap allowed, and nothing came near 65536. These figures read every session under the arm's agent dir, so they include sessions of attempts whose `result.json` was discarded (see below) and so are not a per-run count; the 34129 message belongs to the kept, `converged-green` run `b-high-65k__incident-4__r2`.

The 2 extra green runs are both `incident-4`. Of the +4.5 difference in summed blind scores (82.0 against 77.5), +3.0 comes from `incident-1` (14.0 against 11.0), where both arms were green in both reps, so most of the mean-score margin is not explained by the output cap; the other tasks differ by +1.0 (`incident-4`), +1.0 (`control-1`), +0.5 (`incident-2`), 0 (`control-2`) and -1.0 (`incident-3`).

The 65k arm spent about 17% more tokens for 2 more green runs. Wall time is comparable but load-dependent (see below).

## Caveats and disclosures

- **Small sample.** 12 runs per arm, 2 limit-failed runs and 3 limit events in the baseline. The signal is directional; the baseline did hit limit events, so `analyze.ts` did not fall back to `inconclusive`.
- **Call timeout changed mid-experiment.** The first launch ran with `callTimeoutMs` 900000. The failed worker calls of 11 of its first 19 finished runs were all the bare error `timeout`, so those `other-failed` runs were measuring wall clock under 8-wide pool load rather than the output cap. Those 11 runs were deleted and rerun with `callTimeoutMs` 1800000, which is the value now in `arms.json`. Their classes, per-call counts and audit rows were not kept: the `result.json` files and audit rows were deleted. Their pi sessions remain under the arm's agent dir (which is why the largest-message figures above include them) and still show which arm each belonged to, but the split was not tallied. The other 8 of the 19 were kept, including the one baseline output-limit failure that survived at 900000 ms (`incident-4` r1 in `b-high-32k`, "run hit the output token limit before producing any text"), which is direct evidence that the baseline's `limit-failed` class is a cap effect and not a timeout artifact. What the result roots do show: the 8 runs kept at 900000 ms are 5 in `b-high-32k` (4 `converged-green`, 1 `limit-failed`: `incident-4` r1) and 3 in `b-high-65k` (all `converged-green`); the other 16 ran at 1800000 ms, 7 in `b-high-32k` and 9 in `b-high-65k`. Rerunning only the timeout failures gives those runs a second draw at a looser timeout and the kept successes none, which can favor whichever arm had more reruns, and the arms are close (2 green runs apart on 12). No kept run is classified on a timeout, but 3 of the 8 kept 900000 ms runs recorded a worker-call `timeout` as their last failure and then recovered and converged green (`b-high-32k__control-2__r2`, `b-high-32k__incident-2__r1`, `b-high-65k__control-1__r1`), so the old deadline also shaped the kept data, in both arms; and a rerun's outcome can depend on the timeout.
- **Install revision changed.** The experiment was frozen on pi install `9409dd8`. `pi update` moved the live install to `eb85620` before the final launch. That commit adds only `bench/concurrency/*`, `test/concurrency-bench.test.ts` and one- or two-line edits to `Makefile`, `README.md` and `tsconfig.json`; `git diff --stat 9409dd8 eb85620 -- extensions packages package.json` is empty and the `qwen3.8-27b` model entry hash is unchanged (`d2c6ccbf...1109184`). The 8 runs kept before the change ran on `9409dd8` and the other 16 on `eb85620`. `order.log` has one header per launch (`2026-11-09T21:52:35Z` and `2026-11-10T00:30:58Z` on `9409dd8`, `2026-11-11T11:47:19Z` on `eb85620`).
- **Host reboot.** The second launch was killed by a host reboot; interrupted runs kept no `result.json` and were rerun by resuming with the same `AB_ROOT`.
- **Task-repo HEAD moved** from `1ffe398` (at the original freeze) to `ad20cf4` (at the final launch), through intermediate revisions whose launch boundaries were not recorded. The original freeze therefore did not hold for the repo that holds the live agent files: the plan made fingerprint movement a stop-and-report condition, but the move happened between launches, outside any watcher, and its cause was not recorded. The resume re-froze on `ad20cf4`, with a watcher on the install revision, the model entry and that repo's HEAD for the final 16 runs, and `order.log` shows no stop. This is not harmless by construction: the arms' agent dirs symlink `AGENTS.md`, `agents`, `extensions`, `prompts`, `skills`, `subagents.json` and `pi-permissions.jsonc` from the live `~/.pi/agent`, which points into that checkout, so a move changes the instructions and skills a run saw. `git diff --stat 1ffe398 ad20cf4` over its agent-config directory is not empty: it touches the agent instructions, agent definitions and skill docs (review, panel and other skill docs). The `qwen3.8-27b` model entry (`models.json`) is unchanged, and the changed files are skill and agent docs for other workflows rather than the ledger worker's task, but the effect on worker behavior was not measured. The 8 kept runs ran on the older files and the 16 final runs on the newer ones, unevenly across arms (5 and 3 kept, 7 and 9 final), so this is an unquantified confound alongside the call-timeout and retry caveats above. The effect size inherits this uncertainty, so the clean validation is a serial rerun on a single frozen tree, not treating 65536 as settled.
- **`durationMs` and per-role timing depend on load.** With up to eight runs in flight, the arms shared a pool with each other and with other users, so durations are not comparable to a serial run. Tokens and limit events are not affected. Scores can still shift indirectly, because a worker call that times out under load fails a run (see the call-timeout caveat above).
- **Invalid earlier data.** `stage2/` under `~/.local/state/ledgerpi-ab/` (7 runs on a since-retired provider: 6 ended `other-failed` on HTTP 401 `invalid token` and 1 aborted without a result) is invalid and kept only as evidence. `worker-thinking/` holds stage 1 on cerebras, which cannot produce a recommendation.
- **Blind scoring is by convention.** The scorer sees a copy of the final tree and the diff without arm names, but it runs with file-read tools and no path jail. The 24 recorded scores were produced with the copy staged under the result root, where the arm name is readable in `result.json` paths; `score.sh` as landed stages the copy in a fresh temp directory outside the result root instead, which narrows but does not remove the exposure. No recorded score's text names an arm or an output cap (checked with a search over the values in `scores.json`). The 24 raw review outputs from that scoring pass are still under `blind/` in the result root; the landed `score.sh` keeps no copy of its own, so under it only the recorded `summary` survives in `scores.json`.
- **The `workerThinking` dimension was not measured.** Stage 1 on cerebras was never completed or scored (`worker-thinking/` has 9 run directories and no `scores.json`) and `b-medium-32k` was not run in stage 2, so this result covers only the output cap at `thinking=high`.
- **Harness edited after the run.** After all 24 scores were recorded, review rounds changed `score.sh` (among other fail-closed checks on `result.json`, `scores.json`, the attempt number and the attempt directory; skip runs classed `harness-failed`, `aborted` or `unverified`; fail on a review without a structured score, where it used to record a null score; stage the blind copy in a temp directory outside the result root; treat a recorded entry that is not an object with a numeric `score` as unscored) and `analyze.ts` (ignore non-numeric scores; fail on a missing `runs/` directory), with matching tests in `test/bench-worker-thinking.test.ts`, and extended the bench `README.md`. All 24 recorded scores are numeric, so none of this affects them: `score.sh --dry-run` on the result root lists no pending run, and re-running `summarize` gives the same recommendation and numbers.
- **Manager fixed** at `ollama-cloud/deepseek-v4.1-flash:cloud` for all arms.
