# worker-thinking A/B

Measures how `workerThinking` and the model output cap change output-limit failures and work quality for `qwen3.8-27b`. The result and recommendation are in [RESULT.md](RESULT.md).

Stage 1 screens arms on `cerebras/qwen-3.8-27b`. Stage 2 confirms on `local-router/qwen3.8-27b`, and only stage 2 can produce a recommendation: serving and sampling differ between the two, so a cerebras limit rate is not a `local-router` number. `local-router` stands for whichever provider id in your pi `models.json` serves the same model; edit the `worker` values in `arms.json` to match.

## Files

| File | Purpose |
|---|---|
| `arms.json` | Arms, the fixed manager model, and timeouts. |
| `tasks.json` | Replayed tasks: repo, base commit, stored `task.md` location, gates. |
| `run.sh` | Runs the arms in a shuffled order, serially or up to `AB_CONCURRENCY` at once. Resumable. |
| `finalize.ts` | Independent final gate, diff, and classification for one attempt. |
| `analyze.ts` | Classification, stage screen, and recommendation. `summarize` prints them. |
| `score.sh`, `rubric.md`, `score.schema.json` | Blind review of every diff. |

## Requirements

`pi` with the live agent dir and the `@tintinweb/pi-subagents` extension (every manager and worker call goes through its RPC), plus the `ledger-manager` and `ledger-worker` agent types, copied into the live agent dir (`$AB_LIVE_AGENT_DIR/agents`, default `~/.pi/agent/agents`) as described in [Requirements](../../README.md#requirements). `arms.json` must set `manager` to `provider/modelId`, and every arm's provider and model must exist in the live agent dir's `models.json`. `arms.json` and `tasks.json` are neutral examples: replace the provider ids, task ids, repos, base commits, and gates with your own, keep local clones under `~/code` (`AB_CODE_DIR`), and point `ledgerDir` at stored ledger dirs that hold each task's `task.md`, so a rerun works only on a machine that holds those ledgers. `AB_INSTALL_DIR` names the ledgerpi checkout whose HEAD `order.log` records (default: this repo). `AB_EXTRA_AGENT_ENTRIES` is a space-separated list of extra entries of the live agent dir to link into each run's agent dir, for provider setups that keep config outside the standard files. It refuses `models.json`, `settings.json`, `sessions` and any path (`run.sh` writes those itself) with exit 2. `run.sh` also refuses to start without `jq`, `git`, `node`, `shuf`, `timeout`, `ps` and `pgrep` (procps), the task gates need whatever tools your own gates invoke, and `score.sh` needs `claude`.

## Run

```bash
bench/worker-thinking/run.sh --preflight
CEREBRAS_API_KEY=... bench/worker-thinking/run.sh --stage 1
bench/worker-thinking/score.sh
node --experimental-strip-types bench/worker-thinking/analyze.ts summarize \
  ~/.local/state/ledgerpi-ab/worker-thinking c-high-32k c-medium-32k c-high-41k

AB_ROOT=~/.local/state/ledgerpi-ab/stage2-router bench/worker-thinking/run.sh --stage 2 --arms b-high-32k,b-high-65k
AB_ROOT=~/.local/state/ledgerpi-ab/stage2-router AB_CONCURRENCY=8 AB_RUN_TIMEOUT=12h bench/worker-thinking/run.sh --stage 2 --arms b-high-32k,b-high-65k
AB_ROOT=~/.local/state/ledgerpi-ab/stage2-router bench/worker-thinking/score.sh
node --experimental-strip-types bench/worker-thinking/analyze.ts summarize \
  ~/.local/state/ledgerpi-ab/stage2-router b-high-32k b-high-65k
```

`run.sh` skips any run with a `result.json`, so rerunning the same command resumes a killed job. Three runs in a row ending `harness-failed` stop the job with exit 4 and keep no `result.json`, so an outage does not burn the queue and a rerun resumes them.

`AB_CONCURRENCY` is the number of runs in flight at once. The default 1 is serial. Above 1, `run.sh` builds every selected arm's agent dir first, then dispatches up to N runs at once; it refuses N above 1 with exit 2 when any `c-*` arm is selected. The harness-failed streak counts in completion order. After it trips, no new run starts, runs already in flight finish, late `harness-failed` ones are dropped like the streak (no `result.json`) and late valid ones are kept, then the job exits 4. INT or TERM stops every in-flight run and its `pi` process group, writes no `result.json` for the interrupted runs, and exits 130 or 143. A `finalize` or final gate already running is not stopped, so a rerun exits 5 while any process still references a queued run's directory; wait for it to end (a gate is bounded by `gateTimeoutMs`) and rerun. Rerunning the same command with the same `AB_ROOT` resumes the job, and N may change between runs. `order.log` records `concurrency=N` in each header.

Runs sharing a pool slow each other down, so `durationMs` and per-role timing depend on the concurrency and the pool's load. Tokens and limit events do not. Scores can still shift indirectly, because a worker call that times out under load fails a run (see the call-timeout caveat in `RESULT.md`). Before each cerebras run it stops with exit 3 once billed cerebras tokens across all attempts, failed ones and cached input included, reach `AB_CEREBRAS_TOKEN_LIMIT` (default 23M, about $25). Ledger transcripts and audit rows leave out cached input, so never estimate spend from them; stage 1 averaged about $8 per attempt.

`AB_RUN_TIMEOUT` (default 4h) kills a whole run, while `callTimeoutMs` in `arms.json` bounds each manager or worker call and a run makes the plan, ideation and first manage calls, then up to `maxIters` (8) rounds of a worker call and a manage call, then a final worker call (`2 x maxIters + 4` = 20 calls), and runs the gate after each worker call (up to `maxIters + 2` = 10). A run killed at `AB_RUN_TIMEOUT` is finalized from whatever it left behind and, with no audit row, is `harness-failed` (see Run classes). The worst case `(2 x maxIters + 4) x callTimeoutMs + (maxIters + 2) x gateTimeoutMs` is about 11.3 h at the shipped values and exceeds the default; raise `AB_RUN_TIMEOUT` if calls keep timing out. The longest stage 2 run took about 2.4 h with `callTimeoutMs` 1800000 under the default; the 8-wide stage 2 command above sets 12h so the worst case fits.

Results go to `AB_ROOT` (default `~/.local/state/ledgerpi-ab/worker-thinking`, the stage 1 root), never the repo. Give stage 2 its own `AB_ROOT` so its runs stay out of the stage 1 root.

## Isolation

Each attempt gets a `git clone --shared` with pushes disabled, its own config, ledger state dir, and audit log, and rows stamped `source=benchmark-thinking-<arm>`. Live config and organic stats are untouched: arms run from a throwaway agent dir under `AB_ROOT/agents` that links the live one, with the arm's `maxTokens` in a generated `models.json`, and leaves out telemetry files.

## Run classes

The first match wins.

| Class | Predicate | Counted |
|---|---|---|
| `harness-failed` | No audit row, a setup or finalize failure, or `stop=spawn-failure` with a provider failure as the last failed call (rate limit, 5xx, connection error, or auth error: 401/403, invalid token or key, unauthorized) | No, after one rerun |
| `aborted` | `stop=aborted` | No, after one rerun |
| `limit-failed` | Not converged, last failed worker call hit the output limit | Failure |
| `other-failed` | Not converged, any other cause | Failure |
| `unverified` | Converged, final gate could not run | No, after one gate rerun |
| `converged-red` | Converged, final gate failed | Failure |
| `converged-green` | Converged, final gate passed | Success |

Output-limit events that the loop recovers from count per worker call, not as a class. A worker that dies on a provider error records no error text in the transcript, so `finalize.ts` takes it from the session that closed at that moment. A server's `request_queue_timeout` is not a provider failure here: it counts against the arm, because a larger output cap holds a larger reservation.

`recommend` is inconclusive unless every classified run has a blind score, so run `score.sh` to completion before reading a recommendation. A run with an empty diff is recorded with score 0 and is not reviewed; that 0 counts in the arm's mean like any other score. Runs classed `harness-failed`, `aborted` or `unverified` are skipped, since `analyze.ts` excludes them. `score.sh` stops the whole pass on the first review without a structured score or a damaged result root and names the run; it stages each blind copy in a temporary directory outside the result root and removes it on exit.
