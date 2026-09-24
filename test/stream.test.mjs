// Inference/stream tests using an injected stub client (no child processes).
// Covers: normal completion, event sequence, cancellation, tools refused,
// provider failure, malformed response, timeout-as-error, inference disabled.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStreamSimple, runInference, EventStream, CapabilityError } from "../src/stream.js";

// Minimal stand-in for OMP's AssistantMessageEventStream.
class FakeStream {
	constructor() {
		this.events = [];
		this.ended = false;
		this.result = null;
		this.done = new Promise((r) => (this._resolve = r));
	}
	push(e) { this.events.push(e); }
	end(result) { this.ended = true; this.result = result || null; this._resolve(); }
}

// Stub OpenCodeClient: routes by operation id, records what it was called with.
function stubClient(handlers = {}) {
	return {
		calls: [],
		seen: [],
		async api(operation, opts) {
			this.calls.push(operation);
			this.seen.push({ op: operation, data: opts?.data, params: opts?.params });
			const h = handlers[operation];
			if (typeof h === "function") return h(opts);
			if (h instanceof Error) throw h;
			return h ?? null;
		},
	};
}

const model = { id: "opencode-bridge/opencode/space-bunny-free", reasoning: false };
const ctx = { messages: [{ role: "user", content: "hi" }] };
// Response shapes captured from a live OpenCode server.
const created = { data: { id: "ses_1", projectID: "p" } };
const enqueued = { data: { id: "msg_u", sessionID: "ses_1", type: "user" } };
const answered = {
	data: [
		{ id: "msg_idle", type: "idle", outcome: "succeeded" },
		{
			id: "msg_a", time: { created: 2, completed: 3 }, type: "assistant",
			model: { id: "space-bunny-free", providerID: "opencode" },
			content: [{ type: "text", text: "hello" }], finish: "stop", rawFinish: "stop",
			tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
		},
		{ id: "msg_u", time: { created: 1 }, type: "user", text: "hi" },
	],
	cursor: { previous: "p", next: "n" },
};
const okFlow = (extra = {}) => ({
	"session.create": created,
	"session.prompt": enqueued,
	"experimental.session.wait": null,
	"session.message.list": answered,
	"session.remove": null,
	...extra,
});

test("runInference: create→prompt→wait→message.list→remove, returns text", async () => {
	const client = stubClient(okFlow());
	const r = await runInference(client, { sessionBody: { model: { providerID: "opencode", id: "space-bunny-free" } }, promptBody: { text: "hi" } });
	assert.equal(r.text, "hello");
	assert.deepEqual(client.calls, ["session.create", "session.prompt", "experimental.session.wait", "session.message.list", "session.remove"]);
	// path params, not body fields
	const create = client.seen.find((c) => c.op === "session.create");
	assert.deepEqual(create.data.model, { providerID: "opencode", id: "space-bunny-free" });
	const prompt = client.seen.find((c) => c.op === "session.prompt");
	assert.deepEqual(prompt.params, { sessionID: "ses_1" });
	assert.deepEqual(prompt.data, { text: "hi" });
});

test("runInference: 503 from wait is retried, not failed", async () => {
	let waits = 0;
	const client = stubClient(okFlow({
		"experimental.session.wait": () => {
			waits++;
			if (waits < 3) throw new Error("Request failed (503): session busy");
			return null;
		},
	}));
	const r = await runInference(client, { sessionBody: { model: { providerID: "p", id: "m" } }, promptBody: { text: "hi" } }, { waitTimeoutMs: 5000 });
	assert.equal(r.text, "hello");
	assert.equal(waits, 3);
});

test("runInference: non-503 wait failure propagates", async () => {
	const client = stubClient(okFlow({ "experimental.session.wait": new Error("401 unauthorized") }));
	await assert.rejects(
		() => runInference(client, { sessionBody: { model: { providerID: "p", id: "m" } }, promptBody: { text: "hi" } }),
		/401/,
	);
});

