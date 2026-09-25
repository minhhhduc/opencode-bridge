// Direct (non-OpenCode) provider tests. Everything runs against an in-process
// loopback HTTP server standing in for the provider: no OpenCode, no network,
// no real key. Covers config validation, model registration, credential routing
// (including concurrency), streaming, tools, cancellation, HTTP errors, and the
// guarantee that a broken/absent OpenCode does not affect direct providers.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { directProviders, expandDirectModels, resolveDirectModel, resolveApiKey, discoverModels } from "../src/direct.js";
import { makeDirectStreamSimple, mapMessages, mapTools, DirectHttpError } from "../src/direct-stream.js";
import { default as activate } from "../src/extension.js";

// ── config validation ────────────────────────────────────────────────────────

const env = { JEV_API_KEY_1: "k1", JEV_API_KEY_2: "k2" };
const jev = (over = {}) => ({
	protocol: "openai-chat",
	baseURL: "https://api.jev.example/v1",
	models: [{ id: "jev", name: "JEV" }],
	credentials: [{ id: "account1", apiKeyEnv: "JEV_API_KEY_1" }, { id: "account2", apiKeyEnv: "JEV_API_KEY_2" }],
	...over,
});

test("one model + one key yields one model; two keys yield two independent ids", () => {
	const one = directProviders({ jev: jev({ credentials: [{ id: "account1", apiKeyEnv: "JEV_API_KEY_1" }] }) }, { env });
	const { models, descriptors } = expandDirectModels(one);
	assert.deepEqual(models.map((m) => m.id), ["jev/jev@account1"]);
	assert.equal(models[0].name, "JEV [account1]");
	assert.deepEqual(descriptors.get("jev/jev@account1"), {
		source: "direct", ompModelId: "jev/jev@account1",
		providerID: "jev", modelID: "jev", credentialId: "account1",
		apiKeyEnv: "JEV_API_KEY_1", apiKey: undefined, maxTokens: 8192,
	});

	const two = directProviders({ jev: jev() }, { env });
	assert.deepEqual(expandDirectModels(two).models.map((m) => m.id), ["jev/jev@account1", "jev/jev@account2"]);
});

test("multiple models and multiple providers expand independently", () => {
	const providers = directProviders({
		jev: jev({ models: [{ id: "jev" }, { id: "jev-large" }] }),
		other: jev({ baseURL: "https://other.example/v1", models: [{ id: "x" }], credentials: [{ id: "only", apiKeyEnv: "JEV_API_KEY_1" }] }),
	}, { env });
	assert.deepEqual(expandDirectModels(providers).models.map((m) => m.id).sort(), [
		"jev/jev-large@account1", "jev/jev-large@account2", "jev/jev@account1", "jev/jev@account2", "other/x@only",
	]);
});

test("direct and opencode namespaces cannot collide", () => {
	const ids = expandDirectModels(directProviders({ jev: jev() }, { env })).models.map((m) => `direct/${m.id}`);
	// The OpenCode bridge renders opencode/<model> under its own provider name.
	for (const id of ids) assert.ok(id.startsWith("direct/jev/"), id);
	assert.ok(!ids.some((id) => id.includes("opencode-bridge")));
});

test("capabilities map onto OMP's model descriptor", () => {
	const providers = directProviders({ jev: jev({ models: [{
		id: "jev", name: "JEV",
		capabilities: { streaming: true, tools: true, vision: true, reasoning: true },
		contextWindow: 200000, maxOutputTokens: 32000,
	} ] }) }, { env });
	const m = expandDirectModels(providers).models[0];
	assert.deepEqual(m.input, ["text", "image"]);
	assert.equal(m.reasoning, true);
	assert.equal(m.contextWindow, 200000);
	assert.equal(m.maxTokens, 32000);
});

