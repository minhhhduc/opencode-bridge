// Direct inference: OMP request → configured baseURL → OMP event stream.
//
// This path never touches OpenCode. It is a real model endpoint
// (OpenAI-compatible), not OpenCode's session agent API, so the translation is
// the ordinary one: messages in, `Authorization: Bearer <this request's key>`
// out, SSE deltas back as OMP stream events.
//
// Credential routing is per-call and per-descriptor: resolveApiKey() is read at
// request time and the header is built inline. Nothing is written to
// process.env, so two concurrent requests on different credentials cannot
// clobber each other.

import { CapabilityError, EventStream } from "./stream.js";
import { PROTOCOLS, resolveApiKey } from "./direct.js";
import { redactText } from "./redact.js";

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** OMP context → OpenAI chat messages. Tool results keep their call ids. */
export function mapMessages(context) {
	const out = [];
	for (const text of context?.systemPrompt || []) {
		if (typeof text === "string" && text.trim()) out.push({ role: "system", content: text });
	}
	for (const message of context?.messages || []) {
		if (message?.role === "toolResult") {
			out.push({ role: "tool", tool_call_id: message.toolCallId, content: textOf(message.content) });
		} else if (message?.role === "assistant" && message.content?.some?.((c) => c?.type === "toolCall")) {
			const calls = message.content.filter((c) => c?.type === "toolCall");
			const text = message.content.filter((c) => c?.type === "text").map((c) => c.text).join("");
			out.push({
				role: "assistant",
				content: text || null,
				tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })),
			});
		} else if (message?.role === "assistant" || message?.role === "user" || message?.role === "system" || message?.role === "developer") {
			const text = textOf(message.content);
			if (text) out.push({ role: message.role, content: text });
		}
	}
	return out;
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("");
}

/**
 * OMP's tool list → OpenAI `tools`. Verified against omp 18.2.6: each entry is
 * `{name, description, parameters}` with a JSON-Schema `parameters` object, so
 * this is a shape-guarded pass-through.
 */
export function mapTools(context) {
	const out = [];
	for (const tool of context?.tools || []) {
		if (!tool?.name) continue;
		const fn = { name: tool.name };
		if (typeof tool.description === "string" && tool.description) fn.description = tool.description;
		if (tool.parameters && typeof tool.parameters === "object") fn.parameters = tool.parameters;
		out.push({ type: "function", function: fn });
	}
	return out;
}

function buildBody(descriptor, provider, context, options, protocol) {
	const messages = mapMessages(context);
	if (!messages.length) throw new CapabilityError("empty prompt: nothing to send to the direct provider", { capability: "inference" });
	const body = { model: descriptor.modelID, messages, stream: true };

	if (protocol.stream === "responses") {
		// The Responses API takes a flat `input`, not `messages`. The
		// system/user/assistant subset maps verbatim; tool turns are refused
		// rather than reshaped into something the provider would misread.
		if (messages.some((m) => m.role === "tool" || m.tool_calls)) {
			throw new CapabilityError("protocol openai-responses does not carry tool calls in this bridge", { capability: "tools" });
		}
		body.input = messages.map((m) => ({
			role: m.role,
			content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
		}));
		delete body.messages;
	} else if (context?.tools?.length) {
		if (!provider.supportsTools) {
			throw new CapabilityError(`direct provider "${provider.id}" is configured without tool support`, { capability: "tools" });
		}
		body.tools = mapTools(context);
		if (typeof options?.toolChoice === "string") body.tool_choice = options.toolChoice;
	}
	if (typeof options?.temperature === "number") body.temperature = options.temperature;
	if (typeof options?.topP === "number") body.top_p = options.topP;
	// Always send an explicit max_tokens. OMP does not set options.maxTokens for
	// this provider, and an OpenAI-compatible gateway left to its own default
	// reserves the model's full output ceiling (OpenRouter: 65536), which a
	// credit-limited account rejects with 402 before any content is generated.
	// The configured maxOutputTokens is the ceiling we advertised to OMP, so it
	// is also the most we may ask for.
	body.max_tokens = typeof options?.maxTokens === "number" ? options.maxTokens : descriptor.maxTokens ?? 8192;
	return body;
}

