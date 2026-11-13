export class ExprError extends Error {
	constructor(message, position) {
		super(`${message} at position ${position}`);
		this.name = "ExprError";
		this.position = position;
	}
}

const NUMBER = /\d+(?:\.\d+)?|\.\d+/y;
const WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

function tokenize(source) {
	const tokens = [];
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		if (WHITESPACE.has(ch)) {
			i++;
			continue;
		}
		NUMBER.lastIndex = i;
		const number = NUMBER.exec(source);
		if (number) {
			tokens.push({ type: "number", text: number[0], value: Number(number[0]), pos: i });
			i += number[0].length;
		} else if (source.startsWith("**", i)) {
			tokens.push({ type: "**", text: "**", pos: i });
			i += 2;
		} else if ("+-*/%()".includes(ch)) {
			tokens.push({ type: ch, text: ch, pos: i });
			i++;
		} else {
			throw new ExprError(`unexpected character ${JSON.stringify(ch)}`, i);
		}
	}
	tokens.push({ type: "end", text: "end of input", pos: source.length });
	return tokens;
}

function parse(tokens) {
	let index = 0;
	const peek = () => tokens[index];
	const unexpected = (token) =>
		new ExprError(
			token.type === "end" ? "unexpected end of input" : `unexpected ${JSON.stringify(token.text)}`,
			token.pos,
		);

	function binary(next, operators) {
		let left = next();
		while (operators.includes(peek().type)) {
			const op = tokens[index++];
			left = { kind: "binary", op: op.type, pos: op.pos, left, right: next() };
		}
		return left;
	}

	const expression = () => binary(term, ["+", "-"]);
	const term = () => binary(unary, ["*", "/", "%"]);

	function unary() {
		const token = peek();
		if (token.type === "+" || token.type === "-") {
			index++;
			return { kind: "unary", op: token.type, operand: unary() };
		}
		return power();
	}

	function power() {
		const base = atom();
		if (peek().type === "**") {
			const op = tokens[index++];
			return { kind: "binary", op: "**", pos: op.pos, left: base, right: unary() };
		}
		return base;
	}

	function atom() {
		const token = peek();
		if (token.type === "number") {
			index++;
			return { kind: "number", value: token.value };
		}
		if (token.type === "(") {
			index++;
			const inner = expression();
			if (peek().type !== ")") throw unexpected(peek());
			index++;
			return inner;
		}
		throw unexpected(token);
	}

	const tree = expression();
	if (peek().type !== "end") throw unexpected(peek());
	return tree;
}

function run(node) {
	if (node.kind === "number") return node.value;
	if (node.kind === "unary") {
		const value = run(node.operand);
		return node.op === "-" ? -value : value;
	}
	const left = run(node.left);
	const right = run(node.right);
	switch (node.op) {
		case "+":
			return left + right;
		case "-":
			return left - right;
		case "*":
			return left * right;
		case "**":
			return left ** right;
		case "/":
			if (right === 0) throw new ExprError("division by zero", node.pos);
			return left / right;
		default:
			if (right === 0) throw new ExprError("remainder by zero", node.pos);
			return left % right;
	}
}

export function evaluate(source) {
	if (typeof source !== "string") throw new TypeError("source must be a string");
	return run(parse(tokenize(source)));
}
