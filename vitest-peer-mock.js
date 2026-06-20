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

module.exports = {
	truncateToWidth: (s, w) =>
		typeof s === "string" && s.length > w ? s.slice(0, w - 1) + "\u2026" : s,
	hyperlink,
	visibleWidth,
	pathToFileURL,
};
module.exports.default = module.exports;
