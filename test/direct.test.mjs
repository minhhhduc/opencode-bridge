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
		apiKeyEnv: "JEV_API_KEY_1", apiKey: undefined, maxTokens: 8192, efforts: undefined,
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

// Reasoning detection must come from the payload, never from the name. The name
// heuristic this replaced missed 318 of OpenRouter's 328 reasoning models and
// false-positived on cohere/command-r* (a retrieval model). Each case below is a
// real record shape from the live catalog.
test("discovery reads reasoning and its efforts from the payload, not the name", async () => {
	const upstream = await startProvider((_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: [
			// Name says "command-r", API says not reasoning.
			{ id: "cohere/command-r-plus-08-2024", supported_parameters: ["max_tokens"] },
			// Name says nothing useful, API says reasoning with its own ladder.
			{ id: "meta/muse-spark-1.1", supported_parameters: ["reasoning", "reasoning_effort"],
				reasoning: { mandatory: true, supported_efforts: ["xhigh", "high", "medium", "low", "minimal"], default_effort: "medium" } },
			{ id: "meta/muse-spark-1.2", supported_parameters: ["reasoning", "reasoning_effort"],
				reasoning: { mandatory: true, supported_efforts: ["xhigh", "high", "medium", "low", "minimal"], default_effort: "medium" } },
			// A wider ladder: this one really does accept `max`, so it must offer it.
			{ id: "meta/muse-spark-1.3", supported_parameters: ["reasoning", "reasoning_effort"],
				reasoning: { mandatory: true, supported_efforts: ["max", "xhigh", "high", "medium", "low", "minimal"], default_effort: "medium" } },
			// Mandatory reasoner with no effort knob: real reasoning, no picker.
			{ id: "deepseek/deepseek-r1", supported_parameters: ["include_reasoning", "reasoning"],
				reasoning: { mandatory: true } },
			// A name the old regex did match, still honoured via the payload.
			{ id: "deepseek/deepseek-r1-distill-llama-70b", supported_parameters: ["reasoning"],
				reasoning: { supported_efforts: ["low", "high"] } },
			// A payload with no capability signal at all must not be guessed.
			{ id: "vendor/opaque", supported_parameters: ["tools"] },
		] }));
	});
	try {
		const providers = directProviders({ jev: jev({ baseURL: upstream.baseURL, models: [], discovery: { enabled: true } }) }, { env });
		const extra = await discoverModels(providers.get("jev"), { env });
		const by = (id) => extra.find((m) => m.id === id);

		assert.equal(by("cohere/command-r-plus-08-2024").reasoning, false);
		assert.equal(by("cohere/command-r-plus-08-2024").thinking, undefined);

		// Every level the API advertised, ordered by OMP's canonical ladder
		// (weakest first) exactly as OMP's own OpenRouter adapter would — not in
		// the provider's strongest-first order.
		assert.deepEqual(by("meta/muse-spark-1.1").thinking.efforts, ["minimal", "low", "medium", "high", "xhigh"]);
		assert.deepEqual(by("meta/muse-spark-1.2").thinking.efforts, ["minimal", "low", "medium", "high", "xhigh"]);
		// A wider ladder keeps `max`, which is only offered by models that have it.
		assert.deepEqual(by("meta/muse-spark-1.3").thinking.efforts, ["minimal", "low", "medium", "high", "xhigh", "max"]);

		// Reasoning true, no ladder: no `thinking` key at all. OMP replaces an
		// empty efforts array with a fabricated default ladder (G2r), so omitting
		// the key is the only way not to offer levels the API never advertised.
		assert.equal(by("deepseek/deepseek-r1").reasoning, true);
		assert.equal(by("deepseek/deepseek-r1").thinking, undefined);

		// A gappy ladder keeps its gaps: a model advertising only low/high must
		// not be given `medium`.
		assert.deepEqual(by("deepseek/deepseek-r1-distill-llama-70b").thinking.efforts, ["low", "high"]);

		assert.equal(by("vendor/opaque").reasoning, false);
	} finally { await upstream.close(); }
});

