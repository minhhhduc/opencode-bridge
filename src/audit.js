// External-plugin manifest normalizer + capability/permission validator.
//
// Honest boundary (see DESIGN.md): OMP loads extensions as ESM in-process with
// full host trust — there is NO runtime sandbox this bridge can enforce. So this
// module is a PRE-INSTALL static advisory: it normalizes a third-party manifest
// into {name, version, source, entrypoint, permissions, config}, validates it,
// canonicalizes paths, rejects traversal, validates source URLs, and surfaces the
// capabilities a plugin declares so a human can decide before `omp plugin install`.
// It does not, and cannot, contain a plugin at runtime.

import { resolve, isAbsolute, relative, sep } from "node:path";

// Capabilities a plugin may declare. Anything else is flagged "unknown".
export const KNOWN_PERMISSIONS = ["filesystem", "shell", "network", "env", "credentials", "model"];

// Source kinds we can name. `package` = registry name, others self-explanatory.
const URL_SCHEMES = /^(https?|git\+https?|git|ssh|git\+ssh):/i;

/**
 * Normalize an arbitrary package.json-ish manifest into the OMP plugin shape.
 * Reads the `omp` or `pi` field for plugin metadata, falling back to top level.
 */
export function normalizeManifest(raw = {}, { root } = {}) {
	const meta = raw.omp || raw.pi || raw;
	const entrypoint = firstString(meta.extensions?.[0], meta.entrypoint, meta.main, raw.main);
	return {
		name: firstString(meta.name, raw.name) || null,
		version: firstString(meta.version, raw.version) || null,
		source: classifySource(meta.source || raw.source, root),
		entrypoint: entrypoint || null,
		permissions: normalizePermissions(meta.permissions || meta.capabilities || raw.permissions),
		config: meta.settings || meta.config || {},
	};
}

function classifySource(src, root) {
	if (src && typeof src === "object") return src; // already {type, ...}
	if (typeof src !== "string" || !src) return { type: root ? "directory" : "unknown", location: root || null };
	if (URL_SCHEMES.test(src)) return { type: /git/i.test(src) ? "git" : "url", location: src };
	if (/^[\w.-]+\/[\w.-]+$/.test(src) && !src.includes("\\")) return { type: "github", location: src };
	return { type: "package", location: src };
}

function normalizePermissions(perms) {
	if (!perms) return [];
	const list = Array.isArray(perms) ? perms : Object.keys(perms).filter((k) => perms[k]);
	return list.map(String);
}

/**
 * Validate a normalized manifest. Returns { ok, errors[], warnings[], manifest }.
 * Errors block a safe install; warnings are advisory (e.g. broad capabilities).
 */
export function validateManifest(manifest, { root } = {}) {
	const errors = [];
	const warnings = [];

	if (!manifest.name) errors.push("manifest has no name");
	if (!manifest.entrypoint) errors.push("manifest has no entrypoint/extensions[0]/main");
	if (!manifest.version) warnings.push("manifest has no version");

	// Path safety: entrypoint must stay inside the plugin root (no traversal / absolute escape).
	if (manifest.entrypoint && root) {
		const base = resolve(root);
		const target = resolve(base, manifest.entrypoint);
		const rel = relative(base, target);
		if (isAbsolute(manifest.entrypoint) || rel.startsWith("..") || rel.includes(".." + sep)) {
			errors.push(`entrypoint escapes plugin root (path traversal): ${manifest.entrypoint}`);
		}
	}

	// Source URL sanity.
	const loc = manifest.source?.location;
	if (manifest.source?.type === "url" && loc && !/^https:/i.test(loc)) {
		warnings.push(`insecure source URL (not https): ${loc}`);
	}

	// Capability advisory.
	for (const p of manifest.permissions) {
		if (!KNOWN_PERMISSIONS.includes(p)) warnings.push(`unknown permission declared: ${p}`);
	}
	const dangerous = manifest.permissions.filter((p) => ["shell", "credentials", "filesystem"].includes(p));
	if (dangerous.length) {
		warnings.push(`grants high-trust capabilities: ${dangerous.join(", ")} — OMP runs extensions in-process with no sandbox; install only if you trust the source`);
	}

	return { ok: errors.length === 0, errors, warnings, manifest };
}

// path.sep is imported above for the traversal check.

function firstString(...vals) {
	for (const v of vals) if (typeof v === "string" && v) return v;
	return null;
}

/** Convenience: normalize + validate in one call. */
export function auditManifest(raw, opts = {}) {
	const manifest = normalizeManifest(raw, opts);
	return validateManifest(manifest, opts);
}

/** Human-readable render for the CLI. */
export function formatAudit(r) {
	const lines = [
		`Plugin:      ${r.manifest.name || "(unnamed)"}${r.manifest.version ? ` v${r.manifest.version}` : ""}`,
		`Source:      ${r.manifest.source?.type}${r.manifest.source?.location ? ` (${r.manifest.source.location})` : ""}`,
		`Entrypoint:  ${r.manifest.entrypoint || "-"}`,
		`Permissions: ${r.manifest.permissions.length ? r.manifest.permissions.join(", ") : "(none declared)"}`,
		`Verdict:     ${r.ok ? "SAFE TO INSTALL (static checks passed)" : "BLOCKED"}`,
	];
	if (r.errors.length) lines.push("", "Errors:", ...r.errors.map((e) => `  - ${e}`));
	if (r.warnings.length) lines.push("", "Warnings:", ...r.warnings.map((w) => `  - ${w}`));
	return lines.join("\n");
}
