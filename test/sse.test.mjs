// Streaming transport: SSE parsing, OpenCode→OMP event mapping, the
// first-delta race, session filtering, fallback, cancellation, cleanup.
//
// Event frames below are verbatim from a live OpenCode 2.0.12 server
// (captured via GET /api/event with the service password).

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSSEChunk, SSEUnavailable } from "../src/sse.js";
import { makeStreamSimple, runStreaming, EventStream, CapabilityError } from "../src/stream.js";

const SID = "ses_1";
const ev = (type, data) => ({ id: "evt_1", type, data: { sessionID: SID, ...data } });

// A client whose SSE pump we drive by hand, so every test is deterministic and
// no socket is opened.
function fakeClient(frames, { onPrompt } = {}) {
	const client = {
		calls: [],
		frames: [],
		closed: false,
		async api(op, opts) {
			client.calls.push(op);
			if (op === "session.create") return { data: { id: SID } };
			if (op === "session.prompt") {
				if (onPrompt) onPrompt(client);
				return { data: { id: "msg_u" } };
			}
			return null;
		},
		async serverUrl() { return "http://127.0.0.1:1"; },
		async servicePassword() { return "pw"; },
	};
	return client;
}

// Inject a fake /api/event stream by monkey-patching global fetch for one test.
function withFakeFetch(client, feed, impl = {}) {
	const real = globalThis.fetch;
	globalThis.fetch = async () => {
		impl.ready?.();
		return {
			ok: true,
			status: 200,
			body: {
				getReader() {
					let i = 0;
					return {
						async read() {
							// A string ending in "!" means "stay open" — a stream that
							// connects and then never terminates, unlike real EOF.
							if (feed.length === 1 && feed[0] === "HANG") return new Promise(() => {});
							if (i >= feed.length) return { done: true, value: undefined };
							return { done: false, value: new TextEncoder().encode(feed[i++]) };
						},
					};
				},
			},
		};
	};
	return async () => { globalThis.fetch = real; };
}

test("parseSSEChunk: decodes data frames, ignores heartbeats and bad JSON", () => {
	const raw = [
		'data: {"id":"e1","type":"server.connected","data":{}}',
		"",
		": heartbeat",
		"",
		"data: not json at all",
		"",
		'data: {"id":"e2","type":"session.text.delta","data":{"delta":"hi"}}',
		"",
		"",
	].join("\n");
	const out = parseSSEChunk(raw);
	assert.deepEqual(out.map((e) => e.type), ["server.connected", "session.text.delta"]);
});

test("parseSSEChunk: multiple data: lines in one frame are separate events", () => {
	// OpenCode sends one event per frame; a frame carrying two data lines yields
	// two events, and neither corrupts the other.
	const out = parseSSEChunk('data: {"type":"a"}\ndata: {"type":"b"}\n\n');
	assert.deepEqual(out.map((e) => e.type), ["a", "b"]);
});

// ---------------------------------------------------------------------------
// The real transcript, from a live server: reasoning, a tool step, then text.
// ---------------------------------------------------------------------------
const liveFrames = [
	'data: {"id":"e0","type":"session.execution.started","data":{"sessionID":"ses_1"}}\n\n',
	'data: {"id":"e1","type":"session.step.started","data":{"sessionID":"ses_1","assistantMessageID":"msg_a","agent":"build"}}\n\n',
	'data: {"id":"e2","type":"session.reasoning.started","data":{"sessionID":"ses_1","assistantMessageID":"msg_a","ordinal":0,"state":{"reasoningField":"reasoning_content"}}}\n\n',
	'data: {"id":"e3","type":"session.reasoning.delta","data":{"sessionID":"ses_1","assistantMessageID":"msg_a","ordinal":0,"delta":"2 + 2 "}}\n\n',
	'data: {"id":"e4","type":"session.reasoning.delta","data":{"sessionID":"ses_1","assistantMessageID":"msg_a","ordinal":0,"delta":"is 4"}}\n\n',
	'data: {"id":"e5","type":"session.reasoning.ended","data":{"sessionID":"ses_1","assistantMessageID":"msg_a","text":"2 + 2 is 4"}}\n\n',
	'data: {"id":"e6","type":"session.text.started","data":{"sessionID":"ses_1","assistantMessageID":"msg_a","ordinal":0}}\n\n',
	'data: {"id":"e7","type":"session.text.delta","data":{"sessionID":"ses_1","assistantMessageID":"msg_a","delta":"The answer "}}\n\n',
	'data: {"id":"e8","type":"session.text.delta","data":{"sessionID":"ses_1","assistantMessageID":"msg_a","delta":"is 4."}}\n\n',
	'data: {"id":"e9","type":"session.text.ended","data":{"sessionID":"ses_1","assistantMessageID":"msg_a","text":"The answer is 4."}}\n\n',
	'data: {"id":"e10","type":"session.step.ended","data":{"sessionID":"ses_1","assistantMessageID":"msg_a","finish":"stop","rawFinish":"stop","cost":0.002,"tokens":{"input":11231,"output":68,"reasoning":35,"cache":{"read":10624,"write":0}}}}\n\n',
	'data: {"id":"e11","type":"session.execution.succeeded","data":{"sessionID":"ses_1"}}\n\n',
];

