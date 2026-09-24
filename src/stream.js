// Inference adapter: OMP request → OpenCode session API → OMP event stream.
//
// Boundary (see README "Capability boundary"): OpenCode exposes a session-based
// *agent* API, not a raw model endpoint. Verified against oc_openapi.json and a
// live server; the flow is:
//
//   session.create  (body: { model: { providerID, id }, title? })
//     → { data: { id, … } }
//   session.prompt  (path param sessionID; body: { text })  → { data: { … } }
//     this is ASYNC: it only enqueues a user message and returns immediately.
//   experimental.session.wait (path param sessionID) → 204, blocks until idle.
//   session.message.list (path param sessionID) → { data: Session.Message.Info[] }
//     pick the newest `assistant` message, join its `content[].text` parts.
//   session.remove  (path param sessionID) → 204, deletes the session.
//
// Options OpenCode cannot honor are reported as CapabilityError — never silently
// dropped. Any schema mismatch becomes a stream `error` event, never a silent
// wrong answer.

export class CapabilityError extends Error {
	constructor(message, { capability } = {}) {
		super(message);
		this.name = "CapabilityError";
		this.capability = capability;
	}
}

/**
 * Translate an OMP (model, options) pair into the OpenCode session calls.
 * Returns { sessionBody, promptBody, unsupported }.
 *
 * Verified contract: the model is pinned at *session create* time via
 * `model: { providerID, id }` — `session.prompt` has no model field, and its
 * body accepts only `text` (plus files/agents/skills/metadata/delivery/resume).
 */
