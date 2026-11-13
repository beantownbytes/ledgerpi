---
name: review-ledgers
description: Read ledgerpi's durable audit log (runs.jsonl) and produce a ranked report on how the manager-worker loop is performing -- convergence rate, stop-reason mix, rounds and token cost per run, per-provider/per-model behavior, gate pass/fail, and classifier passthrough mix -- mapped back to ledgerpi's tunable knobs. Read-only; filing improvements is an explicit opt-in. Use when the user says "review the ledgers", "how is the ledger loop doing", or "analyze ledgerpi runs".
---

Read the durable audit log written by the `ledgerpi` extension (the repo this skill
lives in) and produce a ranked report on whether the manager-worker loop is earning
its cost, so the loop's knobs can be tuned from evidence rather than guesswork.
ledgerpi runs the arXiv 2608.26480 scaffold under an allow-listed model, at roughly
triple the tokens of a single call; the gains are a small-model effect that shrinks to
nothing on models that already plan and stop on their own. This skill is where the log
answers, per provider and model, whether that trade is paying off. Any proposed change
still targets ledgerpi (its config, its providers list, or its code), filed against
this repo's issue tracker.

Optional argument: an explicit path to the `runs.jsonl` file (see path resolution
below), optionally combined with a scope filter -- a provider name, a model name, a
`source` label (e.g. `source benchmark`, or `source unknown`), or a time window (e.g.
`since 2026-09-01`). With no argument, resolve the default path and analyze the whole
log. Every analytical view is segmented by `source`, so a provider/model/time filter
narrows each source group independently while a `source <label>` filter restricts the
corpus to that one provenance label.

## Read-Only Rule

The analysis is inspection only: no file edits, `git` writes, config changes, or
ledgerpi changes. Read the audit log (and, if needed, ledgerpi's config to resolve the
path) only to produce proposed findings. The opt-in Filing step is the sole exception:
after explicit confirmation it delegates to the harness's report-task skill, which owns its own writes.
This skill never applies a provider, allowlist, `maxIters`, thinking-level, or
`classifier` change itself.

## Resolve the audit-log path

ledgerpi's `auditLog` resolves (highest precedence first):

1. An explicit path passed as the argument.
2. `LEDGERPI_AUDIT_LOG` in the environment.
3. `auditLog` in ledgerpi's config -- `$LEDGERPI_CONFIG`, else
   `$XDG_CONFIG_HOME/ledgerpi/config.toml`, else `~/.config/ledgerpi/config.toml`
   (read the `auditLog` key with `yq` if present).
4. Default: `runs.jsonl` under ledgerpi's `stateDir`. `stateDir` itself resolves as
   `LEDGERPI_STATE_DIR` (env, highest -- ledgerpi's own resolver applies it last and
   the audit-log default tracks it), else `stateDir` from the config, else
   `agentDir()/ledgerpi`. `agentDir()` is `PI_CODING_AGENT_DIR` when it is set to a
   non-empty value, else `~/.pi/agent` -- the loader nullish-coalesces, so an empty
   `PI_CODING_AGENT_DIR` is NOT the default: it yields the relative path
   `ledgerpi/runs.jsonl`; name that as a misconfiguration rather than following it. The
   default audit path is `<that stateDir>/runs.jsonl`.

A blank value is not set: the loader only accepts a non-blank string, so `auditLog = ""`,
a blank `stateDir`, a blank `LEDGERPI_AUDIT_LOG`, and a blank `LEDGERPI_STATE_DIR` are all
ignored and fall through to the next tier.

