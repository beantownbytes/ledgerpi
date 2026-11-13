#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIVE_AGENT_DIR="${AB_LIVE_AGENT_DIR:-$HOME/.pi/agent}"
ROOT="${AB_ROOT:-$HOME/.local/state/ledgerpi-ab/worker-thinking}"
MODEL="claude-opus-5-5"

usage() {
	echo "usage: score.sh [--dry-run]" >&2
	echo "Env: AB_ROOT, AB_LIVE_AGENT_DIR." >&2
	exit 2
}

DRY_RUN=0
while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run)
		DRY_RUN=1
		shift
		;;
	*) usage ;;
	esac
done

for bin in jq claude shuf; do
	command -v "$bin" >/dev/null || {
		echo "score.sh: missing $bin" >&2
		exit 1
	}
done

if ! compgen -G "$ROOT/runs/*/result.json" >/dev/null; then
	echo "score.sh: no result.json under $ROOT/runs" >&2
	exit 2
fi

for result in "$ROOT"/runs/*/result.json; do
	[ -e "$result" ] || continue
	jq -e . "$result" >/dev/null 2>&1 || {
		echo "score.sh: $result is not valid JSON" >&2
		exit 2
	}
done

scores="$ROOT/scores.json"
if [ -f "$scores" ] && ! jq -e 'type == "object"' "$scores" >/dev/null 2>&1; then
	echo "score.sh: $scores is not a JSON object" >&2
	exit 2
fi
if [ "$DRY_RUN" = 0 ] && [ ! -f "$scores" ]; then
	echo '{}' >"$scores"
fi
scored_source="$scores"
[ -f "$scores" ] || scored_source=/dev/null

record() {
	local run_id="$1" payload="$2" tmp
	tmp="$(mktemp "$scores.XXXXXX")"
	jq --arg id "$run_id" --argjson s "$payload" '.[$id] = $s' "$scores" >"$tmp" || {
		rm -f "$tmp"
		return 1
	}
	mv "$tmp" "$scores"
}

blind_dir=""
trap '[ -z "$blind_dir" ] || rm -rf "$blind_dir"' EXIT

mapfile -t pending < <(
	for result in "$ROOT"/runs/*/result.json; do
		[ -e "$result" ] || continue
		jq -r --slurpfile scored "$scored_source" 'select(((.class // "") as $c | ["harness-failed", "aborted", "unverified"] | index($c) | not) and (($scored[0][.runId] | if type == "object" then .score else null end) | type) != "number") | "\(.runId) \(.task) \(.attempts)"' "$result"
	done | shuf
)

for entry in "${pending[@]}"; do
	read -r run_id task attempts <<<"$entry"
	attempt_dir="$ROOT/runs/$run_id/attempt-$attempts"
	if [ "$DRY_RUN" = 1 ]; then
		echo "$run_id"
		continue
	fi
	case "$attempts" in
	'' | *[!0-9]*)
		echo "score.sh: $run_id has no usable attempt number" >&2
		exit 1
		;;
	esac
	if [ ! -d "$attempt_dir/repo" ]; then
		echo "score.sh: $run_id has no attempt-$attempts/repo directory" >&2
		exit 1
	fi
	if [ ! -s "$attempt_dir/diff.patch" ]; then
		record "$run_id" '{"score": 0, "blockers": 0, "shouldFix": 0, "summary": "empty diff, not reviewed"}'
		echo "empty  $run_id"
		continue
	fi
	ledger_dir="$(jq -r --arg id "$task" '.tasks[] | select(.id == $id) | .ledgerDir // empty' "$HERE/tasks.json")"
	if [ -z "$ledger_dir" ] || [ ! -f "$LIVE_AGENT_DIR/ledgerpi/$ledger_dir/task.md" ]; then
		echo "score.sh: $run_id: no stored task.md for task $task" >&2
		exit 1
	fi
	blind_dir="$(mktemp -d "${TMPDIR:-/tmp}/ab-blind.XXXXXX")"
	tree="$blind_dir/tree"
	cp -a "$attempt_dir/repo" "$tree"
	rm -rf "$tree/.git"
	find "$tree" -type d -name node_modules -prune -exec rm -rf {} +
	cp "$LIVE_AGENT_DIR/ledgerpi/$ledger_dir/task.md" "$tree/.review-task.md"
	cp "$attempt_dir/diff.patch" "$tree/.review-diff.patch"
	output="$blind_dir/review.json"
	if ! (
		cd "$tree"
		claude -p --model "$MODEL" --output-format json --safe-mode --restricted --strict-mcp-config \
			--tools Read,Glob,Grep --allowedTools Read,Glob,Grep --permission-mode dontAsk \
			--no-session-persistence --system-prompt "$(cat "$HERE/rubric.md")" \
			--json-schema "$(cat "$HERE/score.schema.json")" \
			'Review the change described in .review-task.md and shown in .review-diff.patch. The tree in this directory is the result of applying it.' \
			</dev/null >"$output"
	); then
		echo "score.sh: the review of $run_id failed" >&2
		cat "$output" >&2 2>/dev/null || true
		exit 1
	fi
	payload="$(jq -ce '.structured_output | select((.score | type) == "number") | {score, blockers, shouldFix, summary}' "$output")" || {
		echo "score.sh: no structured score for $run_id; review output follows" >&2
		cat "$output" >&2
		exit 1
	}
	record "$run_id" "$payload"
	rm -rf "$blind_dir"
	blind_dir=""
	echo "scored $run_id"
done
