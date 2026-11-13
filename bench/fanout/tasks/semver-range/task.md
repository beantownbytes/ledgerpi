`semver.mjs` exports a stub `satisfies(version, range)`. Implement it so it returns `true` when the version satisfies the range and `false` otherwise.

Versions
- A version is `MAJOR.MINOR.PATCH` with an optional prerelease suffix: `1.2.3` or `1.2.3-beta.2`.
- The three numbers are non-negative integers without leading zeros.
- The prerelease is one or more dot-separated identifiers after a single `-`. Each identifier is non-empty and made of `[0-9A-Za-z-]`. A purely numeric identifier has no leading zeros.
- Build metadata (`+build`), a leading `v`, missing parts (`1.2`), wildcards (`1.x`) and surrounding whitespace are not accepted anywhere, in the version or in the range.

Ordering
- Versions are ordered by major, then minor, then patch.
- A version with a prerelease is lower than the same major.minor.patch without one.
- Two prereleases compare identifier by identifier from the left. Numeric identifiers compare as numbers. Alphanumeric identifiers compare as plain ASCII strings. A numeric identifier is lower than an alphanumeric one. If all shared identifiers are equal, the one with fewer identifiers is lower.

Ranges
- A range is one or more sets separated by `||`. The version satisfies the range if it satisfies at least one set.
- A set is one or more comparators separated by whitespace. The version satisfies the set if it satisfies every comparator in it.
- Whitespace around `||` and around the whole range is ignored. Any amount of whitespace may separate comparators.
- A comparator is an optional operator written directly against a full version, with no space between them (`>=1.2.3`, not `>= 1.2.3`). The operators are `=`, `>`, `>=`, `<`, `<=`, `^` and `~`. A bare version means `=`.
- `~1.2.3` means at least 1.2.3 and below 1.3.0.
- `^` allows changes that keep the left-most non-zero part fixed. `^1.2.3` means at least 1.2.3 and below 2.0.0. `^0.2.3` means at least 0.2.3 and below 0.3.0. `^0.0.3` means at least 0.0.3 and below 0.0.4.
- When `^` or `~` is given a prerelease (`^1.2.3-beta.2`), the lower bound is that exact prerelease version. The upper bound is always the plain version named above.

Prereleases
- A version that has a prerelease satisfies a set only if, in addition to satisfying every comparator, at least one comparator in that set (after `^` and `~` have been expanded to their bounds) names a version that has a prerelease and the same major, minor and patch as the version being tested.
- So `1.2.4-beta.1` does not satisfy `^1.2.3` or `>=1.2.3-alpha`, but `1.2.3-beta.1` satisfies `>=1.2.3-alpha`.
- Versions without a prerelease are not affected by this rule.

Errors
- `satisfies` throws a `TypeError` if the version is not a valid version, or if the range is invalid: an empty range, an empty set (as in `1.0.0 ||` or `||`), or any comparator that is not an optional operator followed by a valid full version.
