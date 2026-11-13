const NUM = "(?:0|[1-9]\\d*)";
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const VERSION = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?$`);
const COMPARATOR = /^(>=|<=|>|<|=|\^|~)?(.+)$/;

function parseVersion(text) {
	const match = typeof text === "string" ? VERSION.exec(text) : null;
	if (!match) throw new TypeError(`invalid version: ${JSON.stringify(text)}`);
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		pre: match[4] === undefined ? [] : match[4].split("."),
	};
}

function compareIdentifiers(a, b) {
	const aNumeric = /^\d+$/.test(a);
	const bNumeric = /^\d+$/.test(b);
	if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
	if (aNumeric) return -1;
	if (bNumeric) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

function compare(a, b) {
	for (const key of ["major", "minor", "patch"]) {
		if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
	}
	if (a.pre.length === 0 && b.pre.length === 0) return 0;
	if (a.pre.length === 0) return 1;
	if (b.pre.length === 0) return -1;
	const shared = Math.min(a.pre.length, b.pre.length);
	for (let i = 0; i < shared; i++) {
		const order = compareIdentifiers(a.pre[i], b.pre[i]);
		if (order !== 0) return order;
	}
	return Math.sign(a.pre.length - b.pre.length);
}

function plain(major, minor, patch) {
	return { major, minor, patch, pre: [] };
}

function parseComparator(token) {
	const match = COMPARATOR.exec(token);
	const op = match[1] ?? "=";
	const version = parseVersion(match[2]);
	if (op === "~") {
		return [
			{ op: ">=", version },
			{ op: "<", version: plain(version.major, version.minor + 1, 0) },
		];
	}
	if (op === "^") {
		const upper =
			version.major > 0
				? plain(version.major + 1, 0, 0)
				: version.minor > 0
					? plain(0, version.minor + 1, 0)
					: plain(0, 0, version.patch + 1);
		return [
			{ op: ">=", version },
			{ op: "<", version: upper },
		];
	}
	return [{ op, version }];
}

function parseRange(range) {
	if (typeof range !== "string") throw new TypeError("range must be a string");
	return range.split("||").map((part) => {
		const tokens = part.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) throw new TypeError(`empty set in range ${JSON.stringify(range)}`);
		return tokens.flatMap(parseComparator);
	});
}

function holds(version, { op, version: bound }) {
	const order = compare(version, bound);
	switch (op) {
		case "=":
			return order === 0;
		case ">":
			return order > 0;
		case ">=":
			return order >= 0;
		case "<":
			return order < 0;
		default:
			return order <= 0;
	}
}

function sameTriple(a, b) {
	return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

export function satisfies(version, range) {
	const parsed = parseVersion(version);
	const sets = parseRange(range);
	return sets.some(
		(set) =>
			set.every((comparator) => holds(parsed, comparator)) &&
			(parsed.pre.length === 0 || set.some((c) => c.version.pre.length > 0 && sameTriple(c.version, parsed))),
	);
}
