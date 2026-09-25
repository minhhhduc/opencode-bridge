// Direct (non-OpenCode) model source.
//
// A direct provider is a baseURL the plugin talks to itself. It is configured
// in the bridge's own profile file, is registered as its own OMP provider, and
// never touches OpenCode — no opencode.json entry, no `/api/provider`, no
// client pool, no shared credential state.
//
//   OMP model id:  direct/<providerID>/<modelID>@<credentialId>
//   (OMP prepends the registered provider name "direct" itself, so the ids
//   handed to fetchDynamicModels are "<providerID>/<modelID>@<credentialId>".)
//
// The namespace cannot collide with the OpenCode bridge, whose selectors are
// `opencode-bridge/<provider>/<model>`, and one credential becomes one
// independently selectable model instance.

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Protocol → wire shape. `openai-chat` is the de-facto standard every
 * OpenAI-compatible gateway speaks; `openai-responses` is OpenAI's newer
 * Responses API. They are separate endpoints, not interchangeable, so the
 * configured one decides the path — no guessing, no sending to both.
 */
export const PROTOCOLS = {
	"openai-chat": { path: "chat/completions", stream: "chat" },
	"openai-responses": { path: "responses", stream: "responses" },
};

const MODALITIES = ["text", "image"];

function fail(msg) {
	const e = new Error(msg);
	e.name = "DirectConfigError";
	return e;
}

/**
 * Read `directProviders` out of the bridge's own profile file — the same file
 * that holds OpenCode credential profiles, because that is the one place a
 * user is told to put their keys. OpenCode never reads this file.
 */
/**
 * Direct providers out of an already-parsed config object (the shared profile
 * file). Returns an empty Map when the section is absent — "not configured" is
 * the normal state, not an error.
 */
export function directProvidersFrom(config, options) {
	return directProviders(config?.directProviders ?? {}, options);
}

/**
 * Validate and normalize `directProviders` into a Map<providerID, provider>.
 * Throws on the first problem, naming the provider/credential but never a key
 * value — a bad config is a startup error, not a silent empty model list.
 */
export function directProviders(providers = {}, { env = process.env, checkEnv = true } = {}) {
	const out = new Map();
	for (const [id, config] of Object.entries(providers || {})) {
		if (!ID.test(id || "")) throw fail(`direct provider "${id}": invalid provider id`);
		if (out.has(id)) throw fail(`direct provider "${id}": duplicate provider id`);
		out.set(id, normalizeProvider(id, config, { env, checkEnv }));
	}
	return out;
}

function normalizeProvider(id, config, { env, checkEnv }) {
	const name = typeof config?.name === "string" && config.name ? config.name : id;

	const protocol = config?.protocol ?? "openai-chat";
	if (!Object.hasOwn(PROTOCOLS, protocol)) {
		throw fail(`direct provider "${id}": unknown protocol "${protocol}" (expected ${Object.keys(PROTOCOLS).join(" or ")})`);
	}

	const baseURL = typeof config?.baseURL === "string" ? config.baseURL.trim() : "";
	if (!baseURL) throw fail(`direct provider "${id}": baseURL is required`);
	let parsed;
	try { parsed = new URL(baseURL); } catch { throw fail(`direct provider "${id}": baseURL is not a valid URL`); }
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw fail(`direct provider "${id}": baseURL must be http(s), got "${parsed.protocol}"`);
	}
	// Trailing slashes would produce `https://host/v1//chat/completions`.
	const root = baseURL.replace(/\/+$/, "");

	const credentials = normalizeCredentials(id, config?.credentials, { env, checkEnv });
	if (!credentials.length) throw fail(`direct provider "${id}": at least one credential is required`);

	const models = normalizeModels(id, config?.models);
	if (!models.length && !config?.discovery?.enabled) {
		throw fail(`direct provider "${id}": no models configured and discovery is disabled`);
	}

	return {
		id, name, protocol, baseURL: root,
		supportsTools: config?.supportsTools !== false,
		credentials, models,
		discovery: {
			enabled: config?.discovery?.enabled === true,
			endpoint: typeof config?.discovery?.endpoint === "string" && config.discovery.endpoint
				? config.discovery.endpoint
				: "/models",
		},
	};
}

