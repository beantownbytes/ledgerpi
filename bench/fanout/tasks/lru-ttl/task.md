`lru.mjs` exports a stub class `LruTtlCache`. Implement an in-memory cache that holds at most `maxSize` entries, evicts the least recently used entry when it is full, and lets entries expire after a time to live. Time comes from an injectable clock, so the cache never needs real timers.

Constructor
- `new LruTtlCache({ maxSize, ttlMs, now, onEvict })`. The options object is required (`TypeError` if it is missing or not an object).
- `maxSize` is required and must be a positive integer, otherwise `RangeError`.
- `ttlMs` is the default time to live in milliseconds. It defaults to `Infinity` (entries never expire). Any number greater than 0, including `Infinity`, is allowed; anything else (0, negative, `NaN`, not a number) is a `RangeError`.
- `now` is a function returning the current time in milliseconds. It defaults to `Date.now`. A non-function is a `TypeError`.
- `onEvict` is an optional function `(key, value, reason)`. A non-function is a `TypeError`.

Entries and expiry
- Keys are compared like `Map` keys (same-value-zero). Any value, including `undefined`, can be stored.
- `set(key, value, ttlMs)` stores the entry and returns the cache. The optional third argument overrides the default time to live for this entry only, with the same validation (`RangeError`); it is validated before anything changes. The entry expires at `now() + ttl`.
- An entry is expired when `now() >= expiresAt`, so it is already expired at exactly the deadline.
- Reading never extends an entry's life. Only `set` (re)computes the expiry.
- Every public method and getter reads the clock exactly once, at the start of the call, and uses that single reading for everything it does. The constructor does not read the clock.

Recency
- Every entry has a recency position. `set` makes its entry the most recently used, whether the key is new or existing.
- `get(key)` returns the value of a live entry and makes it the most recently used. It returns `undefined` for a missing or expired key.
- `peek(key)` returns the same value as `get` but does not change the recency order.
- `has(key)` returns whether a live entry exists and does not change the recency order.
- `keys()` returns an array of the live keys from least recently used to most recently used.
- `size` is a getter returning the number of live entries.

Removing entries and `onEvict`
- Whenever an entry leaves the cache, `onEvict(key, value, reason)` is called if it was provided, with one of these reasons:
  - `"expired"`: the entry was found expired.
  - `"capacity"`: the entry was the least recently used live entry and room was needed for a new key.
  - `"replaced"`: `set` was called with a key that holds a live entry; the callback receives the old value.
  - `"deleted"`: removed by `delete(key)`.
  - `"cleared"`: a live entry removed by `clear()`.
- `get(key)`, `peek(key)`, `has(key)` and `delete(key)` remove the entry for their own key if it is found expired (reason `"expired"`). They do not look at other keys.
- `set`, `size` and `keys()` first remove every expired entry, from least to most recently used, each with reason `"expired"`. So when `set` is called with a key whose existing entry is expired, that entry is reported as `"expired"` in that sweep and not as `"replaced"`. After the sweep, a live entry for the same key is removed and reported as `"replaced"` before any capacity eviction.
- `set` with a new key, after expired entries are gone, evicts least recently used live entries one at a time (reason `"capacity"`) until there is room for one more, then inserts the new entry as the most recently used. Replacing a live key never evicts anyone else.
- `delete(key)` returns `true` if it removed a live entry and `false` otherwise (including when the entry was expired; it is still removed and reported).
- `clear()` removes everything. Expired entries are reported as `"expired"` and live entries as `"cleared"`, in order from least to most recently used.
- All of a call's changes to the cache are complete before the first `onEvict` call of that call is made, and the callbacks are then made in the order the entries were removed. So inside a callback triggered by `set(k, v)`, `peek(k)` already returns `v` and `size` already counts it. The callbacks may call back into the cache.
