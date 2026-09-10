#!/usr/bin/env node
/**
 * Validates against the real `pi` binary that every minimal-context flag exists
 * and that the handshake completes. Spends no LLM credit: no prompt is sent.
 * Skipped when pi is not installed.
 */
const assert = require("node:assert");
const { PiRpcClient } = require("../out/rpc.js");
const { buildSystemPrompt } = require("../out/prompt.js");
const { resolveBudget } = require("../out/budget.js");
const { resolvePiPath } = require("../out/locate.js");

const lines = [];

(async () => {
	let piPath;
	try {
		piPath = await resolvePiPath(process.env.PI_PATH || "", (l) => lines.push(l));
	} catch {
		console.log("SKIP: pi is not installed");
		process.exit(0);
	}
	console.log(`ok  discovery resolved pi at ${piPath}`);

	const client = new PiRpcClient({
		piPath,
		cwd: process.cwd(),
		thinking: "off",
		systemPrompt: buildSystemPrompt({
			style: "conventional",
			includeBody: false,
			maxSubjectLength: 72,
			language: "english",
			customInstructions: "",
			systemPromptOverride: "",
		}),
		log: (l) => lines.push(l),
	});

	await client.start();

	const state = await client.send({ type: "get_state" });
	assert.ok(state.success, "get_state failed");
	assert.strictEqual(state.data.messageCount, 0, "the session should start empty");

	const reset = await client.send({ type: "new_session" });
	assert.ok(reset.success, `new_session failed: ${reset.error}`);

	const after = await client.send({ type: "get_state" });
	assert.strictEqual(after.data.messageCount, 0, "new_session did not clear the session");

	console.log("ok  handshake with the real pi, all flags accepted");
	console.log(`    model: ${after.data.model.provider}/${after.data.model.id}`);
	console.log(`    thinking: ${after.data.thinkingLevel}`);
	const stderrLines = lines.filter((l) => l.includes("stderr"));
	assert.strictEqual(stderrLines.length, 0, `pi complained on stderr:\n${stderrLines.join("\n")}`);
	console.log("ok  no flag rejected (clean stderr)");

	// The catalog that feeds the model picker.
	const catalog = await client.send({ type: "get_available_models" }, 30000);
	assert.ok(catalog.success, `get_available_models failed: ${catalog.error}`);
	const models = catalog.data.models.filter((m) => m && m.id && m.provider);
	assert.ok(models.length > 0, "empty catalog");
	const providers = [...new Set(models.map((m) => m.provider))].sort();
	console.log(`ok  catalog with ${models.length} models across ${providers.length} provider(s): ${providers.join(", ")}`);
	assert.ok(models.some((m) => m.contextWindow > 0), "no model reported a contextWindow");

	// Budget derived from the model pi actually picked.
	const active = after.data.model;
	const budget = resolveBudget(
		{ maxFiles: 0, maxFileDiffBytes: 0, maxTotalDiffBytes: 0 },
		active.contextWindow,
	);
	console.log(
		`ok  automatic budget: ${budget.maxTotalDiffBytes} chars total, ${budget.maxFileDiffBytes} per file, ${budget.maxFiles} files`,
	);
	assert.ok(budget.maxTotalDiffBytes >= 16000);

	client.dispose();
	process.exit(0);
})().catch((err) => {
	console.error("FAIL:", err.message);
	console.error(lines.join("\n"));
	process.exit(1);
});
