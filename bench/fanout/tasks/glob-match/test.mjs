import assert from "node:assert/strict";
import { globMatch } from "./glob.mjs";

let failed = 0;
function check(name, fn) {
	try {
		fn();
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}: ${error.message}`);
	}
}

const yes = (pattern, ...paths) => {
	for (const path of paths)
		assert.equal(globMatch(pattern, path), true, `${pattern} should match ${JSON.stringify(path)}`);
};
const no = (pattern, ...paths) => {
	for (const path of paths)
		assert.equal(globMatch(pattern, path), false, `${pattern} should not match ${JSON.stringify(path)}`);
};

check("literal patterns match the whole path only", () => {
	yes("abc", "abc");
	no("abc", "ab", "abcd", "xabc", "ABC");
	yes("a/b.txt", "a/b.txt");
	no("a.b", "axb");
});

check("empty pattern and empty path", () => {
	yes("", "");
	no("", "a");
	no("a", "");
	yes("*", "");
	yes("**", "");
});

check("star matches within one segment", () => {
	yes("*.js", "a.js", ".js", "foo.bar.js");
	no("*.js", "a/b.js", "a.jsx", "a.ts");
	yes("a*", "a", "abc");
	yes("a*c", "ac", "abc", "abbbc");
	no("a*c", "a/c", "abcd");
	yes("*a*", "a", "xax", "bab");
});

check("star does not cross slashes and counts empty segments", () => {
	yes("a/*", "a/b", "a/");
	no("a/*", "a/b/c", "a");
	yes("*/*", "a/b", "/", "a/");
	no("*/*", "a", "a/b/c");
	yes("a/*/c", "a/b/c", "a//c");
	no("a/*/c", "a/c", "a/b/d/c");
});

check("dot files get no special treatment", () => {
	yes("*", ".hidden");
	yes("*.js", ".js");
	yes("a/*", "a/.git");
	yes("**/x", ".git/x");
});

check("question mark matches exactly one non-slash character", () => {
	yes("?", "a", "-");
	no("?", "", "ab", "/");
	yes("a?c", "abc", "a.c");
	no("a?c", "ac", "a/c", "abbc");
	yes("???", "abc");
	no("???", "ab", "abcd");
});

check("question mark is one code point", () => {
	yes("?", "\u{1F600}");
	yes("a?b", "a\u{1F600}b");
	no("?", "\u{1F600}\u{1F600}");
	yes("[\u{1F600}]", "\u{1F600}");
});

check("double star as a middle segment matches zero or more segments", () => {
	yes("a/**/b", "a/b", "a/x/b", "a/x/y/b", "a//b");
	no("a/**/b", "a", "ab", "a/x/c", "a/b/c", "x/a/b");
});

check("double star at the start", () => {
	yes("**/b", "b", "x/b", "x/y/b", "/b");
	no("**/b", "xb", "b/x", "x/yb");
	yes("**/*.js", "a.js", "x/a.js", "x/y/z/a.js");
	no("**/*.js", "a.ts", "x/a.jsx");
});

check("double star at the end", () => {
	yes("a/**", "a", "a/", "a/x", "a/x/y", "a/x/y/z");
	no("a/**", "ab", "ab/c", "b/a", "b");
	yes("a/b/**", "a/b", "a/b/c/d");
	no("a/b/**", "a", "a/c/d");
});

check("double star alone matches everything", () => {
	yes("**", "", "a", "a/b", "a/b/c.txt", "/", "//");
	yes("**/**", "a", "a/b/c", "");
	yes("**/", "", "a/", "a/b/");
	no("**/", "a", "a/b");
});

check("consecutive double stars and combinations", () => {
	yes("a/**/**/b", "a/b", "a/x/b", "a/x/y/b");
	yes("**/a/**", "a", "x/a", "a/y", "x/y/a/z/w");
	no("**/a/**", "b", "x/b/y");
	yes("**/a/**/b/**", "a/b", "x/a/y/b/z");
});

check("double star that is not a whole segment acts as one star", () => {
	yes("a**b", "ab", "axb", "axxb");
	no("a**b", "a/b", "ax/yb");
	yes("**a", "a", "xa", "xxa");
	no("**a", "x/a");
	yes("a/**b", "a/b", "a/xb");
	no("a/**b", "a/x/b");
	yes("***", "abc");
	no("***", "a/b");
	yes("a/***/b", "a/x/b");
	no("a/***/b", "a/b", "a/x/y/b");
	yes("a**", "a", "abc");
	no("a**", "a/b");
});

check("character class members and ranges", () => {
	yes("[abc]", "a", "b", "c");
	no("[abc]", "d", "", "ab");
	yes("[a-c]x", "ax", "bx", "cx");
	no("[a-c]x", "dx", "x");
	yes("[a-cx-z]", "b", "y");
	no("[a-cx-z]", "m");
	yes("file[0-9].txt", "file0.txt", "file9.txt");
	no("file[0-9].txt", "filex.txt", "file10.txt");
	yes("[A-Za-z_]*", "Hello", "_x");
	no("[A-Za-z_]*", "1abc");
});

check("dash is literal at the edges of a class", () => {
	yes("[-a]", "-", "a");
	yes("[a-]", "-", "a");
	no("[a-]", "b");
});

check("negated classes", () => {
	yes("[!a]", "b", "-", "1");
	no("[!a]", "a", "", "bc");
	yes("[!a-c]x", "dx", "zx");
	no("[!a-c]x", "bx");
	yes("[!!]", "a");
	no("[!!]", "!");
	yes("[^a]", "^", "a");
	no("[^a]", "b");
});

check("a class never matches a slash", () => {
	no("[/]", "/");
	no("a[/]b", "a/b");
	no("[!a]", "/");
	no("a[!b]c", "a/c");
	yes("a[!b]c", "axc");
});

check("closing bracket right after the opening bracket is literal", () => {
	yes("[]a]", "]", "a");
	no("[]a]", "b");
	yes("[!]a]", "b");
	no("[!]a]", "]", "a");
	yes("[]-a]", "]", "^", "a");
});

check("backslash inside a class", () => {
	yes("[\\]]", "]");
	no("[\\]]", "\\");
	yes("[a\\-z]", "a", "-", "z");
	no("[a\\-z]", "m");
	yes("[\\\\]", "\\");
	yes("[\\a]", "a");
});

check("special characters are ordinary inside a class", () => {
	yes("[*?]", "*", "?");
	no("[*?]", "a");
	yes("[{,}]", "{", ",", "}");
	yes("[{]x", "{x");
	yes("a[{,]b", "a{b", "a,b");
	yes("{a,[}]}", "a", "}");
	no("{a,[}]}", "]");
});

check("reversed ranges match nothing", () => {
	no("[z-a]", "a", "m", "z");
	yes("[!z-a]", "a", "q");
	no("[!z-a]", "/");
	yes("[z-ab]", "b");
	no("[z-ab]", "a");
});

check("unterminated class is a literal bracket", () => {
	yes("[abc", "[abc");
	no("[abc", "a");
	yes("a[", "a[");
	yes("[!", "[!");
	yes("[]", "[]");
	yes("[a\\]", "[a]");
});

check("brace alternation", () => {
	yes("{a,b}", "a", "b");
	no("{a,b}", "c", "", "ab", "a,b");
	yes("x{a,bc,d}y", "xay", "xbcy", "xdy");
	no("x{a,bc,d}y", "xy", "xcy");
	yes("*.{js,ts}", "a.js", "b.ts");
	no("*.{js,ts}", "a.jsx", "a.md", "dir/a.js");
	yes("{src,test}/*.js", "src/a.js", "test/b.js");
	no("{src,test}/*.js", "lib/a.js", "src/x/a.js");
});

check("empty alternatives", () => {
	yes("x{,y}", "x", "xy");
	no("x{,y}", "xz");
	yes("x{y,}", "x", "xy");
	yes("x{,}z", "xz");
	no("x{,}z", "x,z");
});

check("braces may contain globs, slashes and classes", () => {
	yes("{a/**,b}", "a", "a/x/y", "b");
	no("{a/**,b}", "b/x");
	yes("{*.js,[0-9]*}", "a.js", "1abc");
	no("{*.js,[0-9]*}", "a.ts");
	yes("src/{a/b,c}/x", "src/a/b/x", "src/c/x");
	yes("**/{a,b}/*.js", "a/x.js", "z/b/x.js", "p/q/a/x.js");
	no("**/{a,b}/*.js", "c/x.js");
});

check("nested braces", () => {
	yes("{a,{b,c}}", "a", "b", "c");
	no("{a,{b,c}}", "d");
	yes("{a,b{c,d}}e", "ae", "bce", "bde");
	no("{a,b{c,d}}e", "be", "ace");
	yes("{a,b}{c,d}", "ac", "ad", "bc", "bd");
	no("{a,b}{c,d}", "ab", "cd");
	yes("{x,{y,{z,w}}}", "w");
});

check("braces without a comma or without a match are literal", () => {
	yes("{a}", "{a}");
	no("{a}", "a");
	yes("{}", "{}");
	yes("a{b", "a{b");
	yes("a}b", "a}b");
	no("a}b", "ab");
	yes("{a,b", "{a,b");
	no("{a,b", "a", "b");
	yes("x{a}y{b,c}", "x{a}yb", "x{a}yc");
});

check("an unmatched first brace does not stop a later group", () => {
	yes("{a,{b,c}", "{a,b", "{a,c");
	no("{a,{b,c}", "a", "b");
	yes("{{a,b}", "{a", "{b");
});

check("a comma outside braces is literal", () => {
	yes("a,b", "a,b");
	no("a,b", "a", "b");
	yes("a,{b,c}", "a,b", "a,c");
});

check("escaped wildcards are literal", () => {
	yes("\\*", "*");
	no("\\*", "a", "");
	yes("a\\*b", "a*b");
	no("a\\*b", "axb");
	yes("\\?", "?");
	no("\\?", "a");
	yes("\\*\\*", "**");
	no("\\*\\*", "ab");
	yes("*\\*", "a*", "**", "*");
	no("*\\*", "ab");
});

check("escaped brackets and braces are literal", () => {
	yes("\\[a]", "[a]");
	no("\\[a]", "a");
	yes("[a\\]", "[a]");
	yes("\\{a,b\\}", "{a,b}");
	no("\\{a,b\\}", "a");
	yes("{a\\,b,c}", "a,b", "c");
	no("{a\\,b,c}", "a", "b");
	yes("a\\}", "a}");
	yes("{a,b\\}}", "a", "b}");
});

check("escaped ordinary characters and backslashes", () => {
	yes("\\a", "a");
	no("\\a", "\\a");
	yes("\\\\", "\\");
	no("\\\\", "\\\\");
	yes("a\\\\b", "a\\b");
	yes("\\\\*", "\\", "\\xyz");
});

check("a trailing backslash is a literal backslash", () => {
	yes("a\\", "a\\");
	no("a\\", "a");
	yes("*\\", "x\\", "\\");
});

check("an escaped slash still separates segments for double star", () => {
	yes("a\\/**", "a", "a/x/y");
	yes("a\\/**\\/b", "a/b", "a/x/y/b");
	yes("a\\/b", "a/b");
});

check("regex metacharacters in the pattern are literal", () => {
	yes("a+b", "a+b");
	no("a+b", "aab");
	yes("(a|b)", "(a|b)");
	no("(a|b)", "a");
	yes("^a$", "^a$");
	yes("a.b", "a.b");
	no("a.b", "axb");
	yes("a|b", "a|b");
	yes("[.]", ".");
	no("[.]", "a");
});

check("mixed realistic patterns", () => {
	yes("src/**/*.{ts,tsx}", "src/a.ts", "src/ui/b.tsx", "src/ui/deep/c.ts");
	no("src/**/*.{ts,tsx}", "src/a.js", "lib/a.ts", "src/a.tsx.map");
	yes("**/node_modules/**", "node_modules", "a/node_modules/b/c", "node_modules/x");
	no("**/node_modules/**", "a/node_module/b");
	yes("logs/app-[0-9][0-9].log", "logs/app-07.log");
	no("logs/app-[0-9][0-9].log", "logs/app-7.log", "logs/app-ab.log");
	yes("v?.?.?", "v1.2.3");
	no("v?.?.?", "v10.2.3");
});

check("non-string arguments throw TypeError", () => {
	assert.throws(() => globMatch(1, "a"), TypeError);
	assert.throws(() => globMatch("a", undefined), TypeError);
	assert.throws(() => globMatch(null, null), TypeError);
	assert.throws(() => globMatch(/a/, "a"), TypeError);
});

if (failed > 0) process.exit(1);
