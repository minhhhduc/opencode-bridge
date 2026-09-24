import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialProfiles, expandModels, parseProfileModelId, resolveProfileModel, credentialStatus, loadCredentialProfiles } from "../src/credentials.js";
import { OpenCodeClientPool } from "../src/client-pool.js";
import { makeStreamSimple, mapRequest } from "../src/stream.js";

const config = { opencode: { credentials: [
	{ id: "account1", apiKeyEnv: "TEST_OC_KEY_1" },
	{ id: "account2", apiKeyEnv: "TEST_OC_KEY_2" },
	{ id: "account3", apiKeyEnv: "TEST_OC_KEY_3" },
] } };
const models = [
	{ id: "opencode/gpt-5.6-sol", name: "Sol", input: ["text"], reasoning: true, cost: { input: 1 }, contextWindow: 123, maxTokens: 456 },
	{ id: "opencode/model@account1", name: "At", input: ["text", "image"], reasoning: false },
	{ id: "other/model", name: "Other", input: ["text"] },
];

test("one model and one key clone metadata and keep original model identity", () => {
	const profiles = credentialProfiles({ opencode: { credentials: config.opencode.credentials.slice(0, 1) } });
	const { models: out, descriptors } = expandModels(models.slice(0, 1), profiles);
	assert.equal(out[0].id, "opencode/gpt-5.6-sol@account1");
	assert.deepEqual(out[0].input, models[0].input);
	assert.equal(out[0].contextWindow, 123);
	assert.equal(out[0].maxTokens, 456);
	assert.equal(out[0].reasoning, true);
	assert.deepEqual(out[0].cost, models[0].cost);
	assert.deepEqual(descriptors.get(out[0].id), {
		ompModelId: out[0].id, providerID: "opencode", modelID: "gpt-5.6-sol", credentialId: "account1", credentialSource: "TEST_OC_KEY_1",
	});
});

test("three keys clone every discovered model; unconfigured provider stays unchanged", () => {
	const profiles = credentialProfiles(config);
	const { models: out } = expandModels(models, profiles);
	assert.equal(out.length, 7);
	assert.deepEqual(out.slice(0, 3).map((m) => m.id), ["opencode/gpt-5.6-sol@account1", "opencode/gpt-5.6-sol@account2", "opencode/gpt-5.6-sol@account3"]);
	assert.equal(out.at(-1), models.at(-1));
	assert.equal(out[3].id, "opencode/model%40account1@account1");
	assert.deepEqual(parseProfileModelId(out[3].id), { providerID: "opencode", modelID: "model@account1", credentialId: "account1" });
	assert.equal(new Set(out.map((m) => m.id)).size, out.length);
});

test("descriptor resolves cached OMP model and strips credential from upstream ID", () => {
	const profiles = credentialProfiles(config);
	const descriptor = resolveProfileModel({ id: "opencode-bridge/opencode/gpt-5.6-sol@account2" }, new Map(), profiles);
	assert.equal(descriptor.credentialSource, "TEST_OC_KEY_2");
	const mapped = mapRequest({ id: "opencode-bridge/opencode/gpt-5.6-sol@account2" }, { messages: [{ role: "user", content: "hi" }] }, {}, descriptor);
	assert.deepEqual(mapped.sessionBody.model, { providerID: "opencode", id: "gpt-5.6-sol" });
	assert.equal(resolveProfileModel({ id: "opencode-bridge/other/model" }, new Map(), profiles), null);
	assert.throws(() => resolveProfileModel({ id: "opencode-bridge/opencode/model@absent" }, new Map(), profiles), /unknown credential profile/);
	assert.throws(() => parseProfileModelId("opencode/model%ZZ@account1"), /encoded/);
});

// Regression: OMP caches dynamic model configs for 24h, so a user who adds
// profiles still has pre-upgrade, un-suffixed ids in the cache. Those used to
// throw "invalid credential model ID", breaking every previously-working model
// until a manual `omp models refresh`. An optional feature must not do that.
test("pre-upgrade cached model IDs still resolve to the default client", () => {
	const profiles = credentialProfiles(config);
	for (const id of ["opencode/gpt-5.6-sol", "opencode-bridge/opencode/gpt-5.6-sol"]) {
		assert.equal(resolveProfileModel({ id }, new Map(), profiles), null, `${id} must fall back, not throw`);
	}
	// …and it must still work end-to-end, on the old unprofiled path.
	const mapped = mapRequest({ id: "opencode-bridge/opencode/gpt-5.6-sol" }, { messages: [{ role: "user", content: "hi" }] });
	assert.deepEqual(mapped.sessionBody.model, { providerID: "opencode", id: "gpt-5.6-sol" });
});

