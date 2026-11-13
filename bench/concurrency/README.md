# Concurrency bench

Measures local inference throughput when 1 to 20 worker requests hit the endpoint at
once. It exists to give `fanoutMax` (and the opt-in fan-out default) a measured basis
instead of a guess. It is standalone: nothing in the loop calls it, and it writes
nothing inside the repo.

For each mode, input size, repetition and concurrency level, it fires that many
streaming chat completions at the same moment, records time to first token (TTFT),
decode speed and errors for each, and then summarizes per level.

No live sweep has been run yet. Treat any numbers you see elsewhere as unverified until
a `summary.json` from a real run is published.

It talks to the endpoint over plain HTTP, so it does not need the pi-subagents extension
or any other part of the pi adapter.

## Run

```sh
# Smoke test: two levels, small prompt, short output, one rep.
LEDGERPI_BENCH_API_KEY=... node --experimental-strip-types bench/concurrency/run.ts \
  --provider local --levels 1,2 --input-tokens 4000 --max-output 128 --reps 1

# Full sweep with the defaults (about 600 requests, 1 to 1.5 hours).
LEDGERPI_BENCH_API_KEY=... LEDGERPI_BENCH_PROVIDER=local \
  node --experimental-strip-types bench/concurrency/run.ts
```

The output directory is printed on stdout; progress goes to stderr.

Run it only when the endpoint is idle. If live sessions share it, a sweep at level 20
with 48k-token prompts will slow them down and be slowed by them.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--provider` | `LEDGERPI_BENCH_PROVIDER` | Id of the `providers` entry in pi's `models.json` to read the base URL and key from. Required unless `--base-url` is given. |
| `--base-url` | from `models.json` (below) | OpenAI-compatible base URL, for example `http://localhost:8000/v1`. |
| `--model` | `qwen3.8-27b` | Model id sent in each request. |
| `--levels` | `1,2,4,8,15,20` | Concurrent requests per batch. Sorted and de-duplicated. |
| `--input-tokens` | `16000,48000` | Prompt sizes to test, in tokens. |
| `--modes` | `distinct,shared-prefix` | `distinct` starts every prompt with a random nonce. `shared-prefix` gives each batch a fresh batch nonce header, then a common body and a short distinct suffix, so every batch starts cold and its requests share the long prefix only with each other. |
| `--max-output` | `2048` | `max_tokens` per request. |
| `--reps` | `3` | Repetitions of each (mode, size, level) batch. |
| `--timeout-s` | `600` | Per-request timeout in seconds, over headers and body. Positive, at most two decimals. |
| `--out` | see Output | Output directory. Must not exist. |

Lists are comma-separated; `--levels`, `--reps` and `--input-tokens` need positive
integers. Unknown flags are rejected.

### Base URL and key

The provider id is `--provider`, else the `LEDGERPI_BENCH_PROVIDER` environment
variable; `--provider` wins when both are set. With neither and no `--base-url`, the run
exits 2 naming both. With `--base-url` the provider is optional: a provider named by flag
or variable that is absent from `models.json` is then ignored, and the key must come from
`LEDGERPI_BENCH_API_KEY`. A provider that is present still supplies its `apiKey` when
`LEDGERPI_BENCH_API_KEY` is unset, so the request carries that key to the `--base-url` host.

The base URL is `--base-url`, else `providers.<id>.baseUrl` in
`<agentDir>/models.json` (`~/.pi/agent` unless `PI_CODING_AGENT_DIR` is set), where `<id>`
is the selected provider. If `models.json` parses but has no such provider (including no
`providers` object) and no `--base-url`
was given, the run exits 2 naming it; a missing or malformed `models.json` is treated as an empty entry. With
no base URL from either source, the run exits 2.

The key is `LEDGERPI_BENCH_API_KEY` if it is non-empty, else the provider `apiKey`
of the selected provider as written in `models.json`. A key that starts with `!` is a shell command in pi's
config, and one containing `$` is an environment-variable reference; the bench refuses
both, never runs or expands them, and exits 2 naming the environment variable. The key is never a flag and is never printed.