test("runInference: session is removed even when the prompt fails", async () => {
	const client = stubClient(okFlow({ "session.prompt": new Error("upstream 500") }));
	await assert.rejects(() => runInference(client, { sessionBody: { model: { providerID: "p", id: "m" } }, promptBody: { text: "hi" } }));
	assert.ok(client.calls.includes("session.remove"), "cleanup runs on failure");
});

test("runInference: no session id throws CapabilityError", async () => {
	const client = stubClient({ "session.create": { data: {} } });
	await assert.rejects(
		() => runInference(client, { sessionBody: {}, promptBody: { text: "hi" } }),
		CapabilityError,
	);
});

test("streamSimple: emits start→text→done and usage", async () => {
	const s = makeStreamSimple(stubClient(okFlow()), FakeStream, { inference: true })(model, ctx, {});
	await s.done;
	const types = s.events.map((e) => e.type);
	assert.deepEqual(types, ["start", "text_start", "text_delta", "text_end", "done"]);
	assert.equal(s.events.find((e) => e.type === "text_end").content, "hello");
	assert.equal(s.result.usage.output, 1);
	// usage must already be on the start partial: OMP copies the message out of the
	// first event it sees and then dereferences message.usage.cost.
	assert.ok(s.events[0].partial.usage.cost, "start partial carries usage.cost");
	assert.equal(s.events.at(-1).message.stopReason, "stop");
});

test("streamSimple: a live iterator receives events pushed after iteration starts", async () => {
	// Regression: the iterator used to snapshot the event array, so it completed
	// before the async work pushed anything and OMP never saw a `done` event.
	const client = stubClient(okFlow());
	const s = makeStreamSimple(client, EventStream, { inference: true })(model, ctx, {});
	const seen = [];
	for await (const e of s) {
		seen.push(e.type);
		if (e.type === "done") break;
	}
	assert.deepEqual(seen, ["start", "text_start", "text_delta", "text_end", "done"]);
	assert.equal(s.events.find((e) => e.type === "text_delta").delta, "hello");
});

test("streamSimple: caller tools become an error event, not a crash", async () => {
	const client = stubClient({});
	const s = makeStreamSimple(client, FakeStream, { inference: true })(model, ctx, { tools: [{ name: "t" }] });
	await s.done;
	const err = s.events.find((e) => e.type === "error");
	assert.ok(err, "error event emitted");
	assert.match(err.error.content[0].text, /tools/);
	assert.equal(client.calls.length, 0, "no session created for a refused request");
});

test("streamSimple: provider failure surfaces as error event", async () => {
	const s = makeStreamSimple(stubClient(okFlow({ "session.prompt": new Error("upstream 500") })), FakeStream, { inference: true })(model, ctx, {});
	await s.done;
	assert.ok(s.events.some((e) => e.type === "error"));
});

test("streamSimple: malformed response → error event, never silent success", async () => {
	const s = makeStreamSimple(stubClient(okFlow({ "session.message.list": { data: [] } })), FakeStream, { inference: true })(model, ctx, {});
	await s.done;
	const err = s.events.find((e) => e.type === "error");
	assert.ok(err && /no assistant message/i.test(err.error.content[0].text));
});

test("streamSimple: timeout is reported as an error event", async () => {
	const s = makeStreamSimple(stubClient(okFlow({ "session.prompt": new Error("opencode timed out after 30000ms") })), FakeStream, { inference: true })(model, ctx, {});
	await s.done;
	assert.ok(s.events.some((e) => e.type === "error"));
});

test("streamSimple: cancellation reason maps to aborted", async () => {
	const s = makeStreamSimple(stubClient(okFlow({ "session.prompt": new Error("aborted") })), FakeStream, { inference: true })(model, ctx, {});
	await s.done;
	const err = s.events.find((e) => e.type === "error");
	assert.equal(err.reason, "aborted");
});

test("streamSimple: inference disabled yields error event", async () => {
	const s = makeStreamSimple(stubClient({}), FakeStream, { inference: false })(model, ctx, {});
	await s.done;
	assert.ok(s.events.some((e) => e.type === "error" && /disabled/i.test(e.error.content[0].text)));
});
