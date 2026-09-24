// Opt-in local integration test: RUN_OPENCODE_INTEGRATION=1 OPENCODE_BIN=... npm test
// Uses the installed OpenCode binary and a loopback mock provider; no paid API.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { OpenCodeClientPool } from "../src/client-pool.js";
import { credentialProfiles } from "../src/credentials.js";

test("real OpenCode sends each concurrent request with its selected key", { skip: !process.env.RUN_OPENCODE_INTEGRATION || !process.env.OPENCODE_BIN, timeout: 30000 }, async () => {
	const requests = [];
	const upstream = http.createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		requests.push({ authorization: req.headers.authorization, body });
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ id: "chatcmpl_test", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	const previous = process.env.OPENCODE_CONFIG_CONTENT;
	const oldA = process.env.OMP_TEST_KEY_A;
	const oldB = process.env.OMP_TEST_KEY_B;
	const oldDefault = process.env.MOCK_API_KEY;
	process.env.OMP_TEST_KEY_A = "test-key-A";
	process.env.OMP_TEST_KEY_B = "test-key-B";
	process.env.MOCK_API_KEY = "wrong-default-key";
	process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ providers: { mock: {
		env: ["MOCK_API_KEY"],
		package: "@opencode/ai/providers/openai-compatible",
		settings: { baseURL: `http://127.0.0.1:${upstream.address().port}/v1` },
		models: { "mock-model": { name: "Mock", limit: { context: 8192, output: 1024 } } },
	} } });
	const profiles = credentialProfiles({ mock: { credentials: [
		{ id: "a", apiKeyEnv: "OMP_TEST_KEY_A" }, { id: "b", apiKeyEnv: "OMP_TEST_KEY_B" },
	] } });
	const pool = new OpenCodeClientPool({ opencodePath: process.env.OPENCODE_BIN }, profiles);
	const sessions = [];
	try {
		await Promise.all(["a", "b"].map(async (id) => {
			const client = await pool.get({ providerID: "mock", credentialId: id, credentialSource: id === "a" ? "OMP_TEST_KEY_A" : "OMP_TEST_KEY_B" });
			const created = await client.api("session.create", { data: { model: { providerID: "mock", id: "mock-model" } } });
			const sessionID = created?.data?.id;
			assert.ok(sessionID);
			sessions.push({ client, sessionID });
			await client.api("session.prompt", { params: { sessionID }, data: { text: `from-${id}` } });
		}));
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !(requests.some((r) => r.body.includes("from-a")) && requests.some((r) => r.body.includes("from-b")))) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(requests.some((r) => r.body.includes("from-a")));
		assert.ok(requests.some((r) => r.body.includes("from-b")));
		for (const r of requests) {
			if (r.body.includes("from-a")) assert.equal(r.authorization, "Bearer test-key-A");
			if (r.body.includes("from-b")) assert.equal(r.authorization, "Bearer test-key-B");
		}
	} finally {
		await Promise.all(sessions.map(({ client, sessionID }) => client.api("session.remove", { params: { sessionID } }).catch(() => {})));
		pool.close();
		upstream.close();
		if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT = previous;
		if (oldA === undefined) delete process.env.OMP_TEST_KEY_A; else process.env.OMP_TEST_KEY_A = oldA;
		if (oldB === undefined) delete process.env.OMP_TEST_KEY_B; else process.env.OMP_TEST_KEY_B = oldB;
		if (oldDefault === undefined) delete process.env.MOCK_API_KEY; else process.env.MOCK_API_KEY = oldDefault;
	}
});