If the endpoint needs a real client token and the `apiKey` in `models.json` is a
placeholder, set `LEDGERPI_BENCH_API_KEY`. A rejected key (for example a 401) fails the
calibration request first, so the run exits 1 before any sweep row is written.

### Exit codes

- `2`: usage or config error (unknown flag, malformed value, no provider, provider missing from `models.json`, no base URL, no usable key,
  `--out` already exists). Reported before any network request.
- `1`: any other failure, for example the calibration probe failing.
- `0`: the sweep finished, even if some requests failed. Failures are data; read
  `summary.json`.

## How it works

Before the sweep, one 1-token request calibrates the characters-per-token ratio from the
server's `usage.prompt_tokens`, so each prompt hits the requested size. The prompt filler
is source text from `packages/core/src`. The actual prompt tokens are recorded per row.
The probe is not a row.

Each request sends `stream: true`, `temperature: 0`, `ignore_eos: true` and
`chat_template_kwargs: {enable_thinking: false}`, with `stream_options.include_usage`.
TTFT is the first non-empty `delta.content` or `delta.reasoning_content`. There are no
retries and each rep is independent. A rerun writes a new directory.

## Output

The default `--out` is `~/.local/state/ledgerpi-bench/concurrency/<UTC ts>/`. An
existing directory is refused. Nothing is written in the repo.

### `results.jsonl`

One row per request, appended after each batch. Fields:

- `mode`, `size` (requested input tokens), `level`, `rep`, `request`: which request this is.
- `outcome`: one of
  - `timeout`: the abort timer fired, before headers or mid-stream. Any TTFT and partial token count are kept.
  - `transport-error`: the request or the body read failed, and not because of the timer.
  - `http-error`: non-2xx status. `detail` holds the first 512 bytes of the body.
  - `stream-error`: 2xx, but the stream carried an error payload, or ended without `[DONE]`, a `finish_reason`, a usage chunk or a first token.
  - `ok`: 2xx with a first token, usage and a clean end.
- `status`, `detail`: HTTP status and failure detail (null for `ok`).
- `ttft_ms`: first token latency from send; kept on partial failures.
- `decode_tps`: `(completion_tokens - 1) / (t_last - t_first)`, only for `ok`; null if the two times are equal.
- `completion_tokens`, `prompt_tokens`: from the usage chunk when present.
- `short_output`: an `ok` request that stopped before `--max-output` tokens. It stays `ok`.
- `sent_ms`, `ended_ms`: timestamps on one clock.

### `summary.json`

One group per (mode, size), with one cell per level plus the group's `knee`. A cell has:

- `n` and `n_ok` (and `n_short_output`): requests and how many were `ok`.
- `error_rate`: share of requests that were not `ok`. `timeout_rate`: share that timed out (also counted in the error rate).
- `ttft_p50_ms`, `ttft_p90_ms`: nearest-rank percentiles over `ok` rows.
- `decode_tps_p50`: median per-request decode tok/s over `ok` rows.
- `total_tps`: sum of `completion_tokens` of `ok` requests over the batch wall clock (first send to last finish, so failed requests stretch it), pooled across reps (total ok tokens over total batch wall time).
- `slowdown`: `decode_tps_p50` at the lowest level divided by that at this level; null if either side has no `ok` request.

`knee` is the first level after the first whose `total_tps` is below 1.10 times the
previous level's, meaning another request stopped buying at least 10% more throughput.
A level with no `ok` requests counts as throughput 0 and can be the knee. `not-reached`
means no level qualified.

## Reading the results

If the endpoint is a router or load balancer in front of several engines, the level at
which throughput stops growing reflects the pool's total capacity and how well load is
spread, not one engine's ceiling. Check the served context length: inputs of 16k and 48k
tokens need a server configured for at least that much.

## Caveats

- The router places by load, not by prompt. In `shared-prefix` mode every batch gets a
  fresh batch nonce, so each batch is cold and its prefix is shared only within the
  batch. Requests of one batch can still land on different engines and miss each
  other's prefix cache, so the mode does not measure a best-case cache hit.
- `ignore_eos` forces full-length output, so decode numbers describe long generations,
  not typical worker replies.