export function mapRequest(model, context, options = {}, descriptor = null) {
	// OMP model ids arrive either as `<providerID>/<modelID>` or, when the
	// registered-provider prefix is still attached, `opencode-bridge/<providerID>/<modelID>`.
	// Strip the bridge prefix if present; what remains is the pair OpenCode expects.
	const rest = descriptor ? null : String(model.id).replace(/^opencode-bridge\//, "").split("/");
	const providerID = descriptor?.providerID || rest[0];
	const modelID = descriptor?.modelID || rest.slice(1).join("/");
	if (!providerID || !modelID) {
		throw new CapabilityError(`model id must be <provider>/<model>, got "${model.id}"`);
	}

	const unsupported = [];

	// Multi-turn history: session.prompt takes ONE text blob, so prior turns are
	// folded into the transcript we send. OpenCode has no multi-message batch.
	const messages = extractMessages(context);
	const text = toPromptText(messages);
	if (!text) throw new CapabilityError("empty prompt: nothing to send to OpenCode", { capability: "inference" });

	// Tool calling: OpenCode drives its own agent tools inside the session; it does
	// not accept a caller-supplied OpenAI/Anthropic tool schema on the wire. Refuse
	// loudly instead of discarding the caller's tools.
	if (Array.isArray(options.tools) && options.tools.length > 0) {
		unsupported.push("tools");
	}
	// Reasoning: the model is chosen by the caller, but the *effort* is a variant
	// on Model.Ref at create time (model.variant), not a prompt field. We cannot set
	// it per-request, so report rather than pretend.
	if (options.thinking || options.effort || options.reasoningEffort) {
		if (!model.reasoning) unsupported.push("reasoning");
		else unsupported.push("reasoning-effort-per-request");
	}
	// Multimodal: files are supported via `files` (uri/name), not inline image parts.
	// We have no way to materialize an OMP image into a uri, so report if present.
	if (hasImages(messages)) unsupported.push("image-input");
	// temperature / maxTokens: not fields of session.create or session.prompt.
	if (typeof options.temperature === "number") unsupported.push("temperature");
	if (typeof options.maxTokens === "number") unsupported.push("maxTokens");

	const sessionBody = { model: { providerID, id: modelID } };
	const promptBody = { text };
	return { providerID, modelID, sessionBody, promptBody, unsupported };
}

/** Flatten OMP context messages into the single text blob session.prompt accepts. */
function toPromptText(messages) {
	const body = messages
		.filter((m) => m.role !== "system")
		.map((m) => {
			const label = m.role === "assistant" ? "Assistant" : "User";
			return textOf(m) ? `${label}: ${textOf(m)}` : "";
		})
		.filter(Boolean)
		.join("\n\n");
	// A system-only context still needs something on the wire; carry it as the prompt.
	const system = messages.filter((m) => m.role === "system").map(textOf).filter(Boolean).join("\n\n");
	return [body, system].filter(Boolean).join("\n\n");
}

function extractMessages(context) {
	if (!context) return [];
	const raw = Array.isArray(context) ? context : context.messages || context.history || [];
	return Array.isArray(raw) ? raw : [];
}
function textOf(m) {
	if (typeof m?.content === "string") return m.content;
	if (Array.isArray(m?.content)) return m.content.map((c) => c?.text || "").join("");
	return typeof m?.text === "string" ? m.text : "";
}
function hasImages(messages) {
	return messages.some((m) => Array.isArray(m?.content) && m.content.some((c) => c?.type === "image"));
}

/**
 * OpenCode SSE driver. One session, one prompt, events streamed out in order.
 *
 * Race handling: the listener is opened and given a chance to deliver the
 * `server.connected` frame BEFORE session.prompt is sent. The first delta can
 * therefore never be lost, because the reader is already draining.
 *
 * The reducer below is the whole translation. OpenCode event → OMP event:
 *
 *   session.reasoning.started → thinking_start  (new {type:"thinking"} block)
 *   session.reasoning.delta   → thinking_delta
 *   session.reasoning.ended   → thinking_end
 *   session.text.started      → text_start
 *   session.text.delta        → text_delta
 *   session.text.ended        → text_end
 *   session.step.ended        → usage/finish (per step)
 *   session.execution.succeeded|failed|interrupted → done
 *
 * Text and reasoning blocks interleave naturally because they share one
 * ordered event stream; each block gets its own contentIndex in `partial.content`
 * exactly as OMP's own assemblers do (read from omp.exe).
 */
export async function runStreaming(client, mapped, { signal, timeoutMs = 120000, partial, onEvent, sanitize = (s) => s } = {}) {
	const { sessionBody, promptBody } = mapped;
	const { openEventStream } = await import("./sse.js");
	const s = new Transcript(onEvent, partial, sanitize);

	// 1. Create the session first, so we know which sessionID to filter events for.
	const created = await client.api("session.create", { signal, data: sessionBody });
	const sessionID = created?.data?.id || created?.id;
	if (!sessionID) throw new CapabilityError("OpenCode session.create returned no session id", { capability: "inference" });

	let stream = null;
	const timer = setTimeout(
		() => s.fail(new OpenCodeTimeout(`OpenCode session ${sessionID} did not complete within ${timeoutMs}ms`)),
		timeoutMs,
	);
	try {
		// 2. Open the listener BEFORE prompting. `ready` resolves when the response
		//    headers land, i.e. the socket is live and the reader is draining — so a
		//    first delta emitted immediately after session.prompt cannot be missed.
		stream = openEventStream(client, {
			signal,
			onEvent: (ev) => s.feed(ev, sessionID),
			onError: (e) => s.fail(e),
		});
		await stream.ready;
		// 3. Trigger generation.
		await client.api("session.prompt", { signal, params: { sessionID }, data: promptBody });
		await s.done;
		return { ...s.result(), raw: null };
	} finally {
		clearTimeout(timer);
		stream?.close();
		try { await client.api("session.remove", { signal, params: { sessionID } }); } catch {}
	}
}

/**
 * The whole OpenCode→OMP translation, as a stateful reducer over one session.
 *
 * Text and reasoning interleave naturally because they share one ordered event
 * stream; each block gets its own `contentIndex` in `partial.content`, exactly as
 * OMP's own assemblers do (shape read from omp.exe: `thinking_start` /
 * `thinking_delta` / `thinking_end` / `text_start` / `text_delta` / `text_end`,
 * each carrying `{contentIndex, partial}`).
 */
class Transcript {
	constructor(emit, partial, sanitize) {
		this.emit = emit || (() => {});
		this.sanitize = sanitize;
		this.text = "";
		this.thinking = "";
		this.finish = null;
		this.tokens = null;
		this.cost = 0;
		// The caller owns the partial (it is the one that pushed `start`), so the
		// usage contract OMP dereferences on the first event stays in one place.
		this.partial = partial || { role: "assistant", content: [], usage: zeroUsage() };
		// OpenCode runs one assistant message per step; only follow the current
		// one, so a multi-step session never splices two answers together.
		this.messageID = null;
		this.textIndex = -1;
		this.thinkingIndex = -1;
		this.done = new Promise((res, rej) => ((this._res = res), (this._rej = rej)));
		this.done.catch(() => {}); // the real rejection is observed via await
		this.settled = false;
	}
	fail(e) {
		if (this.settled) return;
		this.settled = true;
		this._rej(e);
	}
	feed(ev, sessionID) {
		if (this.settled) return;
		const d = ev?.data;
		// Unrelated sessions share one global stream — drop everything not ours.
		if (ev?.type !== "server.connected" && d?.sessionID !== sessionID) return;
		// Content events also carry the assistant message; ignore stale steps.
		const stale = d?.assistantMessageID && this.messageID && d.assistantMessageID !== this.messageID;
		try {
			switch (ev.type) {
				case "session.step.started":
					this.messageID = d.assistantMessageID;
					break;
				case "session.reasoning.started":
					if (stale) break;
					this.thinkingIndex = this.partial.content.push({ type: "thinking", thinking: "" }) - 1;
					this.emit({ type: "thinking_start", contentIndex: this.thinkingIndex, partial: this.partial });
					break;
				case "session.reasoning.delta": {
					if (stale) break;
					this.thinking += d.delta || "";
					this.partial.content[this.thinkingIndex].thinking += d.delta || "";
					this.emit({ type: "thinking_delta", contentIndex: this.thinkingIndex, delta: d.delta || "", partial: this.partial });
					break;
				}
				case "session.reasoning.ended": {
					if (stale) break;
					// The terminal frame carries the full text — prefer it over the
					// sum of deltas, which can be short if a frame was dropped.
					this.thinking = d.text ?? this.thinking;
					this.partial.content[this.thinkingIndex].thinking = this.thinking;
					this.emit({ type: "thinking_end", contentIndex: this.thinkingIndex, content: this.thinking, partial: this.partial });
					this.thinkingIndex = -1;
					break;
				}
				case "session.text.started":
					if (stale) break;
					this.textIndex = this.partial.content.push({ type: "text", text: "" }) - 1;
					this.emit({ type: "text_start", contentIndex: this.textIndex, partial: this.partial });
					break;
				case "session.text.delta": {
					if (stale) break;
					this.text += d.delta || "";
					this.partial.content[this.textIndex].text += d.delta || "";
					this.emit({ type: "text_delta", contentIndex: this.textIndex, delta: d.delta || "", partial: this.partial });
					break;
				}
				case "session.text.ended": {
					if (stale) break;
					this.text = d.text ?? this.text;
					this.partial.content[this.textIndex].text = this.text;
					this.emit({ type: "text_end", contentIndex: this.textIndex, content: this.text, partial: this.partial });
					this.textIndex = -1;
					break;
				}
				case "session.step.ended":
					if (stale) break;
					this.finish = d.finish;
					if (d.tokens) this.tokens = d.tokens;
					if (typeof d.cost === "number") this.cost = d.cost;
					break;
				case "session.usage.updated":
					if (d.tokens) this.tokens = d.tokens;
					if (typeof d.cost === "number") this.cost = d.cost;
					break;
				case "session.execution.succeeded":
					if (!this.text) throw new CapabilityError("OpenCode execution finished with no text output", { capability: "inference" });
					this.partial.stopReason = mapFinish(this.finish);
					this.partial.usage = this.usage();
					this.emit({ type: "done", reason: this.partial.stopReason, message: this.partial, usage: this.partial.usage });
					return this.finishUp();
				case "session.execution.failed":
					this.emit({ type: "error", reason: "error", error: errMessage(this.sanitize(String(d.error?.message || d.error || "OpenCode execution failed"))) });
					return this.finishUp();
				case "session.execution.interrupted":
					this.emit({ type: "error", reason: "aborted", error: errMessage("OpenCode execution interrupted") });
					return this.finishUp();
			}
		} catch (e) {
			this.fail(e);
		}
	}
	finishUp() {
		if (this.settled) return;
		this.settled = true;
		this._res();
	}
	usage() {
		const t = this.tokens || {};
		return {
			input: num(t.input),
			output: num(t.output),
			cacheRead: num(t.cache?.read),
			cacheWrite: num(t.cache?.write),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: num(this.cost) },
		};
	}
	result() {
		return { text: this.text, thinking: this.thinking, finishReason: mapFinish(this.finish), usage: this.usage() };
	}
}

