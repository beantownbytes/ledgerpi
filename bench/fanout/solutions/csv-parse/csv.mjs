export class CsvError extends Error {
	constructor(message, position) {
		super(`${message} at position ${position}`);
		this.name = "CsvError";
		this.position = position;
	}
}

export function parseCsv(text, options = {}) {
	if (typeof text !== "string") throw new TypeError("text must be a string");
	const delimiter = options.delimiter ?? ",";
	if (
		typeof delimiter !== "string" ||
		delimiter.length !== 1 ||
		delimiter === '"' ||
		delimiter === "\r" ||
		delimiter === "\n"
	) {
		throw new RangeError("delimiter must be a single character other than a quote or a line break");
	}

	const atSeparator = (i) => text[i] === "\n" || (text[i] === "\r" && text[i + 1] === "\n");
	const atFieldEnd = (i) => i >= text.length || text[i] === delimiter || atSeparator(i);

	const records = [];
	let record = [];
	let i = 0;
	while (i < text.length) {
		let field = "";
		if (text[i] === '"') {
			const opening = i++;
			for (;;) {
				if (i >= text.length) throw new CsvError("unterminated quoted field", opening);
				if (text[i] !== '"') {
					field += text[i++];
				} else if (text[i + 1] === '"') {
					field += '"';
					i += 2;
				} else {
					i++;
					break;
				}
			}
			if (!atFieldEnd(i)) throw new CsvError("unexpected character after closing quote", i);
		} else {
			while (!atFieldEnd(i)) {
				if (text[i] === '"') throw new CsvError("quote inside an unquoted field", i);
				field += text[i++];
			}
		}
		record.push(field);
		if (i >= text.length) {
			records.push(record);
			record = [];
		} else if (text[i] === delimiter) {
			i++;
		} else {
			i += text[i] === "\r" ? 2 : 1;
			records.push(record);
			record = [];
		}
	}
	if (record.length > 0) records.push([...record, ""]);
	return records;
}
