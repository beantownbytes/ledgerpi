`cron.mjs` exports a stub `nextFire(expression, after)`. Implement it so it returns the first time strictly after `after` at which a five-field cron expression fires, as a new `Date`. All calendar arithmetic is in UTC; there are no time zones and no daylight saving.

Arguments
- `expression` is a string, otherwise `TypeError`. `after` is a `Date`, otherwise `TypeError`; an invalid `Date` is a `RangeError`.
- The result always has seconds and milliseconds equal to 0. "Strictly after" is exact: if `after` is `12:00:00.000` and the expression fires at 12:00, the result is a later firing, and if `after` is `11:59:59.999` the result can be 12:00 of that same day. The argument is never modified, and a new `Date` is returned.
- The result is `null` if the expression can never fire (for example `0 0 30 2 *`, February 30, or `0 0 31 4 *`).

Syntax
- Fields are separated by one or more spaces or tabs; leading and trailing whitespace is allowed. Exactly five fields are required, in this order: minute (0-59), hour (0-23), day of month (1-31), month (1-12 or `JAN`-`DEC`), day of week (0-7 or `SUN`-`SAT`, where both 0 and 7 mean Sunday). Names are case-insensitive, three letters, and are allowed only in their own field: month names in the month field, day names in the day-of-week field.
- A field is a comma-separated list of one or more items; an empty item (`1,,2`, a leading or trailing comma) is an error. Each item is one of:
  - `*` for every value of the field
  - `a` for a single value
  - `a-b` for the inclusive range a through b, which needs `a <= b`
  - `*/n` for every n-th value of the whole field, starting at its minimum
  - `a-b/n` for every n-th value within the range, starting at a
  - `a/n` for every n-th value from a up to the field's maximum, starting at a
- Numbers are plain decimal digits (no sign, no decimal point). Steps are positive integers; `0` is an error. A step larger than the span is fine (`*/45` in the minute field fires at minutes 0 and 45).
- For the day-of-week field, `*` and `*/n` and `a/n` use the values 0 through 6 (so `*/2` is Sunday, Tuesday, Thursday, Saturday and `1/2` is Monday, Wednesday, Friday; `7/n` is just Sunday). An explicit `7` is accepted as an end point or a single value and means Sunday, so `5-7` is Friday, Saturday, Sunday, and `0-7` is every day. Ranges are checked before the 7 is folded into 0, so `7-0` is an error.
- Any syntax problem throws a `SyntaxError`: wrong number of fields, a value outside the field's range, a name in the wrong field, an unknown name, a reversed range, an empty item, a zero or malformed step, `?`, `L`, `W`, `#`, and `@`-macros such as `@daily`. No other error type is thrown for a bad expression, and the expression is validated even when `after` is such that nothing would be reached.

Which days match
- A day-of-month field or day-of-week field is restricted when its text does not start with `*`; `*`, `*/2` and `*,5` all start with `*` and are not restricted.
- If both the day-of-month and the day-of-week fields are restricted, a day matches when its day of month is in the day-of-month set or its weekday is in the day-of-week set (OR). Otherwise, a day matches when its day of month is in the day-of-month set and its weekday is in the day-of-week set (AND), where an unrestricted field `*` allows everything and `*/n` allows only the values it lists.
- The month must also match in every case. A day that does not exist, such as 31 April, never matches by day of month, but can match by weekday under the OR rule.
- A time fires when the month, the day (by the rules above), the hour and the minute all match.