test("config errors name the provider/credential and never the key", () => {
	const cases = [
		[{ jev: jev({ baseURL: undefined }) }, /baseURL is required/],
		[{ jev: jev({ baseURL: "not a url" }) }, /not a valid URL/],
		[{ jev: jev({ baseURL: "ftp://x/v1" }) }, /must be http/],
		[{ jev: jev({ protocol: "grpc" }) }, /unknown protocol/],
		[{ jev: jev({ credentials: [{ id: "a", apiKeyEnv: "JEV_API_KEY_1" }, { id: "a", apiKeyEnv: "JEV_API_KEY_2" }] }) }, /duplicated/],
		[{ jev: jev({ models: [{ id: "m" }, { id: "m" }] }) }, /model "jev\/m" is duplicated/],
		[{ jev: jev({ credentials: [] }) }, /at least one credential/],
		[{ jev: jev({ models: [{ id: "m", contextWindow: -1 }] }) }, /contextWindow must be a positive/],
		[{ jev: jev({ models: [{ id: "m", capabilities: { streaming: "yes" } }] }) }, /streaming must be a boolean/],
		[{ jev: jev({ models: [], discovery: { enabled: false } }) }, /no models configured/],
		[{ jev: jev({ credentials: [{ id: "a", apiKeyEnv: "MISSING_VAR" }] }) }, /environment variable MISSING_VAR is not set/],
	];
	for (const [config, pattern] of cases) {
		assert.throws(() => directProviders(config, { env }), pattern, JSON.stringify(Object.keys(config)));
	}
});

test("a missing environment variable is reported at config time and again at request time", () => {
	assert.throws(
		() => directProviders({ jev: jev({ credentials: [{ id: "a", apiKeyEnv: "NOT_SET" }] }) }, { env }),
		/direct provider "jev": credential "jev\/a": environment variable NOT_SET is not set/,
	);
	// The message names the variable, never a value.
	const descriptor = { providerID: "jev", credentialId: "a", apiKeyEnv: "NOT_SET" };
	assert.throws(() => resolveApiKey(descriptor, env), /NOT_SET is not set/);
	assert.doesNotThrow(() => resolveApiKey(descriptor, { NOT_SET: "later" }), "read at request time, so a late export works");
});

test("a literal apiKey is still supported and never equals the credential id", () => {
	const providers = directProviders({ jev: jev({ credentials: [{ id: "a", apiKey: "literal-secret" }] }) }, { env });
	assert.equal(resolveApiKey({ providerID: "jev", credentialId: "a", apiKey: "literal-secret" }, env), "literal-secret");
	assert.throws(() => directProviders({ jev: jev({ credentials: [{ id: "k", apiKey: "k" }] }) }, { env }), /cannot equal its API key/);
	void providers;
});

test("descriptors resolve from a cold map (cached OMP model config) and reject unknown ids", () => {
	const providers = directProviders({ jev: jev() }, { env });
	const cold = new Map();
	const d = resolveDirectModel({ id: "jev/jev@account2" }, cold, providers);
	assert.equal(d.credentialId, "account2");
	assert.equal(d.apiKeyEnv, "JEV_API_KEY_2");
	// OMP may or may not re-attach the registered provider name.
	assert.equal(resolveDirectModel({ id: "direct/jev/jev@account1" }, cold, providers).credentialId, "account1");
	assert.equal(resolveDirectModel({ id: "opencode/anthropic/claude" }, cold, providers), null, "not a direct model");
	assert.throws(() => resolveDirectModel({ id: "jev/jev@nope" }, cold, providers), /unknown credential/);
});

test("an @ in a model id is percent-encoded so it cannot forge a credential suffix", () => {
	const providers = directProviders({ jev: jev({ models: [{ id: "we@ird" }] }) }, { env });
	const id = expandDirectModels(providers).models[0].id;
	assert.equal(id, "jev/we%40ird@account1");
	assert.equal(resolveDirectModel({ id }, new Map(), providers).modelID, "we@ird");
});

// ── HTTP/SSE transport against a loopback provider ───────────────────────────

/**
 * A loopback OpenAI-compatible provider. `handler` receives each request and
 * returns the SSE body; the request's Authorization header and parsed body are
 * recorded so credential routing is observable, never assumed.
 */
