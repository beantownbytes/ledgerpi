import assert from "node:assert/strict";
import { nextFire } from "./cron.mjs";

let failed = 0;
function check(name, fn) {
	try {
		fn();
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}: ${error.message}`);
	}
}

const BASE = "2024-03-13T10:20:30.000Z";

/** Returns the next fire time as an ISO string, or null. */
function next(expression, after = BASE) {
	const result = nextFire(expression, new Date(after));
	return result === null ? null : result.toISOString();
}
const fires = (expression, after, expected) =>
	assert.equal(next(expression, after), expected, `${expression} after ${after}`);

check("every minute", () => {
	fires("* * * * *", BASE, "2024-03-13T10:21:00.000Z");
	fires("* * * * *", "2024-03-13T10:20:00.000Z", "2024-03-13T10:21:00.000Z");
	fires("* * * * *", "2024-03-13T23:59:00.000Z", "2024-03-14T00:00:00.000Z");
});

check("a fixed time of day", () => {
	fires("30 10 * * *", BASE, "2024-03-13T10:30:00.000Z");
	fires("15 10 * * *", BASE, "2024-03-14T10:15:00.000Z");
	fires("0 0 * * *", BASE, "2024-03-14T00:00:00.000Z");
	fires("59 23 * * *", BASE, "2024-03-13T23:59:00.000Z");
});

check("the result is strictly after the given time", () => {
	fires("30 10 * * *", "2024-03-13T10:29:59.999Z", "2024-03-13T10:30:00.000Z");
	fires("30 10 * * *", "2024-03-13T10:30:00.000Z", "2024-03-14T10:30:00.000Z");
	fires("30 10 * * *", "2024-03-13T10:30:00.001Z", "2024-03-14T10:30:00.000Z");
	fires("30 10 * * *", "2024-03-13T10:30:59.999Z", "2024-03-14T10:30:00.000Z");
	fires("* * * * *", "2024-03-13T10:20:59.999Z", "2024-03-13T10:21:00.000Z");
});

check("the argument is not modified and a new Date is returned", () => {
	const after = new Date(BASE);
	const result = nextFire("* * * * *", after);
	assert.ok(result instanceof Date);
	assert.notEqual(result, after);
	assert.equal(after.toISOString(), BASE);
	assert.equal(result.getUTCSeconds(), 0);
	assert.equal(result.getUTCMilliseconds(), 0);
});

check("minute lists, ranges and duplicates", () => {
	fires("5,20,40 * * * *", "2024-03-13T10:20:00.000Z", "2024-03-13T10:40:00.000Z");
	fires("5,20,40 * * * *", "2024-03-13T10:40:00.000Z", "2024-03-13T11:05:00.000Z");
	fires("40,5,20 * * * *", "2024-03-13T10:20:00.000Z", "2024-03-13T10:40:00.000Z");
	fires("5,5,5 * * * *", "2024-03-13T10:05:00.000Z", "2024-03-13T11:05:00.000Z");
	fires("10-12 9 * * *", "2024-03-13T09:12:00.000Z", "2024-03-14T09:10:00.000Z");
	fires("10-12 9 * * *", "2024-03-13T09:10:00.000Z", "2024-03-13T09:11:00.000Z");
});

check("hour and minute lists combine", () => {
	fires("0,30 8-10 * * *", "2024-03-13T08:30:00.000Z", "2024-03-13T09:00:00.000Z");
	fires("0,30 8-10 * * *", "2024-03-13T10:30:00.000Z", "2024-03-14T08:00:00.000Z");
	fires("0 22,3 * * *", "2024-03-13T03:00:00.000Z", "2024-03-13T22:00:00.000Z");
	fires("15 22,3 * * *", "2024-03-13T22:15:00.000Z", "2024-03-14T03:15:00.000Z");
});

check("steps over the whole field", () => {
	fires("*/15 * * * *", BASE, "2024-03-13T10:30:00.000Z");
	fires("*/15 * * * *", "2024-03-13T10:45:00.000Z", "2024-03-13T11:00:00.000Z");
	fires("*/45 * * * *", "2024-03-13T10:00:00.000Z", "2024-03-13T10:45:00.000Z");
	fires("*/45 * * * *", "2024-03-13T10:45:00.000Z", "2024-03-13T11:00:00.000Z");
	fires("0 */6 * * *", "2024-03-13T13:00:00.000Z", "2024-03-13T18:00:00.000Z");
	fires("0 */6 * * *", "2024-03-13T18:00:00.000Z", "2024-03-14T00:00:00.000Z");
});

check("steps from a start value and within ranges", () => {
	fires("5/20 * * * *", "2024-03-13T10:05:00.000Z", "2024-03-13T10:25:00.000Z");
	fires("5/20 * * * *", "2024-03-13T10:45:00.000Z", "2024-03-13T11:05:00.000Z");
	fires("10-30/10 * * * *", "2024-03-13T10:30:00.000Z", "2024-03-13T11:10:00.000Z");
	fires("10-30/10 * * * *", "2024-03-13T10:11:00.000Z", "2024-03-13T10:20:00.000Z");
	fires("0 9-17/4 * * *", "2024-03-13T13:00:00.000Z", "2024-03-13T17:00:00.000Z");
	fires("0 9-17/4 * * *", "2024-03-13T17:00:00.000Z", "2024-03-14T09:00:00.000Z");
});

check("day of month lists, ranges and steps", () => {
	fires("0 0 1,15 * *", BASE, "2024-03-15T00:00:00.000Z");
	fires("0 0 1,15 * *", "2024-03-15T00:00:00.000Z", "2024-04-01T00:00:00.000Z");
	fires("0 0 28-31 * *", "2024-02-29T00:00:00.000Z", "2024-03-28T00:00:00.000Z");
	fires("0 0 */10 * *", "2024-03-21T00:00:00.000Z", "2024-03-31T00:00:00.000Z");
	fires("0 0 */10 * *", "2024-03-31T00:00:00.000Z", "2024-04-01T00:00:00.000Z");
});

check("months by number and by name", () => {
	fires("0 0 1 12 *", BASE, "2024-12-01T00:00:00.000Z");
	fires("0 0 1 JAN *", BASE, "2025-01-01T00:00:00.000Z");
	fires("0 0 1 jan *", BASE, "2025-01-01T00:00:00.000Z");
	fires("0 0 1 Jul,jan *", BASE, "2024-07-01T00:00:00.000Z");
	fires("0 0 1 mar-may *", "2024-05-01T00:00:00.000Z", "2025-03-01T00:00:00.000Z");
	fires("0 0 1 mar-may *", "2024-03-01T00:00:00.000Z", "2024-04-01T00:00:00.000Z");
});

check("month steps", () => {
	fires("0 0 1 */3 *", BASE, "2024-04-01T00:00:00.000Z");
	fires("0 0 1 1-12/5 *", "2024-06-01T00:00:00.000Z", "2024-11-01T00:00:00.000Z");
	fires("0 0 1 JAN-DEC/6 *", BASE, "2024-07-01T00:00:00.000Z");
});

check("year rollover", () => {
	fires("0 0 1 1 *", "2024-12-31T23:59:59.999Z", "2025-01-01T00:00:00.000Z");
	fires("59 23 31 12 *", "2024-12-31T23:59:00.000Z", "2025-12-31T23:59:00.000Z");
	fires("* * * * *", "2024-12-31T23:59:30.000Z", "2025-01-01T00:00:00.000Z");
});

check("short months", () => {
	fires("0 0 31 * *", "2024-04-15T00:00:00.000Z", "2024-05-31T00:00:00.000Z");
	fires("0 0 31 * *", "2024-05-31T00:00:00.000Z", "2024-07-31T00:00:00.000Z");
	fires("0 0 30 * *", "2024-01-30T00:00:00.000Z", "2024-03-30T00:00:00.000Z");
	fires("0 0 31 * *", "2023-12-31T00:00:00.000Z", "2024-01-31T00:00:00.000Z");
});

check("February 29", () => {
	fires("0 0 29 2 *", "2023-03-01T00:00:00.000Z", "2024-02-29T00:00:00.000Z");
	fires("0 0 29 2 *", "2024-02-29T00:00:00.000Z", "2028-02-29T00:00:00.000Z");
	fires("0 0 29 2 *", "2096-03-01T00:00:00.000Z", "2104-02-29T00:00:00.000Z");
	fires("0 0 28 2 *", "2024-02-28T00:00:00.000Z", "2025-02-28T00:00:00.000Z");
});

check("an expression that can never fire gives null", () => {
	assert.equal(nextFire("0 0 30 2 *", new Date(BASE)), null);
	assert.equal(nextFire("0 0 31 4 *", new Date(BASE)), null);
	assert.equal(nextFire("0 0 31 2,4,6,9,11 *", new Date(BASE)), null);
	assert.equal(nextFire("* * 30-31 2 *", new Date(BASE)), null);
});

check("day of week by number, 7 and name", () => {
	fires("0 12 * * 1", BASE, "2024-03-18T12:00:00.000Z");
	fires("0 12 * * MON", BASE, "2024-03-18T12:00:00.000Z");
	fires("0 12 * * mon", BASE, "2024-03-18T12:00:00.000Z");
	fires("0 12 * * 0", BASE, "2024-03-17T12:00:00.000Z");
	fires("0 12 * * 7", BASE, "2024-03-17T12:00:00.000Z");
	fires("0 12 * * Sun", BASE, "2024-03-17T12:00:00.000Z");
	fires("0 12 * * 5", BASE, "2024-03-15T12:00:00.000Z");
	fires("0 12 * * 5", "2024-03-15T12:00:00.000Z", "2024-03-22T12:00:00.000Z");
	fires("0 12 * * 5", "2024-03-15T11:59:00.000Z", "2024-03-15T12:00:00.000Z");
});

check("day of week lists and ranges", () => {
	fires("0 12 * * 1-5", "2024-03-15T12:00:00.000Z", "2024-03-18T12:00:00.000Z");
	fires("0 12 * * MON-FRI", "2024-03-15T12:00:00.000Z", "2024-03-18T12:00:00.000Z");
	fires("0 12 * * mon,wed,FRI", BASE, "2024-03-13T12:00:00.000Z");
	fires("0 12 * * mon,wed,FRI", "2024-03-13T12:00:00.000Z", "2024-03-15T12:00:00.000Z");
	fires("0 12 * * 6,0", BASE, "2024-03-16T12:00:00.000Z");
	fires("0 12 * * fRi", BASE, "2024-03-15T12:00:00.000Z");
});

check("a range that ends at 7 includes Sunday", () => {
	fires("0 12 * * 5-7", "2024-03-15T12:00:00.000Z", "2024-03-16T12:00:00.000Z");
	fires("0 12 * * 5-7", "2024-03-16T12:00:00.000Z", "2024-03-17T12:00:00.000Z");
	fires("0 12 * * 5-7", "2024-03-17T12:00:00.000Z", "2024-03-22T12:00:00.000Z");
	fires("0 12 * * 0-7", "2024-03-17T12:00:00.000Z", "2024-03-18T12:00:00.000Z");
	fires("0 12 * * 6-7", BASE, "2024-03-16T12:00:00.000Z");
	fires("0 12 * * 7-7", BASE, "2024-03-17T12:00:00.000Z");
});

check("day of week steps use 0 through 6", () => {
	fires("0 12 * * */2", BASE, "2024-03-14T12:00:00.000Z");
	fires("0 12 * * */2", "2024-03-14T12:00:00.000Z", "2024-03-16T12:00:00.000Z");
	fires("0 12 * * */2", "2024-03-16T12:00:00.000Z", "2024-03-17T12:00:00.000Z");
	fires("0 12 * * 1/2", "2024-03-13T12:00:00.000Z", "2024-03-15T12:00:00.000Z");
	fires("0 12 * * 1/2", "2024-03-15T12:00:00.000Z", "2024-03-18T12:00:00.000Z");
	fires("0 12 * * MON-FRI/2", "2024-03-13T12:00:00.000Z", "2024-03-15T12:00:00.000Z");
	fires("0 12 * * 1-5/2", "2024-03-15T12:00:00.000Z", "2024-03-18T12:00:00.000Z");
	fires("0 12 * * 7/2", BASE, "2024-03-17T12:00:00.000Z");
});

check("both day fields restricted: either one matches", () => {
	fires("0 12 13 * 5", "2024-03-13T12:00:00.000Z", "2024-03-15T12:00:00.000Z");
	fires("0 12 13 * 5", "2024-03-15T12:00:00.000Z", "2024-03-22T12:00:00.000Z");
	fires("0 12 13 * 5", "2024-04-12T12:00:00.000Z", "2024-04-13T12:00:00.000Z");
	fires("0 12 13 * 5", "2024-03-12T12:00:00.000Z", "2024-03-13T12:00:00.000Z");
});

check("the OR rule still requires the month", () => {
	fires("0 0 1 3 1", "2024-03-01T00:00:00.000Z", "2024-03-04T00:00:00.000Z");
	fires("0 0 1 3 1", "2024-03-25T00:00:00.000Z", "2025-03-01T00:00:00.000Z");
	fires("0 0 1 3 1", "2024-03-31T23:59:00.000Z", "2025-03-01T00:00:00.000Z");
});

check("the OR rule can fire on days the day of month cannot", () => {
	fires("0 0 31 2 1", "2024-02-01T00:00:00.000Z", "2024-02-05T00:00:00.000Z");
	fires("0 0 31 4 0", "2024-04-01T00:00:00.000Z", "2024-04-07T00:00:00.000Z");
});

check("only the day of month restricted: weekday is unconstrained", () => {
	fires("0 12 13 * *", "2024-03-13T12:00:00.000Z", "2024-04-13T12:00:00.000Z");
	fires("0 12 13 * *", "2024-04-13T12:00:00.000Z", "2024-05-13T12:00:00.000Z");
});

check("a starred day field means both must match (AND)", () => {
	fires("0 12 */2 * 5", BASE, "2024-03-15T12:00:00.000Z");
	fires("0 12 */2 * 5", "2024-03-15T12:00:00.000Z", "2024-03-29T12:00:00.000Z");
	fires("0 12 13 * */2", "2024-03-13T12:00:00.000Z", "2024-04-13T12:00:00.000Z");
	fires("0 12 13 * */2", "2024-04-13T12:00:00.000Z", "2024-06-13T12:00:00.000Z");
	fires("0 12 13 * *,5", "2024-03-13T12:00:00.000Z", "2024-04-13T12:00:00.000Z");
});

check("whitespace between and around fields", () => {
	fires("  0   12\t* * *  ", BASE, "2024-03-13T12:00:00.000Z");
	fires("\t0\t12 *\t* *", BASE, "2024-03-13T12:00:00.000Z");
});

check("dates before the epoch", () => {
	fires("0 0 * * *", "1969-12-31T23:59:59.999Z", "1970-01-01T00:00:00.000Z");
	fires("0 0 * * *", "1970-01-01T00:00:00.000Z", "1970-01-02T00:00:00.000Z");
	fires("30 23 * * *", "1969-12-31T23:00:00.000Z", "1969-12-31T23:30:00.000Z");
});

check("boundary values are accepted", () => {
	fires("59 23 31 12 7", "2024-12-30T00:00:00.000Z", "2024-12-31T23:59:00.000Z");
	fires("0 0 1 1 0", "2024-12-31T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
	assert.doesNotThrow(() => nextFire("0 0 1 1 7", new Date(BASE)));
});

check("syntax errors: wrong field count", () => {
	for (const expression of ["", "   ", "* * * *", "* * * * * *", "*", "@daily", "@hourly"]) {
		assert.throws(() => nextFire(expression, new Date(BASE)), SyntaxError, JSON.stringify(expression));
	}
});

check("syntax errors: values out of range", () => {
	for (const expression of [
		"60 * * * *",
		"* 24 * * *",
		"* * 0 * *",
		"* * 32 * *",
		"* * * 0 *",
		"* * * 13 *",
		"* * * * 8",
		"* * * * 1-8",
		"0-60 * * * *",
		"99999999999999999999 * * * *",
	]) {
		assert.throws(() => nextFire(expression, new Date(BASE)), SyntaxError, expression);
	}
});

check("syntax errors: malformed items", () => {
	for (const expression of [
		"-1 * * * *",
		"+5 * * * *",
		"1.5 * * * *",
		"0x5 * * * *",
		"a * * * *",
		"5-1 * * * *",
		"5- * * * *",
		"-5 * * * *",
		"1-2-3 * * * *",
		"*-5 * * * *",
		"1-* * * * *",
		"** * * * *",
		"* * * * **",
		"1,,2 * * * *",
		",1 * * * *",
		"1, * * * *",
	]) {
		assert.throws(() => nextFire(expression, new Date(BASE)), SyntaxError, expression);
	}
});

check("syntax errors: steps", () => {
	for (const expression of [
		"*/0 * * * *",
		"*/ * * * *",
		"*/x * * * *",
		"*/-1 * * * *",
		"1-5/0 * * * *",
		"1/2/3 * * * *",
		"/5 * * * *",
		"*/1.5 * * * *",
	]) {
		assert.throws(() => nextFire(expression, new Date(BASE)), SyntaxError, expression);
	}
});

check("syntax errors: names in the wrong place and unknown names", () => {
	for (const expression of [
		"* * JAN * *",
		"* * * * JAN",
		"MON * * * *",
		"* * * FRI *",
		"* * * JAN-FOO *",
		"* * * * MONDAY",
		"* * * * SU",
		"* * * JANUARY *",
		"* * * * 1-FOO",
	]) {
		assert.throws(() => nextFire(expression, new Date(BASE)), SyntaxError, expression);
	}
});

check("syntax errors: unsupported extensions and reversed Sunday range", () => {
	for (const expression of [
		"? * * * *",
		"* * ? * *",
		"* * L * *",
		"* * 15W * *",
		"* * * * 5#2",
		"* * * * 5L",
		"* * * * 7-0",
	]) {
		assert.throws(() => nextFire(expression, new Date(BASE)), SyntaxError, expression);
	}
});

check("an invalid expression is reported even if it could never fire", () => {
	assert.throws(() => nextFire("0 0 30 2 x", new Date(BASE)), SyntaxError);
	assert.throws(() => nextFire("0 0 31 2 ?", new Date(BASE)), SyntaxError);
});

check("argument types", () => {
	assert.throws(() => nextFire(5, new Date(BASE)), TypeError);
	assert.throws(() => nextFire(undefined, new Date(BASE)), TypeError);
	assert.throws(() => nextFire("* * * * *", BASE), TypeError);
	assert.throws(() => nextFire("* * * * *", Date.parse(BASE)), TypeError);
	assert.throws(() => nextFire("* * * * *"), TypeError);
	assert.throws(() => nextFire("* * * * *", new Date(Number.NaN)), RangeError);
});

if (failed > 0) process.exit(1);
