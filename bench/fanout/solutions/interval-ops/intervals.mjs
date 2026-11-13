function normalizeInterval(interval) {
	if (typeof interval !== "object" || interval === null) throw new TypeError("interval must be an object");
	const { lo, hi, loOpen = false, hiOpen = false } = interval;
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new TypeError("lo and hi must be finite numbers");
	if (typeof loOpen !== "boolean" || typeof hiOpen !== "boolean")
		throw new TypeError("loOpen and hiOpen must be booleans");
	return { lo, hi, loOpen, hiOpen };
}

function isEmpty(interval) {
	return interval.lo > interval.hi || (interval.lo === interval.hi && (interval.loOpen || interval.hiOpen));
}

function normalizeList(intervals) {
	if (!Array.isArray(intervals)) throw new TypeError("intervals must be an array");
	return intervals.map(normalizeInterval);
}

function compareStart(a, b) {
	if (a.lo !== b.lo) return a.lo - b.lo;
	return Number(a.loOpen) - Number(b.loOpen);
}

function joins(a, b) {
	return b.lo < a.hi || (b.lo === a.hi && !(a.hiOpen && b.loOpen));
}

function mergeNormalized(intervals) {
	const sorted = intervals.filter((interval) => !isEmpty(interval)).sort(compareStart);
	const out = [];
	for (const interval of sorted) {
		const last = out[out.length - 1];
		if (last && joins(last, interval)) {
			if (interval.hi > last.hi) {
				last.hi = interval.hi;
				last.hiOpen = interval.hiOpen;
			} else if (interval.hi === last.hi) {
				last.hiOpen = last.hiOpen && interval.hiOpen;
			}
		} else {
			out.push({ ...interval });
		}
	}
	return out;
}

function intersect(a, b) {
	const startsWithA = a.lo > b.lo || (a.lo === b.lo && a.loOpen);
	const endsWithA = a.hi < b.hi || (a.hi === b.hi && a.hiOpen);
	const lo = startsWithA ? a : b;
	const hi = endsWithA ? a : b;
	const result = {
		lo: lo.lo,
		loOpen: a.lo === b.lo ? a.loOpen || b.loOpen : lo.loOpen,
		hi: hi.hi,
		hiOpen: a.hi === b.hi ? a.hiOpen || b.hiOpen : hi.hiOpen,
	};
	return isEmpty(result) ? null : result;
}

export function merge(intervals) {
	return mergeNormalized(normalizeList(intervals));
}

export function insert(intervals, interval) {
	return mergeNormalized([...normalizeList(intervals), normalizeInterval(interval)]);
}

export function subtract(intervals, hole) {
	const normalized = mergeNormalized(normalizeList(intervals));
	const cut = normalizeInterval(hole);
	if (isEmpty(cut)) return normalized;
	const below = { lo: -Infinity, loOpen: true, hi: cut.lo, hiOpen: !cut.loOpen };
	const above = { lo: cut.hi, loOpen: !cut.hiOpen, hi: Infinity, hiOpen: true };
	return normalized.flatMap((interval) => [intersect(interval, below), intersect(interval, above)].filter(Boolean));
}