function normalizeCredentials(providerID, list, { env, checkEnv }) {
	if (list !== undefined && !Array.isArray(list)) {
		throw fail(`direct provider "${providerID}": credentials must be an array`);
	}
	const seen = new Set();
	const out = [];
	for (const item of list || []) {
		const id = item?.id;
		if (!ID.test(id || "")) throw fail(`direct provider "${providerID}": invalid credential id "${id ?? ""}"`);
		if (seen.has(id)) throw fail(`direct provider "${providerID}": credential "${providerID}/${id}" is duplicated`);
		if (item?.apiKeyEnv !== undefined && !ENV.test(item.apiKeyEnv || "")) {
			throw fail(`direct provider "${providerID}": credential "${providerID}/${id}": invalid environment variable name "${item.apiKeyEnv}"`);
		}
		const key = typeof item?.apiKey === "string" && item.apiKey ? item.apiKey : "";
		if (!key && !ENV.test(item?.apiKeyEnv || "")) {
			throw fail(`direct provider "${providerID}": credential "${providerID}/${id}" needs an apiKey or apiKeyEnv`);
		}
		if (key && id === key) throw fail(`direct provider "${providerID}": credential id "${id}" cannot equal its API key`);
		if (checkEnv && !key && !env[item.apiKeyEnv]) {
			// Names the variable, never the value.
			throw fail(`direct provider "${providerID}": credential "${providerID}/${id}": environment variable ${item.apiKeyEnv} is not set`);
		}
		seen.add(id);
		out.push({ id, apiKeyEnv: item.apiKeyEnv, apiKey: key || undefined });
	}
	return out;
}

function normalizeModels(providerID, list) {
	if (list !== undefined && !Array.isArray(list)) {
		throw fail(`direct provider "${providerID}": models must be an array`);
	}
	const seen = new Set();
	const out = [];
	for (const item of list || []) {
		const id = item?.id;
		// @ and / are permitted in a model id: both are percent-encoded into the
		// OMP id, so they cannot forge a credential suffix or a path separator.
		if (typeof id !== "string" || !id.trim()) {
			throw fail(`direct provider "${providerID}": invalid model id "${id ?? ""}"`);
		}
		if (seen.has(id)) throw fail(`direct provider "${providerID}": model "${providerID}/${id}" is duplicated`);
		const caps = item?.capabilities ?? {};
		if (caps.streaming !== undefined && typeof caps.streaming !== "boolean") {
			throw fail(`direct provider "${providerID}": model "${id}": capabilities.streaming must be a boolean`);
		}
		const input = caps.vision === true ? ["text", "image"] : ["text"];
		for (const mod of input) if (!MODALITIES.includes(mod)) throw fail(`direct provider "${providerID}": unknown modality "${mod}"`);
		seen.add(id);
		out.push({
			id,
			name: typeof item.name === "string" && item.name ? item.name : id,
			reasoning: caps.reasoning === true,
			input,
			// OMP's model descriptor requires a cost object; a direct provider's
			// pricing is unknown, so declare zero rather than omitting the field
			// (an omitted cost makes OMP drop the model entirely).
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: positive(item?.contextWindow, 128000, providerID, id, "contextWindow"),
			maxTokens: positive(item?.maxOutputTokens ?? item?.maxTokens, 8192, providerID, id, "maxOutputTokens"),
		});
	}
	return out;
}

const positive = (v, fallback, providerID, modelID, field) => {
	if (v === undefined || v === null) return fallback;
	if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
		throw fail(`direct provider "${providerID}": model "${modelID}": ${field} must be a positive number`);
	}
	return Math.floor(v);
};

/**
 * One OMP model per (model × credential). A provider with no credentials
 * configured for a model still yields one instance per credential, so a key is
 * always selectable and its id always carries the `@<credentialId>` suffix —
 * that suffix is what routes it, not a display alias.
 */
export function expandDirectModels(providers) {
	const descriptors = new Map();
	const models = [];
	for (const provider of providers.values()) {
		for (const model of provider.models) {
			for (const credential of provider.credentials) {
				const id = `${provider.id}/${encodeURIComponent(model.id)}@${credential.id}`;
				descriptors.set(id, {
					source: "direct",
					ompModelId: id,
					providerID: provider.id,
					modelID: model.id,
					credentialId: credential.id,
					apiKeyEnv: credential.apiKeyEnv,
					apiKey: credential.apiKey,
					maxTokens: model.maxTokens,
				});
				models.push({ ...model, id, name: `${model.name} [${credential.id}]` });
			}
		}
	}
	return { models, descriptors };
}

/**
 * Resolve an OMP-supplied model id to a descriptor. Handles the registered
 * provider prefix OMP may or may not attach, and a cold descriptor map (OMP can
 * serve a cached model config without calling discovery) by re-deriving from
 * the id itself. Returns null when the provider is not a configured direct one,
 * so an unknown id falls through to a clear error rather than a wrong request.
 */
