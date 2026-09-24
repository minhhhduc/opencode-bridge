// Secret redaction shared across diagnostics and logs. Never print raw
// credentials. Covers api keys, bearer/authorization, tokens, cookies.

const SECRET_KEYS =
	/^(authorization|x-api-key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|cookie|set-cookie|password|secret|bearer)$/i;

// Inline patterns for values embedded in free text (sk-..., Bearer xxx, long hex/b64 blobs).
const INLINE = [
	/\b(sk-[A-Za-z0-9_-]{8,})/g,
	/\b(Bearer)\s+([A-Za-z0-9._-]{8,})/gi,
	/\b([A-Za-z0-9_-]{32,})\b/g, // long opaque tokens
];

/** Redact a string value, keeping a short prefix for debuggability. */
export function redactValue(v) {
	if (typeof v !== "string" || v.length === 0) return v;
	if (v.length <= 8) return "***";
	return `${v.slice(0, 4)}…***(${v.length})`;
}

/** Recursively redact secret-looking keys in an object/array. Returns a copy. */
export function redact(obj) {
	if (obj == null || typeof obj !== "object") return redactText(obj);
	if (Array.isArray(obj)) return obj.map(redact);
	const out = {};
	for (const [k, val] of Object.entries(obj)) {
		if (SECRET_KEYS.test(k)) out[k] = redactValue(String(val));
		else out[k] = redact(val);
	}
	return out;
}

/** Redact secret-looking substrings inside a plain string. */
export function redactText(s) {
	if (typeof s !== "string") return s;
	let out = s;
	out = out.replace(INLINE[1], (_, b) => `${b} ***`);
	out = out.replace(INLINE[0], "sk-***");
	// Only mask standalone long tokens, not ordinary words.
	out = out.replace(INLINE[2], (m) => (/[A-Za-z]/.test(m) && /[0-9_-]/.test(m) ? "***" : m));
	return out;
}
