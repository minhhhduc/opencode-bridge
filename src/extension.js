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
import { credentialProfiles, expandModels, resolveProfileModel, loadConfigFile, resolveProfilesFile } from "./credentials.js";
import { OpenCodeClientPool } from "./client-pool.js";
import { directProviders, directProvidersFrom, expandDirectModels, resolveDirectModel, discoverModels } from "./direct.js";
import { makeDirectStreamSimple } from "./direct-stream.js";

// `api` must be a CUSTOM name; built-ins are reserved and registerProvider
// throws. Placeholders unlock OMP's dynamic discovery — every real request is
// routed by streamSimple, so no OMP traffic ever reaches them and no
// credential is copied into OMP.
const PLACEHOLDER = { apiKey: "public", baseUrl: "https://opencode.ai/zen/v1" };
const DIRECT_PROVIDER = "direct";

export default function activate(pi) {
	const cfg = readSettings(pi);
	if (cfg.enabled === false) return;
	const warn = (m) => (pi?.logger?.warn ?? pi?.log?.warn)?.(m);

	// The profile file holds BOTH kinds of config: `providers:` (OpenCode
	// credential profiles) and `directProviders:` (baseURL providers). It is
	// parsed exactly once and both loaders read from the result, so one broken
	// file produces one warning rather than one per source.
	let config = null;
	try { config = loadConfigFile(resolveProfilesFile(cfg.profilesFile)).config; }
	catch (e) {
		// ENOENT = "not configured yet", the normal state of a fresh install.
		if (e?.code !== "ENOENT") {
			warn(`opencode-bridge: invalid credential profile configuration, continuing without profiles: ${e.message}`);
		}
	}

	registerDirectProvider(pi, cfg, config, warn);

	const client = new OpenCodeClient(cfg);
	// A bad profile file must not take the provider down: profiles are opt-in on
	// top of the pre-existing single-credential path. Warn loudly, then keep the
	// unprofiled bridge working instead of unregistering it.
	let profiles = new Map();
	try {
		if (cfg.providers?.directProviders !== undefined) {
			// Inline settings config: direct-only, so skip the file's `providers`.
			profiles = credentialProfiles({});
		} else if (cfg.profilesFile === false) {
			profiles = credentialProfiles(cfg.providers);
		} else if (config?.providers) {
			profiles = credentialProfiles(config.providers);
		}
	} catch (e) {
		warn(`opencode-bridge: invalid credential profile configuration, continuing without profiles: ${e.message}`);
	}
	const pool = new OpenCodeClientPool(cfg, profiles);
	let descriptors = new Map();

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
				const found = await client.discoverModels();
				const expanded = expandModels(found, profiles);
				descriptors = expanded.descriptors;
				return expanded.models;
			} catch {
				return [];
			}
		},
	};

	if (cfg.inference !== false) {
		// OMP does not hand extensions its own stream class, so makeStreamSimple
		// falls back to the minimal EventStream in stream.js.
		provider.streamSimple = makeStreamSimple(client, undefined, {
			inference: true,
			resolveModel: (model) => resolveProfileModel(model, descriptors, profiles),
			resolveClient: (descriptor) => pool.get(descriptor),
			sanitize: (message) => pool.sanitize(message),
		});
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

/**
 * Register the SECOND, independent model source: direct-URL providers.
 *
 * Configured only in the bridge's own profile file, discovered only from that
 * file (never from OpenCode, never from `/api/provider`), and inferred by
 * talking straight to the configured baseURL. Registers under its own provider
 * name, so its selectors are `direct/<provider>/<model>@<credential>` and cannot
 * collide with the OpenCode bridge's `opencode-bridge/...`.
 *
 * A malformed or absent direct config must never take the OpenCode bridge down
 * with it, so failures warn and skip this provider only.
 */
function registerDirectProvider(pi, cfg, config, warn) {
	let providers;
	try {
		// settings.providers.directProviders is an escape hatch; the profile
		// file's top-level `directProviders:` is the documented home.
		providers = cfg.providers?.directProviders !== undefined
			? directProviders(cfg.providers.directProviders, { checkEnv: true })
			: directProvidersFrom(config);
	} catch (e) {
		warn(`opencode-bridge: invalid direct provider configuration, direct providers disabled: ${e.message}`);
		return;
	}
	if (!providers.size) return; // nothing configured — not an error, just absent

	const descriptors = expandDirectModels(providers).descriptors;
	const streamSimple = makeDirectStreamSimple({ providers, resolve: (model) => resolveDirectModel(model, descriptors, providers) });

	// Optional /v1/models discovery. Purely additive and never destructive: a
	// failure leaves the manual model list exactly as configured.
	const withDiscovered = async (base) => {
		const extra = [];
		for (const provider of providers.values()) {
			extra.push(...await discoverModels(provider));
		}
		return base.concat(extra);
	};

	pi.registerProvider(DIRECT_PROVIDER, {
		api: "direct-url-api",
		...PLACEHOLDER,
		async fetchDynamicModels() {
			if (cfg.discovery === false) return expandDirectModels(providers).models;
			return withDiscovered(expandDirectModels(providers).models);
		},
		streamSimple,
	});
}

function readSettings(pi) {
	const s = pi?.settings || pi?.config || {};
	const get = (k, d) => (s[k] !== undefined ? s[k] : d);
	return {
		enabled: get("enabled", true),
		opencodePath: get("opencodePath", undefined),
		server: get("server", undefined),
		providers: get("providers", {}),
		// undefined → resolveProfilesFile finds the installed-plugin / ~/.omp copy.
		// false → profiles explicitly disabled for this session.
		profilesFile: get("profilesFile", undefined),
		discovery: get("discovery", true),
		inference: get("inference", true),
		timeoutMs: get("timeoutMs", 30000),
	};
}
