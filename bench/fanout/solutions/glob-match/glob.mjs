function classEnd(chars, start) {
	let i = start + 1;
	if (chars[i] === "!") i++;
	let first = true;
	while (i < chars.length) {
		if (chars[i] === "]" && !first) return i;
		i += chars[i] === "\\" && i + 1 < chars.length ? 2 : 1;
		first = false;
	}
	return -1;
}

function braceGroup(chars, start) {
	const commas = [];
	let depth = 0;
	for (let i = start; i < chars.length; i++) {
		const c = chars[i];
		if (c === "\\") {
			i++;
		} else if (c === "[") {
			const end = classEnd(chars, i);
			if (end >= 0) i = end;
		} else if (c === "{") {
			depth++;
		} else if (c === "}") {
			depth--;
			if (depth === 0) return commas.length > 0 ? { end: i, commas } : null;
		} else if (c === "," && depth === 1) {
			commas.push(i);
		}
	}
	return null;
}

function expand(chars) {
	for (let i = 0; i < chars.length; i++) {
		const c = chars[i];
		if (c === "\\") {
			i++;
		} else if (c === "[") {
			const end = classEnd(chars, i);
			if (end >= 0) i = end;
		} else if (c === "{") {
			const group = braceGroup(chars, i);
			if (!group) continue;
			const bounds = [i, ...group.commas, group.end];
			const prefix = chars.slice(0, i);
			const suffix = chars.slice(group.end + 1);
			const results = [];
			for (let k = 0; k + 1 < bounds.length; k++) {
				const alternative = chars.slice(bounds[k] + 1, bounds[k + 1]);
				results.push(...expand([...prefix, ...alternative, ...suffix]));
			}
			return results;
		}
	}
	return [chars];
}

const escapeRegex = (c) => c.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
const escapeInClass = (c) => (c === "-" ? "\\-" : escapeRegex(c));

function classRegex(chars, start, end) {
	let i = start + 1;
	const negate = chars[i] === "!";
	if (negate) i++;
	const members = [];
	const read = () => {
		if (chars[i] === "\\" && i + 1 < end) i++;
		return chars[i++];
	};
	while (i < end) {
		const lo = read();
		if (chars[i] === "-" && i + 1 < end) {
			i++;
			const hi = read();
			if (lo.codePointAt(0) <= hi.codePointAt(0)) members.push(`${escapeInClass(lo)}-${escapeInClass(hi)}`);
		} else {
			members.push(escapeInClass(lo));
		}
	}
	return `(?!/)[${negate ? "^/" : ""}${members.join("")}]`;
}

function toRegex(chars) {
	const out = [];
	let segmentStart = true;
	for (let i = 0; i < chars.length; ) {
		const c = chars[i];
		if (c === "\\" && i + 1 < chars.length) {
			const literal = chars[i + 1];
			out.push(escapeRegex(literal));
			segmentStart = literal === "/";
			i += 2;
		} else if (c === "[" && classEnd(chars, i) >= 0) {
			const end = classEnd(chars, i);
			out.push(classRegex(chars, i, end));
			segmentStart = false;
			i = end + 1;
		} else if (c === "*") {
			let n = 0;
			while (chars[i + n] === "*") n++;
			const rest = chars.slice(i + n, i + n + 2).join("");
			const separator = rest.startsWith("\\/") ? 2 : rest.startsWith("/") ? 1 : 0;
			const wholeSegment = n === 2 && segmentStart && (separator > 0 || rest === "");
			if (wholeSegment) {
				if (separator > 0) {
					out.push("(?:[^/]*/)*");
					i += 2 + separator;
					segmentStart = true;
				} else {
					if (out[out.length - 1] === "\\/") {
						out.pop();
						out.push("(?:/[^/]*)*");
					} else {
						out.push("[^/]*(?:/[^/]*)*");
					}
					i += 2;
				}
			} else {
				out.push("[^/]*");
				i += n;
				segmentStart = false;
			}
		} else if (c === "?") {
			out.push("[^/]");
			segmentStart = false;
			i++;
		} else {
			out.push(escapeRegex(c));
			segmentStart = c === "/";
			i++;
		}
	}
	return new RegExp(`^${out.join("")}$`, "u");
}

export function globMatch(pattern, path) {
	if (typeof pattern !== "string" || typeof path !== "string") throw new TypeError("pattern and path must be strings");
	return expand(Array.from(pattern)).some((chars) => toRegex(chars).test(path));
}
