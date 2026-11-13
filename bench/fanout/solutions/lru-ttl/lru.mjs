const isPositiveNumber = (value) => typeof value === "number" && value > 0;

export class LruTtlCache {
	#map = new Map();
	#maxSize;
	#ttlMs;
	#now;
	#onEvict;

	constructor(options) {
		if (typeof options !== "object" || options === null) throw new TypeError("options must be an object");
		const { maxSize, ttlMs = Infinity, now = Date.now, onEvict } = options;
		if (!Number.isInteger(maxSize) || maxSize < 1) throw new RangeError("maxSize must be a positive integer");
		if (!isPositiveNumber(ttlMs)) throw new RangeError("ttlMs must be a number greater than 0");
		if (typeof now !== "function") throw new TypeError("now must be a function");
		if (onEvict !== undefined && typeof onEvict !== "function") throw new TypeError("onEvict must be a function");
		this.#maxSize = maxSize;
		this.#ttlMs = ttlMs;
		this.#now = now;
		this.#onEvict = onEvict;
	}

	#emit(events) {
		if (!this.#onEvict) return;
		for (const [key, value, reason] of events) this.#onEvict(key, value, reason);
	}

	#purge(time, events) {
		for (const [key, entry] of this.#map) {
			if (entry.expiresAt <= time) {
				this.#map.delete(key);
				events.push([key, entry.value, "expired"]);
			}
		}
	}

	#live(key, time) {
		const entry = this.#map.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt > time) return entry;
		this.#map.delete(key);
		this.#emit([[key, entry.value, "expired"]]);
		return undefined;
	}

	set(key, value, ttlMs = this.#ttlMs) {
		if (!isPositiveNumber(ttlMs)) throw new RangeError("ttlMs must be a number greater than 0");
		const time = this.#now();
		const events = [];
		this.#purge(time, events);
		const old = this.#map.get(key);
		if (old) {
			this.#map.delete(key);
			events.push([key, old.value, "replaced"]);
		}
		while (this.#map.size >= this.#maxSize) {
			const [oldestKey, oldest] = this.#map.entries().next().value;
			this.#map.delete(oldestKey);
			events.push([oldestKey, oldest.value, "capacity"]);
		}
		this.#map.set(key, { value, expiresAt: time + ttlMs });
		this.#emit(events);
		return this;
	}

	get(key) {
		const time = this.#now();
		const entry = this.#live(key, time);
		if (!entry) return undefined;
		this.#map.delete(key);
		this.#map.set(key, entry);
		return entry.value;
	}

	peek(key) {
		return this.#live(key, this.#now())?.value;
	}

	has(key) {
		return this.#live(key, this.#now()) !== undefined;
	}

	delete(key) {
		const entry = this.#live(key, this.#now());
		if (!entry) return false;
		this.#map.delete(key);
		this.#emit([[key, entry.value, "deleted"]]);
		return true;
	}

	clear() {
		const time = this.#now();
		const events = [];
		for (const [key, entry] of this.#map) {
			events.push([key, entry.value, entry.expiresAt <= time ? "expired" : "cleared"]);
		}
		this.#map.clear();
		this.#emit(events);
	}

	keys() {
		const events = [];
		this.#purge(this.#now(), events);
		const keys = [...this.#map.keys()];
		this.#emit(events);
		return keys;
	}

	get size() {
		const events = [];
		this.#purge(this.#now(), events);
		const size = this.#map.size;
		this.#emit(events);
		return size;
	}
}
