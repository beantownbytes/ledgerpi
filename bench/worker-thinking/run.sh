#!/usr/bin/env bash
set -euo pipefail
shopt -s inherit_errexit

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARMS_FILE="${AB_ARMS_FILE:-$HERE/arms.json}"
TASKS_FILE="${AB_TASKS_FILE:-$HERE/tasks.json}"
LIVE_AGENT_DIR="${AB_LIVE_AGENT_DIR:-$HOME/.pi/agent}"
CODE_DIR="${AB_CODE_DIR:-$HOME/code}"
INSTALL_DIR="${AB_INSTALL_DIR:-$(cd "$HERE/../.." && pwd)}"
read -r -a EXTRA_AGENT_ENTRIES <<<"${AB_EXTRA_AGENT_ENTRIES:-}"
ROOT="${AB_ROOT:-$HOME/.local/state/ledgerpi-ab/worker-thinking}"
RUN_TIMEOUT="${AB_RUN_TIMEOUT:-4h}"
CEREBRAS_TOKEN_LIMIT="${AB_CEREBRAS_TOKEN_LIMIT:-23000000}"
MAX_HARNESS_FAILURES="${AB_MAX_HARNESS_FAILURES:-3}"
CONCURRENCY="${AB_CONCURRENCY:-1}"

usage() {
	cat >&2 <<EOF
usage: run.sh --stage 1|2 [--arms a,b] [--tasks x,y] [--reps N] [--seed N] [--dry-run]
       run.sh --preflight [--tasks x,y]

  --stage      1: stage 1 arms, incident tasks, 1 rep. 2: stage 2 arms, all tasks, 2 reps.
  --arms       Override the stage's arms (comma-separated ids from arms.json).
  --tasks      Override the stage's tasks (comma-separated ids from tasks.json).
  --reps       Override the rep count.
  --seed       Shuffle seed (default 26).
  --dry-run    Print the run order and exit without launching anything.
  --preflight  Clone each task at its base and run its gates. No pi launch.

Env: AB_ROOT, AB_RUN_TIMEOUT, AB_CEREBRAS_TOKEN_LIMIT, AB_MAX_HARNESS_FAILURES, AB_CONCURRENCY,
AB_CODE_DIR, AB_LIVE_AGENT_DIR, AB_ARMS_FILE, AB_TASKS_FILE, AB_INSTALL_DIR, AB_EXTRA_AGENT_ENTRIES.
AB_EXTRA_AGENT_ENTRIES is a space-separated list of extra entries of the live agent dir to link into
each run's agent dir, for provider setups that keep their config outside the standard files.
AB_INSTALL_DIR is the ledgerpi checkout whose HEAD is recorded in order.log (default: this repo).
AB_CONCURRENCY is the number of runs in flight at once (default 1); above 1 it refuses cerebras arms.
A cerebras arm needs CEREBRAS_API_KEY set by the caller.

Exits 3 at the cerebras token limit and 4 after AB_MAX_HARNESS_FAILURES runs in a row end
harness-failed, counted in completion order. Runs already in flight finish first, and those
that end harness-failed are dropped too. Dropped runs keep no result.json, so rerunning resumes
them. Exits 5 before launching anything while a process from an earlier job still references a
queued run's directory.
EOF
	exit 2
}

STAGE=""
ARMS=""
TASKS=""
REPS=""
SEED=26
DRY_RUN=0
PREFLIGHT=0

while [ $# -gt 0 ]; do
	case "$1" in
	--stage | --arms | --tasks | --reps | --seed)
		[ $# -ge 2 ] || usage
		case "$1" in
		--stage) STAGE="$2" ;;
		--arms) ARMS="$2" ;;
		--tasks) TASKS="$2" ;;
		--reps) REPS="$2" ;;
		--seed) SEED="$2" ;;
		esac
		shift 2
		;;
	--dry-run)
		DRY_RUN=1
		shift
		;;
	--preflight)
		PREFLIGHT=1
		shift
		;;
	*) usage ;;
	esac
done

if [ "$PREFLIGHT" = 0 ]; then
	case "$STAGE" in 1 | 2) ;; *) usage ;; esac
