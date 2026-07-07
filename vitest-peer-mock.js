// Mock module for pi peer dependencies (not installed locally).
// Provides stub exports so tests can resolve imports.
const { pathToFileURL } = require("url");

function hyperlink(text, url) {
	// OSC 8: ESC ] 8 ; ; <url> ESC \ <text> ESC ] 8 ; ; ESC \
	const target = typeof url === "string" ? url : String(url);
	return "\x1b]8;;" + target + "\x1b\\" + text + "\x1b]8;;\x1b\\";
}

function visibleWidth(s) {
	// Strip ANSI codes then count grapheme-like width.
	if (typeof s !== "string") return 0;
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
}

// Minimal Text component stub: stores the string and renders it as a
// single line. Enough for tests that inspect renderResult output.
class Text {
	constructor(text = "", _paddingX = 0, _paddingY = 0) {
		this._text = text;
	}
	setText(text) {
		this._text = text;
	}
	render(_width) {
		return [this._text];
	}
}

module.exports = {
	truncateToWidth: (s, w) =>
		typeof s === "string" && s.length > w ? s.slice(0, w - 1) + "\u2026" : s,
	hyperlink,
	visibleWidth,
	pathToFileURL,
	Text,
};
module.exports.default = module.exports;