**Fail-closed caveat:** tiers 3 and 4 (the config's `auditLog` and `stateDir`) are
honored only when the config loads *valid* -- it exists, parses, and either has a
`[claude]` table, or defines at least one provider, has no retired `[blocklist]` table,
and, if a `[allowlist]` table is present, that table is well-formed (the table is
optional; an absent one is valid and empty). Those pi conditions do not govern a
`[claude]` table: with one, a config with no providers, a retired `[blocklist]`, or a
malformed `[allowlist]` leaves pi inert, but Claude Code runs and the file's paths are
honored. If the config is not valid by these rules, ledgerpi is inert
and its runtime resolver falls back to `LEDGERPI_AUDIT_LOG` if set, then
`<LEDGERPI_STATE_DIR>/runs.jsonl` if `LEDGERPI_STATE_DIR` is set, then the default
`<PI_CODING_AGENT_DIR|~/.pi/agent>/ledgerpi/runs.jsonl`. So do not trust an
`auditLog`/`stateDir` read from the config file blindly: first
confirm the config is valid by those rules. If it is
not, the extension writes nothing now, the live log is at the default path, and a log a
previously-valid config wrote to some other path is stale -- name that caveat rather
than analyzing the stale file.

If the resolved file is absent or empty, say so and stop -- there is nothing to
analyze. **Deployment note:** do not assume a host's and a container's logs are unified
without checking the deployment. Where a container or sandbox profile binds `~/.pi/agent/ledgerpi`
read-write, a run inside the box appends to the same host default-path log as host
sessions; a box or host predating that mount (or where the host dir was never created)
logs to an in-box path invisible here, and a run whose `auditLog` or `stateDir` is
overridden (env or config) writes elsewhere. When the corpus looks partial, say so
rather than reporting it as complete.

## Record schema

The log is JSON Lines, one object per line, of two `event` kinds. Fields below are the
ones the extension's `audit.ts` actually writes; re-derive against that source if it
changes.

- **run** (one per completed loop, from any entry point): `{ t, event:"run", source,
  harness:"pi"|"claude", entry:"input"|"tool"|"command", session, provider, model,
  managerModel, workerModel, planSource, classified, converged, stop, stopDetail, iters,
  maxIters, callTimeoutMs, calls, tokens, managerTokens, workerTokens,
  gate:{command,ran,passed}|null, cwd, repoUrl, branch, headStart, headEnd, durationMs,
  managerMs, workerMs, gateMs, managerCalls, workerCalls, gateRuns,
  fanout:{setting,max,rounds,downgrades,escapes,asked,advised}|null, task }`. `fanout` is `null`
  when the setting was `off`; otherwise it counts the rounds that ran as best-of-N, the
  downgrade and escape reasons, the questions put to the user under `ask` (`asked`;
  rows predating it omit it), and the manager's recommendations. `managerMs`, `workerMs`,
  and `gateMs` are summed, host-measured busy time per role (every manager-type or
  worker-type spawn, failed or timed-out ones included, and every gate run), and
  `managerCalls`, `workerCalls`, and `gateRuns` count them. Concurrent best-of-N
  candidates and an overlapping gate are summed, so the three times can add up to more
  than `durationMs`; on a pi `input` run whose classifier ran (`classified` is not
  `null`) `managerCalls + workerCalls` is `calls - 1` (the classifier call is not a loop
  spawn), and on every other row it equals `calls`. Zero is a real value; a missing key means a
  row from a version predating the fields, which is missing, not zero, and aggregates
  as untimed. `harness` is absent on older rows, which aggregate as `unknown`. Claude rows
  have `provider:"anthropic"`, `model:null` (the loop runs outside the session model),
  the model each role was observed answering on, and `managerTokens`/`workerTokens`,
  which are `null` on pi. Claude's `tokens` count cache reads and writes. `repoUrl` (origin, http(s) userinfo stripped), `branch`, and the
  `headStart`/`headEnd` SHAs are `null` when git cannot say and absent on older rows.
  `stop` is one of `done|budget|no-progress|spawn-failure|unconverged|aborted`.
  `stopDetail` is only meaningful on `stop:"spawn-failure"` rows, where it names the
  RPC failure branch that ended the run: one of `aborted|timeout|refused|agent-error|other`
  (`other` is the defensive default for an unclassified failure). Every other stop writes
  `stopDetail: null` -- rows from a version predating the field have the key missing, and
  that legacy shape aggregates as `unknown`, a distinct bucket from `other`. A malformed
  (non-string or empty) `stopDetail` also aggregates as `unknown`, reported rather than
  crashing or double-counting. `provider`/`model`
  are nullable. `gate` is `null` when no gate *result* was recorded for the run -- that
  happens both when no gate was detected in the repo and when the loop stopped before
  reaching the gate (`aborted`, `no-progress`, or a `spawn-failure` before the first
  round); do not read a bare `gate==null` as "no gate in the repo". A `spawn-failure`
  with `gate==null` means the run stopped before the first round or has no gate
  configured: an in-loop `spawn-failure` (second consecutive worker failure) re-runs the
  gate and records its fresh verdict. `spawn-failure` rows from versions before that
  change may instead carry a stale verdict from an earlier round rather than the tree
  state at the stop. When `gate` is an object, `gate.ran:false`
  means the gate never ran -- a launch failure or an interruption (the caller's abort
  fired before the command closed), not a failed gate; `gate.passed` is meaningful only
  when `gate.ran` is true. `classified` is `"code"` on an input run that ran the
  classifier, `null` on a tool or `/ledger` command run (no classifier on those paths)
  or a run that bypassed it. `managerModel` is the `"provider/modelId"` the manager role
  ran on through the `[roleModel]` pin or its reserved `default` entry, or `null` when it
  ran on the session model (`provider`/`model`); `workerModel` is the worker's model -- the
  `[roleModel]` entry's `worker`, or, for a key absent from the table, the deprecated
  `[workerModel]` mapping or else the `default` entry's `worker` -- or `null` when the
  worker ran on the session model. Rows from a version predating a
  field have the key missing and aggregate as that role's `unknown`, a distinct bucket
  from `session`.
  `planSource` is `"caller"` when the run was handed an approved plan (`plan_file` /
  `--plan-file`) and `"manager"` when the loop planned itself; older rows lack the key.
  `maxIters` and `callTimeoutMs` are the effective budget the loop ran under (numbers,
  read from the resolved config at run time), so a stop pattern can be segmented by the
  budget in force rather than the live config, which has no history. Rows from a version
  predating the fields have the keys missing; a missing key, `null`, or any non-number
  value aggregates as `unknown`, a distinct bucket from every numeric budget.
- **passthrough** (an eligible prompt that did not run): `{ t, event:"passthrough",
  source, harness:"pi", entry:"input"|"redirect", session, provider, model, classified,
  reason, calls, tokens, cwd }`. Claude Code writes no passthrough rows, and `harness` is
  absent on older rows.
  For a classifier decline `classified` is `"chat"` and `reason` is one of `classified`
  (a genuine chat verdict), `error`, `aborted`, `invalid` (empty or unparseable answer),
  or `no-model`. For a user decline at the `trigger="ask"` dialog `reason` is `declined`
  (that prompt) or `declined-session` (skip for the rest of the session); `ask-error`
  is a dialog that failed before the user answered (not a decline). On `entry:"input"`
  `classified` is `"code"` on all three (or `null` with `calls:0` when the classifier is
  off). On `entry:"redirect"` -- the same dialog shown at the first redirected edit of a
  skill session -- no classifier runs, so `classified` is always `null` with `calls:0`
  and `tokens:0`.

`task` is the first 200 chars of the prompt. Parse defensively -- treat missing keys as
null and never let one malformed line break an aggregate.

`source` is the provenance stamp the extension writes at append time. On a run or
passthrough row it is a string: `organic` when `LEDGERPI_AUDIT_SOURCE` was unset (or
blank) at write time, else the caller-supplied label, such as `benchmark`. A harness
that launches runs sets the env var; ledgerpi only reads it. Normalize `source` the same
way in every aggregate, trimming with the same ECMAScript whitespace set the writer's
`trim()` uses: a trimmed non-empty string is its own label; a missing, null,
blank/whitespace-only, or non-string `source` -- the legacy shape written before the
field existed -- aggregates as `unknown`, never as `organic`. Never infer source from the
task text, and never rewrite old rows.

## Aggregations

Group every per-model view by `[.provider, .model]`, never by model alone -- two
providers can serve a same-named model, and pooling them mislabels the row and can point
a provider/allowlist recommendation at the wrong one. Never pool across materially
different time windows either.

Each command prefilters with `jq -R 'fromjson? | select(type=="object")'` so a malformed
line and any non-object record (a bare scalar or an array) are skipped rather than
aborting the whole aggregate (the log is appended live). Report the skipped lines with
the single-pass line-accounting recipe below -- a separate `wc -l` read races with the
live append and misses a final unterminated record, so compute lines and objects in one
raw-input pass.

Segment every analytical view by `source` as well as provider/model, so synthetic
A/B-benchmark activity (a harness-stamped label such as `benchmark`) is never pooled with
organic use -- pooling them is exactly what hides whether the loop earns its cost on real
traffic. Only the line-accounting recipe below stays whole-log; the other nine group by
normalized `source` first. The `trim` builtin is not available on the installed jq, so
each recipe defines `def ws` -- the exact ECMAScript `String.prototype.trim` character
set, written with `\x{...}` escapes because Oniguruma mis-parses `\uXXXX` inside a
range -- and normalizes with `gsub("^"+ws+"+|"+ws+"+$";"")` guarded by a
`type=="string"` check, so the reader trims exactly what the writer's `trim()` trims
(U+FEFF and the Unicode space separators included, U+0085 excluded). A blank result
falls to `unknown` (matching the schema contract above); the `def ws` and `def src`
helpers appear at the top of each recipe. Each analytical recipe builds its
fields as an array and serializes with `@tsv` rather than interpolating raw `\t`, so a
caller-supplied label containing a tab, newline, carriage return, or backslash is escaped
and cannot shift a column or split a row. The count-sorting recipes sort on the count
column: field 3 for the passthrough mix (a source column precedes the count), field 5 for
the stop mix and spawn-failure breakdown (source, `maxIters=`, and `callTimeoutMs=`
precede the stop and the count).

The convergence, stop-mix, and spawn-failure recipes also segment by the run's budget.
Each defines `def bud(f)`, which maps a numeric `maxIters`/`callTimeoutMs` to its
number and anything else (missing, `null`, non-number) to `unknown`, so rows from
before the fields existed form their own bucket and are never pooled with a known
budget. The convergence recipe also defines `def role(f)`, one parameterized word for
both role fields: it maps a pinned `"provider/modelId"` to itself, `null` to
`session`, and a missing key or non-string to `unknown`, so a cross-model run is never
pooled with a same-model run of the same session model.

- Line accounting (single pass; `skipped` is malformed plus non-object lines; stays
  whole-log, not segmented by source):
  ```bash
  jq -R -s -r 'split("\n") | if .[-1] == "" then .[:-1] else . end | . as $lines | ($lines | map(fromjson? // null) | map(select(type=="object"))) as $objs | "lines=\($lines|length)\tobjects=\($objs|length)\tskipped=\(($lines|length)-($objs|length))"' "$LOG"
  ```

- Convergence and cost per provider+model, manager and worker model, budget, and plan
  source (`plan` is the row's `planSource`, `unknown` on rows predating it, so a run handed
  an approved plan is never pooled with one that planned itself; the
  `manager` and `worker` columns are the normalized `managerModel`/`workerModel`: the
  pinned model, `session` for a null, `unknown` for a missing key or a non-string
  value, so a cross-model run is never pooled with a same-model run of the same session
  model; `|numbers` averages only present numeric
  samples, so a row missing `iters`/`tokens` neither aborts the divide nor skews the
  mean; an all-missing group reports `n/a`. Cross-reference the `missingIters`,
  `missingTokens`, and `missingConverged` completeness counts below for how many rows
  were dropped from these denominators -- a missing `converged` is unknown, not a
  failure):
  ```bash
  jq -R 'fromjson? | select(type=="object")' "$LOG" | jq -s -r '
    def ws: "[\\t\\n\\x0b\\x0c\\r \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]";
    def src: (if (.source|type)=="string" then (.source|gsub("^"+ws+"+|"+ws+"+$";"")) else "" end) | if .=="" then "unknown" else . end;
    def role(f): if has(f)|not then "unknown" elif .[f]==null then "session" elif (.[f]|type)=="string" and (.[f]|length)>0 then .[f] else "unknown" end;
    def bud(f): f|if type=="number" then tostring else "unknown" end;
    def plan: if (.planSource|type)=="string" and (.planSource|length)>0 then .planSource else "unknown" end;
    [.[]|select(.event=="run")]|group_by([src,.provider,.model,role("managerModel"),role("workerModel"),bud(.maxIters),bud(.callTimeoutMs),plan])[]|. as $g|($g|map(.iters|numbers)) as $it|($g|map(.tokens|numbers)) as $tk|[($g[0]|src),"\($g[0].provider)/\($g[0].model)","manager=\($g[0]|role("managerModel"))","worker=\($g[0]|role("workerModel"))","maxIters=\($g[0]|bud(.maxIters))","callTimeoutMs=\($g[0]|bud(.callTimeoutMs))","plan=\($g[0]|plan)","runs=\($g|length)","converged=\($g|map(select(.converged==true))|length)","avgIters=\(if ($it|length)>0 then (($it|add)/($it|length)|floor) else "n/a" end)","avgTokens=\(if ($tk|length)>0 then (($tk|add)/($tk|length)|floor) else "n/a" end)"]|@tsv'
  ```
- Stop-reason mix (why runs ended, per budget in force):
  ```bash
  jq -R 'fromjson? | select(type=="object")' "$LOG" | jq -s -r '
    def ws: "[\\t\\n\\x0b\\x0c\\r \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]";
    def src: (if (.source|type)=="string" then (.source|gsub("^"+ws+"+|"+ws+"+$";"")) else "" end) | if .=="" then "unknown" else . end;
    def bud(f): f|if type=="number" then tostring else "unknown" end;
    [.[]|select(.event=="run")]|group_by([src,bud(.maxIters),bud(.callTimeoutMs),.stop])[]|[(.[0]|src),"maxIters=\(.[0]|bud(.maxIters))","callTimeoutMs=\(.[0]|bud(.callTimeoutMs))","\(.[0].stop)","\(length)"]|@tsv' | sort -t$'\t' -k5 -rn
  ```
- Spawn-failure breakdown (why `stop:"spawn-failure"` runs failed; the top-level stop
  mix above keeps the bucket as one row per budget, this recipe splits it by `stopDetail`,
  so a `timeout` cluster can be read against the `callTimeoutMs` it ran under):
  ```bash
  jq -R 'fromjson? | select(type=="object")' "$LOG" | jq -s -r '
    def ws: "[\\t\\n\\x0b\\x0c\\r \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]";
    def src: (if (.source|type)=="string" then (.source|gsub("^"+ws+"+|"+ws+"+$";"")) else "" end) | if .=="" then "unknown" else . end;
    def bud(f): f|if type=="number" then tostring else "unknown" end;
    [.[]|select(.event=="run" and .stop=="spawn-failure")]|map(. as $r|($r.stopDetail as $d|if ($d|type)=="string" and ($d|length)>0 then $d else "unknown" end) as $c|{s:($r|src),m:($r|bud(.maxIters)),o:($r|bud(.callTimeoutMs)),c:$c})|group_by([.s,.m,.o,.c])[]|[(.[0].s),"maxIters=\(.[0].m)","callTimeoutMs=\(.[0].o)","\(.[0].c)","\(length)"]|@tsv' | sort -t$'\t' -k5 -rn
  ```
- Gate coverage and outcome (one row per source; `badGate` is a run whose `gate` is
  present but not an object; only object gates are inspected, so a bad one is reported,
  not aborting the aggregate):
  ```bash
  jq -R 'fromjson? | select(type=="object")' "$LOG" | jq -s -r '
    def ws: "[\\t\\n\\x0b\\x0c\\r \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]";
    def src: (if (.source|type)=="string" then (.source|gsub("^"+ws+"+|"+ws+"+$";"")) else "" end) | if .=="" then "unknown" else . end;
    [.[]|select(.event=="run")]|group_by(src)[]|. as $runs|($runs|map(select(.gate==null))) as $noGate|($runs|map(select(.gate!=null and (.gate|type)=="object"))) as $gates|($runs|map(select(.gate!=null and (.gate|type)!="object"))) as $bad|[($runs[0]|src),"withGate=\($gates|length)","noGate=\($noGate|length)","badGate=\($bad|length)","gateRan=\($gates|map(select(.gate.ran==true))|length)","gatePassed=\($gates|map(select(.gate.passed==true))|length)","total=\($runs|length)"]|@tsv'
  ```
- Classifier passthrough mix (a diagnostic proxy, not measured accuracy -- the log has
  no ground-truth label for whether a decline was right, so this shows the shape of
  declines, not a correctness score):
  ```bash
  jq -R 'fromjson? | select(type=="object")' "$LOG" | jq -s -r '
    def ws: "[\\t\\n\\x0b\\x0c\\r \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]";
    def src: (if (.source|type)=="string" then (.source|gsub("^"+ws+"+|"+ws+"+$";"")) else "" end) | if .=="" then "unknown" else . end;
    [.[]|select(.event=="passthrough")]|group_by([src,.reason])[]|[(.[0]|src),"\(.[0].reason)","\(length)"]|@tsv' | sort -t$'\t' -k3 -rn
  ```
- Classifier spend and completeness. Only passthrough rows carry classifier-only tokens.
  A run row's `tokens` is the whole loop, with its one classifier call folded in (the
  `input` entry folds one call and the classifier's tokens; the `tool` entry runs no
  classifier), and that per-run classifier spend is not separable -- so report the
  passthrough figure as classifier-only and the known-events figure as the combined
  loop+classifier total, never as classifier-only. `combinedTokens(known)` sums only the
  recognized `run`/`passthrough` events; `unknownEvents` counts objects whose `event`
  is anything else (or missing) so a new event type is reported, not silently folded in;
  `missingTokens`, `missingIters`, and `missingConverged` count recognized rows with a
  missing (non-numeric / non-boolean) field so a missing field is reported, not zeroed
  or silently dropped from a denominator; `badGate` counts run rows whose `gate` is
  present but not an object, so a malformed gate is reported, not silently skipped. Token
  counts are not dollar costs: report them as tokens and do not convert to a price. This
  recipe emits one row per source, with the completeness counters scoped to that source's
  rows (an unrecognized `event` is attributed to its normalized source).
  ```bash
  jq -R 'fromjson? | select(type=="object")' "$LOG" | jq -s -r '
    def ws: "[\\t\\n\\x0b\\x0c\\r \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]";
    def src: (if (.source|type)=="string" then (.source|gsub("^"+ws+"+|"+ws+"+$";"")) else "" end) | if .=="" then "unknown" else . end;
    . as $all|$all|group_by(src)[]|. as $g|($g|map(select(.event=="run" or .event=="passthrough"))) as $known|($g|map(select(.event=="run"))) as $runs|[($g[0]|src),"classifierOnlyTokens(passthroughs)=\([$g[]|select(.event=="passthrough")|.tokens|select(type=="number")]|add // 0)","combinedTokens(known)=\([$known[]|.tokens|select(type=="number")]|add // 0)","unknownEvents=\(($g|length)-($known|length))","missingTokens=\([$known[]|.tokens|select(type!="number")]|length)","missingIters=\([$runs[]|.iters|select(type!="number")]|length)","missingConverged=\([$runs[]|.converged|select(type!="boolean")]|length)","badGate=\([$runs[]|select(.gate!=null and (.gate|type)!="object")]|length)"]|@tsv'
  ```
