// One long-lived local OpenCode server per (provider, profile). The server,
// config, data directory and selected key are process-scoped, so concurrent
// requests cannot swap credentials on a shared OpenCode session service.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { OpenCodeClient } from "./opencode.js";
import { CapabilityError } from "./stream.js";

const SLOT = "OMP_BRIDGE_SELECTED_API_KEY";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const activeChildren = new Set();
process.once("exit", () => { for (const child of activeChildren) child.kill("SIGKILL"); });

export class OpenCodeClientPool {
	constructor(cfg, profiles, { spawnServer = startServer } = {}) {
		this.cfg = cfg;
		this.profiles = profiles;
		this.spawnServer = spawnServer;
		this.entries = new Map();
		this.secrets = new Set();
	}

	async get(descriptor) {
		const key = `${descriptor.providerID}\0${descriptor.credentialId}`;
		let pending = this.entries.get(key);
		if (!pending) {
			const secret = process.env[descriptor.credentialSource];
			if (!secret) throw new CapabilityError(`credential ${descriptor.providerID}/${descriptor.credentialId} is missing environment variable ${descriptor.credentialSource}`, { capability: "credential" });
			this.secrets.add(secret);
			pending = Promise.resolve().then(() => this.spawnServer(this.cfg, descriptor, secret, this.profiles)).catch((error) => {
				throw new CapabilityError(this.sanitize(String(error?.message || error)).split(secret).join("***"), { capability: "credential" });
			});
			this.entries.set(key, pending);
			pending.catch(() => { if (this.entries.get(key) === pending) this.entries.delete(key); });
		}
		return (await pending).client;
	}

	close() {
		for (const pending of this.entries.values()) pending.then(({ close }) => close(), () => {});
		this.entries.clear();
	}

	sanitize(message) {
		let result = String(message);
		for (const secret of this.secrets) result = result.split(secret).join("***");
		for (const entries of this.profiles.values()) for (const { apiKeyEnv } of entries) {
			const secret = process.env[apiKeyEnv];
			if (secret) result = result.split(secret).join("***");
		}
		return result;
	}
}

async function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

/**
 * Build the child server's config: the user's own OPENCODE_CONFIG_CONTENT with
 * the selected provider's apiKey pointed at the slot env var. A malformed
 * exported value must not brick every profiled request, so it degrades to `{}`.
 */
export function mergeProfileConfig(providerID, slot = SLOT) {
	let original = {};
	if (process.env.OPENCODE_CONFIG_CONTENT) {
		try { original = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) || {}; }
		catch { original = {}; }
	}
	const existing = original.providers?.[providerID] || {};
	return {
		...original,
		providers: {
			...original.providers,
			[providerID]: {
				...existing,
				settings: { ...existing.settings, apiKey: `{env:${slot}}` },
			},
		},
	};
}

async function startServer(cfg, descriptor, secret, profiles) {
	const port = await freePort();
	const password = randomBytes(24).toString("base64url");
	const root = await mkdtemp(join(tmpdir(), "omp-opencode-bridge-"));
	const content = mergeProfileConfig(descriptor.providerID);
	const env = { ...process.env };
	// OpenCode gives catalog credential env vars precedence over settings.apiKey.
	// Strip inherited credentials before installing the selected key, including
	// provider-standard variables that were not declared as bridge profiles.
	for (const name of Object.keys(env)) if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name)) delete env[name];
	for (const entries of profiles.values()) for (const profile of entries) delete env[profile.apiKeyEnv];
	Object.assign(env, {
		[SLOT]: secret,
		OPENCODE_SERVER_PASSWORD: password,
		OPENCODE_CONFIG_CONTENT: JSON.stringify(content),
		OPENCODE_DISABLE_AUTOUPDATE: "true",
		XDG_DATA_HOME: join(root, "data"),
		XDG_CACHE_HOME: join(root, "cache"),
		XDG_CONFIG_HOME: join(root, "config"),
	});
	// Preserve the user's global provider definitions while keeping auth/data
	// isolated. Project config is still loaded from the child's working directory.
	if (!env.OPENCODE_CONFIG) {
		const base = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
		for (const name of ["opencode.jsonc", "opencode.json"]) {
			const file = join(base, name);
			if (existsSync(file)) { env.OPENCODE_CONFIG = file; break; }
		}
	}
	const upstream = new OpenCodeClient({ ...cfg, childEnv: env });
	const version = await upstream.version();
	if (!/^2\./.test(version || "")) throw new CapabilityError("credential profiles require the verified OpenCode 2 config API", { capability: "credential" });
	const child = spawn(upstream.bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--log-level", "error"], {
		cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
	});
	activeChildren.add(child);
	child.once("exit", () => activeChildren.delete(child));
	child.on("error", () => {}); // startup failure is reported by the readiness check
	// Drain output; OpenCode prints its local server password on stdout.
	child.stdout.resume();
	child.stderr.resume();
	const url = `http://127.0.0.1:${port}`;
	const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
	try {
		let ready = false;
		for (let i = 0; i < 50; i++) {
			if (child.exitCode !== null) break;
			try {
				const response = await fetch(`${url}/api/info`, { headers: { authorization: auth }, signal: AbortSignal.timeout(500) });
				if (response.ok) { ready = true; break; }
			} catch {}
			await pause(200);
		}
		if (!ready) throw new CapabilityError(`isolated OpenCode server failed for ${descriptor.providerID}/${descriptor.credentialId} (exit ${child.exitCode})`, { capability: "credential" });
		const client = new OpenCodeClient({ ...cfg, server: url, serverPassword: password, childEnv: env });
		return { client, close: () => child.kill("SIGKILL") };
	} catch (error) {
		child.kill("SIGKILL");
		throw error;
	}
}