export function resolveDirectModel(model, descriptors, providers) {
	const raw = String(model?.id ?? "").replace(/^direct\//, "");
	const providerID = raw.slice(0, raw.indexOf("/"));
	if (!providers.has(providerID)) return null;
	const known = descriptors.get(raw);
	if (known) return known;
	const parsed = parseDirectModelId(raw);
	const credential = providers.get(parsed.providerID).credentials.find((c) => c.id === parsed.credentialId);
	if (!credential) {
		throw fail(`direct provider "${parsed.providerID}": unknown credential "${parsed.providerID}/${parsed.credentialId}"`);
	}
	const configured = providers.get(parsed.providerID).models.find((m) => m.id === parsed.modelID);
	return {
		source: "direct",
		ompModelId: raw,
		providerID: parsed.providerID,
		modelID: parsed.modelID,
		credentialId: credential.id,
		apiKeyEnv: credential.apiKeyEnv,
		apiKey: credential.apiKey,
		maxTokens: configured?.maxTokens ?? 8192,
	};
}

export function parseDirectModelId(id) {
	const raw = String(id).replace(/^direct\//, "");
	const slash = raw.indexOf("/");
	const at = raw.lastIndexOf("@");
	if (slash < 1 || at < slash + 2) throw fail(`invalid direct model id "${id}"`);
	const providerID = raw.slice(0, slash);
	const credentialId = raw.slice(at + 1);
	if (!ID.test(providerID) || !ID.test(credentialId)) throw fail(`invalid direct model id "${id}"`);
	let modelID;
	try { modelID = decodeURIComponent(raw.slice(slash + 1, at)); }
	catch { throw fail(`invalid direct model id "${id}"`); }
	return { providerID, modelID, credentialId };
}

/**
 * Resolve the key for one request. Literal key from the config file wins,
 * else the named environment variable read at request time (not at startup),
 * so `export`ing a key after OMP started still works. No global mutation: the
 * value is returned to this call only and never assigned to process.env.
 */
export function resolveApiKey(descriptor, env = process.env) {
	const key = descriptor.apiKey || env[descriptor.apiKeyEnv];
	if (!key) {
		const via = descriptor.apiKeyEnv ? `environment variable ${descriptor.apiKeyEnv} is not set` : "no apiKey or apiKeyEnv configured";
		throw fail(`direct provider "${descriptor.providerID}": credential "${descriptor.providerID}/${descriptor.credentialId}": ${via}`);
	}
	return key;
}

/**
 * Optional `GET <baseURL><endpoint>` discovery. Purely additive: it only ever
 * ADDS model ids. A failure, a 404, or an unparseable body returns the manual
 * list untouched, so a provider without /models costs nothing.
 */
export async function discoverModels(provider, { env = process.env, fetchImpl = fetch, signal } = {}) {
	if (!provider.discovery.enabled) return [];
	const credential = provider.credentials[0];
	if (!credential) return [];
	let key;
	try { key = resolveApiKey({ providerID: provider.id, credentialId: credential.id, apiKeyEnv: credential.apiKeyEnv, apiKey: credential.apiKey }, env); }
	catch { return []; }
	let response;
	try {
		response = await fetchImpl(`${provider.baseURL}${provider.discovery.endpoint}`, {
			headers: { accept: "application/json", authorization: `Bearer ${key}` },
			signal,
		});
	} catch { return []; }
	if (!response.ok) return [];
	let body;
	try { body = await response.json(); } catch { return []; }
	const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
	const seen = new Set(provider.models.map((m) => m.id));
	const extra = [];
	for (const item of list) {
		const id = typeof item === "string" ? item : item?.id;
		// "/" is allowed: expandDirectModels percent-encodes the model id into
		// the OMP id, so a vendor-prefixed id like "meta/muse-spark-1.3" is
		// unambiguous. Only blank and duplicate ids are dropped.
		if (typeof id !== "string" || !id.trim() || seen.has(id)) continue;
		seen.add(id);
		const arch = item?.architecture ?? {};
		extra.push({
			id,
			name: typeof item?.name === "string" && item.name ? item.name : id,
			reasoning: looksLikeReasoning(item),
			// Only the modalities OMP understands; a video/audio input model
			// still offers text, so it is usable rather than dropped.
			input: (Array.isArray(arch.input_modalities) ? arch.input_modalities : ["text"]).includes("image")
				? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: safePositive(item?.context_length, 128000),
			maxTokens: safePositive(item?.top_provider?.max_completion_tokens, 8192),
			discovered: true,
		});
	}
	return extra;
}

/**
 * No /models endpoint advertises reasoning as a boolean, so infer it from what
 * the payload does say: an explicit instruct_type (OpenRouter sets e.g.
 * "deepseek-r1"), or a reasoning family in the name/id. Errs towards true only
 * for those explicit signals — a false positive hides nothing, while a false
 * negative silently drops the model's thinking from OMP's picker.
 */
const REASONING_ID = /(^|[/:-])((r|qwq|reasoner|reasoning|think(er)?|mag[uo]d|distill-r|sr|trl|exaone-deep|small-think|gpt-oss)([-_.]|$|\d))/i;
const REASONING_TYPE = /reason|think|deepseek-r\d|qwq/i;

// Discovery is additive and must never fail on one odd record, so a bad limit
// falls back instead of throwing the way config validation does.
const safePositive = (v, fallback) =>
	typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;

function looksLikeReasoning(item) {
	const type = item?.architecture?.instruct_type;
	if (typeof type === "string" && REASONING_TYPE.test(type)) return true;
	const name = typeof item?.name === "string" ? item.name : "";
	return REASONING_ID.test(item?.id ?? "") || REASONING_ID.test(name);
}
