#!/usr/bin/env node
// Bin entry: `omp-opencode-bridge <command>`.
//   doctor                 — detect OpenCode, report capabilities (non-secret).
//   plugin-audit <path>     — normalize + validate a third-party plugin manifest
//                             before install (static, pre-install advisory).
// Exit codes: 0 ok, 1 audit blocked / doctor found no OpenCode, 2 usage error.

import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { doctor, formatDoctor } from "./doctor.js";
import { auditManifest, formatAudit } from "./audit.js";

const args = process.argv.slice(2);
const cmd = args[0];

// Minimal flag parse: --opencode-path, --server, --timeout, --json.
function parseFlags(rest) {
	const cfg = {};
	let json = false;
	const positional = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--json") json = true;
		else if (a === "--opencode-path") cfg.opencodePath = rest[++i];
		else if (a === "--server") cfg.server = rest[++i];
		else if (a === "--timeout") cfg.timeoutMs = Number(rest[++i]);
		else positional.push(a);
	}
	return { cfg, json, positional };
}

async function main() {
	const { cfg, json, positional } = parseFlags(args.slice(1));

	if (cmd === "doctor") {
		const r = await doctor(cfg);
		console.log(json ? JSON.stringify(r, null, 2) : formatDoctor(r));
		process.exit(r.detected ? 0 : 1);
	}

	if (cmd === "plugin-audit") {
		const path = positional[0];
		if (!path) return usage("plugin-audit requires a path to a plugin directory or package.json");
		const { root, raw } = await loadManifest(path);
		const r = auditManifest(raw, { root });
		console.log(json ? JSON.stringify(r, null, 2) : formatAudit(r));
		process.exit(r.ok ? 0 : 1);
	}

	return usage();
}

async function loadManifest(path) {
	const abs = resolve(path);
	// Accept either a directory (read its package.json) or a package.json file.
	let file = abs;
	let root = dirname(abs);
	if (!/package\.json$/i.test(abs)) {
		file = join(abs, "package.json");
		root = abs;
	}
	const raw = JSON.parse(await readFile(file, "utf8"));
	return { root, raw };
}

function usage(msg) {
	if (msg) console.error(`error: ${msg}\n`);
	console.error("usage: omp-opencode-bridge <doctor|plugin-audit <path>> [--json] [--opencode-path P] [--server URL] [--timeout MS]");
	process.exit(2);
}

main().catch((e) => {
	console.error(`error: ${e?.message || e}`);
	process.exit(2);
});
