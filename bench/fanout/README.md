# Fan-out bench

Drives the real `/ledger` loop over a small fixed task set once per fan-out width and
compares the arms. It exists to give the `fanoutMax` default and cap a measured basis,
complementing the endpoint throughput sweep in `bench/concurrency/`. It is
standalone: nothing in the loop calls it, and it writes nothing inside the repo. Its labels
and recommendation are advisory and never applied to code.

It reads the metrics ledgerpi already writes to its audit log (the `event: "run"` row); it
adds no instrumentation.

## Run

```sh
# Calibration probe: every fixture, arm N=2, one rep (see Calibration probe).
node --experimental-strip-types bench/fanout/run.ts --arms 2 --reps 1 --out ~/.local/state/ledgerpi-bench/fanout/probe

# Default sweep: 8 tasks x arms 1,2,4 x 3 reps = 72 serial runs.
node --experimental-strip-types bench/fanout/run.ts
```

Needs `pi` on `PATH`, `git`, `node`, and a working live ledgerpi config (it is the template
for every run). Each run is a real `pi -p`, so `@tintinweb/pi-subagents` must be installed in
pi and the `ledger-manager` / `ledger-worker` agent types must resolve (see
[Requirements](../../README.md#requirements)). The output directory is printed on stdout; per-run progress goes to stderr.

Run it only when the endpoint is idle. The runs are serial and the full sweep takes hours.
An arm needs at least 20 valid runs to be labeled, and the default sweep has 24 cells per
arm, so more than 4 timeouts or missing rows in one arm leave it `insufficient`.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--arms` | `1,2,4` | Fan-out widths to run, from `1, 2, 4, 8`. Sorted and de-duplicated. |
| `--reps` | `3` | Repetitions of each (task, arm) cell. Positive integer. |
| `--tasks` | every fixture | Fixture directory names under `bench/fanout/tasks/`. |
| `--timeout-s` | `1800` | Wall-clock limit for one `pi` run, in seconds. Positive, at most two decimals. |
| `--out` | see Output | Output directory. Must not exist. |

Lists are comma-separated. Unknown flags and positional arguments are rejected.

### Test seams

| Variable | Meaning |
| --- | --- |
| `LEDGERPI_BENCH_PI` | `pi` executable to spawn instead of `pi` on `PATH`. |
| `LEDGERPI_BENCH_TASKS` | Fixture directory to use instead of `bench/fanout/tasks`. |

The live config is found the usual way (`LEDGERPI_CONFIG`, else the default path).

### Exit codes

- `2`: usage or config error (unknown flag, malformed value, unknown arm, unknown fixture,
  unreadable, disabled or provider-less live config, `--out` already exists). Reported before
  the output directory is created and before any `pi` run.
- `1`: any other failure.
- `0`: the sweep finished, even if some runs failed. Failures are data.
- `130` / `143`: interrupted by SIGINT / SIGTERM. The running `pi` process group is killed and
  its scratch directory removed; the `runs.jsonl` written so far is kept and no summary is
  written.

## Arms

| Arm | Setting | Workers |
| --- | --- | --- |
| N=1 | `fanout = "advise"` | 1; same manage prompt as the `on` arms |
| N=2 | `fanout = "on"`, `fanoutMax = 2` | up to 2 |
| N=4 | `fanout = "on"`, `fanoutMax = 4` | up to 4 |
| N=8 | `fanout = "on"`, `fanoutMax = 8` | accepted by `--arms`, not in the default sweep; run it only if N=4 beats N=2 |

N=1 is the baseline every other arm is labeled against.

## What a run does

Cells run serially, task by task and rep by rep with the arms adjacent. For each (task,
arm, rep):

1. Copy the fixture to a temp dir, then `git init` and commit it so `.ledgerpi-gate` is
   carried into candidate worktrees.
2. Write a private config: the live config with `fanout`, `fanoutMax` (not for N=1) and
   `classifier = false` overridden, so `/ledger` always enters the loop, and any explicit
   `gate` dropped so each fixture's `.ledgerpi-gate` is the verifier.
3. Set `LEDGERPI_CONFIG`, `LEDGERPI_STATE_DIR`, a per-run `LEDGERPI_AUDIT_LOG` and
   `LEDGERPI_AUDIT_SOURCE=benchmark`, so nothing touches the live state or audit log.
4. Spawn `pi -p "/ledger <task.md>"` in the copy as its own process group. A single
   wall-clock timer (`--timeout-s`) kills the group, as `runGate` does.
5. Read the run rows from the per-run audit file. Before the temp dir is removed, compare
   `.ledgerpi-gate` and every top-level `test*.mjs` with the fixture originals, which the
   driver snapshots before spawning `pi`; any of those files that was changed or deleted,
   or a `.ledgerpi-gate` the worker created, is recorded in `tamperedFiles`. Append one
   record to `runs.jsonl` and
   remove the temp dir. There are no retries; a rerun writes a new output directory.

### Fixtures

`bench/fanout/tasks/<name>/` holds `task.md`, a one-line `.ledgerpi-gate` (`node test.mjs`),
a stub module and `test.mjs` (about 20-40 `check` cases, each with several `node:assert`
calls). `task.md` states the behavior
and its edge cases, never the approach, and never mentions fan-out. Fixtures need only node,
no install, because candidate worktrees lack ignored files. Each fails its gate unmodified.

The eight fixtures are single-module, spec-heavy tasks:

- `semver-range`: `satisfies` for `^`, `~`, comparators, `||` and prerelease rules.
- `expr-eval`: arithmetic evaluator with precedence, right-associative `**`, unary minus,
  parentheses and error positions.
- `csv-parse`: RFC 4180 parsing with quotes, escaped quotes, embedded newlines, CRLF, a
  trailing newline and a custom delimiter.
- `interval-ops`: merge, insert and subtract over intervals with open and closed endpoints.
- `glob-match`: `*`, `**`, `?`, `[a-z]`, `{a,b}` and escaping.
- `lru-ttl`: LRU cache with TTL, injectable clock, size cap, touching versus peeking and an
  eviction callback.
- `text-wrap`: wrapping by width with hard-breaking of long words, paragraphs, indentation
  and tabs.
- `cron-next`: next fire time of a 5-field cron expression in UTC (lists, ranges, steps,
  names, the day-of-month/day-of-week OR rule).

`bench/fanout/solutions/<name>/` holds a reference module with the same file name as the
fixture module. It lives outside `tasks/` so the driver never copies it into a run.
`test/fanout-bench.test.ts` overlays it on a scratch copy of the fixture and asserts the
gate passes, so every fixture is known to be solvable.

### Why the corpus is spec-heavy

The first corpus was eight trivial fixtures. Live, the manager advised `serial` in 9 of 9
runs (a smoke run of `slugify` at N=1 and N=2 plus a probe at N=2 on the other seven
fixtures), there were
0 best-of-n rounds, and every run passed in 1 iteration. Evidence:
the `smoke` and `probe` run directories under `~/.local/state/ledgerpi-bench/fanout/`.

The manage prompt picks best-of-n for a self-contained task with an uncertain approach or a
retry after a failed gate. The trivial tasks had one obvious approach and passed first time,
so neither held. The current corpus aims to make a first-attempt gate failure likely, which
produces the retry round. No `task.md` hints at fan-out, since a hint would measure the hint.

## Calibration probe

Before the sweep, run every fixture once at N=2 (`--arms 2 --reps 1`). Let `v` be the valid
runs, `e` the valid runs with `fanout.rounds > 0`, and `p` the valid runs with
`gate.passed` and an empty `tamperedFiles`. First match wins:

1. `too-few-valid`: `v < 6`.
2. `no-engagement`: `v >= 6` and `e < 3`.
3. `too-hard`: `v >= 6`, `e >= 3` and `p < 0.5 * v`.
4. `ready`: `v >= 6`, `e >= 3` and `p >= 0.5 * v`.

A `ready` first probe skips tuning. Otherwise tune: adjust only the fixtures that caused the
state (harden ones that did not engage, soften ones no run solved, or fix a driver defect),
keep the reference-solution test green, then probe once more. At most
2 probes: a second probe that is not `ready` stops the run with the evidence.

Budget gate: the projected sweep time is 72 x (mean N=2 probe `durationMs`) x 1.1. Run the
sweep only if it is at most 10 hours; otherwise stop and report the projection. Reps cannot
drop below 3, because each arm needs at least 20 valid runs.

### Probe result with the current corpus

Probe 1 (a run directory under `~/.local/state/ledgerpi-bench/fanout/`, manager
`remote/qwen3.8-flash-next`, worker `local-router/qwen3.8-27b`): `v = 7`, `e = 0`, `p = 7`,
state `no-engagement`. One run (`glob-match`) hit the 1800 s timeout and left no row. Five of
the seven valid runs failed the gate once and retried, and the manager still advised `serial`
in all 12 advice calls. The mean N=2 duration was 752 s, which projects a 72-run sweep to
at least 16.5 hours (the timed-out run is not in the mean), over the budget gate. No sweep
was run, and no constants were chosen.

The tune-and-reprobe step was deliberately not run: the retries already met the manage
prompt's own best-of-n trigger without changing the advice, harder fixtures would only
lengthen the projection, and the budget gate independently stops the sweep at this projection,
so both paths end in a report-only stop.

In these 12 advice calls the manager did not choose best-of-n even on a retry after a failed
gate, so the `fanoutMax` default has no measured effect for it; whether another manager
(`managerModel`) or corpus would engage is untested. Measuring N when best-of-n does engage
needs its own probe first.

Because `fanout.rounds` was 0 in every run, no worker ever entered a candidate worktree, so
whether workers can edit there without a prompt (main `README.md`, fan-out section) is still
unverified.

## Output

The default `--out` is `~/.local/state/ledgerpi-bench/fanout/<UTC ts>/`. An existing
directory is refused with exit 2. Results never go into the repo.

- `runs.jsonl`: one record per cell: `task`, `arm`, `rep`, `outcome`, `run` (the audit
  row when `outcome` is `valid`, else null), and `tamperedFiles` (the sorted names of
  protected files whose final content differs from the original; `[]` means intact). It is
  recorded for every outcome but only affects valid runs.
- `summary.json`: the arguments, per-arm summaries, labels and recommendation.
- `summary.md`: the same as tables, plus the caveats.

### Per-run outcome

Evaluated in order; the first match wins. Only `valid` runs enter rates and medians; the
others are counted per arm.

1. `timeout`: the driver killed the process at the limit.
2. `no-row`: no run row (spawn failure, pass-through, crash).
3. `multi-row`: more than one run row.
4. `valid`: exactly one run row.

A valid run where fan-out never engaged or latched off stays valid and is counted in the
engagement stats.

### Per-arm summary

Over valid runs: median `durationMs`, gate pass rate, converged rate (reported
separately), median `iters`, `tokens`, `gateMs` and `gateRuns`, and gate share of
wall-clock (total `gateMs` over total `durationMs`). The gate pass rate counts valid runs
with `gate.passed` and no tampered files; the advisory labels and the recommendation read
this intact-only rate. `tampered` counts valid runs with any protected file changed,
whatever the gate said (the Tampered column in `summary.md`). The converged rate is the
loop's own verdict, not adjusted for tampering. Engagement is the runs with
`fanout.rounds > 0`, the latched runs, and the `advised`, `downgrades` and `escapes`
totals. `errored` counts valid runs that stopped on `spawn-failure` or `aborted`.

### Advisory labels

Each arm N > 1 is labeled against N=1 over the same tasks and reps. First match wins:

1. `insufficient`: either arm has fewer than 20 valid runs, fan-out engaged in under 30% of
   the arm's valid runs, more than half of them latched, or a pass rate is undefined (this
   includes a sweep without N=1).
2. `harmful`: pass rate more than 5 points below N=1, or median wall-clock above 1.5x.
3. `helping`: pass rate at least 5 points above N=1, or within 5 points with median
   wall-clock at most 0.9x.
4. `neutral`: everything else.

The recommendation line gives a `fanoutMax` cap and default. The cap is the largest labeled
arm that is `neutral` or `helping`, else 2. The default is the `helping` arm with the best
pass rate (ties to the smaller N), else 2. The cap is never above the largest measured N, so it is at most 4 unless N=8
was run.

## Caveats

- Medians are nearest-rank p50 (the shared `percentile` from `bench/concurrency/bench.ts`),
  not the mean of the two middle values for an even count.
- The 5-point margins are near noise: at about 24 runs per arm one run moves a pass rate by
  about 4 points. Treat labels as a prompt for judgement, not a verdict.
- `latched` is inferred from `escapes` and `downgrades` (`latched` or `setup-failed`); the
  audit row has no latched field.
- `errored` runs are a subset of `valid` ones, not a separate outcome.
- Other live config keys are kept. An explicit live `gate` is dropped, so each fixture's
  `.ledgerpi-gate` is the verifier.
- Killing `pi` on a timeout or an interrupt does not reach a gate process it started (the
  loop spawns gates in their own process group), so check for stray `node test.mjs`
  processes after a timeout.
- The tamper check compares `.ledgerpi-gate` and top-level `test*.mjs` files only. A new
  extra test file (for example a new `test-extra.mjs`) is not flagged, and subdirectories
  are not snapshotted.
- Runtime subversion of the harness (for example overriding `process.exit` in the source
  module so the gate exits 0) leaves the protected files intact and is not detected.
- One model (local `qwen3.8-27b` via the router) and eight spec-heavy single-module tasks.
  Cloud and Claude Code workers are not measured, and N=8 is not in the default sweep.
