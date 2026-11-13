#!/usr/bin/env bash
# Bump the patch version in VERSION, package.json, package-lock.json and the Claude
# plugin manifest, and print the new version. Run from anywhere; edits the repo root.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
current="$(tr -d '[:space:]' <"$root/VERSION")"

if ! [[ "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
	echo "bump-version: VERSION is not MAJOR.MINOR.PATCH: '$current'" >&2
	exit 2
fi
next="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))"

# Replace only the first N `"version": "<current>"` lines; later matches in the
# lockfile belong to dependencies that happen to share the number.
replace_first() {
	local file="$1" count="$2"
	CURRENT="$current" NEXT="$next" COUNT="$count" perl -0pi -e '
		my $n = 0;
		s/("version":\s*")\Q$ENV{CURRENT}\E(")/$n++ < $ENV{COUNT} ? "$1$ENV{NEXT}$2" : $&/ge;
		die "expected $ENV{COUNT} version entries, found $n\n" if $n < $ENV{COUNT};
	' "$file"
}

replace_first "$root/package.json" 1
replace_first "$root/packages/claude/.claude-plugin/plugin.json" 1
replace_first "$root/package-lock.json" 2
printf '%s\n' "$next" >"$root/VERSION"
printf '%s\n' "$next"