- Engage vs pass-through ratio per source+provider+model (how often the loop actually
  fires):
  ```bash
  jq -R 'fromjson? | select(type=="object")' "$LOG" | jq -s -r '
    def ws: "[\\t\\n\\x0b\\x0c\\r \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]";
    def src: (if (.source|type)=="string" then (.source|gsub("^"+ws+"+|"+ws+"+$";"")) else "" end) | if .=="" then "unknown" else . end;
    group_by([src,.provider,.model])[]|[(.[0]|src),"\(.[0].provider)/\(.[0].model)","runs=\(map(select(.event=="run"))|length)","passthrough=\(map(select(.event=="passthrough"))|length)"]|@tsv'
  ```

- Harness split (`harness` absent on older rows reads as `unknown`; role tokens are
  Claude-only, so pi reports `n/a`). Never pool the harnesses in a cost comparison:
  Claude's `tokens` include cache reads. The views above do not split by harness, so when
  the log holds both, narrow it to one harness first, then rerun them on the narrowed file:
  `NARROWED=$(mktemp) && jq -R -c 'fromjson? | select(type=="object" and .harness=="claude")' "$LOG" > "$NARROWED" && LOG=$NARROWED`.
  ```bash
  jq -R 'fromjson? | select(type=="object")' "$LOG" | jq -s -r '
    def ws: "[\\t\\n\\x0b\\x0c\\r \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]";
    def src: (if (.source|type)=="string" then (.source|gsub("^"+ws+"+|"+ws+"+$";"")) else "" end) | if .=="" then "unknown" else . end;
    def h: if (.harness|type)=="string" then .harness else "unknown" end;
    def sum: map(numbers)|if length>0 then add else "n/a" end;
    [.[]|select(.event=="run")]|group_by([src,h])[]|. as $g|[($g[0]|src),($g[0]|h),"runs=\($g|length)","converged=\($g|map(select(.converged==true))|length)","managerTokens=\($g|map(.managerTokens)|sum)","workerTokens=\($g|map(.workerTokens)|sum)"]|@tsv'
  ```

