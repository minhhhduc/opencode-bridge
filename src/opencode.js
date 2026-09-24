// OpenCode CLI/server client: detection, versioned JSON API, and
// provider/model discovery. Built only on verified surfaces:
//   - `opencode --version`
//   - `opencode service status`            → server URL
//   - `opencode api <operationId> [-d …]`   → JSON (handles server auth itself)
//   - `opencode api provider.list`          → { location, data: Provider[] }
//   - `opencode models`                     → human table (fallback)
// No TUI scraping. Timeouts, abort, and child cleanup are enforced everywhere.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { redactText } from "./redact.js";

export class OpenCodeError extends Error {}
export class OpenCodeNotInstalledError extends OpenCodeError {}

/**
 * Resolve the opencode executable: explicit config → env → real binary → shim.
 *
 * On Windows the npm shim is `opencode.cmd`. Node >=18.20/20.12 refuses to spawn
 * a `.cmd` directly (EINVAL, CVE-2024-27980), so run() routes it through
 * cmd.exe — but cmd.exe then REJECTS the JSON request bodies we must send
 * ("contains a cmd.exe special character and cannot be safely passed"). So we
 * look for the real `opencode.exe` that the shim itself execs, and spawn that
 * directly; the shim stays the last-resort fallback.
 */
export function resolveBin(cfg = {}) {
	const explicit = cfg.opencodePath || process.env.OPENCODE_BIN;
	if (explicit) return explicit;
	if (process.platform !== "win32") return "opencode";
	if (process.env.OPENCODE_EXE && canSpawn(process.env.OPENCODE_EXE)) return process.env.OPENCODE_EXE;
	// The npm shim is <npm-prefix>/bin/opencode.cmd → <prefix>/node_modules/@opencode/cli/bin/opencode.exe
	for (const prefix of npmPrefixes()) {
		const exe = path.join(prefix, "node_modules", "@opencode", "cli", "bin", "opencode.exe");
		if (canSpawn(exe)) return exe;
	}
	for (const c of ["opencode.exe", "opencode"]) {
		if (canSpawn(c)) return c;
	}
	return "opencode.cmd";
}

function npmPrefixes() {
	const out = [];
	if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, "npm"));
	try {
		const r = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
		const p = r.stdout?.trim();
		if (r.status === 0 && p) out.push(p);
	} catch {}
	return out;
}