/**
 * Build the OMP `streamSimple` handler for the direct provider. `resolve(model)`
 * yields a descriptor, or null for an id that is not a configured direct model.
 * The key is resolved inside the request, from that descriptor alone.
 */
export function makeDirectStreamSimple({ providers, resolve, env = process.env, fetchImpl = fetch, timeoutMs = 300000 }) {
	return function streamSimple(model, context, options = {}) {
		const stream = new EventStream();
		(async () => {
			// usage must exist on the FIRST event: OMP copies the message out of
			// it and then dereferences usage.cost.
			const partial = { role: "assistant", content: [], usage: zeroUsage() };
			try {
				const descriptor = resolve(model);
				if (!descriptor) throw new CapabilityError(`not a configured direct model: ${model?.id}`, { capability: "inference" });
				const provider = providers.get(descriptor.providerID);
				const protocol = PROTOCOLS[provider.protocol];
				const apiKey = resolveApiKey(descriptor, env);
				const body = buildBody(descriptor, provider, context, options, protocol);

				stream.push({ type: "start", partial });
				await runDirect({
					url: `${provider.baseURL}/${protocol.path}`,
					apiKey,
					body,
					partial,
					signal: options.signal,
					fetchImpl,
					timeoutMs,
					emit: (e) => stream.push(e),
				});
				stream.end({ usage: partial.usage });
			} catch (err) {
				const reason = /abort/i.test(String(err?.message)) ? "aborted" : "error";
				// redactText covers an upstream that echoes our Authorization header
				// back inside an error body; the key is never interpolated.
				try { stream.push({ type: "error", reason, error: errMessage(redactText(String(err?.message || err))) }); } catch {}
				stream.end();
			}
		})();
		return stream;
	};
}

const errMessage = (text) => ({ role: "assistant", content: [{ type: "text", text }], usage: zeroUsage() });

/** POST, then drain SSE frame-by-frame, emitting each delta as it lands. */
async function runDirect({ url, apiKey, body, partial, signal, fetchImpl, timeoutMs, emit }) {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "text/event-stream",
			// The one place the selected credential enters the wire.
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: signal ?? AbortSignal.timeout(timeoutMs),
	});

	if (!response.ok) {
		// The body may echo the Authorization header back, so redact it against
		// the key this request actually sent — not just against generic patterns.
		const detail = (await response.text().catch(() => "")).split(apiKey).join("***").slice(0, 500);
		throw new DirectHttpError(response.status, detail);
	}
	if (!response.body) throw new Error("direct provider returned no response body");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const state = { buffer: "", text: -1, thinking: -1, finish: "stop", tools: new Map() };
	const open = (kind) => {
		const idx = state[kind];
		if (idx >= 0) return idx;
		const part = kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
		state[kind] = partial.content.push(part) - 1;
		emit({ type: `${kind}_start`, contentIndex: state[kind], partial });
		return state[kind];
	};

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		state.buffer += decoder.decode(value, { stream: true });
		// Consume only up to the last complete frame; the tail is still partial.
		const cut = state.buffer.lastIndexOf("\n\n");
		if (cut < 0) continue;
		const chunk = state.buffer.slice(0, cut + 2);
		state.buffer = state.buffer.slice(cut + 2);
		for (const line of chunk.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (!payload) continue;
			// [DONE] is a sentinel, not a terminator we can trust blindly: a frame
			// carrying the final finish_reason/usage may follow it. Record it and
			// let the stream's natural end do the finishing.
			if (payload === "[DONE]") continue;
			let event;
			// A malformed frame must never kill an otherwise live stream.
			try { event = JSON.parse(payload); } catch { continue; }
			if (event.error) throw new Error(event.error.message || String(event.error));
			handleChunk(event, { partial, emit, open, state });
		}
	}
	return finish(partial, state, emit);
}