fi
case "$SEED" in '' | *[!0-9]*) usage ;; esac
case "$REPS" in *[!0-9]*) usage ;; esac
[ "$REPS" != 0 ] || usage
case "$CONCURRENCY" in *[!0-9]*) usage ;; esac
[ "$CONCURRENCY" != 0 ] || usage
case "$CEREBRAS_TOKEN_LIMIT" in '' | *[!0-9]*) usage ;; esac
case "$MAX_HARNESS_FAILURES" in '' | *[!0-9]*) usage ;; esac
[ "$MAX_HARNESS_FAILURES" != 0 ] || usage

for bin in jq git node shuf timeout ps pgrep; do
	command -v "$bin" >/dev/null || {
		echo "run.sh: missing $bin" >&2
		exit 1
	}
done

csv_to_json() { jq -cR 'split(",")' <<<"$1"; }

# Prints the validated selection, one id per line, or exits with usage on an unknown id.
select_ids() {
	local file="$1" key="$2" wanted="$3" default_filter="$4" missing
	if [ -z "$wanted" ]; then
		jq -r ".${key}[] | select($default_filter) | .id" "$file"
		return
	fi
	missing="$(jq -r --argjson want "$(csv_to_json "$wanted")" --arg key "$key" '($want - [.[$key][].id]) | join(",")' "$file")"
	if [ -n "$missing" ]; then
		echo "run.sh: unknown id: $missing" >&2
		usage
	fi
	tr ',' '\n' <<<"$wanted"
}

task_field() { jq -r --arg id "$1" --arg f "$2" '.tasks[] | select(.id == $id) | .[$f] // empty' "$TASKS_FILE"; }
arm_field() { jq -r --arg id "$1" --arg f "$2" '.arms[] | select(.id == $id) | .[$f]' "$ARMS_FILE"; }

# Clones a task's repo at its base, with pushes disabled, into the given directory. Returns
# nonzero on any failed step: callers run it in a condition, where errexit does not apply.
clone_task() {
	local task="$1" dest="$2" source branch base setup
	source="$CODE_DIR/$(task_field "$task" repo)"
	branch="$(task_field "$task" branch)"
	base="$(task_field "$task" base)"
	setup="$(task_field "$task" setup)"
	git clone --quiet --shared "$source" "$dest" || return 1
	git -C "$dest" remote set-url --push origin no-push-from-bench || return 1
	git -C "$dest" switch --quiet -c "$branch" "$base" || return 1
	if [ -n "$setup" ]; then
		(cd "$dest" && bash -c "$setup") >"$dest.setup.log" 2>&1 || return 1
	fi
}

rewrite_paths() {
	local text="$1" from="$2" to="$3"
	printf '%s' "${text//"$from"/"$to"}"
}

task_gate() { rewrite_paths "$(task_field "$1" gate)" "$(task_field "$1" originalCwd)" "$2"; }

# The gate the harness reruns itself: a task's wider finalGate, else the loop's gate.
task_final_gate() {
	local final
	final="$(task_field "$1" finalGate)"
	if [ -n "$final" ]; then
		rewrite_paths "$final" "$(task_field "$1" originalCwd)" "$2"
	else
		task_gate "$1" "$2"
	fi
}

if [ "$PREFLIGHT" = 1 ]; then
	task_list="$(select_ids "$TASKS_FILE" tasks "$TASKS" 'true')"
	mapfile -t task_ids <<<"$task_list"
	gate_timeout_s=$(($(jq -r .gateTimeoutMs "$ARMS_FILE") / 1000))
	work="$(mktemp -d "${TMPDIR:-/tmp}/ledgerpi-ab-preflight.XXXXXX")"
	trap 'rm -rf "$work"' EXIT
	status=0
	for task in "${task_ids[@]}"; do
		repo="$work/$task"
		if ! clone_task "$task" "$repo"; then
			echo "FAIL  $task  clone or setup"
			status=1
			continue
		fi
		for gate in "$(task_gate "$task" "$repo")" "$(task_final_gate "$task" "$repo")"; do
			if (cd "$repo" && timeout "$gate_timeout_s" sh -c "$gate") >"$repo.gate.log" 2>&1; then
				echo "PASS  $task  ${gate:0:60}"
			else
				echo "FAIL  $task  ${gate:0:60}"
				tail -n 8 "$repo.gate.log"
				status=1
			fi
		done
	done
	exit "$status"
