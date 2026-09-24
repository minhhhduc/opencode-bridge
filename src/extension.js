// OMP extension entrypoint. Registers one dynamic provider, "opencode-bridge",
// whose models are discovered at runtime from the real OpenCode install — never
// hardcoded. Inference is forwarded through OpenCode's session API (bounded; see
// README "Capability boundary"). A broken or absent OpenCode must never crash
// OMP: registration is best-effort and every async path is guarded.
//
// Verified against omp 18.2.6 by probing the binary's registerProvider and
// modelRegistry paths. Three non-obvious requirements:
//   1. `api` must be a CUSTOM name. Built-in names ("openai-completions", …) are
//      reserved and registerProvider throws, which discards the whole provider.
//   2. fetchDynamicModels is only invoked when BOTH apiKey and baseUrl are set.
//   3. streamSimple is required whenever `api` is present.
// apiKey/baseUrl are the public OpenCode Zen placeholders that unlock discovery;
// every real request is routed to OpenCode by streamSimple, so no OMP traffic
// ever reaches them, and no credential is copied into OMP.

import { OpenCodeClient } from "./opencode.js";
import { makeStreamSimple } from "./stream.js";

export default function activate(pi) {
	const cfg = readSettings(pi);
	if (cfg.enabled === false) return;

	const client = new OpenCodeClient(cfg);

	const provider = {
		api: "opencode-session",
		apiKey: "public",
		baseUrl: "https://opencode.ai/zen/v1",
		// Dynamic discovery. OMP caches the result (SQLite, 24h TTL) and calls this
		// on a cache miss. Never throws: a discovery failure must not break OMP
		// startup, it just yields no models.
		async fetchDynamicModels() {
			if (cfg.discovery === false) return [];
			try {
				return await client.discoverModels();
			} catch {
				return [];
			}
		},
	};

	if (cfg.inference !== false) {
		// OMP does not hand extensions its own stream class, so makeStreamSimple
		// falls back to the minimal EventStream in stream.js.
		provider.streamSimple = makeStreamSimple(client, undefined, { inference: true });
	}

	try {
		// Named "opencode-bridge", not "opencode": OpenCode's own default provider is
		// also called "opencode", so that name would render every model as the
		// ambiguous `opencode/opencode/<model>`. This yields selectors like
		// `opencode-bridge/opencode/space-bunny-free`, which mapRequest() splits
		// back into the providerID/modelID pair OpenCode expects.
		pi.registerProvider("opencode-bridge", provider);
	} catch (e) {
		// Registration API mismatch: warn and bail gracefully rather than taking
		// down the host. `logger` is OMP's real surface; pi.log is a fallback.
		const msg = `opencode-bridge: registerProvider failed: ${e.message}`;
		(pi?.logger?.warn ?? pi?.log?.warn)?.(msg);
	}
}

function readSettings(pi) {
	const s = pi?.settings || pi?.config || {};
	const get = (k, d) => (s[k] !== undefined ? s[k] : d);
	return {
		enabled: get("enabled", true),
		opencodePath: get("opencodePath", undefined),
		server: get("server", undefined),
		discovery: get("discovery", true),
		inference: get("inference", true),
		timeoutMs: get("timeoutMs", 30000),
	};
}