async function startProvider(handler) {
	const requests = [];
	const server = http.createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		let body = null;
		try { body = JSON.parse(raw); } catch {}
		requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body, raw });
		const out = await handler(req, res, requests.length - 1);
		if (out === undefined) return; // handler wrote the response itself
		res.writeHead(out.status ?? 200, { "content-type": "text/event-stream" });
		res.end(out.sse);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return {
		requests,
		baseURL: `http://127.0.0.1:${server.address().port}/v1`,
		close: () => new Promise((r) => server.close(r)),
	};
}

const sse = (...frames) => frames.map((f) => (f === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(f)}\n\n`)).join("");
// `usage` is a top-level OpenAI field; `finish_reason` lives inside choices[0].
const chunk = (delta, extra = {}) => {
	const { usage, ...rest } = extra;
	return {
		id: "c", object: "chat.completion.chunk", model: "jev",
		choices: [{ index: 0, delta, finish_reason: null, ...rest }],
		...(usage ? { usage } : {}),
	};
};

function harness(providers, extra = {}) {
	const { models, descriptors } = expandDirectModels(providers);
	return makeDirectStreamSimple({
		providers,
		resolve: (model) => resolveDirectModel(model, descriptors, providers),
		env,
		...extra,
	});
}

const run = (stream) => stream.result().then(() => stream.events);

test("direct provider loads, registers, and infers with zero OpenCode involvement", async () => {
	const upstream = await startProvider(() => ({ sse: sse(chunk({ content: "JEV_ACCOUNT_1_OK" }, {}), chunk({}, { finish_reason: "stop" }), "[DONE]") }));
	try {
		const providers = directProviders({ jev: jev({ baseURL: upstream.baseURL }) }, { env });
		const streamSimple = harness(providers, { fetchImpl: fetch });
		const s = streamSimple({ id: "jev/jev@account1" }, { messages: [{ role: "user", content: "Reply exactly with: JEV_ACCOUNT_1_OK" }] }, {});
		const events = await run(s);
		const text = events.find((e) => e.type === "text_end").content;
		assert.equal(text, "JEV_ACCOUNT_1_OK");
		assert.equal(events.at(-1).type, "done");
		// The request went straight to the configured baseURL, with the right key.
		assert.equal(upstream.requests.length, 1);
		assert.equal(upstream.requests[0].url, "/v1/chat/completions");
		assert.equal(upstream.requests[0].authorization, "Bearer k1");
		assert.equal(upstream.requests[0].body.model, "jev");
		assert.match(upstream.requests[0].body.messages[0].content, /JEV_ACCOUNT_1_OK/);
	} finally { await upstream.close(); }
});

test("streamed deltas are emitted as they arrive, not buffered to the end", async () => {
	let sent = 0;
	const upstream = await startProvider(async (_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		for (const piece of ["one ", "two ", "three"]) {
			await new Promise((r) => setTimeout(r, 10));
			res.write(`data: ${JSON.stringify(chunk({ content: piece }))}\n\n`);
			sent++;
		}
		res.write(`data: ${JSON.stringify(chunk({}, { finish_reason: "stop" }))}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
		return undefined;
	});
	try {
		const providers = directProviders({ jev: jev({ baseURL: upstream.baseURL }) }, { env });
		const s = harness(providers)({ id: "jev/jev@account1" }, { messages: [{ role: "user", content: "hi" }] }, {});
		// Before the stream ends, the deltas already on the wire must be visible.
		await new Promise((r) => setTimeout(r, 40));
		assert.ok(s.events.some((e) => e.type === "text_delta"), "deltas are not buffered until the end");
		await s.result();
		assert.ok(sent >= 2);
		assert.equal(s.events.find((e) => e.type === "text_end").content, "one two three");
	} finally { await upstream.close(); }
});

