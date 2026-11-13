function requireInteger(name, value, minimum) {
	if (!Number.isInteger(value) || value < minimum) {
		throw new RangeError(`${name} must be an integer of at least ${minimum}`);
	}
	return value;
}

function expandTabs(line, tabSize) {
	let column = 0;
	let out = "";
	for (const char of line) {
		if (char === "\t") {
			const pad = tabSize - (column % tabSize);
			out += " ".repeat(pad);
			column += pad;
		} else {
			out += char;
			column++;
		}
	}
	return out;
}

function paragraphWords(lines) {
	const words = [];
	lines.forEach((line, index) => {
		let first = true;
		for (const [, gap, word] of line.matchAll(/( *)([^ ]+)/g)) {
			words.push({ gap: first && index > 0 ? " " : gap, word });
			first = false;
		}
	});
	return words;
}

function fillParagraph(words, width, firstIndent, indent) {
	const lines = [];
	const available = () => width - (lines.length === 0 ? firstIndent : indent);
	const emit = (text) => lines.push(" ".repeat(lines.length === 0 ? firstIndent : indent) + text);
	let text = "";
	let textLength = 0;
	for (const { gap, word } of words) {
		const chars = Array.from(word);
		const hasWord = textLength > 0;
		if (textLength + gap.length + chars.length <= available()) {
			text += gap + word;
			textLength += gap.length + chars.length;
			continue;
		}
		if (hasWord) emit(text);
		let rest = chars;
		while (rest.length > available()) {
			const size = available();
			emit(rest.slice(0, size).join(""));
			rest = rest.slice(size);
		}
		text = rest.join("");
		textLength = rest.length;
	}
	if (textLength > 0) emit(text);
	return lines;
}

export function wrap(text, options) {
	if (typeof text !== "string") throw new TypeError("text must be a string");
	const { width, indent = 0, firstIndent = indent, tabSize = 8 } = options ?? {};
	requireInteger("width", width, 1);
	requireInteger("indent", indent, 0);
	requireInteger("firstIndent", firstIndent, 0);
	requireInteger("tabSize", tabSize, 1);
	if (indent >= width || firstIndent >= width) throw new RangeError("indentation leaves no room for text");

	const inputLines = text.replace(/\r\n?/g, "\n").split("\n");
	const paragraphs = [];
	let current = [];
	for (const line of inputLines) {
		const expanded = expandTabs(line, tabSize);
		if (/^ *$/.test(expanded)) {
			if (current.length > 0) paragraphs.push(current);
			current = [];
		} else {
			current.push(expanded);
		}
	}
	if (current.length > 0) paragraphs.push(current);

	return paragraphs
		.map((lines) => fillParagraph(paragraphWords(lines), width, firstIndent, indent).join("\n"))
		.join("\n\n");
}
