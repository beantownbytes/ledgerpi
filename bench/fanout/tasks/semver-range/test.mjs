import assert from "node:assert/strict";
import { satisfies } from "./semver.mjs";

let failed = 0;
function check(name, fn) {
	try {
		fn();
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}: ${error.message}`);
	}
}
const yes = (version, range) => assert.equal(satisfies(version, range), true, `${version} should satisfy ${range}`);
const no = (version, range) => assert.equal(satisfies(version, range), false, `${version} should not satisfy ${range}`);
const bad = (version, range) =>
	assert.throws(
		() => satisfies(version, range),
		TypeError,
		`${JSON.stringify(version)} / ${JSON.stringify(range)} should throw a TypeError`,
	);

check("exact and = comparators", () => {
	yes("1.2.3", "1.2.3");
	no("1.2.4", "1.2.3");
	yes("1.2.3", "=1.2.3");
	no("1.2.2", "=1.2.3");
});

check("> and >= compare numerically", () => {
	yes("1.2.4", ">1.2.3");
	no("1.2.3", ">1.2.3");
	yes("1.2.3", ">=1.2.3");
	no("1.2.2", ">=1.2.3");
	yes("1.10.0", ">1.9.9");
	yes("10.0.0", ">9.99.99");
});

check("< and <= comparators", () => {
	yes("1.2.2", "<1.2.3");
	no("1.2.3", "<1.2.3");
	yes("1.2.3", "<=1.2.3");
	no("1.2.4", "<=1.2.3");
});

check("caret with a non-zero major", () => {
	yes("1.2.3", "^1.2.3");
	yes("1.9.9", "^1.2.3");
	no("2.0.0", "^1.2.3");
	no("1.2.2", "^1.2.3");
});

check("caret with major 0 fixes the minor", () => {
	yes("0.2.9", "^0.2.3");
	no("0.3.0", "^0.2.3");
	no("0.2.2", "^0.2.3");
	no("1.0.0", "^0.2.3");
});

check("caret with major and minor 0 fixes the patch", () => {
	yes("0.0.3", "^0.0.3");
	no("0.0.4", "^0.0.3");
	no("0.0.2", "^0.0.3");
	yes("0.0.0", "^0.0.0");
	no("0.0.1", "^0.0.0");
});

check("tilde fixes major and minor", () => {
	yes("1.2.9", "~1.2.3");
	no("1.3.0", "~1.2.3");
	no("1.2.2", "~1.2.3");
	yes("0.2.5", "~0.2.3");
	no("0.3.0", "~0.2.3");
});

check("space-joined comparators are ANDed", () => {
	yes("1.4.0", "^1.2.3 <1.5.0");
	no("1.5.0", "^1.2.3 <1.5.0");
	yes("1.5.0", "  >=1.2.0 \t <2.0.0  ");
	no("1.2.3", ">=2.0.0 <1.0.0");
});

check("|| unions sets", () => {
	yes("3.0.0", ">=1.0.0 <2.0.0 || >=3.0.0");
	yes("1.5.0", ">=1.0.0 <2.0.0 || >=3.0.0");
	no("2.5.0", ">=1.0.0 <2.0.0 || >=3.0.0");
	yes("0.1.0", "^1.0.0||^0.1.0");
	yes("2.0.0", "  ^1.0.0   ||   ~2.0.0  ");
	no("3.0.0", "  ^1.0.0   ||   ~2.0.0  ");
});

check("prerelease identifiers are ordered by semver rules", () => {
	yes("1.0.0", ">=1.0.0-alpha");
	yes("1.0.0-alpha", "1.0.0-alpha");
	no("1.0.0-alpha", "1.0.0");
	no("1.0.0-alpha", "1.0.0-beta");
	yes("1.0.0-alpha.1", ">1.0.0-alpha");
	yes("1.0.0-alpha.beta", ">1.0.0-alpha.1");
	yes("1.0.0-beta", ">1.0.0-alpha.beta");
	yes("1.0.0-beta.11", ">1.0.0-beta.2");
	no("1.0.0-beta.2", ">1.0.0-beta.11");
	yes("1.0.0-rc.1", "<1.0.0-rc.2");
	yes("1.0.0-rc.1", "<1.0.0 >=1.0.0-beta");
});

check("alphanumeric identifiers compare as ASCII, numeric sorts below alphanumeric", () => {
	yes("1.0.0-alpha-1", ">1.0.0-alpha");
	yes("1.0.0-Beta", "<1.0.0-alpha");
	yes("1.0.0-1", "<1.0.0-a");
	no("1.0.0-a", "<1.0.0-1");
});

check("prerelease needs a prerelease comparator on the same major.minor.patch", () => {
	no("1.2.3-beta.1", "^1.2.3");
	no("1.2.4-beta.1", "^1.2.3");
	no("1.5.0-rc.1", ">=1.2.3 <2.0.0");
	no("2.0.0-alpha", "<2.0.0");
	no("1.2.3-alpha", "<1.2.3");
	yes("1.2.3-alpha", "<1.2.3-beta");
	no("1.2.4-beta.1", ">=1.2.3-alpha");
	yes("1.2.3-beta.1", ">=1.2.3-alpha");
	yes("1.2.3-beta.1", ">=1.2.3-alpha <1.3.0");
});

check("prerelease on the upper bound's version", () => {
	yes("2.0.0-beta", ">=2.0.0-alpha <2.0.0");
	no("2.0.0-beta", ">=1.0.0-alpha <2.0.0");
});

check("caret with a prerelease lower bound", () => {
	yes("1.2.3-beta.10", "^1.2.3-beta.2");
	no("1.2.3-beta.1", "^1.2.3-beta.2");
	yes("1.2.3", "^1.2.3-beta.2");
	yes("1.9.0", "^1.2.3-beta.2");
	no("1.2.4-beta.1", "^1.2.3-beta.2");
	no("2.0.0", "^1.2.3-beta.2");
});

check("tilde with a prerelease lower bound", () => {
	yes("1.2.3-rc.1", "~1.2.3-beta");
	no("1.2.4-rc.1", "~1.2.3-beta");
});

check("the prerelease rule applies per set", () => {
	yes("1.2.4-rc.1", "^1.0.0 || >=1.2.4-rc.0");
	no("1.2.4-rc.1", "^1.0.0 || <1.2.3-rc.0");
	no("1.2.4-rc.1", "^1.2.3-beta || >=1.0.0");
});

check("invalid versions throw TypeError", () => {
	for (const version of [
		"1.2",
		"1",
		"1.2.3.4",
		"01.2.3",
		"1.02.3",
		"1.2.03",
		"v1.2.3",
		" 1.2.3",
		"1.2.3 ",
		"1.2.3-",
		"1.2.3-01",
		"1.2.3-a..b",
		"1.2.3-a.",
		"1.2.3+build",
		"1.2.x",
		"",
		"latest",
		"-1.2.3",
		"1.2.3-a_b",
	]) {
		bad(version, ">=0.0.0");
	}
	bad(undefined, ">=0.0.0");
});

check("invalid ranges throw TypeError", () => {
	for (const range of [
		"",
		"   ",
		"||",
		"1.0.0 ||",
		"|| 1.0.0",
		"1.0.0 || || 2.0.0",
		">= 1.2.3",
		"^1.2",
		"~1.2",
		"1.x",
		"*",
		"v1.2.3",
		"==1.0.0",
		"=>1.0.0",
		"^^1.0.0",
		"!1.0.0",
		"1.2.3 - 2.0.0",
		"1.2.3+build",
		"^1.2.3 ,<2.0.0",
	]) {
		bad("1.0.0", range);
	}
	bad("1.0.0", undefined);
});

check("an invalid range is reported even when an earlier set matches", () => {
	bad("1.0.0", "1.0.0 || bogus");
});

if (failed > 0) process.exit(1);
