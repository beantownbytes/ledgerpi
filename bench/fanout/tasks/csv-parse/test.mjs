import assert from "node:assert/strict";
import { CsvError, parseCsv } from "./csv.mjs";

let failed = 0;
function check(name, fn) {
	try {
		fn();
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}: ${error.message}`);
	}
}
const parses = (text, expected, options) =>
	assert.deepStrictEqual(parseCsv(text, options), expected, `parse of ${JSON.stringify(text)}`);
const fails = (text, position, options) =>
	assert.throws(
		() => parseCsv(text, options),
		(error) => {
			assert.ok(error instanceof CsvError, `${JSON.stringify(text)}: expected a CsvError, got ${error}`);
			assert.equal(
				error.position,
				position,
				`${JSON.stringify(text)}: position ${error.position}, wanted ${position}`,
			);
			assert.ok(
				error.message.includes(`position ${position}`),
				`message ${JSON.stringify(error.message)} lacks "position ${position}"`,
			);
			return true;
		},
	);

check("simple records", () => {
	parses("a,b,c\n1,2,3", [
		["a", "b", "c"],
		["1", "2", "3"],
	]);
	parses("a", [["a"]]);
	parses("a,b", [["a", "b"]]);
});

check("empty text has no records", () => {
	parses("", []);
});

check("CRLF and LF separators", () => {
	parses("a,b\r\nc,d\r\n", [
		["a", "b"],
		["c", "d"],
	]);
	parses("a,b\nc,d\n", [
		["a", "b"],
		["c", "d"],
	]);
	parses("a\r\nb\nc\r\nd", [["a"], ["b"], ["c"], ["d"]]);
});

check("a trailing line break adds no record", () => {
	parses("a,b\n", [["a", "b"]]);
	parses("a,b\r\n", [["a", "b"]]);
	parses("a,b", [["a", "b"]]);
});

check("blank lines are records with one empty field", () => {
	parses("\n", [[""]]);
	parses("\r\n", [[""]]);
	parses("a\n\nb", [["a"], [""], ["b"]]);
	parses("a\n\n", [["a"], [""]]);
	parses("\n\n", [[""], [""]]);
});

check("empty fields", () => {
	parses("a,,b", [["a", "", "b"]]);
	parses("a,b,", [["a", "b", ""]]);
	parses(",a", [["", "a"]]);
	parses(",", [["", ""]]);
	parses(",,", [["", "", ""]]);
	parses("a,\nb,\n", [
		["a", ""],
		["b", ""],
	]);
	parses("a,b,\r\n,c\r\n", [
		["a", "b", ""],
		["", "c"],
	]);
});

check("rows may differ in length", () => {
	parses("a,b,c\nd\ne,f", [["a", "b", "c"], ["d"], ["e", "f"]]);
});

check("whitespace is data", () => {
	parses(" a , b ", [[" a ", " b "]]);
	parses("a \t,\tb", [["a \t", "\tb"]]);
});

check("lone CR is data", () => {
	parses("a\rb", [["a\rb"]]);
	parses("a\r", [["a\r"]]);
	parses("a\r\r\nb", [["a\r"], ["b"]]);
});

check("quoted fields", () => {
	parses('"a","b"', [["a", "b"]]);
	parses('"a b",c', [["a b", "c"]]);
	parses('a,"b"\n"c",d', [
		["a", "b"],
		["c", "d"],
	]);
	parses('"a"\n', [["a"]]);
	parses('"a"\r\n"b"', [["a"], ["b"]]);
});

check("doubled quotes", () => {
	parses('"a""b"', [['a"b']]);
	parses('""""', [['"']]);
	parses('"""a"""', [['"a"']]);
	parses('"a"""', [['a"']]);
	parses('""""""', [['""']]);
});

check("empty quoted fields", () => {
	parses('""', [[""]]);
	parses('"",""', [["", ""]]);
	parses('a,""\n""', [["a", ""], [""]]);
	parses('"",a', [["", "a"]]);
});

check("delimiters and line breaks inside quotes", () => {
	parses('"a,b",c', [["a,b", "c"]]);
	parses('"a\nb",c', [["a\nb", "c"]]);
	parses('"a\r\nb"', [["a\r\nb"]]);
	parses('"a\rb"', [["a\rb"]]);
	parses('x,"line1\nline2",y\nz', [["x", "line1\nline2", "y"], ["z"]]);
	parses('"\n"', [["\n"]]);
	parses('"a\n"\n', [["a\n"]]);
	parses('","', [[","]]);
});

check("quotes keep surrounding spaces inside the quotes", () => {
	parses('" a ",b', [[" a ", "b"]]);
});

check("custom delimiter", () => {
	parses(
		"a;b;c\n1;2;3",
		[
			["a", "b", "c"],
			["1", "2", "3"],
		],
		{ delimiter: ";" },
	);
	parses("a\tb\tc", [["a", "b", "c"]], { delimiter: "\t" });
	parses("a,b;c", [["a,b", "c"]], { delimiter: ";" });
	parses('"a;b";c', [["a;b", "c"]], { delimiter: ";" });
	parses("a;;b;", [["a", "", "b", ""]], { delimiter: ";" });
	parses("a|b", [["a", "b"]], { delimiter: "|" });
	parses("a,b", [["a,b"]], { delimiter: ";" });
});

check("default options", () => {
	parses("a,b", [["a", "b"]], {});
	parses("a,b", [["a", "b"]], undefined);
});

check("invalid delimiter options", () => {
	for (const delimiter of ["", ";;", '"', "\n", "\r", ",,", 5]) {
		assert.throws(() => parseCsv("a,b", { delimiter }), RangeError, JSON.stringify(delimiter));
	}
});

check("non-string text", () => {
	for (const bad of [undefined, null, 5, ["a"]]) {
		assert.throws(() => parseCsv(bad), TypeError);
	}
});

check("unterminated quote", () => {
	fails('"abc', 0);
	fails('a,"bc', 2);
	fails('a\n"b\nc', 2);
	fails('"abc""', 0);
	fails('"', 0);
	fails('x,y\n"', 4);
});

check("quote inside an unquoted field", () => {
	fails('ab"c"', 2);
	fails('a,b"', 3);
	fails('a\nb,c"d', 5);
	fails(' "a"', 1);
});

check("junk after a closing quote", () => {
	fails('"ab"c', 4);
	fails('"ab" ,c', 4);
	fails('"ab" ', 4);
	fails('"a""b"x', 6);
	fails('a\n"b"c', 5);
	fails('"a"\r', 3);
	fails('""x', 2);
});

check("error positions with a custom delimiter", () => {
	fails('a;"b"c', 5, { delimiter: ";" });
	fails('a;b"', 3, { delimiter: ";" });
	fails('"a,b" ;c', 5, { delimiter: ";" });
});

check("a CsvError is an Error", () => {
	assert.ok(new CsvError("x") instanceof Error);
});

if (failed > 0) process.exit(1);
