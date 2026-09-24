// A profile names its key either literally (`apiKey`, kept in the gitignored
// profile file) or by environment variable reference (`apiKeyEnv`). Nothing is
// hardcoded in source; both forms end up in the same {id, …} shape.
import { CapabilityError } from "./stream.js";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function loadCredentialProfiles(file) {
	const contents = readFileSync(file, "utf8");
	let config;
	try { config = parse(contents); }
	catch { throw new Error("invalid YAML profile file"); }
	if (!config || typeof config !== "object" || Array.isArray(config) || !config.providers || typeof config.providers !== "object" || Array.isArray(config.providers)) {
		throw new Error("profile file must contain a providers mapping");
	}
	return credentialProfiles(config.providers);
}

export function credentialProfiles(providers = {}) {
	const profiles = new Map();
	for (const [providerID, config] of Object.entries(providers || {})) {
		if (!providerID || providerID.includes("/")) throw new Error("invalid provider ID in credential profiles");
		const list = config?.credentials || [];
		if (!Array.isArray(list)) throw new Error(`credentials for ${providerID} must be an array`);
		const seen = new Set();
		const out = [];
		for (const item of list) {
			if (!ID.test(item?.id || "") || seen.has(item.id)) {
				throw new Error(`invalid or duplicate credential profile for ${providerID}`);
			}
			const key = typeof item.apiKey === "string" ? item.apiKey : "";
			// Either form is enough; apiKeyEnv is only required when there is no literal key.
			if (item.apiKeyEnv !== undefined && !ENV.test(item.apiKeyEnv || "")) {
				throw new Error(`invalid credential profile for ${providerID}`);
			}
			if (!key && !ENV.test(item.apiKeyEnv || "")) {
				throw new Error(`credential profile ${providerID}/${item.id} needs an apiKey or apiKeyEnv`);
			}
			if (key && item.id === key) throw new Error(`credential profile ID for ${providerID} cannot equal its API key`);
			seen.add(item.id);
			out.push(key ? { id: item.id, apiKeyEnv: item.apiKeyEnv, apiKey: key } : { id: item.id, apiKeyEnv: item.apiKeyEnv });
		}
		if (list.length) profiles.set(providerID, out);
	}
	return profiles;
}

export function expandModels(models, profiles) {
	const descriptors = new Map();
	const output = [];
	const emitted = new Set();
	for (const model of models) {
		// One duplicate upstream record (a provider listed twice, a repeated table
		// row) must not take down every other model: emit it once and move on.
		if (emitted.has(model.id)) continue;
		emitted.add(model.id);
		const slash = model.id.indexOf("/");
		const providerID = model.id.slice(0, slash);
		const modelID = model.id.slice(slash + 1);
		const entries = profiles.get(providerID);
		if (!entries?.length) { output.push(model); continue; }
		for (const profile of entries) {
			// Encode the complete upstream model ID so @, %, and / cannot collide
			// with the credential suffix or another upstream model name.
			const id = `${providerID}/${encodeURIComponent(modelID)}@${profile.id}`;
			const descriptor = { ompModelId: id, providerID, modelID, credentialId: profile.id, credentialSource: profile.apiKeyEnv, apiKey: profile.apiKey };
			descriptors.set(id, descriptor);
			output.push({ ...model, id, name: `${model.name} [${profile.id}]` });
		}
	}
	return { models: output, descriptors };
}

export function parseProfileModelId(id) {
	const raw = String(id).replace(/^opencode-bridge\//, "");
	const slash = raw.indexOf("/");
	const at = raw.lastIndexOf("@");
	if (slash < 1 || at < slash + 2) throw new CapabilityError("invalid credential model ID");
	const providerID = raw.slice(0, slash);
	const credentialId = raw.slice(at + 1);
	if (!ID.test(credentialId)) throw new CapabilityError("invalid credential profile ID");
	let modelID;
	try { modelID = decodeURIComponent(raw.slice(slash + 1, at)); } catch { throw new CapabilityError("invalid encoded model ID"); }
	if (!modelID || encodeURIComponent(modelID) !== raw.slice(slash + 1, at)) throw new CapabilityError("invalid encoded model ID");
	return { providerID, modelID, credentialId };
}

export function resolveProfileModel(model, descriptors, profiles) {
	const id = String(model.id).replace(/^opencode-bridge\//, "");
	const descriptor = descriptors.get(id);
	if (descriptor) return descriptor;
	const providerID = id.split("/")[0];
	if (profiles.has(providerID)) {
		// OMP can serve cached dynamic model configs without calling discovery.
		// An un-suffixed id here is a pre-upgrade cache entry, not a corrupt one:
		// it must keep working on the default client, exactly as it did before
		// profiles existed, instead of failing until the user refreshes.
		if (!id.includes("@")) return null;
		const parsed = parseProfileModelId(id);
		const profile = profiles.get(providerID).find((item) => item.id === parsed.credentialId);
		if (!profile) throw new CapabilityError(`unknown credential profile: ${providerID}/${parsed.credentialId}`, { capability: "credential" });
		return { ompModelId: id, providerID, modelID: parsed.modelID, credentialId: profile.id, credentialSource: profile.apiKeyEnv, apiKey: profile.apiKey };
	}
	return null; // unconfigured providers keep their original model IDs and auth path
}

export function credentialStatus(profiles, env = process.env) {
	// Never echo the key itself — only whether one was found, and where it came from.
	return [...profiles].flatMap(([providerID, entries]) => entries.map(({ id, apiKeyEnv, apiKey }) => ({
		providerID,
		id,
		apiKeyEnv: apiKey ? "(profile file)" : apiKeyEnv,
		status: apiKey || env[apiKeyEnv] ? "configured" : "missing",
	})));
}