test("runStreaming: maps reasoning and text to OMP events in upstream order", async () => {
	const client = fakeClient();
	const restore = await withFakeFetch(client, liveFrames);
	const seen = [];
	try {
		const r = await runStreaming(client, { sessionBody: {}, promptBody: { text: "2+2?" } }, { partial: null, onEvent: (e) => seen.push(e.type) });
		assert.deepEqual(seen, [
			"thinking_start", "thinking_delta", "thinking_delta", "thinking_end",
			"text_start", "text_delta", "text_delta", "text_end", "done",
		]);
		assert.equal(r.text, "The answer is 4.");
		assert.equal(r.thinking, "2 + 2 is 4");
	} finally { await restore(); }
});

test("runStreaming: reasoning precedes text via distinct contentIndex blocks", async () => {
	const client = fakeClient();
	const restore = await withFakeFetch(client, liveFrames);
	const seen = [];
	try {
		const partial = { role: "assistant", content: [], usage: { cost: { total: 0 } } };
		await runStreaming(client, { sessionBody: {}, promptBody: { text: "2+2?" } }, { partial, onEvent: (e) => seen.push(e) });
		assert.equal(seen.find((e) => e.type === "thinking_start").contentIndex, 0);
		assert.equal(seen.find((e) => e.type === "text_start").contentIndex, 1);
		assert.equal(partial.content[0].type, "thinking");
		assert.equal(partial.content[0].thinking, "2 + 2 is 4");
		assert.equal(partial.content[1].type, "text");
		assert.equal(partial.content[1].text, "The answer is 4.");
		// Every content event carries the live partial, as OMP's own assemblers do.
		assert.ok(seen.filter((e) => e.partial).every((e) => e.partial === partial));
		assert.equal(seen.find((e) => e.type === "done").message, partial);
	} finally { await restore(); }
});

test("runStreaming: usage from step.ended lands on the done event", async () => {
	const client = fakeClient();
	const restore = await withFakeFetch(client, liveFrames);
	const seen = [];
	try {
		await runStreaming(client, { sessionBody: {}, promptBody: { text: "q" } }, { onEvent: (e) => seen.push(e) });
		const done = seen.find((e) => e.type === "done");
		assert.equal(done.usage.input, 11231);
		assert.equal(done.usage.output, 68);
		assert.equal(done.usage.cacheRead, 10624);
		assert.equal(done.usage.cost.total, 0.002);
		assert.equal(done.reason, "stop");
	} finally { await restore(); }
});

test("runStreaming: unrelated-session events are filtered out", async () => {
	const client = fakeClient();
	const frames = [
		'data: {"type":"session.text.started","data":{"sessionID":"ses_OTHER","assistantMessageID":"m"}}\n\n',
		'data: {"type":"session.text.delta","data":{"sessionID":"ses_OTHER","delta":"LEAKED"}}\n\n',
		'data: {"type":"session.text.started","data":{"sessionID":"ses_1","assistantMessageID":"m"}}\n\n',
		'data: {"type":"session.text.delta","data":{"sessionID":"ses_1","delta":"mine"}}\n\n',
		'data: {"type":"session.text.ended","data":{"sessionID":"ses_1","text":"mine"}}\n\n',
		'data: {"type":"session.execution.succeeded","data":{"sessionID":"ses_1"}}\n\n',
	];
	const restore = await withFakeFetch(client, frames);
	const seen = [];
	try {
		const r = await runStreaming(client, { sessionBody: {}, promptBody: { text: "q" } }, { onEvent: (e) => seen.push(e) });
		assert.equal(r.text, "mine");
		assert.ok(!JSON.stringify(seen).includes("LEAKED"), "no foreign delta leaked");
	} finally { await restore(); }
});

