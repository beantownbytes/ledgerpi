`expr.mjs` exports a stub `evaluate(source)` and a stub `ExprError` class. Implement `evaluate` so it evaluates an arithmetic expression given as a string and returns the resulting number.

Tokens
- Numbers are decimal: digits with an optional fractional part (`3`, `3.25`), or a fractional part alone (`.5`). A `.` must be followed by a digit, so `1.` is an error. There are no exponents (`1e3` is an error), no hex and no signs inside a number.
- Operators are `+ - * / % **`. Parentheses group.
- Space, tab, carriage return and newline between tokens are ignored. Whitespace inside a token is not allowed, so `* *` is two multiplications, not a power, and is an error.

Meaning
- Arithmetic is ordinary IEEE double arithmetic. `%` is the JavaScript remainder (the result takes the sign of the left operand).
- `+` and `-` are binary operators and also prefix operators. A prefix `+` or `-` may be applied repeatedly (`--2` is 2, `+-+2` is -2).
- Precedence from loosest to tightest:
  1. binary `+` and `-`, left-associative
  2. `*`, `/` and `%`, left-associative
  3. prefix `+` and `-`
  4. `**`, right-associative
- `**` binds tighter than a prefix sign on its left, so `-2 ** 2` is -4. A prefix sign is allowed on the right-hand side of `**`, so `2 ** -1` is 0.5 and `2 ** -2 ** 2` is `2 ** -(2 ** 2)`. A prefix sign binds tighter than `*`, so `-7 % 4` is `(-7) % 4`.
- Operands are evaluated from left to right.

Errors
- Every error is an `ExprError` (exported, a subclass of `Error`) with a numeric `position` property: the 0-based index into the source string where the problem is. The message also contains the text `position N` where N is that index.
- An unexpected character is reported at its own index.
- An unexpected token (a number, operator or parenthesis that cannot appear there, such as the `2` in `1 2`, the `*` in `1 + * 2` or a `)` with no matching `(`) is reported at the token's first character.
- Running out of input where more is needed (`1 +`, `(1 + 2`, an empty expression, whitespace only) is reported at `source.length`.
- Division or remainder by exactly zero (`1 / 0`, `0 / 0`, `5 % 0`) is an `ExprError` reported at the index of the `/` or `%` operator. If several occur, the one evaluated first is reported.
- The whole source is read and checked for syntax before anything is evaluated, so a syntax error is reported even when an earlier part would divide by zero.
- A non-string argument throws a `TypeError`.