fi

if [ "$STAGE" = 1 ]; then
	task_filter='.kind == "incident"'
	[ -n "$REPS" ] || REPS=1
else
	task_filter='true'
	[ -n "$REPS" ] || REPS=2
fi
# Assigned first: an unknown id must exit here, which a process substitution would hide.
arm_list="$(select_ids "$ARMS_FILE" arms "$ARMS" ".stage == $STAGE")"
task_list="$(select_ids "$TASKS_FILE" tasks "$TASKS" "$task_filter")"
mapfile -t arm_ids <<<"$arm_list"
mapfile -t task_ids <<<"$task_list"

manager_ref="$(jq -r '.manager // empty' "$ARMS_FILE")"
if [[ ! "$manager_ref" =~ ^[^/]+/.+$ ]]; then
	echo "run.sh: $ARMS_FILE must set manager to provider/modelId" >&2
	usage
fi

for extra in ${EXTRA_AGENT_ENTRIES[@]+"${EXTRA_AGENT_ENTRIES[@]}"}; do
	case "$extra" in
	. | .. | */* | models.json | settings.json | sessions)
		echo "run.sh: AB_EXTRA_AGENT_ENTRIES cannot name '$extra'; it must be a plain entry that run.sh does not write" >&2
		usage
		;;
	esac
done

# One shuffled block per rep, so every arm sees every task once in each block and arms
# do not track time of day.
order=()
for ((rep = 1; rep <= REPS; rep++)); do
	block=()
	for arm in "${arm_ids[@]}"; do
		for task in "${task_ids[@]}"; do
			block+=("$arm $task $rep")
		done
	done
	mapfile -t shuffled < <(printf '%s\n' "${block[@]}" | shuf --random-source=<(yes "$SEED-$STAGE-$rep"))
	order+=("${shuffled[@]}")
done

if [ "$CONCURRENCY" -gt 1 ]; then
	for arm in "${arm_ids[@]}"; do
		case "$arm" in
		c-*)
			echo "run.sh: AB_CONCURRENCY=$CONCURRENCY does not support cerebras arm $arm" >&2
			usage
			;;
		esac
	done
fi

if [ "$DRY_RUN" = 1 ]; then
	printf '%s\n' "${order[@]}"
	exit 0
fi

command -v pi >/dev/null || {
	echo "run.sh: missing pi" >&2
	exit 1
}
for arm in "${arm_ids[@]}"; do
	case "$(arm_field "$arm" worker)" in
	cerebras/*)
		if [ -z "${CEREBRAS_API_KEY:-}" ]; then
			echo "run.sh: $arm needs CEREBRAS_API_KEY" >&2
			exit 1
		fi
		;;
	esac
done

unset LEDGERPI LEDGERPI_DEBUG LEDGERPI_STATE_DIR LEDGERPI_AUDIT_LOG LEDGERPI_AUDIT_SOURCE LEDGERPI_CONFIG

# Builds a throwaway agent dir that matches the live one except for the arm's output
# cap. Telemetry files are left out so bench traffic stays out of the live stats, and
# relative package paths are made absolute because the dir sits at a different depth.
ensure_agent_dir() {
	local arm="$1" dir worker provider model cap name
	dir="$ROOT/agents/$arm"
	worker="$(arm_field "$arm" worker)"
	provider="${worker%%/*}"
	model="${worker#*/}"
	cap="$(arm_field "$arm" maxTokens)"
	mkdir -p "$dir"
	for name in agents AGENTS.md auth.json extensions git npm keybindings.json pi-permissions.jsonc \
		prompts skills subagents.json themes trust.json ${EXTRA_AGENT_ENTRIES[@]+"${EXTRA_AGENT_ENTRIES[@]}"}; do
		[ ! -e "$LIVE_AGENT_DIR/$name" ] || ln -sfn "$LIVE_AGENT_DIR/$name" "$dir/$name"
	done
	jq --arg p "$provider" --arg m "$model" --argjson cap "$cap" \
		'(.providers[$p].models[] | select(.id == $m) | .maxTokens) = $cap' \
		"$LIVE_AGENT_DIR/models.json" >"$dir/models.json"
	jq -e --arg p "$provider" --arg m "$model" --argjson cap "$cap" \
		'.providers[$p].models[] | select(.id == $m) | .maxTokens == $cap' "$dir/models.json" >/dev/null || {
		echo "run.sh: $arm cap $cap did not reach $worker in models.json" >&2
		return 1
	}
	jq --arg live "$LIVE_AGENT_DIR" \
		'.packages |= map(if type == "string" and startswith("../") then $live + "/" + . else . end)' \
		"$LIVE_AGENT_DIR/settings.json" >"$dir/settings.json"
	printf '%s\n' "$dir"
}

