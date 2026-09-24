// Pure-logic tests: discovery mapping, request mapping, result extraction,
// redaction, manifest audit. No child processes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mapProvidersToModels, mapModelList, parseModelsTable } from "../src/opencode.js";
import { mapRequest, normalizeResult, CapabilityError } from "../src/stream.js";
import { redact, redactText, redactValue } from "../src/redact.js";
import { normalizeManifest, validateManifest, auditManifest } from "../src/audit.js";

test("discovery: provider.list data → opencode/<provider>/<model> configs", () => {
	const providers = [
		{ id: "anthropic", models: { "claude-x": { name: "Claude X", reasoning: true, cost: { input: 3, output: 15 }, limit: { context: 200000, output: 8192 } } } },
		{ id: "openai", models: [{ id: "gpt-y", modalities: { input: ["text", "image"] } }] },
	];
	const out = mapProvidersToModels(providers);
	assert.equal(out.length, 2);
	const cx = out.find((m) => m.id === "anthropic/claude-x");
	assert.ok(cx, "anthropic model present");
	assert.equal(cx.reasoning, true);
	assert.equal(cx.thinking.mode, "effort");
	assert.equal(cx.contextWindow, 200000);
	const gy = out.find((m) => m.id === "openai/gpt-y");
	assert.deepEqual(gy.input, ["text", "image"]);
	assert.equal(gy.reasoning, false);
});

test("discovery: models are never invented for empty providers", () => {
	assert.deepEqual(mapProvidersToModels([]), []);
	assert.deepEqual(mapProvidersToModels([{ id: "x", models: {} }]), []);
});

test("discovery fallback: parse `opencode models` table", () => {
	const text = ["anthropic (2)", "│ claude-a │", "│ claude-b │", "openai (1)", "│ gpt-z │"].join("\n");
	const out = parseModelsTable(text);
	assert.deepEqual(out.map((m) => m.id).sort(), ["anthropic/claude-a", "anthropic/claude-b", "openai/gpt-z"]);
});

// Fixtures below mirror shapes verified against a live OpenCode server
// (session.create / session.prompt / session.message.list), not guesses.
const assistantMsg = (over = {}) => ({
	id: "msg_1",
	time: { created: 1790246631655, completed: 1790246634317 },
	type: "assistant",
	model: { id: "space-bunny-free", providerID: "opencode" },
	content: [ { type: "reasoning", text: "thinking…" }, { type: "text", text: "hello" } ],
	finish: "stop",
	rawFinish: "stop",
	cost: 0,
	tokens: { input: 10300, output: 4, reasoning: 21, cache: { read: 475, write: 0 } },
	...over,
});
const listRes = (...msgs) => ({ data: msgs, cursor: { previous: "p", next: "n" } });

test("mapRequest: pins model at session.create, folds turns into prompt text", () => {
	const { sessionBody, promptBody, unsupported } = mapRequest(
		{ id: "opencode-bridge/anthropic/claude-x", reasoning: false },
		{ messages: [ { role: "system", content: "be terse" }, { role: "user", content: "hi" } ] },
		{},
	);
	// Model is a Model.Ref on session.create; session.prompt has no model field.
	assert.deepEqual(sessionBody, { model: { providerID: "anthropic", id: "claude-x" } });
	assert.deepEqual(Object.keys(promptBody), ["text"]);
	assert.match(promptBody.text, /User: hi/);
	assert.match(promptBody.text, /be terse/);
	assert.deepEqual(unsupported, []);
});

test("mapRequest: temperature/maxTokens are refused, not dropped", () => {
	const { unsupported } = mapRequest(
		{ id: "opencode-bridge/a/b", reasoning: false },
		{ messages: [{ role: "user", content: "hi" }] },
		{ temperature: 0.2, maxTokens: 100 },
	);
	assert.ok(unsupported.includes("temperature"));
	assert.ok(unsupported.includes("maxTokens"));
});

test("mapRequest: empty prompt throws instead of sending nothing", () => {
	assert.throws(() => mapRequest({ id: "opencode-bridge/a/b" }, { messages: [] }, {}), CapabilityError);
});

test("mapRequest: invalid model id throws CapabilityError", () => {
	assert.throws(() => mapRequest({ id: "onlyprovider" }, { messages: [{ role: "user", content: "x" }] }, {}), CapabilityError);
});

test("mapRequest: caller tools are refused, not dropped", () => {
	const { unsupported } = mapRequest({ id: "opencode-bridge/a/b" }, { messages: [{ role: "user", content: "hi" }] }, { tools: [{ name: "t" }] });
	assert.ok(unsupported.includes("tools"));
});

test("mapRequest: effort is reported on both reasoning and non-reasoning models", () => {
	// Effort is a create-time Model.Ref variant, not a per-request field: report either way.
	const off = mapRequest({ id: "opencode-bridge/a/b", reasoning: false }, { messages: [{ role: "user", content: "hi" }] }, { effort: "high" });
	assert.ok(off.unsupported.includes("reasoning"));
	const on = mapRequest({ id: "opencode-bridge/a/b", reasoning: true }, { messages: [{ role: "user", content: "hi" }] }, { effort: "high" });
	assert.ok(on.unsupported.includes("reasoning-effort-per-request"));
});

