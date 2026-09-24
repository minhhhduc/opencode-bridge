// `opencode doctor`: deterministic detection + capability report. Non-secret only.

import { OpenCodeClient } from "./opencode.js";
import { openEventStream } from "./sse.js";

export async function doctor(cfg = {}, signal) {
	const client = new OpenCodeClient(cfg);
	const report = {
		detected: false,
		version: null,
		integrationMode: "opencode api (JSON) + session API",
		serverReachable: false,
		serverUrl: null,
		providers: [],
		models: 0,
		streaming: "unknown (not probed yet)",
		toolCalling: "unsupported (OpenCode drives its own agent tools; caller schemas refused)",
		reasoning: "content exposed; per-request effort unsupported (effort is a session-create model variant, not a prompt field)",
		errors: [],
	};

	report.detected = await client.detect(signal).catch((e) => { report.errors.push(`detect: ${e.message}`); return false; });
	if (!report.detected) return report;

	report.version = await client.version(signal).catch((e) => { report.errors.push(`version: ${e.message}`); return null; });
	report.serverUrl = await client.serverUrl(signal).catch(() => null);
	report.serverReachable = Boolean(report.serverUrl);

	try {
		const res = await client.api("provider.list", { signal });
		report.providers = (res?.data || []).map((p) => p.id || p.name).filter(Boolean);
	} catch (e) {
		report.errors.push(`provider.list: ${e.message}`);
	}
	try {
		const models = await client.discoverModels(signal);
		report.models = models.length;
	} catch (e) {
		report.errors.push(`models: ${e.message}`);
	}
	// Actual capability detection: can we open the SSE event stream right now?
	report.streaming = (await probeStreaming(client, signal))
		? "SSE (incremental text + reasoning deltas)"
		: "buffered fallback (session.wait + message.list)";
	return report;
}

/**
 * Open the event stream and close it as soon as the response headers land.
 * That is exactly the condition the streaming transport needs, so a "yes" here
 * is not a guess — no request is generated, nothing is mutated.
 */
export function probeStreaming(client, signal) {
	return new Promise((resolve) => {
		let stream;
		const done = (v) => { stream?.close(); resolve(v); };
		const guard = setTimeout(() => done(false), 5000);
		stream = openEventStream(client, { signal, onError: () => done(false) });
		stream.ready.then(() => { clearTimeout(guard); done(true); }, () => { clearTimeout(guard); done(false); });
	});
}

/** Human-readable render for the CLI. */
export function formatDoctor(r) {
	const yn = (b) => (b ? "yes" : "no");
	return [
		`OpenCode detected:   ${yn(r.detected)}`,
		`Version:             ${r.version || "-"}`,
		`Integration mode:    ${r.integrationMode}`,
		`Server reachable:    ${yn(r.serverReachable)}${r.serverUrl ? ` (${r.serverUrl})` : ""}`,
		`Providers discovered:${r.providers.length ? " " + r.providers.join(", ") : " (none)"}`,
		`Models discovered:   ${r.models}`,
		`Streaming transport:  ${r.streaming}`,
		`Tool calling:        ${r.toolCalling}`,
		`Reasoning/effort:    ${r.reasoning}`,
		...(r.errors.length ? ["", "Warnings:", ...r.errors.map((e) => `  - ${e}`)] : []),
	].join("\n");
}