test("runStreaming: the first delta immediately after the prompt is not lost", async () => {
	// The race this protects: the model can emit its first token before
	// session.prompt's HTTP response even comes back. The listener is already
	// draining, so the delta is buffered on the socket and replayed, not lost.
	const client = fakeClient();
	const fast = [
		'data: {"type":"session.step.started","data":{"sessionID":"ses_1","assistantMessageID":"m"}}\n\n',
		'data: {"type":"session.text.started","data":{"sessionID":"ses_1","assistantMessageID":"m"}}\n\n',
		'data: {"type":"session.text.delta","data":{"sessionID":"ses_1","delta":"FIRST"}}\n\n',
		'data: {"type":"session.text.ended","data":{"sessionID":"ses_1","text":"FIRST"}}\n\n',
		'data: {"type":"session.execution.succeeded","data":{"sessionID":"ses_1"}}\n\n',
	];
	const restore = await withFakeFetch(client, fast);
	try {
		const r = await runStreaming(client, { sessionBody: {}, promptBody: { text: "q" } }, {});
		assert.equal(r.text, "FIRST");
	} finally { await restore(); }
});

test("runStreaming: the SSE listener is opened before session.prompt is sent", async () => {
	const order = [];
	const client = fakeClient();
	client.serverUrl = async () => { order.push("sse:url"); return "http://127.0.0.1:1"; };
	client.servicePassword = async () => { order.push("sse:pw"); return "pw"; };
	const origApi = client.api.bind(client);
	client.api = async (op, opts) => { order.push(`api:${op}`); return origApi(op, opts); };
	const restore = await withFakeFetch(client, liveFrames, { ready: () => order.push("sse:connected") });
	try {
		await runStreaming(client, { sessionBody: {}, promptBody: { text: "q" } }, {});
		assert.ok(order.indexOf("sse:connected") < order.indexOf("api:session.prompt"),
			`listener must connect first, got ${order.join(" → ")}`);
	} finally { await restore(); }
});

test("runStreaming: execution.failed becomes an error event, not a crash", async () => {
	const client = fakeClient();
	const restore = await withFakeFetch(client, [
		'data: {"type":"session.text.started","data":{"sessionID":"ses_1","assistantMessageID":"m"}}\n\n',
		'data: {"type":"session.text.delta","data":{"sessionID":"ses_1","delta":"partial"}}\n\n',
		'data: {"type":"session.execution.failed","data":{"sessionID":"ses_1","error":{"name":"ProviderError","message":"model exploded"}}}\n\n',
	]);
	const seen = [];
	try {
		await runStreaming(client, { sessionBody: {}, promptBody: { text: "q" } }, { onEvent: (e) => seen.push(e) });
		const err = seen.find((e) => e.type === "error");
		assert.ok(err && /model exploded/.test(err.error.content[0].text));
	} finally { await restore(); }
});

test("runStreaming: session is removed and the stream closed on both paths", async () => {
	const client = fakeClient();
	const restore = await withFakeFetch(client, liveFrames);
	try { await runStreaming(client, { sessionBody: {}, promptBody: { text: "q" } }, {}); } finally { await restore(); }
	assert.ok(client.calls.includes("session.remove"), "cleanup on success");

	const failClient = fakeClient();
	const restore2 = await withFakeFetch(failClient, [
		'data: {"type":"session.execution.failed","data":{"sessionID":"ses_1","error":"nope"}}\n\n',
	]);
	try { await runStreaming(failClient, { sessionBody: {}, promptBody: { text: "q" } }, {}); } finally { await restore2(); }
	assert.ok(failClient.calls.includes("session.remove"), "cleanup on failure");
});

test("runStreaming: timeout rejects instead of hanging forever", async () => {
	const client = fakeClient();
	// A stream that connects then never delivers a terminal event.
	const restore = await withFakeFetch(client, ["HANG"]);
	try {
		await assert.rejects(
			() => runStreaming(client, { sessionBody: {}, promptBody: { text: "q" } }, { timeoutMs: 200 }),
			/did not complete within 200ms/,
		);
	} finally { await restore(); }
});