- Timing by role (where wall-clock time goes: manager vs worker vs gate). One row per
  source, harness, provider+model, manager and worker model, plan source, and mode
  (`best-of-n` when `fanout` is an object with `rounds>0`, else `serial`), so a
  best-of-N run, whose concurrent candidates are summed, is never pooled with a serial
  one. `timed` counts rows whose `managerMs` is a number and `untimed` the rest (rows
  predating the fields); the medians use only present numeric samples, so an untimed row
  is dropped from a role median rather than read as zero, and a group with no sample
  reports `n/a`. `medDurationMs` covers every row of the group, timed or not, while
  `medTimedDurationMs` covers only the timed rows, so compare the role medians with
  `medTimedDurationMs`, the same rows, and never with `medDurationMs` in a group that
  mixes timed and untimed rows.
  `medWorkerMsPerCall` is `workerMs/workerCalls` per row where `workerCalls>0`, which
  tells a slower worker from more worker calls. The role medians are busy time and can
  exceed `medTimedDurationMs` on a `best-of-n` row:
  ```bash
  jq -R 'fromjson? | select(type=="object")' "$LOG" | jq -s -r '
    def ws: "[\\t\\n\\x0b\\x0c\\r \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]";
    def src: (if (.source|type)=="string" then (.source|gsub("^"+ws+"+|"+ws+"+$";"")) else "" end) | if .=="" then "unknown" else . end;
    def role(f): if has(f)|not then "unknown" elif .[f]==null then "session" elif (.[f]|type)=="string" and (.[f]|length)>0 then .[f] else "unknown" end;
    def h: if (.harness|type)=="string" then .harness else "unknown" end;
    def plan: if (.planSource|type)=="string" and (.planSource|length)>0 then .planSource else "unknown" end;
    def mode: if (.fanout|type)=="object" and (((.fanout.rounds|numbers) // 0) > 0) then "best-of-n" else "serial" end;
    def med: map(numbers)|sort|length as $n|if $n==0 then "n/a" elif $n%2==1 then .[($n-1)/2] else (.[$n/2-1]+.[$n/2])/2 end;
    [.[]|select(.event=="run")]|group_by([src,h,.provider,.model,role("managerModel"),role("workerModel"),plan,mode])[]|. as $g|[($g[0]|src),($g[0]|h),"\($g[0].provider)/\($g[0].model)","manager=\($g[0]|role("managerModel"))","worker=\($g[0]|role("workerModel"))","plan=\($g[0]|plan)","mode=\($g[0]|mode)","runs=\($g|length)","timed=\($g|map(select((.managerMs|type)=="number"))|length)","untimed=\($g|map(select((.managerMs|type)!="number"))|length)","medDurationMs=\($g|map(.durationMs)|med)","medTimedDurationMs=\($g|map(select((.managerMs|type)=="number")|.durationMs)|med)","medManagerMs=\($g|map(.managerMs)|med)","medWorkerMs=\($g|map(.workerMs)|med)","medGateMs=\($g|map(.gateMs)|med)","medWorkerMsPerCall=\($g|map(select((.workerMs|type)=="number" and (.workerCalls|type)=="number" and .workerCalls>0)|.workerMs/.workerCalls)|med)"]|@tsv'
  ```

