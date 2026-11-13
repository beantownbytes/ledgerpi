`intervals.mjs` exports stub functions `merge(intervals)`, `insert(intervals, interval)` and `subtract(intervals, hole)`. Implement them. They work on sets of real numbers described as lists of intervals with open or closed endpoints.

Intervals
- An interval is an object `{ lo, hi, loOpen, hiOpen }`. `lo` and `hi` are finite numbers. `loOpen` and `hiOpen` are booleans and default to `false` (closed) when omitted. `{ lo: 1, hi: 2, hiOpen: true }` is the half-open interval [1, 2).
- An interval is empty when `lo > hi`, or when `lo === hi` and either end is open. A single point is the interval with `lo === hi` and both ends closed. Empty intervals contain no numbers; they are dropped from every input and have no effect on the result.
- A `TypeError` is thrown for an interval that is not an object, whose `lo` or `hi` is not a finite number, or whose `loOpen` or `hiOpen` is present but not a boolean, and for an argument that should be an array and is not. This is checked for empty intervals too.

Normal form
- Every function returns a new array in normal form: the intervals are non-empty, sorted by `lo`, and pairwise disjoint, and no two of them could be joined into one interval without adding or losing a number. Every returned interval is a fresh object with all four properties present (`loOpen` and `hiOpen` always booleans).
- The inputs are never modified, and the returned intervals do not share objects with the inputs.

Functions
- `merge(intervals)` returns the union of the intervals in normal form. The input list may be in any order and may overlap.
- Two intervals join when they overlap or when they meet at a single point that at least one of them includes: `[1, 2]` and `[2, 3]` give `[1, 3]`; `[1, 2)` and `[2, 3]` give `[1, 3]`; `[1, 2]` and `(2, 3]` give `[1, 3]`. But `[1, 2)` and `(2, 3]` stay separate, because the point 2 is in neither.
- When joined intervals end at the same number, the combined end is open only if every interval that ends there is open there. The same holds for starts.
- `insert(intervals, interval)` returns the union of `intervals` and `interval` in normal form. `intervals` need not be in normal form. Inserting an empty interval just normalizes the list.
- `subtract(intervals, hole)` returns the numbers that are in some interval of `intervals` but not in `hole`, in normal form. `hole` is one interval. Removing a closed end of `hole` leaves an open end behind and vice versa, so removing `[2, 4]` from `[0, 10]` leaves `[0, 2)` and `(4, 10]`. Removing `(2, 4)` from `[0, 10]` leaves `[0, 2]` and `[4, 10]`. Removing an empty hole changes nothing apart from normalization. Subtraction can leave single points, for example removing `(1, 3)` from `[1, 3]` leaves `[1, 1]` and `[3, 3]`.
