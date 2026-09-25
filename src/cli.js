#!/usr/bin/env node
// Bin entry: `omp-opencode-bridge <command>`.
//   doctor                 — detect OpenCode, report capabilities (non-secret).
//   plugin-audit <path>     — normalize + validate a third-party plugin manifest
//                             before install (static, pre-install advisory).
// Exit codes: 0 ok, 1 audit blocked / doctor found no OpenCode, 2 usage error.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { doctor, formatDoctor } from "./doctor.js";
import { auditManifest, formatAudit } from "./audit.js";
import { run } from "./opencode.js";
import { loadCredentialProfiles, credentialStatus, resolveProfilesFile, STARTER } from "./credentials.js";

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
		else if (a === "--profiles-file") cfg.profilesFile = rest[++i];
		else if (a === "--provider") cfg.setupProvider = rest[++i];
		else if (a === "--key") {
			// --key account1=sk-...   (repeatable)
			const raw = rest[++i] || "";
			const eq = raw.indexOf("=");
			if (eq < 1) return usage("--key needs ID=VALUE");
			(cfg.keys || (cfg.keys = [])).push({ id: raw.slice(0, eq), key: raw.slice(eq + 1) });
		}
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
	if (cmd === "setup") {
		await setup(cfg, positional, json);
		return;
	}
	if (cmd === "keys") {
		const file = resolveProfilesFile(cfg.profilesFile);
		if (!existsSync(file)) {
			console.error(`no profile file at ${file}\ncreate it, or pass --profiles-file PATH`);
			process.exit(2);
		}
		const profiles = loadCredentialProfiles(file);
		const rows = credentialStatus(profiles);
		console.log(json ? JSON.stringify(rows, null, 2) : rows.map(({ providerID, id, status }) => `${providerID}/${id}\t${status}`).join("\n"));
		return;
	}

	return usage();
}

/**
 * One-command install: pack the plugin, install it into OMP's plugin store, and
 * write the credential profile file. Keys can be supplied inline
 * (`--key ID=VALUE`, repeatable) or left to edit by hand in the written file.
 */
async function setup(cfg, positional, json) {
	const { writeFileSync, readFileSync, mkdirSync } = await import("node:fs");
	// Accept a directory or its package.json, like plugin-audit does.
	const target = resolve(positional[0] || ".");
	const file = /package\.json$/i.test(target) ? target : join(target, "package.json");
	const pkg = JSON.parse(await readFile(file, "utf8"));

	// The plugin store is a standalone npm project; installing the tarball there
	// is what makes the installed copy independent of this checkout. It must have
	// its own package.json: `npm install <tarball>` in a directory without one
	// walks UP to the nearest project and installs there instead (a stray
	// C:\Users\<you>\package.json), leaving the store empty.
	const store = join(homedir(), ".omp", "plugins");
	mkdirSync(store, { recursive: true });
	const manifest = join(store, "package.json");
	if (!existsSync(manifest)) {
		writeFileSync(manifest, JSON.stringify({ name: "omp-plugins", version: "1.0.0", private: true }, null, 2) + "\n");
	}
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const packed = await run(npm, ["pack", "--pack-destination", store], { timeoutMs: 120000, cwd: target });
	if (packed.code !== 0) throw new Error(`npm pack failed: ${(packed.stderr || packed.stdout || "").trim().slice(0, 300)}`);
	const tarball = packed.stdout.trim().split(/\r?\n/).pop().trim();
	const installed = await run(npm, ["install", "--no-audit", "--no-fund", `./${tarball}`], { timeoutMs: 300000, cwd: store });
	if (installed.code !== 0) throw new Error(`npm install failed: ${(installed.stderr || installed.stdout || "").trim().slice(0, 300)}`);
	// npm exits 0 for "up to date" even when it installed into a different
	// project, so confirm the files are actually in the store.
	const installedPkg = join(store, "node_modules", pkg.name, "package.json");
	if (!existsSync(installedPkg)) throw new Error(`npm reported success but ${pkg.name} is not in ${store}`);

	// Credential file: never overwrite one the user already has. It belongs to the
	// install (~/.omp), so a reinstall or update keeps their keys. With no --key
	// the user gets the commented starter and fills the keys in by hand.
	// resolveProfilesFile may have just written that starter, so a file still equal
	// to it counts as untouched — otherwise --key would be silently dropped.
	const profileFile = resolveProfilesFile(cfg.profilesFile);
	const untouched = !existsSync(profileFile) || readFileSync(profileFile, "utf8") === STARTER;
	const keys = cfg.keys || [];
	if (untouched) {
		const provider = cfg.setupProvider || "opencode";
		const body = keys.length
			? `providers:\n  ${provider}:\n    credentials:\n${keys.map(({ id, key }) => `      - id: ${id}\n        apiKey: ${key}`).join("\n")}\n`
			: STARTER;
		mkdirSync(dirname(profileFile), { recursive: true });
		writeFileSync(profileFile, body);
	}

	const out = {
		installed: `${pkg.name}@${pkg.version}`,
		store,
		profilesFile: profileFile,
		keys: credentialStatus(loadCredentialProfiles(profileFile), {}),
	};
	if (json) { console.log(JSON.stringify(out, null, 2)); return; }
	console.log(`installed ${out.installed} into ${store}`);
	console.log(`credentials: ${out.profilesFile}`);
	for (const k of out.keys) console.log(`  ${k.providerID}/${k.id}\t${k.status === "configured" ? "configured" : k.status === "placeholder" ? "add your key" : "missing"}`);
	console.log("\nnext: omp models refresh");
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
	console.error(`usage: omp-opencode-bridge <command> [options]

  setup [PATH]                  one-command install (pack + install + write keys)
  doctor                        detect OpenCode, report capabilities (non-secret)
  plugin-audit <path>           normalize + validate a plugin manifest before install
  keys                          list credential profiles (never prints a key)

options:
  --key ID=VALUE                credential for setup; repeat for more accounts
  --provider ID                 provider name for setup (default: opencode)
  --profiles-file FILE          explicit credential file
  --opencode-path P, --server URL, --timeout MS, --json

examples:
  omp-opencode-bridge setup .
  omp-opencode-bridge setup . --key account1=sk-... --key account2=sk-...`);
	process.exit(2);
}

main().catch((e) => {
	console.error(`error: ${e?.message || e}`);
	process.exit(2);
});
