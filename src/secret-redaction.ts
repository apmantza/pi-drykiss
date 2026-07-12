// Defense-in-depth redaction for high-signal credential shapes.

interface SecretPattern {
	re: RegExp;
	type: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
	{
		// Private key blocks (base64-encoded content between BEGIN/END markers).
		// Use a specific character class instead of [\\s\\S]*? to avoid
		// excessive backtracking on non-matching input.
		re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]*\r?\n-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
		type: "private key",
	},
	{ re: /\bAKIA[0-9A-Z]{16}\b/g, type: "AWS access key id" },
	{ re: /\bghp_[A-Za-z0-9]{36}\b/g, type: "GitHub token" },
	{ re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g, type: "GitHub fine-grained token" },
	{ re: /\bgh[ousr]_[A-Za-z0-9]{36}\b/g, type: "GitHub token" },
	{ re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, type: "Slack token" },
	{
		re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
		type: "Stripe secret key",
	},
	{ re: /\bAIza[0-9A-Za-z_-]{35}\b/g, type: "Google API key" },
	{
		re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
		type: "Anthropic API key",
	},
	{
		re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g,
		type: "OpenAI API key",
	},
	{
		re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
		type: "JWT",
	},
	{
		// Assignment-style: key = "value" where the value looks secret.
		re: /(api[_-]?key|apikey|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*["'][A-Za-z0-9/+_=-]{16,}["']/gi,
		type: "credential assignment",
	},
];

export interface RedactResult {
	readonly text: string;
	readonly redacted: number;
	readonly types: readonly string[];
}

/** Redact credential-shaped values without returning the original values. */
export function redactSecrets(input: string): RedactResult {
	let text = input;
	let redacted = 0;
	const types = new Set<string>();
	for (const { re, type } of SECRET_PATTERNS) {
		text = text.replace(re, () => {
			redacted++;
			types.add(type);
			return "[REDACTED]";
		});
	}
	return { text, redacted, types: [...types] };
}
