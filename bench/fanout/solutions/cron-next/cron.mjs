const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_SEARCH_DAYS = 366 * 9;

const FIELDS = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
	{ name: "day of week", min: 0, max: 6, names: WEEKDAYS, nameBase: 0, allowed: 7 },
];

function parseValue(field, text) {
	if (/^\d+$/.test(text)) {
		const value = Number(text);
		if (value < field.min || value > (field.allowed ?? field.max)) {
			throw new SyntaxError(`${field.name}: ${text} is out of range`);
		}
		return value;
	}
	const index = field.names?.indexOf(text.toUpperCase()) ?? -1;
	if (index < 0) throw new SyntaxError(`${field.name}: invalid value ${JSON.stringify(text)}`);
	return index + field.nameBase;
}

function parseItem(field, item) {
	const [rangeText, stepText, ...extra] = item.split("/");
	if (extra.length > 0) throw new SyntaxError(`${field.name}: invalid item ${JSON.stringify(item)}`);
	let step = 1;
	if (stepText !== undefined) {
		if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
			throw new SyntaxError(`${field.name}: invalid step ${JSON.stringify(stepText)}`);
		}
		step = Number(stepText);
	}
	let lo;
	let hi;
	if (rangeText === "*") {
		lo = field.min;
		hi = field.max;
	} else {
		const [loText, hiText, ...more] = rangeText.split("-");
		if (more.length > 0) throw new SyntaxError(`${field.name}: invalid item ${JSON.stringify(item)}`);
		lo = parseValue(field, loText);
		if (hiText !== undefined) {
			hi = parseValue(field, hiText);
			if (lo > hi) throw new SyntaxError(`${field.name}: reversed range ${JSON.stringify(item)}`);
		} else {
			hi = stepText === undefined ? lo : Math.max(lo, field.max);
		}
	}
	const values = [];
	for (let value = lo; value <= hi; value += step) values.push(field.allowed && value === field.allowed ? 0 : value);
	return values;
}

function parseField(field, text) {
	const values = new Set();
	for (const item of text.split(",")) {
		if (item === "") throw new SyntaxError(`${field.name}: empty list item`);
		for (const value of parseItem(field, item)) values.add(value);
	}
	return values;
}

function parseExpression(expression) {
	const parts = expression.trim().split(/[ \t]+/);
	if (parts.length !== 5) throw new SyntaxError(`expected 5 fields, got ${parts.length}`);
	const [minute, hour, dayOfMonth, month, dayOfWeek] = FIELDS.map((field, i) => parseField(field, parts[i]));
	return {
		minute: [...minute].sort((a, b) => a - b),
		hour: [...hour].sort((a, b) => a - b),
		dayOfMonth,
		month,
		dayOfWeek,
		bothRestricted: !parts[2].startsWith("*") && !parts[4].startsWith("*"),
	};
}

function dayMatches(schedule, date) {
	const byDate = schedule.dayOfMonth.has(date.getUTCDate());
	const byWeekday = schedule.dayOfWeek.has(date.getUTCDay());
	return schedule.bothRestricted ? byDate || byWeekday : byDate && byWeekday;
}

export function nextFire(expression, after) {
	if (typeof expression !== "string") throw new TypeError("expression must be a string");
	if (!(after instanceof Date)) throw new TypeError("after must be a Date");
	if (Number.isNaN(after.getTime())) throw new RangeError("after is an invalid Date");
	const schedule = parseExpression(expression);

	const start = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
	const firstDay = Math.floor(start / DAY_MS) * DAY_MS;
	for (let offset = 0; offset < MAX_SEARCH_DAYS; offset++) {
		const dayStart = firstDay + offset * DAY_MS;
		const date = new Date(dayStart);
		if (!schedule.month.has(date.getUTCMonth() + 1) || !dayMatches(schedule, date)) continue;
		for (const hour of schedule.hour) {
			for (const minute of schedule.minute) {
				const time = dayStart + hour * 3_600_000 + minute * MINUTE_MS;
				if (time >= start) return new Date(time);
			}
		}
	}
	return null;
}