test("concurrent requests on two credentials never share state", async () => {
	// The mock answers "ACCOUNT_N_OK" only if the key that arrived is the right
	// one, so a cross-wired key produces a wrong body, not just a wrong header.
	const upstream = await startProvider((_req, _res, i) => {
		const key = { "Bearer k1": "account1", "Bearer k2": "account2" };
		void i;
		return new Promise((r) => setTimeout(() => r({ sse: sse(chunk({ content: `${key[_req.headers.authorization].toUpperCase()}_OK` }), chunk({}, { finish_reason: "stop" }), "[DONE]") }), 15));
	});
	try {
		const providers = directProviders({ jev: jev({ baseURL: upstream.baseURL }) }, { env });
		const streamSimple = harness(providers);
		const ctx = { messages: [{ role: "user", content: "hi" }] };
		// 10 interleaved pairs: any shared mutable credential state shows up here.
		const jobs = Array.from({ length: 10 }, (_, i) => {
			const n = i % 2 ? 2 : 1;
			return run(streamSimple({ id: `jev/jev@account${n}` }, ctx, {})).then((events) => events.find((e) => e.type === "text_end").content);
		});
		assert.deepEqual(await Promise.all(jobs), Array.from({ length: 10 }, (_, i) => `${i % 2 ? "ACCOUNT2" : "ACCOUNT1"}_OK`));
		// Every single request carried its own credential on the wire.
		assert.equal(upstream.requests.length, 10);
		assert.equal(upstream.requests.filter((r) => r.authorization === "Bearer k1").length, 5);
		assert.equal(upstream.requests.filter((r) => r.authorization === "Bearer k2").length, 5);
		// And process.env was never used as the carrier.
		assert.equal(process.env.JEV_API_KEY_1, undefined);
	} finally { await upstream.close(); }
});

test("usage, finish reason, and reasoning map to OMP's done event", async () => {
	const upstream = await startProvider(() => ({ sse: sse(
		chunk({ reasoning_content: "thinking…" }),
		chunk({ content: "hello" }),
		chunk({}, { usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } } }),
		chunk({}, { finish_reason: "length" }),
		"[DONE]",
	) }));
	try {
		const providers = directProviders({ jev: jev({ baseURL: upstream.baseURL }) }, { env });
		const s = harness(providers)({ id: "jev/jev@account1" }, { messages: [{ role: "user", content: "hi" }] }, {});
		const events = await run(s);
		const done = events.at(-1);
		assert.equal(done.reason, "length");
		assert.equal(done.message.stopReason, "length");
		assert.equal(done.usage.input, 11);
		assert.equal(done.usage.output, 7);
		assert.equal(done.usage.cacheRead, 3);
		assert.equal(events.find((e) => e.type === "thinking_end").content, "thinking…");
		assert.ok(events[0].partial.usage.cost, "the start event carries usage.cost");
	} finally { await upstream.close(); }
});

test("tool calls are forwarded and mapped back, never dropped", async () => {
	const upstream = await startProvider(() => ({ sse: sse(
		chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } }] }),
		chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
		chunk({}, { finish_reason: "tool_calls" }),
		"[DONE]",
	) }));
	try {
		const providers = directProviders({ jev: jev({ baseURL: upstream.baseURL }) }, { env });
		const context = {
			messages: [{ role: "user", content: "read a.txt" }],
			tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
		};
		const s = harness(providers)({ id: "jev/jev@account1" }, context, {});
		const events = await run(s);
		// Request side: OMP tools → OpenAI tools.
		assert.deepEqual(upstream.requests[0].body.tools, [{ type: "function", function: { name: "read", description: "Read a file", parameters: context.tools[0].parameters } }]);
		// Response side: fragments → one toolCall part + start/delta/end.
		const start = events.find((e) => e.type === "toolcall_start");
		const end = events.find((e) => e.type === "toolcall_end");
		assert.equal(start.contentIndex, 0);
		assert.deepEqual(end.toolCall, { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } });
		assert.equal(events.filter((e) => e.type === "toolcall_delta").map((e) => e.delta).join(""), '{"path":"a.txt"}');
		assert.equal(events.at(-1).reason, "toolUse");
	} finally { await upstream.close(); }
});