function errMessage(text) {
	return { role: "assistant", content: [{ type: "text", text }], usage: zeroUsage() };
}

/**
 * Drive an OpenCode session and return a normalized result {text, finishReason,
 * usage, raw}. The answer arrives via session.message.list, not from the prompt
 * call — session.prompt only enqueues.
 */
export async function runInference(client, mapped, { signal, waitTimeoutMs = 120000 } = {}) {
	const { sessionBody, promptBody } = mapped;
	// 1. Create the session, pinned to the caller's model.
	const created = await client.api("session.create", { signal, data: sessionBody });
	const sessionID = created?.data?.id || created?.id;
	if (!sessionID) {
		throw new CapabilityError("OpenCode session.create returned no session id", { capability: "inference" });
	}
	try {
		// 2. Enqueue the prompt (async — returns the queued user message).
		await client.api("session.prompt", { signal, params: { sessionID }, data: promptBody });
		// 3. Block until the session goes idle. 204 = idle, 503 = still busy
		// (poll through), anything else is a real failure.
		await waitForIdle(client, sessionID, { signal, waitTimeoutMs });
		// 4. Read the transcript and take the newest assistant message.
		const res = await client.api("session.message.list", { signal, params: { sessionID } });
		return normalizeResult(res);
	} finally {
		// 5. Best-effort cleanup; ignore failures.
		try { await client.api("session.remove", { signal, params: { sessionID } }); } catch {}
	}
}

