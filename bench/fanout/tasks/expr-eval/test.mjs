import assert from "node:assert/strict";
import { ExprError, evaluate } from "./expr.mjs";

let failed = 0;
function check(name, fn) {
	try {
		fn();
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}: ${error.message}`);
	}
}
const value = (source, expected) =>
	assert.equal(evaluate(source), expected, `${JSON.stringify(source)} should be ${expected}`);
const fails = (source, position) => {
	assert.throws(
		() => evaluate(source),
		(error) => {
			assert.ok(error instanceof ExprError, `${JSON.stringify(source)}: expected an ExprError, got ${error}`);
			assert.equal(
				error.position,
				position,
				`${JSON.stringify(source)}: position ${error.position}, wanted ${position}`,
			);
			assert.ok(
				error.message.includes(`position ${position}`),
				`message ${JSON.stringify(error.message)} lacks "position ${position}"`,
			);
			return true;
		},
	);
};

check("numbers", () => {
	value("42", 42);
	value("3.25", 3.25);
	value(".5", 0.5);
	value("007", 7);
	value("0.1 + 0.2", 0.1 + 0.2);
});

check("basic operators", () => {
	value("1 + 2", 3);
	value("5 - 8", -3);
	value("6 * 7", 42);
	value("7 / 2", 3.5);
	value("7 % 4", 3);
	value("2 ** 10", 1024);
});

check("remainder takes the sign of the left operand", () => {
	value("-7 % 4", -3);
	value("7 % -4", 3);
	value("5.5 % 2", 1.5);
});

check("left associativity", () => {
	value("10 - 4 - 3", 3);
	value("100 / 10 / 5", 2);
	value("7 % 4 * 2", 6);
	value("8 / 2 * 4", 16);
});

check("precedence of * over +", () => {
	value("1 + 2 * 3 - 4 / 2", 5);
	value("2 * 3 + 4 * 5", 26);
	value("2 + 3 % 2", 3);
});

check("** is right-associative", () => {
	value("2 ** 3 ** 2", 512);
	value("(2 ** 3) ** 2", 64);
	value("2 ** 2 ** 3", 256);
});

check("** binds tighter than prefix signs and multiplication", () => {
	value("-2 ** 2", -4);
	value("(-2) ** 2", 4);
	value("-3 ** 2 ** 2", -81);
	value("2 * 3 ** 2", 18);
	value("2 ** 3 * 2", 16);
	value("+2 ** 2", 4);
});

check("a prefix sign on the right of **", () => {
	value("2 ** -1", 0.5);
	value("2 ** -2 ** 2", 0.0625);
	value("2 ** +3", 8);
	value("-2 ** -2", -0.25);
});

check("prefix signs", () => {
	value("-5", -5);
	value("+5", 5);
	value("--2", 2);
	value("+-+2", -2);
	value("- - - 2", -2);
	value("2 * -3", -6);
	value("2 - -3", 5);
	value("2 + +3", 5);
	value("-2 * 3", -6);
	value("-(1 + 2)", -3);
});

check("parentheses", () => {
	value("(1 + 2) * 3", 9);
	value("2 * (3 + 4) ** 2", 98);
	value("((((7))))", 7);
	value("(2 + 3) * (4 - 1)", 15);
	value("10 / (2 + 3)", 2);
});

check("whitespace", () => {
	value("  1+2  ", 3);
	value("\t1\n+\r\n2 ", 3);
	value("1+2*3", 7);
});

check("large and fractional results", () => {
	value("2 ** 0.5", Math.SQRT2);
	value("0 ** 0", 1);
	value("2 ** 1024", Infinity);
	value("1 / 3", 1 / 3);
});

check("unexpected characters", () => {
	fails("2 $ 3", 2);
	fails("abc", 0);
	fails("1 + a", 4);
	fails("1e3", 1);
	fails("1.", 1);
	fails("(1 + 2) # 3", 8);
	fails("1 = 2", 2);
});

check("number followed by a number", () => {
	fails("1 2", 2);
	fails("1.2.3", 3);
	fails("(1) 2", 4);
	fails("1 (2)", 2);
});

check("operators with a missing or misplaced operand", () => {
	fails("1 + * 2", 4);
	fails("* 2", 0);
	fails("2 * * 3", 4);
	fails("2 *** 3", 4);
	fails("1 / / 2", 4);
	fails("2 ** * 3", 5);
});

check("ran out of input", () => {
	fails("", 0);
	fails("   ", 3);
	fails("1 +", 3);
	fails("1 + ", 4);
	fails("-", 1);
	fails("2 **", 4);
	fails("(1 + 2", 6);
	fails("((1)", 4);
	fails("1 + (", 5);
});

check("misplaced parentheses", () => {
	fails("()", 1);
	fails("(1 + 2))", 7);
	fails(")", 0);
	fails("1 + )", 4);
	fails("(1 + * 2)", 5);
});

check("division and remainder by zero", () => {
	fails("1 / 0", 2);
	fails("0 / 0", 2);
	fails("5 % 0", 2);
	fails("1 / (2 - 2)", 2);
	fails("4 + 6 % (3 - 3)", 6);
	fails("1 / 0.0", 2);
});

check("the first division by zero evaluated is the one reported", () => {
	fails("(1 / 0) + (2 / 0)", 3);
	fails("1 % 0 + 1 / 0", 2);
	fails("1 + 2 / 0 * 4 / 0", 6);
});

check("syntax errors win over earlier division by zero", () => {
	fails("1 / 0 + * 2", 8);
	fails("1 / 0 + (2", 10);
	fails("1 / 0 $", 6);
});

check("non-string argument", () => {
	for (const bad of [undefined, null, 5, {}, ["1"]]) {
		assert.throws(() => evaluate(bad), TypeError);
	}
});

check("errors are ExprError instances of Error", () => {
	assert.ok(new ExprError("x") instanceof Error);
	try {
		evaluate("1 +");
		assert.fail("should have thrown");
	} catch (error) {
		assert.ok(error instanceof Error);
		assert.ok(error instanceof ExprError);
	}
});

if (failed > 0) process.exit(1);