// Regression: a duplicate upstream record used to throw, and the blanket catch
// in fetchDynamicModels turned that into ZERO advertised models — one dup wiped
// out the whole provider instead of just the dup.
test("duplicate upstream model records are collapsed, not fatal", () => {
	const profiles = credentialProfiles(config);
	const { models } = expandModels([
		{ id: "opencode/gpt-5.6-sol", name: "Sol" },
		{ id: "opencode/gpt-5.6-sol", name: "Sol" },
		{ id: "opencode/other-model", name: "Other" },
	], profiles);
	assert.deepEqual(models.map((m) => m.id), [
		"opencode/gpt-5.6-sol@account1", "opencode/gpt-5.6-sol@account2", "opencode/gpt-5.6-sol@account3",
		"opencode/other-model@account1", "opencode/other-model@account2", "opencode/other-model@account3",
	]);
});

test("invalid or duplicate profile IDs are rejected; status never contains key value", () => {
	assert.throws(() => credentialProfiles({ x: { credentials: [{ id: "a", apiKeyEnv: "KEY" }, { id: "a", apiKeyEnv: "KEY2" }] } }), /duplicate/);
	assert.throws(() => credentialProfiles({ x: { credentials: [{ id: "a@b", apiKeyEnv: "KEY" }] } }), /invalid/);
	const status = credentialStatus(credentialProfiles(config), { TEST_OC_KEY_1: "never-show-this" });
	assert.deepEqual(status.map((x) => x.status), ["configured", "missing", "missing"]);
	assert.ok(!JSON.stringify(status).includes("never-show-this"));
});

test("concurrent profile requests use distinct cached clients and selected secrets", async () => {
	const profiles = credentialProfiles(config);
	const old1 = process.env.TEST_OC_KEY_1;
	const old2 = process.env.TEST_OC_KEY_2;
	process.env.TEST_OC_KEY_1 = "key-one-secret";
	process.env.TEST_OC_KEY_2 = "key-two-secret";
	const seen = [];
	const pool = new OpenCodeClientPool({}, profiles, { spawnServer: async (_cfg, d, secret) => {
		await new Promise((r) => setTimeout(r, d.credentialId === "account1" ? 10 : 2));
		const client = { streamingSupported: false, async api(op, opts) {
			if (op === "session.create") { seen.push({ account: d.credentialId, secret, model: opts.data.model }); return { data: { id: `ses_${d.credentialId}` } }; }
			if (op === "session.message.list") return { data: [{ type: "assistant", time: { created: 1 }, content: [{ type: "text", text: d.credentialId }] }] };
			return null;
		} };
		return { client, close() {} };
	} });
	try {
		const resolveModel = (model) => resolveProfileModel(model, new Map(), profiles);
		const stream = makeStreamSimple(null, undefined, { resolveModel, resolveClient: (d) => pool.get(d), sanitize: (s) => pool.sanitize(s) });
		const ctx = { messages: [{ role: "user", content: "hi" }] };
		const a = stream({ id: "opencode-bridge/opencode/gpt-5.6-sol@account1" }, ctx);
		const b = stream({ id: "opencode-bridge/opencode/gpt-5.6-sol@account2" }, ctx);
		await Promise.all([a.result(), b.result()]);
		assert.deepEqual(seen.map(({ account, secret }) => [account, secret]).sort(), [["account1", "key-one-secret"], ["account2", "key-two-secret"]]);
		assert.ok(seen.every(({ model }) => model.providerID === "opencode" && model.id === "gpt-5.6-sol"));
		assert.equal(await pool.get(resolveModel({ id: "opencode-bridge/opencode/gpt-5.6-sol@account1" })), await pool.get(resolveModel({ id: "opencode-bridge/opencode/gpt-5.6-sol@account1" })));
		assert.equal(pool.sanitize("bad key-one-secret and key-two-secret"), "bad *** and ***");
	} finally {
		pool.close();
		if (old1 === undefined) delete process.env.TEST_OC_KEY_1; else process.env.TEST_OC_KEY_1 = old1;
		if (old2 === undefined) delete process.env.TEST_OC_KEY_2; else process.env.TEST_OC_KEY_2 = old2;
	}
});

test("missing credential emits a useful error without starting a client", async () => {
	const profiles = credentialProfiles(config);
	const old = process.env.TEST_OC_KEY_3;
	delete process.env.TEST_OC_KEY_3;
	let started = false;
	const pool = new OpenCodeClientPool({}, profiles, { spawnServer: async () => { started = true; } });
	try {
		await assert.rejects(() => pool.get(resolveProfileModel({ id: "opencode-bridge/opencode/m@account3" }, new Map(), profiles)), /TEST_OC_KEY_3/);
		assert.equal(started, false);
	} finally {
		if (old !== undefined) process.env.TEST_OC_KEY_3 = old;
	}
});