test("normalizeResult: picks newest assistant message, joins text parts, usage", () => {
	const older = assistantMsg({ id: "msg_0", time: { created: 1 }, content: [{ type: "text", text: "stale" }] });
	const r = normalizeResult(listRes(older, assistantMsg()));
	assert.equal(r.text, "hello"); // reasoning part excluded
	// OMP's message usage shape, with cost.total always present.
	assert.equal(r.usage.input, 10300);
	assert.equal(r.usage.output, 4);
	assert.equal(r.usage.cacheRead, 475);
	assert.equal(r.usage.cacheWrite, 0);
	assert.equal(r.usage.cost.total, 0);
	assert.equal(r.finishReason, "stop");
});

test("normalizeResult: unextractable response throws (never silent-wrong)", () => {
	assert.throws(() => normalizeResult({ weird: true }), CapabilityError);
	assert.throws(() => normalizeResult(listRes()), CapabilityError); // no assistant message
	assert.throws(() => normalizeResult(listRes(assistantMsg({ content: [{ type: "reasoning", text: "x" }] }))), CapabilityError); // no text
});

test("normalizeResult: maps length/tool finish reasons", () => {
	assert.equal(normalizeResult(listRes(assistantMsg({ finish: "length" }))).finishReason, "length");
	assert.equal(normalizeResult(listRes(assistantMsg({ finish: "tool" }))).finishReason, "toolUse");
});

// Regression: OpenCode advertises modalities OMP does not model (video, audio,
// pdf). Forwarding them verbatim makes OMP drop the whole model, so a real model
// silently disappears from `omp models`.
test("discovery: only text/image modalities reach OMP", () => {
	const out = mapModelList([
		{ providerID: "opencode", modelID: "m", capabilities: { input: ["text", "image", "video", "audio", "pdf"] } },
		{ providerID: "opencode", modelID: "t", capabilities: { input: ["text"] } },
		{ providerID: "opencode", modelID: "v", capabilities: { input: ["video"] } },
		{ providerID: "opencode", modelID: "n" },
	]);
	assert.equal(out.length, 4, "no model is dropped");
	assert.deepEqual(out[0].input, ["text", "image"]);
	assert.deepEqual(out[1].input, ["text"]);
	assert.deepEqual(out[2].input, ["text"], "video-only degrades to text, not an empty list");
	assert.deepEqual(out[3].input, ["text"]);
	for (const m of out) {
		assert.ok(m.input.every((c) => c === "text" || c === "image"), `bad modality in ${m.id}`);
	}
});

test("redaction: masks secret keys and inline tokens", () => {
	const o = redact({ authorization: "Bearer abcdef123456", nested: { api_key: "sk-abcdef123456", ok: "plain" } });
	assert.notEqual(o.authorization, "Bearer abcdef123456");
	assert.ok(!String(o.nested.api_key).includes("abcdef123456"));
	assert.equal(o.nested.ok, "plain");
	assert.ok(redactText("token sk-supersecretvalue here").includes("sk-***"));
	assert.equal(redactValue("short"), "***");
});

test("audit: normalizes an omp-field manifest", () => {
	const m = normalizeManifest({ omp: { name: "p", version: "1.0.0", extensions: ["src/e.js"], permissions: ["network"] } }, { root: "/plugins/p" });
	assert.equal(m.name, "p");
	assert.equal(m.entrypoint, "src/e.js");
	assert.deepEqual(m.permissions, ["network"]);
});

test("audit: missing name/entrypoint is an error", () => {
	const r = validateManifest(normalizeManifest({}, {}), {});
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => /name/.test(e)));
});

test("audit: path traversal in entrypoint is blocked", () => {
	const r = auditManifest({ omp: { name: "p", version: "1", extensions: ["../../evil.js"] } }, { root: "/plugins/p" });
	assert.equal(r.ok, false);
	assert.ok(r.errors.some((e) => /traversal/i.test(e)));
});

test("audit: high-trust capabilities produce a warning, not a block", () => {
	const r = auditManifest({ omp: { name: "p", version: "1", extensions: ["e.js"], permissions: ["shell", "credentials"] } }, { root: "/plugins/p" });
	assert.equal(r.ok, true);
	assert.ok(r.warnings.some((w) => /high-trust/i.test(w)));
});

test("audit: classifies github/url/package sources", () => {
	assert.equal(normalizeManifest({ omp: { source: "owner/repo" } }).source.type, "github");
	assert.equal(normalizeManifest({ omp: { source: "https://x/y.tgz" } }).source.type, "url");
	assert.equal(normalizeManifest({ omp: { source: "left-pad" } }).source.type, "package");
	assert.equal(normalizeManifest({ omp: { source: "git+https://x/y.git" } }).source.type, "git");
});
