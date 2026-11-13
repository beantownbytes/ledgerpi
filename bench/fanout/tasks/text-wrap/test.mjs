import assert from "node:assert/strict";
import { wrap } from "./wrap.mjs";

let failed = 0;
function check(name, fn) {
	try {
		fn();
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}: ${error.message}`);
	}
}

const is = (text, options, expected) => assert.equal(wrap(text, options), expected, JSON.stringify([text, options]));

check("greedy filling", () => {
	is("the quick brown fox jumps over the lazy dog", { width: 10 }, "the quick\nbrown fox\njumps over\nthe lazy\ndog");
	is(
		"Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
		{ width: 20 },
		"Lorem ipsum dolor\nsit amet,\nconsectetur\nadipiscing elit.",
	);
});

check("a line may be exactly as wide as the width", () => {
	is("aaa bbb", { width: 7 }, "aaa bbb");
	is("aaa bbb", { width: 6 }, "aaa\nbbb");
	is("aa bbbb", { width: 4 }, "aa\nbbbb");
	is("hello", { width: 5 }, "hello");
});

check("empty and blank input", () => {
	is("", { width: 10 }, "");
	is("   ", { width: 10 }, "");
	is("\n\n  \n\t\n", { width: 10 }, "");
});

check("no trailing newline and ignored outer blank lines", () => {
	is("abc\n", { width: 10 }, "abc");
	is("\n\na b\n\n", { width: 10 }, "a b");
	is("abc\n\n\n", { width: 10 }, "abc");
});

check("hard break of a word longer than the width", () => {
	is("abcdefghij", { width: 4 }, "abcd\nefgh\nij");
	is("abcdefgh", { width: 4 }, "abcd\nefgh");
	is("abcdefghi", { width: 3 }, "abc\ndef\nghi");
});

check("a long word starts on a new line", () => {
	is("ab abcdefghij cd", { width: 4 }, "ab\nabcd\nefgh\nij\ncd");
	is("ab abcdefghij cd", { width: 5 }, "ab\nabcde\nfghij\ncd");
	is("x abcdefgh", { width: 4 }, "x\nabcd\nefgh");
});

check("the remainder of a hard-broken word can be continued", () => {
	is("ab abcdefg x", { width: 5 }, "ab\nabcde\nfg x");
	is("abcdefg h", { width: 4 }, "abcd\nefg\nh");
	is("abcdefg h", { width: 5 }, "abcde\nfg h");
});

check("width 1", () => {
	is("ab c", { width: 1 }, "a\nb\nc");
	is("", { width: 1 }, "");
});

check("paragraphs", () => {
	is("one two\n\nthree four", { width: 20 }, "one two\n\nthree four");
	is("a\n\n\n   \nb", { width: 20 }, "a\n\nb");
	is("one two three\n\nfour five six", { width: 8 }, "one two\nthree\n\nfour\nfive six");
});

check("single newlines are plain gaps", () => {
	is("hello\nworld", { width: 20 }, "hello world");
	is("hello  \n  world", { width: 20 }, "hello world");
	is("a\nb\nc", { width: 3 }, "a b\nc");
	is("one\ntwo\nthree", { width: 7 }, "one two\nthree");
});

check("line endings", () => {
	is("a\r\n\r\nb", { width: 20 }, "a\n\nb");
	is("a\rb", { width: 20 }, "a b");
	is("a\r\rb", { width: 20 }, "a\n\nb");
	is("a\r\nb\r\n", { width: 20 }, "a b");
});

check("gaps inside a line keep their length", () => {
	is("a  b   c", { width: 20 }, "a  b   c");
	is("aa  bb", { width: 6 }, "aa  bb");
	is("one   two", { width: 20 }, "one   two");
});

check("the gap at a break is dropped", () => {
	is("aaa  bbb", { width: 3 }, "aaa\nbbb");
	is("aa  bb", { width: 5 }, "aa\nbb");
	is("aaaa     bb", { width: 6 }, "aaaa\nbb");
});

check("leading spaces of a paragraph are kept", () => {
	is("  hello world", { width: 20 }, "  hello world");
	is("  hello world", { width: 7 }, "  hello\nworld");
	is("  ab", { width: 4 }, "  ab");
	is("    first\n\n  second", { width: 20 }, "    first\n\n  second");
});

check("leading spaces of later lines are dropped", () => {
	is("a\n   b", { width: 20 }, "a b");
	is("x\n\ty", { width: 20 }, "x y");
});

check("a leading gap that does not fit is dropped", () => {
	is("     abc", { width: 5 }, "abc");
	is("   abcdefg", { width: 4 }, "abcd\nefg");
	is("  a  b", { width: 5 }, "  a\nb");
});

check("trailing spaces are dropped", () => {
	is("abc   ", { width: 10 }, "abc");
	is("abc   \n\nde  ", { width: 10 }, "abc\n\nde");
	is("abc \t ", { width: 10 }, "abc");
});

check("indent applies to every line", () => {
	is("aaa bbb ccc", { width: 8, indent: 2 }, "  aaa\n  bbb\n  ccc");
	is("aaa bbb ccc", { width: 10, indent: 2 }, "  aaa bbb\n  ccc");
	is("a\n\nb", { width: 10, indent: 3 }, "   a\n\n   b");
});

check("firstIndent replaces indent on the first line of each paragraph", () => {
	is("aaa bbb ccc ddd", { width: 10, indent: 2, firstIndent: 0 }, "aaa bbb\n  ccc ddd");
	is("aaa bbb ccc", { width: 10, firstIndent: 4 }, "    aaa\nbbb ccc");
	is("a\n\nb", { width: 20, indent: 2, firstIndent: 4 }, "    a\n\n    b");
	is("aaa bbb", { width: 20, indent: 0, firstIndent: 0 }, "aaa bbb");
});

check("indent narrows hard breaks", () => {
	is("abcdefghij", { width: 6, indent: 2 }, "  abcd\n  efgh\n  ij");
	is("abcdefghij", { width: 6, indent: 2, firstIndent: 0 }, "abcdef\n  ghij");
	is("abcdefghijkl", { width: 8, indent: 1, firstIndent: 3 }, "   abcde\n fghijkl");
	is("ab c", { width: 5, indent: 4 }, "    a\n    b\n    c");
});

check("indentation must leave room for text", () => {
	assert.throws(() => wrap("a", { width: 5, indent: 5 }), RangeError);
	assert.throws(() => wrap("a", { width: 5, indent: 9 }), RangeError);
	assert.throws(() => wrap("a", { width: 5, firstIndent: 5 }), RangeError);
	assert.throws(() => wrap("", { width: 5, indent: 5 }), RangeError);
	assert.doesNotThrow(() => wrap("a", { width: 5, indent: 4 }));
});

check("option validation", () => {
	assert.throws(() => wrap("a"), RangeError);
	assert.throws(() => wrap("a", {}), RangeError);
	for (const width of [0, -1, 1.5, "10", Number.NaN, null, Number.POSITIVE_INFINITY]) {
		assert.throws(() => wrap("a", { width }), RangeError, `width ${String(width)}`);
	}
	for (const indent of [-1, 1.5, "2", Number.NaN]) {
		assert.throws(() => wrap("a", { width: 10, indent }), RangeError, `indent ${String(indent)}`);
		assert.throws(() => wrap("a", { width: 10, firstIndent: indent }), RangeError, `firstIndent ${String(indent)}`);
	}
	for (const tabSize of [0, -2, 2.5, "4"]) {
		assert.throws(() => wrap("a", { width: 10, tabSize }), RangeError, `tabSize ${String(tabSize)}`);
	}
});

check("non-string text is a TypeError", () => {
	assert.throws(() => wrap(5, { width: 10 }), TypeError);
	assert.throws(() => wrap(undefined, { width: 10 }), TypeError);
	assert.throws(() => wrap(null, { width: 10 }), TypeError);
});

check("tabs expand to the next multiple of tabSize", () => {
	is("a\tb", { width: 30 }, `a${" ".repeat(7)}b`);
	is("ab\tc", { width: 30, tabSize: 4 }, "ab  c");
	is("abcd\te", { width: 30, tabSize: 4 }, "abcd    e");
	is("a\t\tb", { width: 30, tabSize: 4 }, `a${" ".repeat(7)}b`);
	is("\t\tx", { width: 30, tabSize: 2 }, "    x");
});

check("tab columns restart on every input line", () => {
	is("ab\ncd\te", { width: 30 }, `ab cd${" ".repeat(6)}e`);
	is("ab\r\ncd\te", { width: 30, tabSize: 4 }, "ab cd  e");
});

check("tab columns count code points", () => {
	is("\u{1F600}\tx", { width: 30, tabSize: 4 }, "\u{1F600}   x");
});

check("leading tabs form the leading gap and count against the width", () => {
	is("\tab", { width: 10 }, "        ab");
	is("\tab", { width: 9 }, "ab");
	is("\tab", { width: 12, tabSize: 4 }, "    ab");
});

check("a tab-only line is blank", () => {
	is("a\n\t\nb", { width: 20 }, "a\n\nb");
});

check("a tab inside a gap that must break is dropped", () => {
	is("aaaaaaaa\tb", { width: 8 }, "aaaaaaaa\nb");
	is("aaaaaaaa\tb", { width: 17 }, `aaaaaaaa${" ".repeat(8)}b`);
});

check("only the space separates words", () => {
	is("a\u00a0b c", { width: 3 }, "a\u00a0b\nc");
	is("a\fb", { width: 10 }, "a\fb");
	is("a\n\u00a0\nb", { width: 20 }, "a \u00a0 b");
	is("\u00a0a", { width: 20 }, "\u00a0a");
});

check("lengths count code points", () => {
	is(
		"\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}",
		{ width: 2 },
		"\u{1F600}\u{1F600}\n\u{1F600}\u{1F600}\n\u{1F600}",
	);
	is("\u{1F600} \u{1F600}", { width: 3 }, "\u{1F600} \u{1F600}");
	is("héllo wörld", { width: 5 }, "héllo\nwörld");
	is("\u{1F600}\u{1F601}\u{1F602}", { width: 2 }, "\u{1F600}\u{1F601}\n\u{1F602}");
});

check("wrapping output again changes nothing when gaps are single spaces", () => {
	const text =
		"The quick brown fox jumps over the lazy dog and then keeps running through the supercalifragilisticexpialidocious field.";
	for (const width of [7, 10, 20, 33]) {
		const once = wrap(text, { width });
		assert.equal(wrap(once, { width }), once, `width ${width}`);
	}
});

check("every line respects the width and keeps all words", () => {
	const text =
		"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega";
	for (const [width, indent] of [
		[12, 0],
		[12, 3],
		[5, 1],
		[30, 4],
	]) {
		const lines = wrap(text, { width, indent }).split("\n");
		for (const line of lines) {
			assert.ok(line.length <= width, `line too long: ${JSON.stringify(line)}`);
			assert.ok(line.startsWith(" ".repeat(indent)) && !line.startsWith(" ".repeat(indent + 1)), "indentation");
			assert.ok(!line.endsWith(" "), "trailing space");
		}
		const words = lines.join(" ").split(" ").filter(Boolean);
		assert.equal(words.join(""), text.replaceAll(" ", ""));
	}
});

if (failed > 0) process.exit(1);
