// Dedicated SSE transport for OpenCode's `GET /api/event` (operationId
// `event.subscribe`, verified against oc_openapi.json and a live server).
//
// Why not `opencode api event.subscribe`: that path spawns a CLI child and waits
// for it to exit, but this stream is unbounded — the CLI blocks forever, so the
// child never returns, never gets cleaned up, and buffers unbounded stdout. A
// plain fetch with a cancellable reader is the correct transport.
//
// Wire format (captured from a live server):
//
//   data: {"id":"evt_…","type":"server.connected","data":{}}
//   : heartbeat
//
// Frames are separated by a blank line; `:`-prefixed lines are comments. The
// OpenAPI declares a frame as {id, event, data} but the server actually sends
// the encoded event object — with its own `type` — as the `data:` payload.

/** One-shot parser: raw SSE text → the event objects the bridge consumes. */
export function parseSSEChunk(text) {
	const out = [];
	for (const frame of String(text).split(/\r?\n\r?\n/)) {
		const payload = [];
		for (const line of frame.split(/\r?\n/)) {
			if (line.startsWith("data:")) payload.push(line.slice(5).trim());
		}
		// Comment-only frame (`: heartbeat`) or blank → nothing to emit.
		if (!payload.length) continue;
		for (const raw of payload) {
			if (!raw) continue;
			// A malformed frame must never kill the pump; the stream is still usable.
			try { out.push(JSON.parse(raw)); } catch { /* skip */ }
		}
	}
	return out;
}

/**
 * Open the event stream and push every decoded event to `onEvent`.
 * Returns `{ready, close}`. `ready` resolves once response headers are in — i.e.
 * the socket is live and draining — so a caller can subscribe before triggering
 * generation. `close()` is idempotent and aborts the request.
 *
 * Deliberately no reconnect: a dropped SSE connection loses the deltas it was
 * carrying, and replaying a partial token stream would corrupt the answer. The
 * caller falls back to the buffered path instead.
 */
export function openEventStream(client, { signal, onEvent, onError } = {}) {
	const state = { closed: false, controller: null };
	let ready;
	const readyPromise = new Promise((r) => (ready = r));

	const close = () => {
		if (state.closed) return;
		state.closed = true;
		try { state.controller?.abort(); } catch {}
	};

	(async () => {
		try {
			const url = await client.serverUrl(signal);
			if (!url) throw new SSEUnavailable("no OpenCode server URL");
			const password = await client.servicePassword(signal);
			const res = await fetch(`${url.replace(/\/+$/, "")}/api/event`, {
				headers: {
					accept: "text/event-stream",
					...(password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}),
				},
				signal: mergedSignal(state, signal),
			});
			if (!res.ok) throw new SSEUnavailable(`OpenCode /api/event returned ${res.status}`);
			if (!res.body) throw new SSEUnavailable("OpenCode /api/event returned no body");
			ready();
			await pump(res.body, onEvent, () => state.closed);
			// A clean end-of-stream before completion is a failure, not a success.
			if (!state.closed) onError?.(new SSEUnavailable("OpenCode event stream ended unexpectedly"));
		} catch (e) {
			ready(); // never leave a caller waiting on `ready`
			if (!state.closed) {
				state.closed = true;
				onError?.(e);
			}
		}
	})();

	return { ready: readyPromise, close };
}

/** Merge the caller's signal with our own abort handle. */
function mergedSignal(state, outer) {
	const c = new AbortController();
	state.controller = c;
	if (outer) {
		if (outer.aborted) c.abort();
		else outer.addEventListener("abort", () => c.abort(), { once: true });
	}
	return c.signal;
}

async function pump(body, onEvent, isClosed) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		if (isClosed()) return;
		buf += decoder.decode(value, { stream: true });
		// Consume only up to the last complete frame; the tail is a partial frame.
		const cut = buf.lastIndexOf("\n\n");
		if (cut < 0) continue;
		const ready = buf.slice(0, cut + 2);
		buf = buf.slice(cut + 2);
		for (const ev of parseSSEChunk(ready)) onEvent?.(ev);
	}
}

/**
 * The server is reachable but will not stream (older build, auth mismatch, or a
 * version without `event.subscribe`). Distinguishable from a mid-flight error so
 * the bridge can fall back to the buffered path instead of failing the request.
 */
export class SSEUnavailable extends Error {
	constructor(msg) {
		super(msg);
		this.name = "SSEUnavailable";
	}
}