function finish(partial, state, emit) {
	if (!partial.content.length) throw new Error("direct provider produced no content");
	for (const part of state.tools.values()) {
		// Drop the internal accumulation buffer before the part is handed to OMP.
		delete part.raw;
		emit({ type: "toolcall_end", contentIndex: partial.content.indexOf(part), toolCall: part, partial });
	}
	if (state.thinking >= 0) {
		emit({ type: "thinking_end", contentIndex: state.thinking, content: partial.content[state.thinking].thinking, partial });
	}
	if (state.text >= 0) {
		emit({ type: "text_end", contentIndex: state.text, content: partial.content[state.text].text, partial });
	}
	partial.stopReason = state.finish;
	emit({ type: "done", reason: partial.stopReason, message: partial, usage: partial.usage });
}

/**
 * One provider chunk → OMP events. Chat-completions shape (`choices[0].delta`),
 * which is what every OpenAI-compatible gateway streams for both protocol
 * entries here: text, reasoning, tool-call fragments, usage, finish reason.
 */
function handleChunk(event, { partial, emit, open, state }) {
	// Usage may ride on any chunk or only the last, depending on stream_options.
	if (event.usage) {
		partial.usage = {
			input: num(event.usage.prompt_tokens ?? event.usage.input_tokens),
			output: num(event.usage.completion_tokens ?? event.usage.output_tokens),
			cacheRead: num(event.usage.prompt_tokens_details?.cached_tokens),
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}
	const choice = event.choices?.[0];
	if (!choice) return;
	if (choice.finish_reason) state.finish = mapFinish(choice.finish_reason);
	const delta = choice.delta || choice.message || {};

	const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
	if (typeof reasoning === "string" && reasoning) {
		const i = open("thinking");
		partial.content[i].thinking += reasoning;
		emit({ type: "thinking_delta", contentIndex: i, delta: reasoning, partial });
	}
	if (typeof delta.content === "string" && delta.content) {
		const i = open("text");
		partial.content[i].text += delta.content;
		emit({ type: "text_delta", contentIndex: i, delta: delta.content, partial });
	}
	for (const call of delta.tool_calls || []) handleToolCall(call, { partial, emit, state });
}

/**
 * Tool calls arrive as fragments keyed by `index`: the first carries id+name,
 * later ones only append `arguments`. One content part per index, start emitted
 * on first sight, arguments parsed once they are complete JSON.
 */
function handleToolCall(call, { partial, emit, state }) {
	const index = call.index ?? 0;
	let part = state.tools.get(index);
	if (!part) {
		part = { type: "toolCall", id: call.id || `call_${index}`, name: call.function?.name || "", arguments: {}, raw: "" };
		state.tools.set(index, part);
		partial.content.push(part);
		emit({ type: "toolcall_start", contentIndex: partial.content.length - 1, partial });
	}
	if (call.id) part.id = call.id;
	if (call.function?.name) part.name = call.function.name;
	const args = call.function?.arguments;
	if (typeof args === "string" && args) {
		emit({ type: "toolcall_delta", contentIndex: partial.content.indexOf(part), delta: args, partial });
		// Arguments arrive as JSON *fragments*, so only the final accumulated
		// string is parseable. Parsing each fragment separately would always fail.
		part.raw += args;
		try { part.arguments = JSON.parse(part.raw); } catch { /* still streaming */ }
	}
}

function mapFinish(r) {
	if (r === "length" || r === "max_tokens") return "length";
	if (r === "tool_calls" || r === "tool_use" || r === "function_call") return "toolUse";
	return "stop";
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** HTTP status plus a key-free excerpt of the upstream error body. */
export class DirectHttpError extends Error {
	constructor(status, detail) {
		super(`direct provider HTTP ${status}${detail ? `: ${oneLine(redactText(detail))}` : ""}`);
		this.name = "DirectHttpError";
		this.status = status;
	}
}

function oneLine(s) {
	return String(s).replace(/\s+/g, " ").trim().slice(0, 300);
}