## Map findings to ledgerpi's knobs

Every finding names an evidence row (its `source`, provider/model, count, and the
aggregate it came from) and the knob it points at. A finding drawn from `benchmark` rows
does not transfer to organic traffic on its own -- keep the sources' evidence separate,
and never recommend an organic tuning change off benchmark-only rows:

- Low convergence with many `stop:"budget"` -> `maxIters` is too low, or the model is
  too weak to converge; consider raising `maxIters` or allowlisting the provider down to a
  stronger model. Compare the `budget` rate across the stop mix's `maxIters=` buckets
  first: it only points at the knob if it moves with the budget.
- Many `stop:"no-progress"` -> the model stalls on the same instruction; a model
  problem, not a budget one.
- Many `stop:"spawn-failure"` -> read the breakdown recipe's `stopDetail` mix before
  naming a knob: `timeout` points at `callTimeoutMs` being too low or a slow provider
  (raise the budget or investigate latency), while `refused`/`agent-error` point at the
  RPC layer or provider (auth, capacity, broken model) -- investigate those, do not
  drop a model from its provider's allowlist off them alone. `aborted` never appears as a spawn-failure detail
  (a user abort is its own top-level stop) -- keep it out of provider-health reasoning.
  `other`/`unknown` are unclassified: report them as a provenance gap, not a verdict.
  Read a `timeout` cluster against its `callTimeoutMs=` bucket: a cluster that stops
  after a budget change is attributable to the change only when both sides carry a
  numeric budget. A `callTimeoutMs=unknown` bucket is history from before the field
  existed -- report that the budget it ran under is unknown, never infer it from the
  current config.