test("a provider configured without tool support refuses tools instead of dropping them", async () => {
	const providers = directProviders({ jev: jev({ supportsTools: false }) }, { env });
	const s = harness(providers)({ id: "jev/jev@account1" }, { messages: [{ role: "user", content: "hi" }], tools: [{ name: "read" }] }, {});
	const events = await run(s);
	assert.match(events.find((e) => e.type === "error").error.content[0].text, /without tool support/);
});

test("a 401 is reported with its status and without leaking the key", async () => {
	const upstream = await startProvider((_req, res) => {
		res.writeHead(401, { "content-type": "application/json" });
		// A hostile upstream echoing the key it was given must not defeat us.
		res.end(JSON.stringify({ error: { message: "invalid key Bearer k1" } }));
		return undefined;
	});
	try {
		const providers = directProviders({ jev: jev({ baseURL: upstream.baseURL }) }, { env });
		const s = harness(providers)({ id: "jev/jev@account1" }, { messages: [{ role: "user", content: "hi" }] }, {});
		const events = await run(s);
		const err = events.find((e) => e.type === "error");
		assert.match(err.error.content[0].text, /HTTP 401/);
		assert.ok(!JSON.stringify(events).includes("Bearer k1"), "the key never reaches an event");
	} finally { await upstream.close(); }
});

test("429 and 500 surface as errors", async () => {
	for (const status of [429, 500]) {
		const upstream = await startProvider((_req, res) => { res.writeHead(status); res.end("upstream said no"); return undefined; });
		try {
			const providers = directProviders({ jev: jev({ baseURL: upstream.baseURL }) }, { env });
			const s = harness(providers)({ id: "jev/jev@account1" }, { messages: [{ role: "user", content: "hi" }] }, {});
			assert.match((await run(s)).find((e) => e.type === "error").error.content[0].text, new RegExp(`HTTP ${status}`));
		} finally { await upstream.close(); }
	}
	assert.equal(new DirectHttpError(429, "slow down").status, 429);
});

