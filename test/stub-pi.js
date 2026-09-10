#!/usr/bin/env node
/**
 * Fake pi for tests: speaks the real RPC protocol (payload shapes captured from
 * an actual `pi --mode rpc`). Scenario selected via PI_STUB_MODE.
 */
const fs = require("node:fs");

// resolvePiPath confirms every candidate with `--version` before accepting it.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
	process.stdout.write("0.85.1-stub\n");
	process.exit(0);
}

const mode = process.env.PI_STUB_MODE || "success";
if (process.env.PI_STUB_ARGV_OUT) {
	fs.writeFileSync(process.env.PI_STUB_ARGV_OUT, JSON.stringify(process.argv.slice(2)));
}

function emit(obj) {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let i = buffer.indexOf("\n");
	while (i !== -1) {
		const line = buffer.slice(0, i);
		buffer = buffer.slice(i + 1);
		if (line.trim()) handle(JSON.parse(line));
		i = buffer.indexOf("\n");
	}
});

let promptCount = 0;

function handle(cmd) {
	if (cmd.type === "get_state") {
		emit({
			id: cmd.id,
			type: "response",
			command: "get_state",
			success: true,
			data: {
				messageCount: 0,
				model: { id: "big-model", name: "Big Model", provider: "acme", contextWindow: 200000 },
			},
		});
		return;
	}
	if (cmd.type === "get_available_models") {
		emit({
			id: cmd.id,
			type: "response",
			command: "get_available_models",
			success: true,
			data: {
				models: [
					{ id: "big-model", name: "Big Model", provider: "acme", contextWindow: 200000, reasoning: true, cost: { input: 3, output: 15 } },
					{ id: "free-model", name: "Free Model", provider: "acme", contextWindow: 32768, cost: { input: 0, output: 0 } },
					{ id: "other", name: "Other", provider: "zeta", contextWindow: 128000 },
				],
			},
		});
		return;
	}
	if (cmd.type === "set_auto_retry" || cmd.type === "new_session" || cmd.type === "abort") {
		emit({ id: cmd.id, type: "response", command: cmd.type, success: true });
		return;
	}
	if (cmd.type !== "prompt") {
		emit({ id: cmd.id, type: "response", command: cmd.type, success: true });
		return;
	}

	promptCount++;
	emit({ id: cmd.id, type: "response", command: "prompt", success: true });

	if (mode === "hang") return; // never answers: exercises the timeout

	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: cmd.message }] } });
	emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: cmd.message }] } });

	if (mode === "provider_error") {
		// Real shape observed on a provider 401.
		const msg = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: '401 {"type":"error","error":{"type":"CreditsError","message":"No payment method."}}',
		};
		emit({ type: "message_start", message: msg });
		emit({ type: "message_end", message: msg });
		emit({ type: "agent_end", messages: [], willRetry: false });
		emit({ type: "agent_settled" });
		return;
	}

	let text = "feat(auth): add token refresh";
	if (mode === "fenced") text = "Here's the commit message:\n```\nfix(api): handle empty payload\n```";
	if (mode === "echo_prompt") text = `PROMPT_LEN=${cmd.message.length}`;
	if (mode === "leak_check") {
		text = promptCount === 1 ? "first commit" : `SAW_PREVIOUS=${cmd.message.includes("PREVIOUS_MARKER")}`;
	}

	const assistant = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		model: "stub",
	};
	emit({ type: "message_start", message: { role: "assistant", content: [] } });
	emit({ type: "message_end", message: assistant });
	emit({ type: "turn_end", message: assistant, toolResults: [] });
	emit({ type: "agent_end", messages: [assistant], willRetry: false });
	emit({ type: "agent_settled" });
}