test("runStreaming: a missing session id still throws CapabilityError", async () => {
	const client = fakeClient();
	client.api = async (op) => (op === "session.create" ? { data: {} } : null);
	await assert.rejects(
		() => runStreaming(client, { sessionBody: {}, promptBody: { text: "q" } }, {}),
		CapabilityError,
	);
});

test("openEventStream: an HTTP error is reported as SSEUnavailable", async () => {
	const { openEventStream } = await import("../src/sse.js");
	const real = globalThis.fetch;
	globalThis.fetch = async () => ({ ok: false, status: 404 });
	try {
		const client = { async serverUrl() { return "http://x"; }, async servicePassword() { return null; } };
		const err = await new Promise((r) => openEventStream(client, { onError: r }).close);
		assert.ok(err instanceof SSEUnavailable);
		assert.match(err.message, /404/);
	} finally { globalThis.fetch = real; }
});

// ---------------------------------------------------------------------------
// streamSimple end-to-end: transport selection and the live EventStream.
// ---------------------------------------------------------------------------
class FakeStream {
	constructor() { this.events = []; this.ended = false; this.result = null; this.done = new Promise((r) => (this._resolve = r)); }
	push(e) { this.events.push(e); }
	end(r) { this.ended = true; this.result = r || null; this._resolve(); }
}

const buffered = () => ({
	api: async (op) => {
		if (op === "session.create") return { data: { id: "ses_1" } };
		if (op === "session.message.list") return {
			data: [{
				id: "msg_a", type: "assistant", time: { created: 2 }, finish: "stop",
				content: [{ type: "reasoning", text: "let me see" }, { type: "text", text: "hello" }],
				tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } },
			}],
		};
		return null;
	},
	async serverUrl() { return null; }, // no SSE → buffered
	async servicePassword() { return null; },
});

const model = { id: "opencode-bridge/opencode/space-bunny-free", reasoning: false };
const ctx = { messages: [{ role: "user", content: "hi" }] };

test("streamSimple: falls back to the buffered transport when SSE is unavailable", async () => {
	const client = buffered();
	const s = makeStreamSimple(client, FakeStream)(model, ctx, {});
	await s.done;
	assert.deepEqual(s.events.map((e) => e.type),
		["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done"]);
	assert.equal(s.events.find((e) => e.type === "done").usage.output, 2);
	assert.equal(s.events.at(-1).message.content[1].text, "hello");
});

test("streamSimple: buffered fallback still reports usage.cost on the start partial", async () => {
	const s = makeStreamSimple(buffered(), FakeStream)(model, ctx, {});
	await s.done;
	assert.ok(s.events[0].partial.usage.cost, "start partial carries usage.cost");
});

test("streamSimple: a live iterator receives streamed events pushed after iteration starts", async () => {
	const client = fakeClient();
	const restore = await withFakeFetch(client, liveFrames);
	try {
		const s = makeStreamSimple(client, EventStream)(model, ctx, {});
		const seen = [];
		for await (const e of s) {
			seen.push(e.type);
			if (e.type === "done") break;
		}
		assert.deepEqual(seen, [
			"start", "thinking_start", "thinking_delta", "thinking_delta", "thinking_end",
			"text_start", "text_delta", "text_delta", "text_end", "done",
		]);
		assert.equal(s.events.find((e) => e.type === "text_delta").delta, "The answer ");
	} finally { await restore(); }
});

test("streamSimple: a consumer iterating an empty queue keeps waiting for later events", async () => {
	// The live-queue contract, isolated: start iterating first, produce later.
	const s = new EventStream();
	const seen = [];
	const consumer = (async () => { for await (const e of s) seen.push(e.type); })();
	await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(seen, [], "nothing to consume yet");
	s.push({ type: "start" });
	s.push({ type: "done" });
	s.end();
	await consumer;
	assert.deepEqual(seen, ["start", "done"]);
});

test("streamSimple: cancellation surfaces as an aborted error event", async () => {
	const ac = new AbortController();
	const client = fakeClient();
	client.api = async (op) => {
		if (op === "session.create") return { data: { id: "ses_1" } };
		if (op === "session.prompt") { ac.abort(); throw new Error("aborted"); }
		return null;
	};
	const restore = await withFakeFetch(client, []);
	try {
		const s = makeStreamSimple(client, FakeStream)(model, ctx, { signal: ac.signal });
		await s.done;
		assert.equal(s.events.find((e) => e.type === "error").reason, "aborted");
	} finally { await restore(); }
});