- High `avgTokens` with low convergence -> the +tokens trade is not paying off for that
  model (the paper's gains vanish on models that already plan) -> drop the provider or
  allowlist it down to the specific model that does.
- Healthy convergence at reasonable token cost -> keep; this is where the loop earns its
  keep.
- `reason:"error"` frequent among passthroughs -> classifier/provider outages (API
  failures), not real chat; a provider-health issue (consider `classifier=false` only if
  chronic).
- `reason:"aborted"` frequent -> the user cancelled mid-classification (the caller's
  signal fired), not a provider problem; report it separately and never fold it into
  provider health or a classifier-disable recommendation.
- `reason:"invalid"` frequent -> the model cannot follow the classifier prompt (empty or
  unparseable answers) -> tune the classifier prompt or disable the classifier for that
  model.
- `reason:"declined"`/`"declined-session"` frequent -> the user is turning the loop down
  on prompts the classifier sent it; a usage signal, not a classifier miss. Report it
  apart from the classifier reasons; a high share argues for `trigger="manual"` (no
  input-hook runs; `/ledger` and `ledger_solve` still run) or a stricter classifier,
  not for disabling the classifier.
  `reason:"ask-error"` is a UI failure, not a decline -- keep it out of the decline share.
- `gate==null` means no gate *result* was recorded for that run, which happens both when
  no gate was detected in the repo AND when the loop stopped before testing (`aborted`,
  `no-progress`, or a `spawn-failure` before the first round). A `spawn-failure` with
  `gate==null` means the run stopped before the first round or has no gate configured;
  an in-loop one re-runs the gate, and older `spawn-failure` rows may carry a stale
  verdict from an earlier round instead of the tree state at the stop. Do not read
  `gate==null` as "no gate in the repo"
  on its own -- cross-reference the stop reason: `gate==null` with `stop:"done"` after
  real rounds points at a missing gate (the manager's verdict stood unchecked -- a
  weaker signal, a caveat not a fix), whereas `gate==null` with an early-stop reason
  points at never reaching the gate. `gate.ran==false` is a launch failure or an
  interruption, not a failed gate.

## Output format

- **Corpus summary**: resolved log path, line count, run vs passthrough counts, date
  range, distinct providers/models, the distinct `source` labels present, and any
  deployment-visibility caveat -- plus the completeness counts: malformed and non-object
  lines (skipped by the prefilter), `unknownEvents`, `missingTokens`, `missingIters`,
  `missingConverged`, and `badGate`. Report the completeness counts per source as well
  as whole-log, since the source-grouped recipes scope them per group. If any of those
  is nonzero, say so and treat the aggregates as partial in that respect.
- **Source segmentation**: report `organic`, `benchmark`, and any custom or `unknown`
  sources separately, each with its own per-source denominators (runs, convergence rate,
  token cost) and completeness. Never pool sources into one headline number. If the
  corpus contains no organic rows, say explicitly that organic effectiveness cannot be
  assessed -- the loop's real-traffic cost/benefit trade is not answerable from benchmark
  or `unknown` rows alone, and label any benchmark finding as synthetic.
- **Convergence & cost**: the per-source, per-model table -- each row split by the
  manager and worker models it ran on and the budget in force -- with the loop's overall
  convergence rate and average token cost per source (tokens, not dollars).
- **Stop-reason mix**: the per-source breakdown, calling out the failure reasons, with
  the spawn-failure bucket split by `stopDetail` (timeout / refused / agent-error / other
  / unknown-legacy) rather than reported as one opaque count, and each split by the
  `maxIters`/`callTimeoutMs` budget it ran under (`unknown` for rows predating the fields).
- **Gate coverage**: per source, how often a gate ran and passed, vs `gate==null` (no
  result recorded) -- distinguishing repos with no gate from runs that stopped before
  testing by cross-referencing the stop reason, and reading `gate.ran==false` as a launch
  failure or interruption.
- **Classifier passthrough mix**: the per-source passthrough reason mix (separating
  genuine chat verdicts from failures) as a diagnostic proxy, the per-source
  classifier-only spend from passthrough rows, and the combined loop+classifier total --
  labeled as combined, since per-run classifier spend is folded into run tokens and not
  separable.
- **Timing by role**: per source, harness, and model, the median run time of the timed
  rows (`medTimedDurationMs`) and how it splits across manager, worker, and gate, with
  `timed` against `untimed` runs. Say
  that the role times are busy-time sums (they can exceed the run time on best-of-N),
  and that untimed rows predate the fields.
- **Ranked opportunities**: one line per item, most impactful first, each naming its
  evidence row (source + provider/model) and the knob it targets (provider / allowlist /
  maxIters / workerThinking / managerThinking / classifier).
- **Residual**: malformed and non-object lines, `unknownEvents`, `missingTokens`,
  `missingIters`, `missingConverged`, `badGate`, legacy rows normalized to
  `source:"unknown"`, ambiguous clusters, or corpus gaps (e.g. in-box runs not yet
  host-visible), with the specific missing evidence.

Ranking: frequency in the window, size of the effect (delta vs the window's median or a
prior window), and how cheaply the knob could plausibly be changed.

## Filing step (opt-in)

After the report, offer to file each actionable opportunity. Filing is the only write
and is gated on explicit confirmation via the harness's structured user-question tool.

1. Show one routing row per opportunity and ask the user to confirm, drop, or reword
   each one.
2. For each confirmed finding, invoke the harness's report-task skill against
   this repo's issue tracker -- or its report-task-frontier variant when it
   should carry an implementation plan -- once per finding, never bundling unrelated
   findings. Every filing carries the
   evidence (provider/model, counts, the aggregate), the ranked impact, and the knob it
   targets.
3. Report the created work-item URLs, dedup hits, and any local fallback.

End by reminding the user that the analysis changed nothing, listing anything filed, and
noting any corpus gaps or deployment-visibility caveats that remain.