write_arm_config() {
	local arm="$1" gate="$2" dest="$3" worker manager
	worker="$(arm_field "$arm" worker)"
	manager="$(jq -r .manager "$ARMS_FILE")"
	jq -rn \
		--arg gate "$gate" \
		--arg thinking "$(arm_field "$arm" thinking)" \
		--arg worker "$worker" \
		--arg manager "$manager" \
		--argjson call "$(jq .callTimeoutMs "$ARMS_FILE")" \
		--argjson gateMs "$(jq .gateTimeoutMs "$ARMS_FILE")" '
		($manager | split("/")[0]) as $managerProvider
		| ($manager | split("/")[1:] | join("/")) as $managerModel
		| ($worker | split("/")[0]) as $workerProvider
		| (if $workerProvider == $managerProvider then [$managerProvider] else [$managerProvider, $workerProvider] end) as $providers
		| [
			"enabled = true",
			"providers = \($providers | tojson)",
			"maxIters = 8",
			"callTimeoutMs = \($call)",
			"gateTimeoutMs = \($gateMs)",
			"workerThinking = \($thinking | tojson)",
			"gate = \($gate | tojson)",
			"[allowlist]",
			"\($managerProvider | tojson) = \([$managerModel] | tojson)",
			"[roleModel]",
			"default = { worker = \($worker | tojson) }"
		] | join("\n")' >"$dest"
}

# Runs one attempt and prints its class. A setup, pi, or finalize failure is recorded as
# harness-failed rather than fatal, so one bad run cannot end the queue.
run_attempt() {
	local arm="$1" task="$2" rep="$3" attempt="$4" run_id="$5" agent_dir="$6"
	local dir="$ROOT/runs/$run_id/attempt-$attempt" repo stored_task task_text gate final_gate source rc=0 class pi_pid
	rm -rf "$dir"
	mkdir -p "$dir/state"
	repo="$dir/repo"
	gate="$(task_gate "$task" "$repo")"
	final_gate="$(task_final_gate "$task" "$repo")"

	finalize() {
		node --experimental-strip-types --no-warnings "$HERE/finalize.ts" \
			--dir "$dir" --repo "$repo" --base "$(task_field "$task" base)" --gate "$final_gate" \
			--gate-timeout-ms "$(jq .gateTimeoutMs "$ARMS_FILE")" --sessions "$agent_dir/sessions" \
			--run-id "$run_id" --arm "$arm" --task "$task" --rep "$rep" --attempt "$attempt" "$@"
	}

	if ! clone_task "$task" "$repo" ||
		! stored_task="$(cat "$LIVE_AGENT_DIR/ledgerpi/$(task_field "$task" ledgerDir)/task.md")" ||
		[ -z "$stored_task" ]; then
		finalize --harness-failure "setup failed"
		return
	fi
	task_text="$(rewrite_paths "$stored_task" "$(task_field "$task" originalCwd)" "$repo")"
	printf '%s\n' "$task_text" >"$dir/task.md"
	write_arm_config "$arm" "$gate" "$dir/config.toml"
	source="benchmark-thinking-$arm"

	# exec makes the subshell the timeout process itself, which leads its own process group,
	# so pi.pgid names a group that holds pi and everything it spawned.
	(
		cd "$repo"
		PI_CODING_AGENT_DIR="$agent_dir" \
			LEDGERPI_CONFIG="$dir/config.toml" \
			LEDGERPI_STATE_DIR="$dir/state" \
			LEDGERPI_AUDIT_LOG="$dir/runs.jsonl" \
			LEDGERPI_AUDIT_SOURCE="$source" \
			exec timeout --kill-after=60 "$RUN_TIMEOUT" \
			pi -p --model "$(jq -r .manager "$ARMS_FILE")" "/ledger $task_text" \
			</dev/null >"$dir/pi.out" 2>"$dir/pi.err"
	) &
	pi_pid=$!
	printf '%s\n' "$pi_pid" >"$dir/pi.pgid"
	wait "$pi_pid" || rc=$?
	printf '%s\n' "$rc" >"$dir/pi.exit"

	class="$(finalize || finalize --harness-failure "finalize crashed")"
	if [ "$class" = unverified ]; then
		class="$(finalize --reuse-diff || finalize --harness-failure "finalize crashed")"
	fi
	printf '%s\n' "$class"
}