/**
 * experimental.session.wait blocks until the session is idle (204). 503 means
 * "still running" — back off and retry until the budget runs out.
 */
async function waitForIdle(client, sessionID, { signal, waitTimeoutMs }) {
	const deadline = Date.now() + waitTimeoutMs;
	let delay = 500;
	for (;;) {
		try {
			await client.api("experimental.session.wait", { signal, params: { sessionID }, timeoutMs: waitTimeoutMs });
			return; // 204 (or empty) → idle
		} catch (e) {
			const busy = /503|still.*(busy|running|active)/i.test(String(e?.message));
			if (!busy) throw e;
			if (Date.now() >= deadline) {
				throw new OpenCodeTimeout(`OpenCode session ${sessionID} did not go idle within ${waitTimeoutMs}ms`);
			}
			await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), signal);
			delay = Math.min(delay * 2, 5000);
		}
	}
}
const sleep = (ms, signal) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, Math.max(0, ms));
		const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});

class OpenCodeTimeout extends Error {}

export function normalizeResult(res) {
	const messages = Array.isArray(res?.data) ? res.data : null;
	if (!messages) {
		throw new CapabilityError("session.message.list returned no message array", { capability: "inference" });
	}
	// Newest assistant message wins.
	const assistants = messages.filter((m) => m?.type === "assistant");
	const msg = assistants.sort((a, b) => (b?.time?.created || 0) - (a?.time?.created || 0))[0];
	if (!msg) {
		throw new CapabilityError("no assistant message in OpenCode session", { capability: "inference" });
	}
	const parts = Array.isArray(msg.content) ? msg.content : [];
	const text = parts.filter((p) => p?.type === "text").map((p) => p.text || "").join("");
	if (!text) {
		throw new CapabilityError("assistant message had no text content", { capability: "inference" });
	}
	const tokens = msg.tokens || {};
	// OMP's message usage shape (omp 18.2.6, read from the binary): flat
	// input/output/cacheRead/cacheWrite plus a cost object. `cost.total` is read
	// unconditionally by the done handler, so it must always be present.
	const input = num(tokens.input);
	const output = num(tokens.output);
	const cacheRead = num(tokens.cache?.read);
	const cacheWrite = num(tokens.cache?.write);
	return {
		text,
		// Reasoning is a first-class `reasoning` content part on the message;
		// surface it in the buffered path too, not just when streaming.
		thinking: parts.filter((p) => p?.type === "reasoning").map((p) => p.text || p.reasoning || "").join(""),
		finishReason: mapFinish(msg.finish || msg.rawFinish),
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		raw: msg,
	};
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** OMP's message usage shape: flat counters plus a cost object with `total`. */
function zeroUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function mapFinish(r) {
	if (r === "length" || r === "max_tokens") return "length";
	if (r === "tool" || r === "toolUse" || r === "tool_use") return "toolUse";
	return "stop";
}

/**
 * Minimal AssistantMessageEventStream. OMP does not hand extensions its own
 * stream class, but the api-registry contract only requires this surface:
 * push/end plus async iteration, `result()`, and the local-work flag the
 * watchdog consults.
 *
 * ponytail: the iterator is a live queue, not a snapshot of an array. OMP starts
 * iterating immediately and stops when the iterator returns — a snapshot yields
 * nothing, the stream ends with no `done` event, and the caller dereferences a
 * message that was never assembled. Requeue/resume needed if OMP ever hands us
 * its real class in; prefer it and delete this.
 */
export class EventStream {
	constructor() {
		this.events = [];
		this.queue = [];
		this.waiters = [];
		this.done = false;
		this.resultValue = undefined;
		this._resolve = null;
		this.resultPromise = new Promise((r) => (this._resolve = r));
	}
	push(event) {
		this.events.push(event);
		const waiter = this.waiters.shift();
		if (waiter) waiter(event);
		else this.queue.push(event);
	}
	end(result) {
		if (this.done) return;
		this.done = true;
		this.resultValue = result;
		this._resolve?.(result);
		// Release the iterator so a `for await` loop terminates.
		for (const w of this.waiters.splice(0)) w(undefined);
	}
	async *[Symbol.asyncIterator]() {
		for (;;) {
			if (this.queue.length) {
				yield this.queue.shift();
				continue;
			}
			if (this.done) return;
			const next = await new Promise((r) => this.waiters.push(r));
			if (next === undefined) return;
			yield next;
		}
	}
	result() { return this.resultPromise; }
	get hasPendingLocalWork() { return !this.done; }
}

/**
 * Build the OMP `streamSimple` handler.
 *
 * Transport: SSE when the server offers `GET /api/event`, else the verified
 * buffered path (session.prompt → session.wait → message.list). The buffered
 * path stays the default until SSE proves it can connect — a working inference
 * path is never traded away for a streaming one.
 *
 * Every failure path becomes an `error` stream event, so a bridge fault can
 * never crash OMP or masquerade as a successful empty answer.
 */
export function makeStreamSimple(client, StreamCtor = EventStream, { inference = true, streaming = true, timeoutMs = 120000, resolveModel, resolveClient, sanitize = (s) => s } = {}) {
	return function streamSimple(model, context, options = {}) {
		const stream = new StreamCtor();
		(async () => {
			// OMP's assembler copies the message out of the FIRST event it sees
			// (`{...partial}`) and then dereferences message.usage.cost — so
			// `usage` must exist on the start partial, not just on `done`.
			const partial = { role: "assistant", content: [], usage: zeroUsage() };
			try {
				if (!inference) throw new CapabilityError("OpenCode inference is disabled (opencode.inference=false)", { capability: "inference" });
				const descriptor = resolveModel?.(model) || null;
				const mapped = mapRequest(model, context, options, descriptor);
				if (mapped.unsupported.length) {
					throw new CapabilityError(`OpenCode cannot honor: ${mapped.unsupported.join(", ")}`, { capability: mapped.unsupported[0] });
				}
				stream.push({ type: "start", partial });
				const selectedClient = descriptor ? await resolveClient(descriptor) : client;

				if (streaming && selectedClient.streamingSupported !== false) {
					try {
						const result = await runStreaming(selectedClient, mapped, {
							signal: options.signal,
							timeoutMs,
							partial,
							onEvent: (e) => stream.push(e),
							sanitize,
						});
						stream.end({ usage: result.usage });
						return;
					} catch (e) {
						// Fall back only if the stream produced nothing: a half-delivered
						// token stream cannot be replayed without corrupting the answer.
						// (Any error before the first content block means SSE never started —
						// no server, auth mismatch, older build without event.subscribe.)
						if (partial.content.length) throw e;
					}
				}

				const result = await runBuffered(selectedClient, mapped, { signal: options.signal, partial, onEvent: (e) => stream.push(e) });
				stream.end({ usage: result.usage });
			} catch (err) {
				const reason = /abort/i.test(String(err?.message)) ? "aborted" : "error";
				// Same message contract as the success path: OMP's error handler also
				// walks usage.cost.total.
				try { stream.push({ type: "error", reason, error: errMessage(sanitize(String(err?.message || err))) }); } catch {}
				stream.end();
			}
		})();
		return stream;
	};
}

/**
 * Buffered transport: session.prompt → experimental.session.wait →
 * session.message.list. The answer arrives whole, so text is emitted as a
 * single delta; reasoning is emitted as a thinking block when the message
 * carries one. Event shapes are identical to the streaming path.
 */
async function runBuffered(client, mapped, { signal, partial, onEvent }) {
	const result = await runInference(client, mapped, { signal });
	if (result.thinking) {
		partial.content.push({ type: "thinking", thinking: result.thinking });
		onEvent({ type: "thinking_start", contentIndex: partial.content.length - 1, partial });
		onEvent({ type: "thinking_delta", contentIndex: partial.content.length - 1, delta: result.thinking, partial });
		onEvent({ type: "thinking_end", contentIndex: partial.content.length - 1, content: result.thinking, partial });
	}
	partial.content.push({ type: "text", text: result.text });
	const i = partial.content.length - 1;
	onEvent({ type: "text_start", contentIndex: i, partial });
	onEvent({ type: "text_delta", contentIndex: i, delta: result.text, partial });
	onEvent({ type: "text_end", contentIndex: i, content: result.text, partial });
	partial.stopReason = result.finishReason;
	partial.usage = result.usage;
	onEvent({ type: "done", reason: result.finishReason, message: partial, usage: result.usage });
	return result;
}

