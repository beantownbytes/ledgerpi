import assert from "node:assert/strict";
import { insert, merge, subtract } from "./intervals.mjs";

let failed = 0;
function check(name, fn) {
	try {
		fn();
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}: ${error.message}`);
	}
}

const INTERVAL = /([[(])\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*([\])])/g;

/** Parses "[1,2) (3,4]" into interval objects. */
function list(text) {
	return [...text.matchAll(INTERVAL)].map((m) => ({
		lo: Number(m[2]),
		hi: Number(m[3]),
		loOpen: m[1] === "(",
		hiOpen: m[4] === ")",
	}));
}

/** Renders intervals as "[1,2) (3,4]", insisting on explicit boolean flags. */
function show(intervals) {
	assert.ok(Array.isArray(intervals), "result must be an array");
	return intervals
		.map((i) => {
			assert.equal(typeof i.loOpen, "boolean", "loOpen must be a boolean");
			assert.equal(typeof i.hiOpen, "boolean", "hiOpen must be a boolean");
			return `${i.loOpen ? "(" : "["}${i.lo},${i.hi}${i.hiOpen ? ")" : "]"}`;
		})
		.join(" ");
}

const merged = (input, expected) => assert.equal(show(merge(list(input))), expected, `merge ${input}`);
const inserted = (input, add, expected) =>
	assert.equal(show(insert(list(input), list(add)[0])), expected, `insert ${add} into ${input}`);
const subtracted = (input, hole, expected) =>
	assert.equal(show(subtract(list(input), list(hole)[0])), expected, `subtract ${hole} from ${input}`);

check("merge of nothing", () => {
	assert.deepStrictEqual(merge([]), []);
});

check("merge keeps disjoint intervals sorted", () => {
	merged("[5,6] [1,2] [3,4]", "[1,2] [3,4] [5,6]");
	merged("[1,2]", "[1,2]");
});

check("merge joins overlapping intervals", () => {
	merged("[1,5] [3,8]", "[1,8]");
	merged("[1,10] [3,4]", "[1,10]");
	merged("[6,9] [1,3] [2,7]", "[1,9]");
	merged("[1,2] [5,6] [2,5]", "[1,6]");
});

check("closed endpoints that touch join", () => {
	merged("[1,2] [2,3]", "[1,3]");
	merged("[2,3] [1,2]", "[1,3]");
});

check("a closed end touching an open start joins", () => {
	merged("[1,2] (2,3]", "[1,3]");
	merged("[1,2) [2,3]", "[1,3]");
	merged("(2,3] [1,2]", "[1,3]");
});

check("two open ends at the same point stay apart", () => {
	merged("[1,2) (2,3]", "[1,2) (2,3]");
	merged("(2,3] [1,2)", "[1,2) (2,3]");
	merged("(0,1) (1,2)", "(0,1) (1,2)");
});

check("merge picks the correct openness for the combined ends", () => {
	merged("[1,5) [1,5]", "[1,5]");
	merged("[1,5] [1,5)", "[1,5]");
	merged("(1,5) [1,5)", "[1,5)");
	merged("(1,5) (1,5)", "(1,5)");
	merged("(1,5) (1,3]", "(1,5)");
	merged("[1,3) [2,3]", "[1,3]");
	merged("[1,4) [2,4)", "[1,4)");
	merged("[1,5] (2,5)", "[1,5]");
	merged("(0,5) [0,3]", "[0,5)");
});

check("a point interval", () => {
	merged("[2,2]", "[2,2]");
	merged("[2,2] [2,5]", "[2,5]");
	merged("[1,2) [2,2]", "[1,2]");
	merged("[2,2] (2,5]", "[2,5]");
	merged("[1,2) [2,2] (2,5]", "[1,5]");
	merged("[2,2] [3,3]", "[2,2] [3,3]");
});

check("empty intervals are dropped", () => {
	merged("(2,2) [3,3]", "[3,3]");
	assert.deepStrictEqual(merge([{ lo: 2, hi: 2, loOpen: true }]), []);
	assert.deepStrictEqual(merge([{ lo: 2, hi: 2, hiOpen: true }]), []);
	assert.deepStrictEqual(merge([{ lo: 5, hi: 1 }]), []);
	merged("[1,2] [4,3] [2,3]", "[1,3]");
});

check("an empty interval does not bridge a gap", () => {
	assert.equal(
		show(
			merge([
				{ lo: 1, hi: 2 },
				{ lo: 2, hi: 2, loOpen: true },
				{ lo: 3, hi: 4 },
			]),
		),
		"[1,2] [3,4]",
	);
});

check("negative and fractional endpoints", () => {
	merged("[-3,-1] [-2,0.5] [0.5,0.75)", "[-3,0.75)");
	merged("[-1.5,-0.5) (-0.5,0]", "[-1.5,-0.5) (-0.5,0]");
});

check("optional flags default to closed and results carry explicit booleans", () => {
	assert.deepStrictEqual(merge([{ lo: 1, hi: 2 }]), [{ lo: 1, hi: 2, loOpen: false, hiOpen: false }]);
	assert.deepStrictEqual(
		merge([
			{ lo: 1, hi: 2, hiOpen: true },
			{ lo: 2, hi: 3, loOpen: true, hiOpen: true },
		]),
		[
			{ lo: 1, hi: 2, loOpen: false, hiOpen: true },
			{ lo: 2, hi: 3, loOpen: true, hiOpen: true },
		],
	);
});

check("inputs are not modified and not shared", () => {
	const a = { lo: 1, hi: 3 };
	const b = { lo: 2, hi: 5, hiOpen: true };
	const input = [b, a];
	const out = merge(input);
	assert.deepStrictEqual(input, [b, a]);
	assert.deepStrictEqual(a, { lo: 1, hi: 3 });
	assert.deepStrictEqual(b, { lo: 2, hi: 5, hiOpen: true });
	assert.notStrictEqual(out[0], a);
	assert.notStrictEqual(out[0], b);
	const single = merge([a]);
	assert.notStrictEqual(single[0], a);
	single[0].hi = 99;
	assert.equal(a.hi, 3);
	const added = insert([a], { lo: 10, hi: 11 });
	assert.notStrictEqual(added[0], a);
	assert.equal(show(subtract([a], { lo: 7, hi: 8 })), "[1,3]");
	assert.notStrictEqual(subtract([a], { lo: 7, hi: 8 })[0], a);
});

check("insert into the middle, start and end", () => {
	inserted("[1,2] [5,6]", "[3,4]", "[1,2] [3,4] [5,6]");
	inserted("[5,6]", "[1,2]", "[1,2] [5,6]");
	inserted("[1,2]", "[5,6]", "[1,2] [5,6]");
	inserted("", "[1,2]", "[1,2]");
});

check("insert that bridges several intervals", () => {
	inserted("[1,2] [4,5] [7,8]", "[2,7]", "[1,8]");
	inserted("[1,2] [4,5] [7,8]", "(2,7)", "[1,8]");
	inserted("[1,2) [4,5] (7,8]", "[2,7]", "[1,8]");
	inserted("[1,2) (7,8]", "(2,7)", "[1,2) (2,7) (7,8]");
});

check("insert touching and swallowing", () => {
	inserted("[1,2]", "(2,3)", "[1,3)");
	inserted("[1,2)", "(2,3)", "[1,2) (2,3)");
	inserted("[1,10]", "[3,4]", "[1,10]");
	inserted("[3,4]", "[1,10]", "[1,10]");
	inserted("[1,2]", "[1,2]", "[1,2]");
});

check("insert normalizes an unsorted overlapping list", () => {
	inserted("[8,9] [1,3] [2,4]", "[20,21]", "[1,4] [8,9] [20,21]");
	inserted("[5,6] [5,7]", "[0,0]", "[0,0] [5,7]");
});

check("insert of an empty interval only normalizes", () => {
	inserted("[3,4] [1,2]", "(5,5)", "[1,2] [3,4]");
	inserted("[1,2] [2,3]", "[9,1]", "[1,3]");
});

check("subtract from the middle", () => {
	subtracted("[0,10]", "[2,4]", "[0,2) (4,10]");
	subtracted("[0,10]", "(2,4)", "[0,2] [4,10]");
	subtracted("[0,10]", "[2,4)", "[0,2) [4,10]");
	subtracted("[0,10]", "(2,4]", "[0,2] (4,10]");
	subtracted("(0,10)", "[2,4]", "(0,2) (4,10)");
});

check("subtract at the edges", () => {
	subtracted("[0,10]", "[0,3]", "(3,10]");
	subtracted("[0,10]", "[0,3)", "[3,10]");
	subtracted("[0,10]", "(0,3]", "[0,0] (3,10]");
	subtracted("[0,10]", "[7,10]", "[0,7)");
	subtracted("[0,10]", "(7,10]", "[0,7]");
	subtracted("[0,10]", "[7,10)", "[0,7) [10,10]");
	subtracted("[0,10)", "[7,10)", "[0,7)");
});

check("subtract can leave single points", () => {
	subtracted("[1,3]", "(1,3)", "[1,1] [3,3]");
	subtracted("[1,3]", "(1,2)", "[1,1] [2,3]");
	subtracted("[0,10]", "(0,10)", "[0,0] [10,10]");
});

check("subtract everything", () => {
	subtracted("[1,3]", "[1,3]", "");
	subtracted("(1,3)", "[1,3]", "");
	subtracted("[1,3]", "[0,4]", "");
	subtracted("(1,3)", "(1,3)", "");
	subtracted("[1,3] [5,6]", "[0,10]", "");
});

check("subtract nothing", () => {
	subtracted("[1,3]", "[4,5]", "[1,3]");
	subtracted("[1,3]", "(3,5]", "[1,3]");
	subtracted("[1,3)", "[3,5]", "[1,3)");
	subtracted("[1,3]", "[-5,0]", "[1,3]");
	subtracted("(1,3]", "[-5,1]", "(1,3]");
	subtracted("[1,3]", "[3,3]", "[1,3)");
	subtracted("[1,3]", "(2,2)", "[1,3]");
});

check("subtract across several intervals", () => {
	subtracted("[0,2] [4,6] [8,10]", "[1,9]", "[0,1) (9,10]");
	subtracted("[0,2] [4,6] [8,10]", "(2,8)", "[0,2] [8,10]");
	subtracted("[0,2] [4,6] [8,10]", "(2,3)", "[0,2] [4,6] [8,10]");
	subtracted("[0,2] [4,6] [8,10]", "[2,8]", "[0,2) (8,10]");
	subtracted("[0,2] [4,6] [8,10]", "[5,5]", "[0,2] [4,5) (5,6] [8,10]");
});

check("subtract normalizes the input first", () => {
	subtracted("[8,10] [0,5] [3,9]", "[4,6]", "[0,4) (6,10]");
	subtracted("[0,5) [5,10]", "[5,5]", "[0,5) (5,10]");
});

check("subtract an empty hole only normalizes", () => {
	subtracted("[3,4] [1,3]", "(2,2)", "[1,4]");
	assert.equal(show(subtract(list("[1,3]"), { lo: 9, hi: 2 })), "[1,3]");
});

check("subtract from an empty list", () => {
	assert.deepStrictEqual(subtract([], { lo: 0, hi: 1 }), []);
});

check("invalid arguments throw TypeError", () => {
	const bad = [
		() => merge(),
		() => merge("[1,2]"),
		() => merge([null]),
		() => merge([5]),
		() => merge([{ lo: "1", hi: 2 }]),
		() => merge([{ lo: 1 }]),
		() => merge([{ lo: NaN, hi: 2 }]),
		() => merge([{ lo: 1, hi: Infinity }]),
		() => merge([{ lo: 1, hi: 2, loOpen: 1 }]),
		() => merge([{ lo: 1, hi: 2, hiOpen: "yes" }]),
		() => merge([{ lo: 3, hi: 1, hiOpen: null }]),
		() => insert([{ lo: 1, hi: 2 }], undefined),
		() => insert([{ lo: 1, hi: 2 }], { lo: 1, hi: "x" }),
		() => insert({}, { lo: 1, hi: 2 }),
		() => subtract([{ lo: 1, hi: 2 }], null),
		() => subtract([{ lo: 1, hi: 2 }], [{ lo: 1, hi: 2 }]),
		() => subtract(null, { lo: 1, hi: 2 }),
	];
	for (const [index, call] of bad.entries()) {
		assert.throws(call, TypeError, `bad call #${index}`);
	}
});

if (failed > 0) process.exit(1);