# Billed cerebras tokens across every attempt, read from per-turn session usage: ledger
# transcripts omit cached input, which cerebras billed at the full input rate. Tolerates
# a truncated line from a killed run.
cerebras_tokens() {
	find "$ROOT/agents" -path "$ROOT/agents/c-*/sessions/*" -name '*.jsonl' -exec cat {} + |
		jq -Rn '[inputs | fromjson? | .message? // empty | select(.provider == "cerebras") | .usage // empty
			| (.input // 0) + (.cacheRead // 0) + (.output // 0)] | add // 0'
}

# Runs one task to a result.json, rerunning once after a harness-failed or aborted attempt.
# Prints nothing: the dispatching loop reads the outcome from result.json. Each attempt runs in
# the background so a TERM from the dispatcher stops it before it can start or retry a finalize.
# A finalize or gate already running is not stopped; the start-up check refuses to rerun over it.
run_one() {
	local arm="$1" task="$2" rep="$3" run_id="$4" attempt class attempt_pid=""
	local run_dir="$ROOT/runs/$run_id"
	trap '[ -z "$attempt_pid" ] || { kill -TERM "$attempt_pid" 2>/dev/null || true; wait "$attempt_pid" 2>/dev/null || true; }; exit 143' TERM
	mkdir -p "$run_dir"
	for attempt in 1 2; do
		run_attempt "$arm" "$task" "$rep" "$attempt" "$run_id" "$ROOT/agents/$arm" >"$run_dir/attempt.class" &
		attempt_pid=$!
		wait "$attempt_pid"
		class="$(cat "$run_dir/attempt.class")"
		case "$class" in
		harness-failed | aborted) ;;
		*) break ;;
		esac
	done
	rm -f "$run_dir/attempt.class"
	cp "$run_dir/attempt-$attempt/attempt.json" "$run_dir/result.json"
}

# An interrupt stops pi but not a finalize or gate already running, which would otherwise write
# into the clone a rerun makes at the same path. Refuse to start while one still references a run.
for entry in "${order[@]}"; do
	read -r arm task rep <<<"$entry"
	run_id="${arm}__${task}__r${rep}"
	[ -f "$ROOT/runs/$run_id/result.json" ] && continue
	if pgrep -f -- "$ROOT/runs/$run_id/" >/dev/null; then
		echo "run.sh: a process from an earlier job still references $ROOT/runs/$run_id; wait for it to exit and rerun" >&2
		exit 5
	fi
done

mkdir -p "$ROOT/runs" "$ROOT/agents"
{
	printf 'stage=%s seed=%s concurrency=%s ledgerpi=%s started=%s\n' "$STAGE" "$SEED" "$CONCURRENCY" \
		"$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || echo unknown)" \
		"$(date -u +%FT%TZ)"
	printf '%s\n' "${order[@]}"
} >>"$ROOT/order.log"

