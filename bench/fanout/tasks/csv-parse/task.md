`csv.mjs` exports a stub `parseCsv(text, options)` and a stub `CsvError` class. Implement `parseCsv` so it parses CSV text (RFC 4180 style) into an array of records, each an array of strings.

Records and fields
- Fields are separated by the delimiter, which is `,` unless `options.delimiter` says otherwise.
- Records are separated by `\r\n` or `\n`. A `\r` that is not immediately followed by `\n` is ordinary data, both inside and outside quotes.
- The final record may or may not end with a line break; a single trailing line break does not produce an extra empty record. An empty `text` gives `[]`.
- A blank line is a record with exactly one empty field, so `"a\n\nb"` gives three records. Because only the final line break is optional, `"a\n\n"` gives `[["a"], [""]]`.
- Empty fields are empty strings: `a,,b` has three fields, and `a,b,` also has three, the last one empty. A line of just the delimiter has two empty fields.
- Records may have different numbers of fields. Nothing is trimmed: spaces and tabs around a field are data (but see Errors: a quote after leading spaces is not allowed).

Quoted fields
- A field is quoted when its first character is `"`. The value is everything up to the matching closing `"`, without the surrounding quotes.
- Inside a quoted field a doubled `""` is one literal `"`. Delimiters, `\n` and `\r\n` inside quotes are data and are preserved exactly as written.
- `""` is an empty field. `""""` is a field holding one `"`.
- A closing quote must be followed by the delimiter, a record separator, or the end of the text.

Options
- `options` is optional. `options.delimiter` is a single character (default `,`), for example `;` or a tab. When it is not a comma, commas are ordinary data. The delimiter must be exactly one character, and cannot be `"`, `\r` or `\n`; otherwise `parseCsv` throws a `RangeError`.
- A non-string `text` throws a `TypeError`.

Errors
- Malformed input throws a `CsvError` (exported, a subclass of `Error`) with a numeric `position` property, the 0-based index into `text`, and a message that contains the text `position N` for that index N.
- A quoted field that never closes: the position of its opening quote.
- A `"` that appears inside an unquoted field (`ab"c`): the position of that quote.
- Any character other than the delimiter, a record separator or the end of the text right after a closing quote (`"ab"c`, or `"ab" ,`): the position of that character. A lone `\r` counts as such a character.
