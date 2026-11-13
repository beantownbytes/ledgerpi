`wrap.mjs` exports a stub `wrap(text, options)`. Implement it so it reflows `text` into lines of at most `options.width` characters and returns the result as one string.

Options
- `width` is required: a positive integer, the maximum length of every output line including its indentation. Anything else is a `RangeError`.
- `indent` is a non-negative integer, default 0: the number of spaces put in front of every output line.
- `firstIndent` is a non-negative integer, default equal to `indent`: the number of spaces in front of the first line of each paragraph, replacing `indent` on that line.
- `tabSize` is a positive integer, default 8, used for tab expansion.
- Invalid values for these options are a `RangeError`. So is an `indent` or `firstIndent` that leaves no room for at least one character (greater than or equal to `width`). A non-string `text` is a `TypeError`. Omitting `options` is a `RangeError`, because `width` is missing.
- Lengths are counted in Unicode code points, not UTF-16 units, and a word is never split inside a code point.

Input handling
- `\r\n` and a lone `\r` are treated as `\n`.
- Tabs are expanded first, line by line: a tab becomes the spaces needed to reach the next multiple of `tabSize`, counting columns in code points from the start of its input line. After that, the only whitespace character is the space. Any other character, such as a non-breaking space or a form feed, is an ordinary part of a word.
- A line that is empty or contains only spaces is blank. One or more consecutive blank lines separate paragraphs. Blank lines before the first and after the last paragraph are ignored. Text with no paragraphs gives the empty string.

Filling a paragraph
- Within a paragraph, a line break is just a gap between two words: the spaces that end an input line and the spaces that start the next input line are dropped, and the break becomes a single space.
- Words are maximal runs of non-space characters. Gaps between words on the same input line keep their exact length (after tab expansion): two spaces stay two spaces.
- Leading spaces of the first line of a paragraph are kept as a gap before its first word (this is how an indented first line is expressed). Leading spaces of any later input line are dropped.
- Lines are filled greedily: a word (preceded by its gap) goes on the current line if the line stays within the available width, which is `width` minus that line's indentation. Otherwise the line ends, and the word starts a new line. The gap at a break is dropped, so no output line starts or ends with a space (apart from its indentation), and output lines are never empty.
- The first word of a paragraph that does not fit even after its leading gap simply loses the gap.
- A word longer than the available width of a fresh line is hard-broken. It always starts on a new line (the current line ends first, if it has any words), and is cut into pieces of exactly the available width, each on its own line, with the shorter remainder left as the current line, which later words may continue after a normal gap. The first piece uses the first-line width if it is the first line of its paragraph.

Output
- The lines of a paragraph are joined with `\n`, each prefixed by its indentation. Paragraphs are joined by exactly one blank line (`\n\n`). There is no trailing newline.