# Every agent dir is built before the first launch, so a bad cap stops the job with nothing run.
for arm in "${arm_ids[@]}"; do
	ensure_agent_dir "$arm" >/dev/null
done

# Dispatch up to CONCURRENCY runs, then reap them in completion order: the parent alone prints
# and keeps the harness-failure streak. Once the streak trips nothing new is dispatched; the
# runs still in flight finish, and any that end harness-failed are dropped like the streak.
declare -A in_flight=()

# True while process group $1 holds a process that is not a zombie: an orphan nobody reaps (PID 1
# of a container) stays in the group but runs nothing.
group_running() {
	ps -eo pgid=,stat= | awk -v group="$1" '$1 == group && $2 !~ /^Z/ { found = 1 } END { exit !found }'
}

# On INT or TERM: stop every in-flight run_one first so none writes a result.json or retries,
# then TERM the process group of each run's latest pi attempt and wait for the groups to end.
# Interrupted runs keep no result.json, so rerunning resumes them.
interrupt() {
	local signal="$1" pid pgid_file pgids=() pgid
	trap '' INT TERM
	for pid in "${!in_flight[@]}"; do
		kill -TERM "$pid" 2>/dev/null || true
	done
	wait || true
	for pid in "${!in_flight[@]}"; do
		pgid_file="$(compgen -G "$ROOT/runs/${in_flight[$pid]}/attempt-*/pi.pgid" | sort | tail -n 1 || true)"
		[ -n "$pgid_file" ] || continue
		pgids+=("$(cat "$pgid_file")")
	done
	for pgid in "${pgids[@]}"; do
		kill -TERM -- "-$pgid" 2>/dev/null || true
	done
	SECONDS=0
	for pgid in "${pgids[@]}"; do
		while group_running "$pgid" && [ "$SECONDS" -lt 90 ]; do
			sleep 0.2
		done
	done
	exit $((128 + signal))
}
trap 'interrupt 2' INT
trap 'interrupt 15' TERM

failed_runs=()
tripped=0
next=0
while true; do
	if [ "$tripped" = 0 ] && [ "$next" -lt "${#order[@]}" ] && [ "${#in_flight[@]}" -lt "$CONCURRENCY" ]; then
		read -r arm task rep <<<"${order[$next]}"
		next=$((next + 1))
		run_id="${arm}__${task}__r${rep}"
		if [ -f "$ROOT/runs/$run_id/result.json" ]; then
			echo "skip  $run_id"
			continue
		fi
		case "$arm" in
		c-*)
			spent="$(cerebras_tokens)"
			if [ "$spent" -ge "$CEREBRAS_TOKEN_LIMIT" ]; then
				echo "run.sh: cerebras token limit reached ($spent >= $CEREBRAS_TOKEN_LIMIT), stopping" >&2
				exit 3
			fi
			;;
		esac
		run_one "$arm" "$task" "$rep" "$run_id" &
		in_flight[$!]="$run_id"
		continue
	fi
	[ "${#in_flight[@]}" -gt 0 ] || break
	finished=""
	wait -n -p finished || true
	run_id="${in_flight[$finished]}"
	unset "in_flight[$finished]"
	run_dir="$ROOT/runs/$run_id"
	if [ -f "$run_dir/result.json" ]; then
		class="$(jq -r .class "$run_dir/result.json")"
		attempts="$(jq -r .attempts "$run_dir/result.json")"
	else
		class=harness-failed
		attempts=unknown
	fi
	echo "done  $run_id  $class  attempts=$attempts"
	if [ "$class" != harness-failed ]; then
		failed_runs=()
		continue
	fi
	failed_runs+=("$run_dir")
	if [ "$tripped" = 1 ]; then
		rm -f "$run_dir/result.json"
	elif [ "${#failed_runs[@]}" -ge "$MAX_HARNESS_FAILURES" ]; then
		for failed in "${failed_runs[@]}"; do
			rm -f "$failed/result.json"
		done
		echo "run.sh: $MAX_HARNESS_FAILURES runs in a row ended harness-failed, stopping" >&2
		tripped=1
	fi
done
[ "$tripped" = 0 ] || exit 4