test("cancellation aborts the request and is reported as aborted", async () => {
	let closed = null;
	const closedP = new Promise((r) => (closed = r));
	const upstream = await startProvider((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify(chunk({ content: "partial" }))}\n\n`);
		// Never ends on its own; only an abort from the client can close this.
		res.on("close", () => closed());
		return undefined;
	});
	try {
		const providers = directProviders({ jev: jev({ baseURL: upstream.baseURL }) }, { env });
		const ac = new AbortController();
		const s = harness(providers)({ id: "jev/jev@account1" }, { messages: [{ role: "user", content: "hi" }] }, { signal: ac.signal });
		await new Promise((r) => setTimeout(r, 60));
		assert.ok(s.events.some((e) => e.type === "text_delta"), "the first delta arrived before the abort");
		ac.abort();
		const events = await run(s);
		assert.equal(events.at(-1).type, "error");
		assert.equal(events.at(-1).reason, "aborted");
		await closedP;
	} finally { await upstream.close(); }
});

test("an empty upstream response is an error, never a silent empty answer", async () => {
	const upstream = await startProvider(() => ({ sse: sse("[DONE]") }));
	try {
		const providers = directProviders({ jev: jev({ baseURL: upstream.baseURL }) }, { env });
		const s = harness(providers)({ id: "jev/jev@account1" }, { messages: [{ role: "user", content: "hi" }] }, {});
		assert.match((await run(s)).find((e) => e.type === "error").error.content[0].text, /no content/);
	} finally { await upstream.close(); }
});

test("a malformed SSE frame is skipped without killing a live stream", async () => {
	const upstream = await startProvider(() => ({ sse: "data: {not json}\n\n" + sse(chunk({ content: "ok" }), chunk({}, { finish_reason: "stop" }), "[DONE]") }));
	try {
		const providers = directProviders({ jev: jev({ baseURL: upstream.baseURL }) }, { env });
		const s = harness(providers)({ id: "jev/jev@account1" }, { messages: [{ role: "user", content: "hi" }] }, {});
		assert.equal((await run(s)).find((e) => e.type === "text_end").content, "ok");
	} finally { await upstream.close(); }
});

test("context mapping preserves roles, tool results, and system prompts", () => {
	const messages = mapMessages({
		systemPrompt: ["be terse"],
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } }] },
			{ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "file body" }] },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		],
	});
	assert.deepEqual(messages[0], { role: "system", content: "be terse" });
	assert.equal(messages[2].role, "assistant");
	assert.deepEqual(messages[2].tool_calls[0].function, { name: "read", arguments: '{"path":"a"}' });
	assert.deepEqual(messages[3], { role: "tool", tool_call_id: "c1", content: "file body" });
	assert.equal(mapTools({ tools: [{ name: "t", parameters: { type: "object" } }] })[0].function.name, "t");
});

test("the openai-responses protocol posts to /responses with a flat input", async () => {
	const upstream = await startProvider(() => ({ sse: sse(chunk({ content: "hi" }), chunk({}, { finish_reason: "stop" }), "[DONE]") }));
	try {
		const providers = directProviders({ jev: jev({ baseURL: upstream.baseURL, protocol: "openai-responses" }) }, { env });
		const s = harness(providers)({ id: "jev/jev@account1" }, { messages: [{ role: "user", content: "hi" }] }, {});
		await run(s);
		assert.equal(upstream.requests[0].url, "/v1/responses");
		assert.ok(Array.isArray(upstream.requests[0].body.input));
		assert.equal(upstream.requests[0].body.messages, undefined);
	} finally { await upstream.close(); }
});

// ── optional /models discovery ───────────────────────────────────────────────

test("discovery adds model ids and never removes the manual ones", async () => {
	const upstream = await startProvider((_req, res, i) => {
		if (i > 0) { res.writeHead(404); res.end(); return undefined; }
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: [{ id: "jev-turbo" }, { id: "jev" }, "not-a-model/x", { id: "jev-mini" }] }));
		return undefined;
	});
	try {
		const provider = directProviders({ jev: jev({ baseURL: upstream.baseURL, discovery: { enabled: true } }) }, { env }).get("jev");
		const extra = await discoverModels(provider, { env });
		assert.deepEqual(extra.map((m) => m.id), ["jev-turbo", "jev-mini"], "only valid, non-duplicate ids are added");
		assert.equal(upstream.requests[0].url, "/v1/models");
		assert.equal(upstream.requests[0].authorization, "Bearer k1");
	} finally { await upstream.close(); }
});

test("a failing /models endpoint leaves manual models intact", async () => {
	const upstream = await startProvider((_req, res) => { res.writeHead(500); res.end("nope"); return undefined; });
	try {
		const provider = directProviders({ jev: jev({ baseURL: upstream.baseURL, discovery: { enabled: true } }) }, { env }).get("jev");
		assert.deepEqual(await discoverModels(provider, { env }), []);
		assert.deepEqual(expandDirectModels(new Map([["jev", provider]])).models.map((m) => m.id), ["jev/jev@account1", "jev/jev@account2"]);
	} finally { await upstream.close(); }
});

// ── plugin wiring ────────────────────────────────────────────────────────────

/**
 * Run activate() with a temp profile file. `keepEnv: true` leaves the direct
 * credentials exported afterwards, because the key is read at REQUEST time —
 * a bridge that captured it at construction would not notice the difference,
 * and this test is here to prove it does read it late.
 */
function activateWith({ profileBody, settings = {}, keepEnv = false }) {
	const dir = mkdtempSync(join(tmpdir(), "omp-direct-"));
	const file = join(dir, "profiles.yml");
	if (profileBody !== undefined) writeFileSync(file, profileBody);
	const registered = [];
	const warnings = [];
	const previousRoot = process.env.OMP_PLUGIN_ROOT;
	const saved = {};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	const restoreEnv = () => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k]; else process.env[k] = v;
		}
	};
	process.env.OMP_PLUGIN_ROOT = dir;
	try {
		activate({ settings: { profilesFile: file, ...settings }, registerProvider: (name, p) => registered.push({ name, p }), logger: { warn: (m) => warnings.push(m) } });
	} finally {
		if (previousRoot === undefined) delete process.env.OMP_PLUGIN_ROOT; else process.env.OMP_PLUGIN_ROOT = previousRoot;
		if (!keepEnv) restoreEnv();
	}
	return { registered, warnings, cleanup: () => { restoreEnv(); rmSync(dir, { recursive: true, force: true }); } };
}

test("activation registers BOTH sources from one profile file", async () => {
	const h = activateWith({ profileBody: "providers:\n  opencode:\n    credentials: []\ndirectProviders:\n  jev:\n    baseURL: https://api.jev.example/v1\n    models:\n      - id: jev\n    credentials:\n      - id: account1\n        apiKeyEnv: JEV_API_KEY_1\n" });
	try {
		assert.deepEqual(h.registered.map((r) => r.name).sort(), ["direct", "opencode-bridge"]);
		assert.deepEqual(h.warnings, []);
		const direct = h.registered.find((r) => r.name === "direct");
		// A custom (non-reserved) api name, a placeholder baseUrl, and a streamSimple.
		assert.equal(direct.p.api, "direct-url-api");
		assert.ok(direct.p.baseUrl && direct.p.apiKey, "placeholders unlock dynamic discovery");
		assert.equal(typeof direct.p.streamSimple, "function");
		// Models come from the config file alone — no OpenCode call happens.
		const models = await direct.p.fetchDynamicModels();
		assert.deepEqual(models.map((m) => `direct/${m.id}`), ["direct/jev/jev@account1"]);
	} finally { h.cleanup(); }
});

test("an invalid direct config disables only direct, leaving the OpenCode bridge registered", () => {
	const h = activateWith({ profileBody: "providers:\n  opencode:\n    credentials: []\ndirectProviders:\n  jev:\n    baseURL: nope\n    models: [{id: jev}]\n    credentials: [{id: a, apiKeyEnv: JEV_API_KEY_1}]\n" });
	try {
		assert.deepEqual(h.registered.map((r) => r.name), ["opencode-bridge"], "the bridge survives a bad direct config");
		assert.equal(h.warnings.length, 1);
		assert.match(h.warnings[0], /direct provider "jev".*not a valid URL/);
	} finally { h.cleanup(); }
});

test("a profile file with no directProviders registers no direct provider and warns nothing", () => {
	const h = activateWith({ profileBody: "providers:\n  opencode:\n    credentials: []\n" });
	try {
		assert.deepEqual(h.registered.map((r) => r.name), ["opencode-bridge"]);
		assert.deepEqual(h.warnings, []);
	} finally { h.cleanup(); }
});

// The load-bearing regression: a Direct provider must work with OpenCode gone.
// OPENCODE_BIN points at a binary that does not exist, so every OpenCode
// discovery call fails for real — and the direct path must be untouched.
test("direct providers register and infer with OpenCode unavailable", async () => {
	const upstream = await startProvider(() => ({ sse: sse(chunk({ content: "OK_WITHOUT_OPENCODE" }), chunk({}, { finish_reason: "stop" }), "[DONE]") }));
	const previousBin = process.env.OPENCODE_BIN;
	process.env.OPENCODE_BIN = "definitely-not-opencode-xyz";
	const h = activateWith({
		keepEnv: true,
		profileBody: `providers:\n  opencode:\n    credentials: []\ndirectProviders:\n  jev:\n    baseURL: ${upstream.baseURL}\n    models:\n      - id: jev\n    credentials:\n      - id: account1\n        apiKeyEnv: JEV_API_KEY_1\n`,
	});
	try {
		const direct = h.registered.find((r) => r.name === "direct");
		assert.ok(direct, "the direct provider registered with no OpenCode binary present");
		// The OpenCode provider registered too, but discovery yields nothing.
		assert.equal((await h.registered.find((r) => r.name === "opencode-bridge").p.fetchDynamicModels()).length, 0);
		// And the direct path really works end to end.
		const models = await direct.p.fetchDynamicModels();
		assert.deepEqual(models.map((m) => m.id), ["jev/jev@account1"]);
		const s = direct.p.streamSimple({ id: "jev/jev@account1" }, { messages: [{ role: "user", content: "hi" }] }, {});
		await s.result();
		assert.equal(s.events.find((e) => e.type === "text_end").content, "OK_WITHOUT_OPENCODE");
	} finally {
		if (previousBin === undefined) delete process.env.OPENCODE_BIN; else process.env.OPENCODE_BIN = previousBin;
		h.cleanup();
		await upstream.close();
	}
});

// doctor must surface direct-provider credential state without printing a key,
// and must do so even when OpenCode is not detected at all.
test("doctor reports direct provider credentials without leaking keys", async () => {
	const { doctor, formatDoctor } = await import("../src/doctor.js");
	const dir = mkdtempSync(join(tmpdir(), "omp-doctor-direct-"));
	const file = join(dir, "p.yml");
	writeFileSync(file, `directProviders:
  mock:
    baseURL: https://example.test/v1
    models: [{ id: m1 }]
    credentials:
      - { id: good, apiKeyEnv: DIRECT_TEST_KEY }
      - { id: bad, apiKeyEnv: DIRECT_TEST_ABSENT }
`);
	process.env.DIRECT_TEST_KEY = "super-secret-value";
	const old = process.env.OPENCODE_BRIDGE_PROFILES_FILE;
	try {
		process.env.OPENCODE_BRIDGE_PROFILES_FILE = file;
		const report = await doctor({ opencodePath: "C:/nonexistent/opencode" });
		assert.equal(report.detected, false, "OpenCode detection must not gate the direct report");
		assert.equal(report.directProviders.length, 2);
		assert.deepEqual(report.directProviders.map((d) => d.status), ["configured", "missing"]);
		const text = formatDoctor(report);
		assert.ok(text.includes("mock/good@DIRECT_TEST_KEY"), text);
		assert.ok(text.includes("mock/bad@DIRECT_TEST_ABSENT"), text);
		assert.ok(!text.includes("super-secret-value"), "doctor must never print a key");
	} finally {
		if (old === undefined) delete process.env.OPENCODE_BRIDGE_PROFILES_FILE; else process.env.OPENCODE_BRIDGE_PROFILES_FILE = old;
		delete process.env.DIRECT_TEST_KEY;
		unlinkSync(file); rmdirSync(dir);
	}
});

// Regression: OMP sets no options.maxTokens for a custom provider, and an
// OpenAI-compatible gateway left to its own default reserves the model's full
// output ceiling (OpenRouter: 65536). A credit-limited account rejects that
// with HTTP 402 before generating anything, so max_tokens must always be sent.
test("an explicit max_tokens is always sent, from the configured limit", async () => {
	const server = await startProvider(() => ({ sse: sse(chunk({ content: "ok" }, { finish_reason: "stop" }), "[DONE]") }));
	try {
		const providers = directProviders({ jev: jev({ baseURL: server.baseURL, models: [{ id: "jev", name: "JEV", maxOutputTokens: 2048 }] }) }, { env });
		const { descriptors } = expandDirectModels(providers);
		assert.equal(descriptors.get("jev/jev@account1").maxTokens, 2048);

		await run(harness(providers, { fetchImpl: fetch })({ id: "jev/jev@account1" }, { messages: [{ role: "user", content: "hi" }] }, {}));
		assert.equal(server.requests.at(-1).body.max_tokens, 2048,
			"must use the model's configured output limit, not the upstream default");

		// An explicit caller value still wins over the configured default.
		await run(harness(providers, { fetchImpl: fetch })({ id: "jev/jev@account1" }, { messages: [{ role: "user", content: "hi" }] }, { maxTokens: 512 }));
		assert.equal(server.requests.at(-1).body.max_tokens, 512);
	} finally { await server.close(); }
});