// Cheap existence probe: does `spawn <bin> --version` get past ENOENT?
function canSpawn(bin) {
	const r = spawnSync(bin, ["--version"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
	return !r.error;
}

/**
 * Run a command, capturing stdout/stderr, killing the child on timeout or
 * abort so no orphan OpenCode process survives.
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function run(bin, args, { signal, timeoutMs = 30000, input } = {}) {
	return new Promise((resolve, reject) => {
		let child;
		let spawnBin = bin;
		let spawnArgs = args;
		// Windows: `.cmd`/`.bat` shims must go through the shell (Node blocks direct
		// spawn). Only for shims — an explicit .exe/.path still spawns directly.
		if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
			spawnBin = process.env.COMSPEC || "cmd.exe";
			spawnArgs = ["/d", "/s", "/c", bin, ...args];
		}
		try {
			child = spawn(spawnBin, spawnArgs, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		} catch (e) {
			return reject(wrapSpawnError(e, bin));
		}
		let out = "";
		let err = "";
		let settled = false;
		const done = (fn, arg) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener?.("abort", onAbort);
			fn(arg);
		};
		const kill = () => {
			try { child.kill("SIGKILL"); } catch {}
		};
		const onAbort = () => { kill(); done(reject, new OpenCodeError("aborted")); };
		if (signal) {
			if (signal.aborted) { kill(); return reject(new OpenCodeError("aborted")); }
			signal.addEventListener("abort", onAbort, { once: true });
		}
		const timer = setTimeout(() => {
			kill();
			done(reject, new OpenCodeError(`opencode timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.stdout.on("data", (d) => { out += d; });
		child.stderr.on("data", (d) => { err += d; });
		child.on("error", (e) => done(reject, wrapSpawnError(e, bin)));
		child.on("close", (code) => done(resolve, { code: code ?? -1, stdout: out, stderr: err }));
		if (input != null) { child.stdin.write(input); }
		child.stdin.end();
	});
}

function wrapSpawnError(e, bin) {
	if (e && (e.code === "ENOENT" || /ENOENT/.test(String(e.message)))) {
		return new OpenCodeNotInstalledError(`OpenCode executable not found: ${bin}`);
	}
	return new OpenCodeError(redactText(String(e?.message || e)));
}

export class OpenCodeClient {
	constructor(cfg = {}) {
		this.cfg = cfg;
		this.bin = resolveBin(cfg);
		this.timeoutMs = cfg.timeoutMs ?? 30000;
	}

	/** True if the opencode binary is invocable. */
	async detect(signal) {
		try {
			const r = await run(this.bin, ["--version"], { signal, timeoutMs: this.timeoutMs });
			return r.code === 0;
		} catch (e) {
			if (e instanceof OpenCodeNotInstalledError) return false;
			throw e;
		}
	}

	async version(signal) {
		const r = await run(this.bin, ["--version"], { signal, timeoutMs: this.timeoutMs });
		// e.g. "opencode v2.0.12"
		const m = r.stdout.match(/v?(\d+\.\d+\.\d+[\w.-]*)/);
		return m ? m[1] : r.stdout.trim() || null;
	}

	/** Server URL: explicit config/env wins, else `opencode service status`. */
	async serverUrl(signal) {
		if (this.cfg.server || process.env.OPENCODE_SERVER) return this.cfg.server || process.env.OPENCODE_SERVER;
		try {
			const r = await run(this.bin, ["service", "status"], { signal, timeoutMs: this.timeoutMs });
			const m = r.stdout.match(/https?:\/\/[^\s]+/);
			return m ? m[0].trim() : null;
		} catch {
			return null;
		}
	}

	/**
	 * Password for the local server's HTTP Basic realm. Only the local OpenCode
	 * daemon uses this; it is unrelated to model auth and is never a model API key.
	 */
	async servicePassword(signal) {
		if (this.cfg.serverPassword) return this.cfg.serverPassword;
		if (process.env.OPENCODE_SERVER_PASSWORD) return process.env.OPENCODE_SERVER_PASSWORD;
		// `opencode service get password` is the same lookup the CLI itself does —
		// no file-path guessing, no new auth model.
		try {
			const r = await run(this.bin, ["service", "get", "password"], { signal, timeoutMs: this.timeoutMs });
			const v = r.stdout?.trim();
			return r.code === 0 && v ? v : null;
		} catch {
			return null;
		}
	}

	/**
	 * Call an OpenCode OpenAPI operation via `opencode api`, parsing JSON.
	 * Throws OpenCodeError on non-zero exit or unparseable output (never silently
	 * returns a malformed result).
	 */
	async api(operation, { data, params, signal, timeoutMs } = {}) {
		const args = ["api", operation];
		if (this.cfg.server || process.env.OPENCODE_SERVER) {
			args.push("--server", this.cfg.server || process.env.OPENCODE_SERVER);
		}
		if (data != null) args.push("-d", typeof data === "string" ? data : JSON.stringify(data));
		for (const [k, v] of Object.entries(params || {})) args.push("--param", `${k}=${v}`);
		const r = await run(this.bin, args, { signal, timeoutMs: timeoutMs ?? this.timeoutMs });
		if (r.code !== 0) {
			throw new OpenCodeError(`opencode api ${operation} failed (exit ${r.code}): ${redactText(r.stderr || r.stdout).slice(0, 400)}`);
		}
		const text = r.stdout.trim();
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch {
			throw new OpenCodeError(`malformed JSON from opencode api ${operation}: ${redactText(text).slice(0, 200)}`);
		}
	}

	/** Discover providers/models. Returns normalized ProviderModelConfig[]. */
	async discoverModels(signal) {
		// Preferred: model.list — the real, per-model record (capabilities, cost,
		// limits, reasoning variants). `provider.list` only names providers and
		// carries no `models` array, so it is a name-only fallback.
		try {
			const res = await this.api("model.list", { signal });
			const models = Array.isArray(res?.data) ? res.data : [];
			if (models.length) return mapModelList(models);
			// No authenticated models: still report the provider, with none attached.
			return await this._fromProviderList(signal);
		} catch {
			return await this._fromProviderList(signal);
		}
	}

	async _fromProviderList(signal) {
		let providers;
		try {
			const res = await this.api("provider.list", { signal });
			providers = Array.isArray(res?.data) ? res.data : [];
		} catch (e) {
			// Last resort: parse the `opencode models` table.
			const r = await run(this.bin, ["models"], { signal, timeoutMs: this.timeoutMs });
			if (r.code !== 0) throw e;
			return parseModelsTable(r.stdout);
		}
		return mapProvidersToModels(providers);
	}
}

/**
 * Map `model.list` records → ProviderModelConfig[] with ids `<provider>/<model>`.
 * OMP prepends the registered provider name itself, so the id must NOT repeat
 * it — registering as `opencode` yields `opencode/opencode/space-bunny-free`.
 * Reasoning is inferred from the presence of reasoningEffort variants, which is
 * how OpenCode advertises a thinking-capable model.
 */
export function mapModelList(models) {
	return (models || []).map((m) => {
		const pid = m.providerID || m.provider || "opencode";
		const mid = m.modelID || m.id;
		const efforts = (m.variants || [])
			.map((v) => v?.settings?.reasoningEffort ?? v?.id)
			.filter((e) => EFFORTS.includes(e));
		const reasoning = efforts.length > 0;
		// OMP only understands "text" | "image". OpenCode advertises more (video,
		// audio, pdf); passing those through produces a config OMP silently drops,
		// so the model never appears at all. Keep what OMP can represent.
		// ponytail: assumes OMP's modality enum stays two-valued; re-check if the
		// model config schema grows new entries.
		const inputs = (Array.isArray(m.capabilities?.input) ? m.capabilities.input : ["text"]).filter(
			(cap) => cap === "text" || cap === "image",
		);
		if (!inputs.includes("text")) inputs.unshift("text"); // every model is text-capable in practice
		const cost = m.cost || {};
		const cache = cost.cache || {};
		return {
			id: `${pid}/${mid}`,
			name: m.name ? `${m.name} (OpenCode)` : `${pid}/${mid}`,
			reasoning,
			thinking: reasoning ? { mode: "effort", efforts: [...new Set(efforts)] } : undefined,
			input: inputs,
			cost: {
				input: num(cost.input),
				output: num(cost.output),
				cacheRead: num(cache.read),
				cacheWrite: num(cache.write),
			},
			contextWindow: num(m.limit?.context) || 128000,
			maxTokens: num(m.limit?.output) || 8192,
		};
	});
}

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Coerce OpenCode/models.dev reasoning metadata into an OMP thinking config. */
function thinkingFrom(m) {
	// models.dev exposes `reasoning: boolean`; some builds add `reasoning_effort`/efforts.
	const raw = m.reasoning ?? m.thinking ?? m.supports_reasoning;
	if (!raw) return { reasoning: false, thinking: undefined };
	let efforts = Array.isArray(m.efforts) ? m.efforts.filter((e) => EFFORTS.includes(e)) : [];
	if (efforts.length === 0) efforts = ["low", "medium", "high"];
	return { reasoning: true, thinking: { mode: "effort", efforts } };
}

function inputsFrom(m) {
	const mods = m.modalities?.input || m.input || [];
	const arr = Array.isArray(mods) ? mods : [];
	const attach = m.attachment === true || arr.includes("image");
	return attach ? ["text", "image"] : ["text"];
}

function costFrom(m) {
	const c = m.cost || {};
	return {
		input: num(c.input),
		output: num(c.output),
		cacheRead: num(c.cache_read ?? c.cacheRead),
		cacheWrite: num(c.cache_write ?? c.cacheWrite),
	};
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Map `provider.list` data → ProviderModelConfig[] with ids `<provider>/<model>`
 * (OMP prefixes the registered provider name, yielding `opencode/<provider>/<model>`).
 */
export function mapProvidersToModels(providers) {
	const out = [];
	for (const p of providers || []) {
		const pid = p.id || p.provider || p.name;
		if (!pid) continue;
		const models = normalizeModels(p.models);
		for (const m of models) {
			const mid = m.id || m.model;
			if (!mid) continue;
			const t = thinkingFrom(m);
			out.push({
				id: `${pid}/${mid}`,
				name: m.name ? `${m.name} (OpenCode/${pid})` : `${pid}/${mid}`,
				reasoning: t.reasoning,
				thinking: t.thinking,
				input: inputsFrom(m),
				cost: costFrom(m),
				contextWindow: num(m.limit?.context ?? m.context_window ?? m.contextWindow) || 128000,
				maxTokens: num(m.limit?.output ?? m.max_output ?? m.maxTokens) || 8192,
			});
		}
	}
	return out;
}

// `models` may be an object map (models.dev) or an array.
function normalizeModels(models) {
	if (Array.isArray(models)) return models;
	if (models && typeof models === "object") {
		return Object.entries(models).map(([id, v]) => ({ id, ...(v && typeof v === "object" ? v : {}) }));
	}
	return [];
}

/** Fallback parser for the `opencode models` table (provider header + rows). */
export function parseModelsTable(text) {
	const out = [];
	let provider = null;
	for (const line of String(text).split(/\r?\n/)) {
		const head = line.match(/^([a-z0-9][\w-]*)\s*\(\d+\)/i);
		if (head) { provider = head[1]; continue; }
		const cell = line.match(/^[│|]\s*([\w.@:-]+)\s*[│|]/);
		if (provider && cell) {
			const mid = cell[1];
			if (mid === "model") continue; // header row
			out.push({
				id: `${provider}/${mid}`,
				name: `${provider}/${mid}`,
				reasoning: false,
				thinking: undefined,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			});
		}
	}
	return out;
}