test("a configured reasoning model with no efforts gets reasoning without a picker", () => {
	const providers = directProviders({ jev: jev({ models: [{ id: "r1", capabilities: { reasoning: true } }] }) }, { env });
	const m = expandDirectModels(providers).models[0];
	assert.equal(m.reasoning, true);
	assert.equal(m.thinking, undefined);
});

test("a configured model can override the effort list", () => {
	const providers = directProviders({ jev: jev({ models: [{ id: "r1", capabilities: { reasoning: true, efforts: ["low", "high", "xhigh"] } }] }) }, { env });
	assert.deepEqual(expandDirectModels(providers).models[0].thinking.efforts, ["low", "high", "xhigh"]);
});

test("configured efforts outside OMP's ladder are dropped, not passed through", () => {
	const providers = directProviders({ jev: jev({ models: [{ id: "r1", capabilities: { reasoning: true, efforts: ["low", "turbo", "high"] } }] }) }, { env });
	assert.deepEqual(expandDirectModels(providers).models[0].thinking.efforts, ["low", "high"]);
});

// The descriptor carries the advertised ladder, not the picker: it is what the
// request path checks before sending `reasoning_effort`.
test("the descriptor carries the advertised ladder, and nothing when there is none", () => {
	const providers = directProviders({ jev: jev({ models: [
		{ id: "r1", capabilities: { reasoning: true, efforts: ["low", "high"] } },
		{ id: "r2", capabilities: { reasoning: true } },
		{ id: "plain" },
	] }) }, { env });
	const { descriptors } = expandDirectModels(providers);
	assert.deepEqual(descriptors.get("jev/r1@account1").efforts, ["low", "high"]);
	assert.equal(descriptors.get("jev/r2@account1").efforts, undefined);
	assert.equal(descriptors.get("jev/plain@account1").efforts, undefined);
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

// Effort must not change how the response is consumed: thinking, text, a tool
// call, usage and finish_reason all still stream, and the body carries the level.
test("a reasoning model with an effort still streams thinking, text, tools and usage", async () => {
	const upstream = await startProvider(() => ({ sse: sse(
		chunk({ reasoning_content: "thinking…" }),
		chunk({ content: "hello" }),
		chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] }),
		chunk({}, { usage: { prompt_tokens: 5, completion_tokens: 2 } }),
		chunk({}, { finish_reason: "tool_calls" }),
		"[DONE]",
	) }));
	try {
		const providers = directProviders({ jev: jev({ baseURL: upstream.baseURL, models: [{ id: "r1", capabilities: { reasoning: true, efforts: ["low", "high"] } }] }) }, { env });
		const events = await run(harness(providers)({ id: "jev/r1@account1" }, { messages: [{ role: "user", content: "hi" }] }, { reasoning: "high" }));

		assert.equal(upstream.requests.at(-1).body.reasoning_effort, "high");
		assert.equal(events.find((e) => e.type === "thinking_end").content, "thinking…");
		assert.equal(events.find((e) => e.type === "text_end").content, "hello");
		assert.equal(events.find((e) => e.type === "toolcall_end").toolCall.arguments.path, "a");
		const done = events.at(-1);
		assert.equal(done.reason, "toolUse");
		assert.equal(done.usage.input, 5);
		assert.equal(done.usage.output, 2);
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
		// "not-a-model/x" is a valid id: the model segment is percent-encoded into
		// the OMP id, so a vendor-prefixed upstream id is unambiguous there. Only
		// blanks and duplicates are dropped.
		assert.deepEqual(extra.map((m) => m.id), ["jev-turbo", "not-a-model/x", "jev-mini"]);
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

// A picker the user can move is worthless if the choice never reaches the API:
// OMP hands the level over as `options.reasoning`, and the direct path used to
// drop it, so every request ran at the provider's own default effort.
test("every advertised effort reaches the wire as reasoning_effort", async () => {
	const server = await startProvider((_req, res) => ({ sse: sse(chunk({ content: "ok" }, {}), chunk({}, { finish_reason: "stop" }), "[DONE]") }));
	try {
		const providers = directProviders({ jev: jev({ baseURL: server.baseURL, models: [{ id: "r1", capabilities: { reasoning: true, efforts: ["minimal", "low", "medium", "high", "xhigh", "max"] } }] }) }, { env });
		const call = harness(providers, { fetchImpl: fetch });
		const send = async (reasoning) => {
			await run(call({ id: "jev/r1@account1" }, { messages: [{ role: "user", content: "hi" }] }, reasoning === null ? {} : { reasoning }));
			return server.requests.at(-1).body;
		};

		for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
			assert.equal((await send(effort)).reasoning_effort, effort, `${effort} must reach the request body`);
		}

		// No effort chosen: omit the field rather than guess one, so the provider
		// applies its own default.
		assert.equal("reasoning_effort" in await send(null), false);
	} finally { await server.close(); }
});

// The picker is not proof of support. OMP substitutes a default ladder for a model
// that advertises none (G2r), so a level the provider never offered can still
// arrive in `options.reasoning`; forwarding it would send a parameter the model
// has never accepted. OMP's copy of the ladder is a *presentation* concern and is
// never consulted at the wire — only the provider's own metadata is.
//
// Regression: a DISCOVERED model is never in the registration-time descriptor map
// (discovery appends to the provider list after the map is built), so its ladder
// can only come from the cold-path re-derivation. That must still work, or every
// discovered reasoning model silently loses its reasoning_effort. Found by
// running the real OMP picker against real OpenRouter.
test("a discovered model, absent from the descriptor map, still sends its effort", async () => {
	const server = await startProvider((_req, res) => ({ sse: sse(chunk({ content: "ok" }, {}), chunk({}, { finish_reason: "stop" }), "[DONE]") }));
	try {
		const providers = directProviders({ jev: jev({ baseURL: server.baseURL, models: [], discovery: { enabled: true } }) }, { env });
		// Discovery output goes through the same normalization as a configured model.
		const found = await discoverModels(providers.get("jev"), {
			env,
			fetchImpl: async () => ({ ok: true, json: async () => ({ data: [
				{ id: "z-ai/glm-4.6", supported_parameters: ["reasoning", "reasoning_effort"],
					reasoning: { supported_efforts: ["max", "high", "low", "medium", "minimal"] } },
				// A reasoner that advertises no ladder: OMP will still show a picker.
				{ id: "qwen/qwen3.7-flash", supported_parameters: ["reasoning"], reasoning: {} },
			] }) }),
		});
		// extension.js builds the descriptor map at registration, then discovery
		// appends to the provider list. Mirror that order so the id is absent.
		const { descriptors } = expandDirectModels(providers);
		providers.get("jev").models = providers.get("jev").models.concat(found);
		assert.equal(descriptors.has("jev/z-ai%2Fglm-4.6@account1"), false);

		const call = makeDirectStreamSimple({
			providers,
			resolve: (model) => resolveDirectModel(model, descriptors, providers),
			env,
			fetchImpl: fetch,
		});
		const send = (id, model, reasoning) =>
			run(call({ id, ...model }, { messages: [{ role: "user", content: "hi" }] }, { reasoning }))
				.then(() => server.requests.at(-1).body);

		// OMP passes the model it resolved, carrying the ladder it rendered.
		const ladder = { thinking: { mode: "effort", efforts: found[0].thinking.efforts } };
		assert.equal((await send("jev/z-ai%2Fglm-4.6@account1", ladder, "high")).reasoning_effort, "high");
		// Still guarded: `xhigh` is a valid OMP level this model never advertised.
		assert.equal("reasoning_effort" in await send("jev/z-ai%2Fglm-4.6@account1", ladder, "xhigh"), false);

		// The picker OMP fabricates for a no-ladder model must not reach the wire,
		// however confident that picker looks.
		assert.equal("reasoning_effort" in await send("jev/qwen%2Fqwen3.7-flash@account1", {}, "high"), false);
	} finally { await server.close(); }
});

test("an effort the model never advertised is dropped, not rewritten", async () => {
	const server = await startProvider((_req, res) => ({ sse: sse(chunk({ content: "ok" }, {}), chunk({}, { finish_reason: "stop" }), "[DONE]") }));
	try {
		const providers = directProviders({ jev: jev({ baseURL: server.baseURL, models: [
			{ id: "r1", capabilities: { reasoning: true, efforts: ["low", "medium", "high"] } },
			// Mandatory reasoner with no ladder, like deepseek/deepseek-r1.
			{ id: "r2", capabilities: { reasoning: true } },
		] }) }, { env });
		const call = harness(providers, { fetchImpl: fetch });
		const send = async (id, reasoning) => {
			await run(call({ id }, { messages: [{ role: "user", content: "hi" }] }, { reasoning }));
			return server.requests.at(-1).body;
		};

		// `max` is valid OMP but absent from this model's ladder. It must not be
		// silently turned into `high`, nor sent.
		const body = await send("jev/r1@account1", "max");
		assert.equal("reasoning_effort" in body, false);
		assert.equal((await send("jev/r1@account1", "high")).reasoning_effort, "high");

		// A model with no ladder accepts no effort at all.
		assert.equal("reasoning_effort" in await send("jev/r2@account1", "high"), false);
	} finally { await server.close(); }
});

// ── the wire guard ───────────────────────────────────────────────────────────
//
// `reasoning_effort` is authorized by exactly one thing: the provider's own
// ladder. OMP's rendering of that model is a separate concern and is never
// consulted, because OMP fabricates a default ladder for a model that advertises
// none — measured live, 136 of OpenRouter's 140 no-ladder reasoning models show
// `minimal,low,medium,high`, none of which is provider evidence.
//
// The bug this locks down: the guard read `model.thinking.efforts ?? descriptor.efforts`,
// so for a no-ladder model the FIRST source was OMP's fabrication, the `??` never
// fell through to the provider truth, and the fabrication was re-admitted.
test("reasoning_effort is authorized only by the provider's own ladder", async () => {
	const server = await startProvider((_req, res) => ({ sse: sse(chunk({ content: "ok" }, {}), chunk({}, { finish_reason: "stop" }), "[DONE]") }));
	try {
		const providers = directProviders({ jev: jev({ baseURL: server.baseURL, models: [
			{ id: "ladder", capabilities: { reasoning: true, efforts: ["low", "medium", "high"] } },
			// Reasoning, but the payload advertised no ladder at all. OMP shows a
			// fabricated `minimal,low,medium,high` picker for both of these.
			{ id: "noladder", capabilities: { reasoning: true } },
			{ id: "notreasoning" },
		] }) }, { env });
		const call = harness(providers, { fetchImpl: fetch });
		// `model` is what OMP resolved and hands back; `thinking` is its own copy.
		const send = (id, thinking, reasoning) =>
			run(call({ id, ...(thinking && { thinking }) }, { messages: [{ role: "user", content: "hi" }] }, { reasoning }))
				.then(() => server.requests.at(-1).body);
		const FABRICATED = { mode: "effort", efforts: ["minimal", "low", "medium", "high"] };

		// 1. provider ladder + supported level -> sent
		assert.equal((await send("jev/ladder@account1", { mode: "effort", efforts: ["low", "medium", "high"] }, "medium")).reasoning_effort, "medium");
		// 2. provider ladder + unsupported level -> dropped, never rewritten
		assert.equal("reasoning_effort" in await send("jev/ladder@account1", { mode: "effort", efforts: ["low", "medium", "high"] }, "max"), false);
		// 3. no provider ladder + OMP's fake `high` -> dropped
		assert.equal("reasoning_effort" in await send("jev/noladder@account1", FABRICATED, "high"), false);
		// 4. empty provider ladder + OMP's fake `minimal` -> dropped
		//    (an empty configured list is normalized away to no ladder at all)
		assert.equal("reasoning_effort" in await send("jev/noladder@account1", FABRICATED, "minimal"), false);
		// 5. non-reasoning model + an OMP effort -> dropped
		assert.equal("reasoning_effort" in await send("jev/notreasoning@account1", FABRICATED, "high"), false);
		// ...and the non-reasoning model never gets one even if OMP omits `thinking`.
		assert.equal("reasoning_effort" in await send("jev/notreasoning@account1", undefined, "high"), false);
	} finally { await server.close(); }
});

// Effort is per-request, keys are per-credential, and neither may leak into the
// other. Both requests are in flight at once against a single shared provider.
test("concurrent requests keep their own key and their own effort", async () => {
	// Answered on a delay so both requests are genuinely in flight together.
	const server = await startProvider((_req, _res, i) =>
		new Promise((r) => setTimeout(() => r({ sse: sse(chunk({ content: "ok" }, {}), chunk({}, { finish_reason: "stop" }), "[DONE]") }), 15 + i)));
	try {
		const providers = directProviders({ jev: jev({ baseURL: server.baseURL, models: [
			{ id: "r1", capabilities: { reasoning: true, efforts: ["low", "high"] } },
			{ id: "r2", capabilities: { reasoning: true } },
		] }) }, { env });
		const call = harness(providers, { fetchImpl: fetch });
		// OMP's fabricated picker for r2, to prove a neighbour's capability (or
		// lack of it) cannot leak across a concurrent request.
		const FABRICATED = { mode: "effort", efforts: ["minimal", "low", "medium", "high"] };
		const req = (id, thinking, reasoning) =>
			run(call({ id, ...(thinking && { thinking }) }, { messages: [{ role: "user", content: "hi" }] }, { reasoning }));

		await Promise.all([
			req("jev/r1@account1", { mode: "effort", efforts: ["low", "high"] }, "high"),
			req("jev/r1@account2", { mode: "effort", efforts: ["low", "high"] }, "low"),
			req("jev/r2@account1", FABRICATED, "high"),
		]);

		const sent = (key) => server.requests.find((r) => r.authorization === `Bearer ${key}`)?.body;
		assert.equal(sent("k1").reasoning_effort, "high", "account1 keeps key1 + high");
		assert.equal(sent("k2").reasoning_effort, "low", "account2 keeps key2 + low");
		// r2's request carries the same key as r1/account1 and must still send nothing.
		assert.equal(sent("k1").model, "r1");
		assert.equal("reasoning_effort" in server.requests.find((r) => r.body.model === "r2").body, false);
		assert.equal(process.env.JEV_API_KEY_1, undefined, "the key never leaked into process.env");
	} finally { await server.close(); }
});

// A discovered id is useless unless it can be selected and carries a key, so it
// must go through the same credential expansion as a manual model. Regression:
// discovery previously appended raw ids, which had no @credential suffix and no
// key, so the model could be listed but never called.
test("a discovered model is selectable and infers with a credential", async () => {
	const upstream = await startProvider((_req, res, i) => {
		if (i === 0) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "meta/muse-spark-1.3" }] }));
			return undefined;
		}
		return { sse: sse(chunk({ content: "DISCOVERED_OK" }, {}), chunk({}, { finish_reason: "stop" }), "[DONE]") };
	});
	try {
		const providers = directProviders({
			jev: jev({ baseURL: upstream.baseURL, models: [], discovery: { enabled: true } }),
		}, { env });
		const extra = await discoverModels(providers.get("jev"), { env });
		assert.deepEqual(extra.map((m) => m.id), ["meta/muse-spark-1.3"]);
		providers.get("jev").models = providers.get("jev").models.concat(extra);

		const { models, descriptors } = expandDirectModels(providers);
		const id = "jev/meta%2Fmuse-spark-1.3@account1";
		assert.ok(models.some((m) => m.id === id), `expected ${id} in ${models.map((m) => m.id).join(", ")}`);

		const events = await run(harness(providers, { fetchImpl: fetch })({ id }, { messages: [{ role: "user", content: "hi" }] }, {}));
		assert.equal(events.find((e) => e.type === "text_end").content, "DISCOVERED_OK");
		// The upstream model id is un-encoded again on the wire, and the
		// credential is attached.
		assert.equal(upstream.requests[1].body.model, "meta/muse-spark-1.3");
		assert.equal(upstream.requests[1].authorization, "Bearer k1");
	} finally { await upstream.close(); }
});
