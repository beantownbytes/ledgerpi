import assert from "node:assert/strict";
import { LruTtlCache } from "./lru.mjs";

let failed = 0;
function check(name, fn) {
	try {
		fn();
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}: ${error.message}`);
	}
}

/** Builds a cache with a manual clock and an eviction log of "key:value:reason" strings. */
function setup(options = {}) {
	const clock = { time: 1000, reads: 0 };
	const log = [];
	const cache = new LruTtlCache({
		maxSize: 3,
		now: () => {
			clock.reads++;
			return clock.time;
		},
		onEvict: (key, value, reason) => log.push(`${String(key)}:${String(value)}:${reason}`),
		...options,
	});
	return { cache, clock, log };
}

check("basic set, get, has, size", () => {
	const { cache } = setup();
	assert.equal(cache.size, 0);
	assert.equal(cache.get("a"), undefined);
	assert.equal(cache.set("a", 1), cache);
	cache.set("b", 2);
	assert.equal(cache.get("a"), 1);
	assert.equal(cache.get("b"), 2);
	assert.equal(cache.has("a"), true);
	assert.equal(cache.has("z"), false);
	assert.equal(cache.size, 2);
});

check("constructor validation", () => {
	assert.throws(() => new LruTtlCache(), TypeError);
	assert.throws(() => new LruTtlCache(null), TypeError);
	assert.throws(() => new LruTtlCache({}), RangeError);
	assert.throws(() => new LruTtlCache({ maxSize: 0 }), RangeError);
	assert.throws(() => new LruTtlCache({ maxSize: -1 }), RangeError);
	assert.throws(() => new LruTtlCache({ maxSize: 1.5 }), RangeError);
	assert.throws(() => new LruTtlCache({ maxSize: "2" }), RangeError);
	assert.throws(() => new LruTtlCache({ maxSize: 2, ttlMs: 0 }), RangeError);
	assert.throws(() => new LruTtlCache({ maxSize: 2, ttlMs: -5 }), RangeError);
	assert.throws(() => new LruTtlCache({ maxSize: 2, ttlMs: Number.NaN }), RangeError);
	assert.throws(() => new LruTtlCache({ maxSize: 2, ttlMs: "100" }), RangeError);
	assert.throws(() => new LruTtlCache({ maxSize: 2, now: 5 }), TypeError);
	assert.throws(() => new LruTtlCache({ maxSize: 2, onEvict: "x" }), TypeError);
	assert.doesNotThrow(() => new LruTtlCache({ maxSize: 1, ttlMs: Number.POSITIVE_INFINITY }));
	assert.doesNotThrow(() => new LruTtlCache({ maxSize: 1 }));
});

check("the default clock is Date.now", () => {
	const cache = new LruTtlCache({ maxSize: 2, ttlMs: 60_000 });
	cache.set("a", 1);
	assert.equal(cache.get("a"), 1);
	cache.set("b", 2, 1);
	const after = Date.now();
	while (Date.now() <= after + 2) {
		// wait for the real clock to pass the entry's deadline
	}
	assert.equal(cache.get("b"), undefined);
});

check("constructor does not read the clock", () => {
	const { clock } = setup();
	assert.equal(clock.reads, 0);
});

check("capacity evicts the least recently used entry", () => {
	const { cache, log } = setup();
	cache.set("a", 1).set("b", 2).set("c", 3);
	cache.set("d", 4);
	assert.deepEqual(cache.keys(), ["b", "c", "d"]);
	assert.deepEqual(log, ["a:1:capacity"]);
	assert.equal(cache.size, 3);
	assert.equal(cache.get("a"), undefined);
});

check("get makes an entry most recently used", () => {
	const { cache, log } = setup();
	cache.set("a", 1).set("b", 2).set("c", 3);
	assert.equal(cache.get("a"), 1);
	assert.deepEqual(cache.keys(), ["b", "c", "a"]);
	cache.set("d", 4);
	assert.deepEqual(cache.keys(), ["c", "a", "d"]);
	assert.deepEqual(log, ["b:2:capacity"]);
});

check("peek and has do not change the order", () => {
	const { cache, log } = setup();
	cache.set("a", 1).set("b", 2).set("c", 3);
	assert.equal(cache.peek("a"), 1);
	assert.equal(cache.has("a"), true);
	assert.deepEqual(cache.keys(), ["a", "b", "c"]);
	cache.set("d", 4);
	assert.deepEqual(log, ["a:1:capacity"]);
	assert.equal(cache.peek("zzz"), undefined);
});

check("set on an existing key refreshes recency and replaces the value", () => {
	const { cache, log } = setup();
	cache.set("a", 1).set("b", 2).set("c", 3);
	cache.set("a", 10);
	assert.deepEqual(cache.keys(), ["b", "c", "a"]);
	assert.equal(cache.peek("a"), 10);
	assert.deepEqual(log, ["a:1:replaced"]);
	assert.equal(cache.size, 3);
});

check("replacing a live key never evicts another entry", () => {
	const { cache, log } = setup({ maxSize: 2 });
	cache.set("a", 1).set("b", 2);
	cache.set("b", 3).set("a", 4).set("a", 5);
	assert.deepEqual(cache.keys(), ["b", "a"]);
	assert.deepEqual(log, ["b:2:replaced", "a:1:replaced", "a:4:replaced"]);
});

check("maxSize of one", () => {
	const { cache, log } = setup({ maxSize: 1 });
	cache.set("a", 1).set("b", 2);
	assert.deepEqual(cache.keys(), ["b"]);
	assert.deepEqual(log, ["a:1:capacity"]);
});

check("entries expire at the deadline", () => {
	const { cache, clock, log } = setup({ ttlMs: 100 });
	cache.set("a", 1);
	clock.time = 1099;
	assert.equal(cache.get("a"), 1);
	clock.time = 1100;
	assert.equal(cache.get("a"), undefined);
	assert.deepEqual(log, ["a:1:expired"]);
	assert.equal(cache.size, 0);
});

check("reading does not extend the time to live", () => {
	const { cache, clock } = setup({ ttlMs: 100 });
	cache.set("a", 1);
	clock.time = 1090;
	assert.equal(cache.get("a"), 1);
	assert.equal(cache.peek("a"), 1);
	clock.time = 1100;
	assert.equal(cache.has("a"), false);
});

check("set resets the expiry", () => {
	const { cache, clock } = setup({ ttlMs: 100 });
	cache.set("a", 1);
	clock.time = 1090;
	cache.set("a", 2);
	clock.time = 1150;
	assert.equal(cache.get("a"), 2);
	clock.time = 1190;
	assert.equal(cache.get("a"), undefined);
});

check("per-entry ttl overrides the default", () => {
	const { cache, clock } = setup({ ttlMs: 100 });
	cache.set("short", 1, 10);
	cache.set("long", 2, 500);
	cache.set("default", 3);
	clock.time = 1010;
	assert.equal(cache.has("short"), false);
	assert.equal(cache.has("default"), true);
	clock.time = 1100;
	assert.equal(cache.has("default"), false);
	assert.equal(cache.has("long"), true);
	clock.time = 1500;
	assert.equal(cache.has("long"), false);
});

check("a per-entry ttl is validated before anything changes", () => {
	const { cache, log } = setup();
	cache.set("a", 1);
	assert.throws(() => cache.set("a", 2, 0), RangeError);
	assert.throws(() => cache.set("b", 2, -1), RangeError);
	assert.throws(() => cache.set("b", 2, Number.NaN), RangeError);
	assert.throws(() => cache.set("b", 2, "5"), RangeError);
	assert.deepEqual(cache.keys(), ["a"]);
	assert.equal(cache.peek("a"), 1);
	assert.deepEqual(log, []);
	assert.doesNotThrow(() => cache.set("c", 3, Number.POSITIVE_INFINITY));
});

check("entries without a ttl never expire", () => {
	const { cache, clock } = setup();
	cache.set("a", 1);
	clock.time = Number.MAX_SAFE_INTEGER;
	assert.equal(cache.get("a"), 1);
});

check("get on an expired key removes it and reports it", () => {
	const { cache, clock, log } = setup({ ttlMs: 50 });
	cache.set("a", 1).set("b", 2);
	clock.time = 1060;
	assert.equal(cache.get("a"), undefined);
	assert.deepEqual(log, ["a:1:expired"]);
	assert.equal(cache.get("a"), undefined);
	assert.deepEqual(log, ["a:1:expired"]);
});

check("peek and has on an expired key remove only that key", () => {
	const { cache, clock, log } = setup({ ttlMs: 50 });
	cache.set("a", 1);
	cache.set("b", 2, 500);
	cache.set("c", 3);
	clock.time = 1060;
	assert.equal(cache.peek("a"), undefined);
	assert.deepEqual(log, ["a:1:expired"]);
	assert.equal(cache.has("c"), false);
	assert.deepEqual(log, ["a:1:expired", "c:3:expired"]);
	assert.equal(cache.has("b"), true);
});

check("get on a missing or live key does not look at other keys", () => {
	const { cache, clock, log } = setup({ ttlMs: 50 });
	cache.set("a", 1);
	cache.set("b", 2, 500);
	clock.time = 1060;
	assert.equal(cache.get("b"), 2);
	assert.equal(cache.get("nothing"), undefined);
	assert.deepEqual(log, []);
	assert.deepEqual(cache.keys(), ["b"]);
	assert.deepEqual(log, ["a:1:expired"]);
});

check("size and keys purge expired entries from least to most recently used", () => {
	const { cache, clock, log } = setup({ ttlMs: 50 });
	cache.set("a", 1).set("b", 2).set("c", 3, 500);
	cache.get("a");
	clock.time = 1060;
	assert.equal(cache.size, 1);
	assert.deepEqual(log, ["b:2:expired", "a:1:expired"]);
	assert.deepEqual(cache.keys(), ["c"]);
});

check("set purges expired entries before evicting for capacity", () => {
	const { cache, clock, log } = setup({ ttlMs: 100 });
	cache.set("old", 1, 10);
	cache.set("b", 2);
	cache.set("c", 3);
	clock.time = 1020;
	cache.set("d", 4);
	assert.deepEqual(log, ["old:1:expired"]);
	assert.deepEqual(cache.keys(), ["b", "c", "d"]);
});

check("set purges every expired entry, not only as many as needed", () => {
	const { cache, clock, log } = setup({ maxSize: 5, ttlMs: 100 });
	cache.set("a", 1, 10).set("b", 2, 10).set("c", 3);
	clock.time = 1020;
	cache.set("d", 4);
	assert.deepEqual(log, ["a:1:expired", "b:2:expired"]);
	assert.deepEqual(cache.keys(), ["c", "d"]);
});

check("set on an expired key reports expired, not replaced", () => {
	const { cache, clock, log } = setup({ ttlMs: 100 });
	cache.set("a", 1, 10);
	clock.time = 1020;
	cache.set("a", 2);
	assert.deepEqual(log, ["a:1:expired"]);
	assert.equal(cache.get("a"), 2);
});

check("eviction order within one set call", () => {
	const { cache, clock, log } = setup({ maxSize: 2, ttlMs: 100 });
	cache.set("x", 1, 10).set("a", 2);
	clock.time = 1020;
	cache.set("a", 3);
	assert.deepEqual(log, ["x:1:expired", "a:2:replaced"]);
	cache.set("b", 4).set("c", 5);
	assert.deepEqual(log, ["x:1:expired", "a:2:replaced", "a:3:capacity"]);
});

check("an expired entry does not count against the capacity", () => {
	const { cache, clock, log } = setup({ maxSize: 2, ttlMs: 100 });
	cache.set("a", 1, 10).set("b", 2);
	clock.time = 1020;
	cache.set("c", 3);
	assert.deepEqual(log, ["a:1:expired"]);
	assert.deepEqual(cache.keys(), ["b", "c"]);
});

check("delete", () => {
	const { cache, log } = setup();
	cache.set("a", 1).set("b", 2);
	assert.equal(cache.delete("a"), true);
	assert.equal(cache.delete("a"), false);
	assert.equal(cache.delete("never"), false);
	assert.deepEqual(log, ["a:1:deleted"]);
	assert.deepEqual(cache.keys(), ["b"]);
});

check("delete of an expired entry returns false and reports expired", () => {
	const { cache, clock, log } = setup({ ttlMs: 10 });
	cache.set("a", 1);
	clock.time = 1010;
	assert.equal(cache.delete("a"), false);
	assert.deepEqual(log, ["a:1:expired"]);
	assert.equal(cache.size, 0);
});

check("clear reports expired and live entries in recency order", () => {
	const { cache, clock, log } = setup({ maxSize: 4, ttlMs: 100 });
	cache.set("a", 1, 10).set("b", 2).set("c", 3, 10).set("d", 4);
	clock.time = 1020;
	cache.clear();
	assert.deepEqual(log, ["a:1:expired", "b:2:cleared", "c:3:expired", "d:4:cleared"]);
	assert.equal(cache.size, 0);
	assert.deepEqual(cache.keys(), []);
	cache.clear();
	assert.equal(log.length, 4);
});

check("callbacks run after the call's changes are complete", () => {
	const seen = [];
	let cache;
	const clock = { time: 0 };
	cache = new LruTtlCache({
		maxSize: 2,
		now: () => clock.time,
		onEvict: (key, _value, reason) => {
			seen.push([key, reason, cache.peek("c"), cache.size, cache.keys().join("")]);
		},
	});
	cache.set("a", 1).set("b", 2);
	cache.set("c", 3);
	assert.deepEqual(seen, [["a", "capacity", 3, 2, "bc"]]);
});

check("callbacks may call back into the cache", () => {
	const log = [];
	let cache;
	cache = new LruTtlCache({
		maxSize: 1,
		onEvict: (key, value, reason) => {
			log.push(`${key}:${reason}`);
			if (reason === "capacity" && !key.endsWith("-again")) cache.set(`${key}-again`, value);
		},
	});
	cache.set("a", 1);
	cache.set("b", 2);
	assert.deepEqual(log, ["a:capacity", "b:capacity", "a-again:capacity"]);
	assert.deepEqual(cache.keys(), ["b-again"]);
});

check("every public call reads the clock exactly once", () => {
	const { cache, clock } = setup({ ttlMs: 100 });
	const reads = (fn) => {
		const before = clock.reads;
		fn();
		return clock.reads - before;
	};
	assert.equal(
		reads(() => cache.set("a", 1)),
		1,
	);
	assert.equal(
		reads(() => cache.get("a")),
		1,
	);
	assert.equal(
		reads(() => cache.get("zzz")),
		1,
	);
	assert.equal(
		reads(() => cache.peek("a")),
		1,
	);
	assert.equal(
		reads(() => cache.has("a")),
		1,
	);
	assert.equal(
		reads(() => cache.delete("a")),
		1,
	);
	assert.equal(
		reads(() => cache.size),
		1,
	);
	assert.equal(
		reads(() => cache.keys()),
		1,
	);
	assert.equal(
		reads(() => cache.clear()),
		1,
	);
});

check("one clock reading is used for the whole call", () => {
	let time = 1000;
	const cache = new LruTtlCache({ maxSize: 5, ttlMs: 10, now: () => time++ });
	cache.set("a", 1);
	cache.set("b", 2);
	assert.deepEqual(cache.keys(), ["a", "b"]);
	time = 1100;
	assert.deepEqual(cache.keys(), []);
});

check("keys use map semantics and values may be undefined", () => {
	const { cache } = setup({ maxSize: 5 });
	cache.set(Number.NaN, "nan").set(0, "zero").set("0", "string zero").set(undefined, undefined);
	assert.equal(cache.get(Number.NaN), "nan");
	assert.equal(cache.get(-0), "zero");
	assert.equal(cache.get("0"), "string zero");
	assert.equal(cache.has(undefined), true);
	assert.equal(cache.get(undefined), undefined);
	const object = {};
	cache.set(object, 1);
	assert.equal(cache.get({}), undefined);
	assert.equal(cache.get(object), 1);
});

check("works without an eviction callback", () => {
	const cache = new LruTtlCache({ maxSize: 1, ttlMs: 5, now: () => 0 });
	cache.set("a", 1).set("b", 2);
	assert.equal(cache.delete("b"), true);
	cache.set("c", 3);
	cache.clear();
	assert.equal(cache.size, 0);
});

check("separate caches do not share state", () => {
	const one = new LruTtlCache({ maxSize: 2 });
	const two = new LruTtlCache({ maxSize: 2 });
	one.set("a", 1);
	assert.equal(two.has("a"), false);
	assert.equal(two.size, 0);
});

if (failed > 0) process.exit(1);
