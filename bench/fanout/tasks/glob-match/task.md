`glob.mjs` exports a stub `globMatch(pattern, path)`. Implement it so it returns `true` when the whole `path` string matches the glob `pattern` and `false` otherwise. Both arguments must be strings, otherwise throw a `TypeError`. Matching is case-sensitive, always covers the entire path, and never touches the file system.

Path segments
- A path is a string whose segments are separated by `/`. Empty segments count (`a//b` has three segments, `a/` has two) and nothing is normalized. A leading dot has no special meaning: `*` matches `.hidden`.
- The empty pattern matches only the empty path.

Wildcards
- `*` matches zero or more characters, none of them `/`.
- `?` matches exactly one character that is not `/`. A character is a Unicode code point, so `?` matches one emoji.
- `**` is special only when it makes up a whole segment of the pattern: the segment is exactly two stars, between `/` or the start of the pattern on the left and `/` or the end of the pattern on the right. Such a segment matches zero or more whole path segments. So `a/**/b` matches `a/b`, `a/x/b` and `a/x/y/b`, `**/b` matches `b` and `x/y/b`, and `a/**` matches `a`, `a/x` and `a/x/y` (and `a/`). A pattern that is only `**` matches every path.
- Any other run of stars (`a**b`, `**a`, `***`, `a/**b`) behaves like a single `*`.

Character classes
- `[abc]` matches one character that is a, b or c. `[a-z]` matches one character from a to z by code point. `-` is literal when it is first or last in the class. `[!abc]` matches one character that is not a, b or c. (`^` has no special meaning and is an ordinary member.)
- A `]` directly after `[` or `[!` is a literal member: `[]a]` matches `]` or `a`. Otherwise the first `]` ends the class.
- Inside a class a backslash makes the next character an ordinary member (including `]`, `-` and `\`). Inside a class, `{`, `}`, `,`, `*` and `?` are ordinary members.
- A class never matches `/`, even when negated or written as `[/]`. A reversed range such as `[z-a]` contributes no characters (so `[z-a]` matches nothing and `[!z-a]` matches any single character except `/`).
- A `[` with no closing `]` is a literal `[`.

Alternation
- `{a,b}` matches any one of its comma-separated alternatives. Alternatives may be empty (`x{,y}` matches `x` and `xy`), may contain any other glob syntax including `**`, `/` and character classes, and may nest (`{a,{b,c}}`).
- Commas inside a nested group do not split the outer group. A `{` that has no matching `}`, or a pair of braces with no top-level comma such as `{a}` or `{}`, is literal, as is any `}` that closes nothing. When the first `{` is unmatched a later one can still start a group: `{a,{b,c}` matches `{a,b` and `{a,c`.
- Braces are expanded before wildcards are looked at; the alternatives of a group are not required to be complete segments.

Escaping
- A backslash makes the next pattern character literal, whatever it is: `\*`, `\?`, `\[`, `\{`, `\}`, `\,` and `\\` match those characters. An escaped `/` is still a segment separator for the `**` rule. A backslash at the very end of the pattern is a literal backslash.