test("invalid credential error is sanitized before it leaves the pool", async () => {
	const profiles = credentialProfiles(config);
	const old = process.env.TEST_OC_KEY_1;
	process.env.TEST_OC_KEY_1 = "unusual-secret-value";
	const pool = new OpenCodeClientPool({}, profiles, { spawnServer: async () => { throw new Error("401 invalid unusual-secret-value"); } });
	try {
		await assert.rejects(() => pool.get(resolveProfileModel({ id: "opencode-bridge/opencode/m@account1" }, new Map(), profiles)), (e) => {
			assert.match(e.message, /401 invalid \*\*\*/);
			assert.ok(!e.message.includes("unusual-secret-value"));
			return true;
		});
	} finally {
		if (old === undefined) delete process.env.TEST_OC_KEY_1; else process.env.TEST_OC_KEY_1 = old;
	}
});

test("inference authentication error hides the selected key", async () => {
	const profiles = credentialProfiles(config);
	const old = process.env.TEST_OC_KEY_1;
	process.env.TEST_OC_KEY_1 = "secret-in-auth-error";
	const pool = new OpenCodeClientPool({}, profiles, { spawnServer: async () => ({
		client: { streamingSupported: false, async api() { throw new Error("401 invalid secret-in-auth-error"); } }, close() {},
	}) });
	try {
		const stream = makeStreamSimple(null, undefined, {
			resolveModel: (model) => resolveProfileModel(model, new Map(), profiles),
			resolveClient: (descriptor) => pool.get(descriptor),
			sanitize: (message) => pool.sanitize(message),
		});
		const result = stream({ id: "opencode-bridge/opencode/m@account1" }, { messages: [{ role: "user", content: "hi" }] });
		await result.result();
		const error = result.events.find((event) => event.type === "error");
		assert.match(error.error.content[0].text, /401 invalid \*\*\*/);
		assert.ok(!JSON.stringify(result.events).includes("secret-in-auth-error"));
	} finally {
		pool.close();
		if (old === undefined) delete process.env.TEST_OC_KEY_1; else process.env.TEST_OC_KEY_1 = old;
	}
});

test("keys command reports status without printing the key", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-keys-test-"));
	const file = join(dir, "profiles.yml");
	writeFileSync(file, "# Environment references only\nproviders:\n  opencode:\n    credentials:\n      - id: account1\n        apiKeyEnv: TEST_OC_KEY_1\n");
	try {
		assert.equal(loadCredentialProfiles(file).get("opencode")[0].id, "account1");
		const result = spawnSync(process.execPath, ["src/cli.js", "keys", "--profiles-file", file], {
			cwd: process.cwd(), encoding: "utf8", env: { ...process.env, TEST_OC_KEY_1: "secret-must-stay-private" },
		});
		assert.equal(result.status, 0);
		assert.match(result.stdout, /opencode\/account1\s+configured/);
		assert.ok(!result.stdout.includes("secret-must-stay-private"));
	} finally { unlinkSync(file); rmdirSync(dir); }
});

test("malformed YAML profile file is rejected", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-keys-test-"));
	const file = join(dir, "profiles.yml");
	writeFileSync(file, "providers:\n  opencode: [broken\n");
	try { assert.throws(() => loadCredentialProfiles(file)); }
	finally { unlinkSync(file); rmdirSync(dir); }
});

// Regression: a bad profile file used to `return` from activate(), which left
// the whole provider unregistered — the previously working unprofiled bridge
// disappeared from OMP's model list. Profiles are opt-in; losing them must not
// cost the user the bridge.
test("invalid profile config keeps the bridge provider registered", async () => {
	const { default: activate } = await import("../src/extension.js");
	for (const settings of [
		{ profilesFile: join(tmpdir(), "omp-does-not-exist-profiles.yml") },
		{ profilesFile: "not-a-real-dir/nope.yml" },
	]) {
		const registered = [];
		const warnings = [];
		activate({
			settings,
			registerProvider: (name) => registered.push(name),
			logger: { warn: (m) => warnings.push(m) },
		});
		assert.deepEqual(registered, ["opencode-bridge"], `provider dropped for ${JSON.stringify(settings)}`);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /continuing without profiles/);
	}
});

// Regression: an exported-but-malformed OPENCODE_CONFIG_CONTENT used to throw
// out of JSON.parse inside startServer, failing every profiled request.
test("malformed OPENCODE_CONFIG_CONTENT does not break the profile config merge", async () => {
	const { mergeProfileConfig } = await import("../src/client-pool.js");
	const previous = process.env.OPENCODE_CONFIG_CONTENT;
	try {
		for (const [raw, expectBase] of [
			["{ this is not json", false],
			[JSON.stringify({ providers: { mock: { settings: { baseURL: "http://x/v1" } } } }), true],
		]) {
			process.env.OPENCODE_CONFIG_CONTENT = raw;
			const content = mergeProfileConfig("mock", "SLOT_VAR");
			assert.deepEqual(content.providers.mock.settings, {
				...(expectBase ? { baseURL: "http://x/v1" } : {}),
				apiKey: "{env:SLOT_VAR}",
			});
		}
	} finally {
		if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
		else process.env.OPENCODE_CONFIG_CONTENT = previous;
	}
});
