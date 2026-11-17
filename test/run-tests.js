#!/usr/bin/env node
/** Integration tests: RPC, agent, discovery, budget and git context gathering. */
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PiRpcClient } = require("../out/rpc.js");
const { AgentManager } = require("../out/agent.js");
const { gatherCommitContext, parsePorcelain, NoChangesError } = require("../out/git.js");
const { sanitizeMessage, buildUserMessage, buildSystemPrompt } = require("../out/prompt.js");
const { resolveBudget } = require("../out/budget.js");
const { resolvePiPath, clearPiPathCache, PiNotFoundError } = require("../out/locate.js");

const STUB = path.join(__dirname, "stub-pi.js");
const quiet = () => {};
let passed = 0;
const failures = [];

async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`  ok  ${name}`);
	} catch (err) {
		failures.push({ name, err });
		console.log(`FAIL  ${name}\n      ${err.message}`);
	}
}

function baseConfig(overrides = {}) {
	return {
		piPath: STUB,
		provider: "",
		model: "",
		thinking: "off",
		extraArgs: [],
		timeoutMs: 8000,
		idleShutdownMs: 0,
		style: "conventional",
		includeBody: false,
		maxSubjectLength: 72,
		language: "english",
		customInstructions: "",
		systemPromptOverride: "",
		...overrides,
	};
}

function makeAgent(mode, overrides) {
	process.env.PI_STUB_MODE = mode;
	return new AgentManager(() => baseConfig(overrides), quiet);
}

const NO_BUDGET = { maxFiles: 0, maxFileDiffBytes: 0, maxTotalDiffBytes: 0 };
const FIXED_BUDGET = {
	maxFiles: 20,
	maxFileDiffBytes: 2000,
	maxTotalDiffBytes: 12000,
	recentCommitCount: 10,
};

function tmpRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ide-commiter-test-"));
	const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "Test");
	git("commit", "-q", "--allow-empty", "-m", "chore: initial commit");
	return { dir, git };
}

(async () => {
	console.log("\n--- JSONL framing ---");

	await test("splits records on \\n only and survives U+2028 inside a JSON string", async () => {
		// Node's readline would break here — pi's docs warn about exactly this.
		const client = new PiRpcClient({ piPath: STUB, cwd: process.cwd(), systemPrompt: "s", log: quiet });
		const received = [];
		client.onEvent((e) => received.push(e));
		process.env.PI_STUB_MODE = "success";
		await client.start();
		// U+2028/U+2029 are valid inside JSON strings and show up in real diffs.
		const payload = "line1\u2028line2\u2029line3\r\nwith CR and a lone \u2028";
		await client.send({ type: "prompt", message: payload });
		await new Promise((r) => setTimeout(r, 500));
		const userMsg = received.find((e) => e.type === "message_end" && e.message.role === "user");
		assert.ok(userMsg, "user event never arrived");
		assert.strictEqual(userMsg.message.content[0].text, payload, "payload corrupted in round-trip");
		client.dispose();
	});

	await test("correlates responses by id under concurrency", async () => {
		const client = new PiRpcClient({ piPath: STUB, cwd: process.cwd(), systemPrompt: "s", log: quiet });
		await client.start();
		const results = await Promise.all([
			client.send({ type: "get_state" }),
			client.send({ type: "new_session" }),
			client.send({ type: "set_auto_retry", enabled: false }),
		]);
		assert.deepStrictEqual(
			results.map((r) => r.command),
			["get_state", "new_session", "set_auto_retry"],
		);
		assert.ok(results.every((r) => r.success));
		client.dispose();
	});

	console.log("\n--- minimal context ---");

	await test("passes the minimal-context flags to pi", async () => {
		const argvOut = path.join(os.tmpdir(), `pi-argv-${Date.now()}.json`);
		process.env.PI_STUB_ARGV_OUT = argvOut;
		process.env.PI_STUB_MODE = "success";
		const client = new PiRpcClient({ piPath: STUB, cwd: process.cwd(), systemPrompt: "sys", log: quiet });
		await client.start();
		const argv = JSON.parse(fs.readFileSync(argvOut, "utf8"));
		for (const flag of [
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--no-session",
			"--no-prompt-templates",
		]) {
			assert.ok(argv.includes(flag), `missing ${flag}`);
		}
		assert.ok(argv.includes("--system-prompt") && argv.includes("sys"), "system prompt not passed");
		client.dispose();
		delete process.env.PI_STUB_ARGV_OUT;
		fs.unlinkSync(argvOut);
	});

	await test("new_session prevents context leaking between generations", async () => {
		const agents = makeAgent("leak_check");
		const first = await agents.generate(process.cwd(), "PREVIOUS_MARKER first diff", () => false);
		assert.strictEqual(first, "first commit");
		const second = await agents.generate(process.cwd(), "second diff", () => false);
		assert.strictEqual(second, "SAW_PREVIOUS=false", "the second generation saw the first");
		agents.dispose();
	});

	console.log("\n--- error paths ---");

	await test("a provider error becomes a readable message instead of hanging", async () => {
		const agents = makeAgent("provider_error");
		await assert.rejects(
			() => agents.generate(process.cwd(), "diff", () => false),
			(err) => {
				assert.match(err.message, /CreditsError|No payment method/);
				return true;
			},
		);
		agents.dispose();
	});

	await test("a silent agent hits the timeout instead of hanging forever", async () => {
		const agents = makeAgent("hang", { timeoutMs: 1200 });
		const started = Date.now();
		await assert.rejects(() => agents.generate(process.cwd(), "diff", () => false), /did not answer/);
		assert.ok(Date.now() - started < 5000, "the timeout took too long");
		agents.dispose();
	});

	await test("cancellation aborts the generation", async () => {
		const agents = makeAgent("hang", { timeoutMs: 20000 });
		let cancelled = false;
		setTimeout(() => {
			cancelled = true;
		}, 300);
		await assert.rejects(() => agents.generate(process.cwd(), "diff", () => cancelled), /cancelled/);
		agents.dispose();
	});

	await test("a missing pi executable gives an actionable error", async () => {
		const agents = makeAgent("success", { piPath: "/does/not/exist/pi" });
		await assert.rejects(
			() => agents.generate(process.cwd(), "diff", () => false),
			/pi-ide-commiter\.piPath/,
		);
		agents.dispose();
	});

	console.log("\n--- output cleanup ---");

	await test("strips markdown fences and preamble", async () => {
		const agents = makeAgent("fenced");
		const msg = await agents.generate(process.cwd(), "diff", () => false);
		assert.strictEqual(msg, "fix(api): handle empty payload");
		agents.dispose();
	});

	await test("sanitizeMessage covers the common variations", () => {
		assert.strictEqual(sanitizeMessage("```\nfeat: x\n```"), "feat: x");
		assert.strictEqual(sanitizeMessage('"feat: x"'), "feat: x");
		assert.strictEqual(sanitizeMessage("feat: x"), "feat: x");
		assert.strictEqual(sanitizeMessage("feat: x\n\nsome body"), "feat: x\n\nsome body");
	});

	console.log("\n--- git context ---");

	await test("prefers the staged set over the working tree", async () => {
		const { dir, git } = tmpRepo();
		fs.writeFileSync(path.join(dir, "staged.txt"), "staged content\n");
		fs.writeFileSync(path.join(dir, "unstaged.txt"), "must not appear\n");
		git("add", "staged.txt");
		const ctx = await gatherCommitContext(dir, FIXED_BUDGET);
		assert.strictEqual(ctx.staged, true);
		assert.deepStrictEqual(ctx.files, ["staged.txt"]);
		assert.ok(ctx.fileDiffs.some((d) => d.file === "staged.txt"));
		assert.ok(!ctx.fileDiffs.some((d) => d.file === "unstaged.txt"));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	await test("with nothing staged, includes untracked files as a real diff", async () => {
		const { dir } = tmpRepo();
		fs.writeFileSync(path.join(dir, "new.js"), "export const sum = (a, b) => a + b;\n");
		const ctx = await gatherCommitContext(dir, FIXED_BUDGET);
		assert.strictEqual(ctx.staged, false);
		const diff = ctx.fileDiffs.find((d) => d.file === "new.js");
		assert.ok(diff, "untracked file missing from the context");
		assert.ok(diff.diff.includes("sum"), "untracked file content missing");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	await test("lockfiles are listed by name, never by diff", async () => {
		const { dir, git } = tmpRepo();
		fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ x: "y".repeat(5000) }));
		fs.writeFileSync(path.join(dir, "src.js"), "const a = 1;\n");
		git("add", ".");
		const ctx = await gatherCommitContext(dir, FIXED_BUDGET);
		assert.ok(ctx.omitted.includes("package-lock.json"), "the lockfile should have been omitted");
		assert.ok(!ctx.fileDiffs.some((d) => d.file === "package-lock.json"), "lockfile diff leaked");
		assert.ok(ctx.fileDiffs.some((d) => d.file === "src.js"));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	await test("respects the total diff budget", async () => {
		const { dir, git } = tmpRepo();
		for (let i = 0; i < 10; i++) {
			fs.writeFileSync(path.join(dir, `f${i}.txt`), `line ${i}\n`.repeat(500));
		}
		git("add", ".");
		const ctx = await gatherCommitContext(dir, {
			maxFiles: 20,
			maxFileDiffBytes: 500,
			maxTotalDiffBytes: 1500,
			recentCommitCount: 10,
		});
		const total = ctx.fileDiffs.reduce((sum, d) => sum + d.diff.length, 0);
		assert.ok(total <= 1500 + 200, `budget exceeded: ${total}`);
		assert.strictEqual(ctx.truncated, true);
		assert.ok(ctx.statSummary.length > 0, "the stat summary should cover what was cut");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	await test("source ranks before tests/docs, generated files are listed by name, headers are stripped", async () => {
		const { dir, git } = tmpRepo();
		fs.mkdirSync(path.join(dir, "dist"));
		fs.writeFileSync(path.join(dir, "a.md"), "docs\n");
		fs.writeFileSync(path.join(dir, "a.test.js"), "t\n");
		fs.writeFileSync(path.join(dir, "dist", "x.js"), "gen\n");
		fs.writeFileSync(path.join(dir, "z.js"), "src\n");
		git("add", ".");
		const ctx = await gatherCommitContext(dir, FIXED_BUDGET);
		assert.deepStrictEqual(ctx.fileDiffs.map((d) => d.file), ["z.js", "a.test.js", "a.md"]);
		assert.ok(ctx.omitted.includes("dist/x.js"));
		assert.ok(!ctx.fileDiffs[0].diff.includes("index "), "header noise leaked");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	await test("a huge diff is cut at a hunk boundary and small ones stay whole", async () => {
		const { dir, git } = tmpRepo();
		const big = Array.from({ length: 400 }, (_, i) => `line ${i}`);
		fs.writeFileSync(path.join(dir, "big.txt"), big.join("\n") + "\n");
		fs.writeFileSync(path.join(dir, "small.txt"), "tiny\n");
		git("add", ".");
		git("commit", "-q", "-m", "base");
		for (const i of [5, 200, 380]) for (let k = 0; k < 10; k++) big[i + k] = `changed ${i + k}`;
		fs.writeFileSync(path.join(dir, "big.txt"), big.join("\n") + "\n");
		fs.writeFileSync(path.join(dir, "small.txt"), "tiny changed\n");
		git("add", ".");
		const ctx = await gatherCommitContext(dir, { maxFiles: 20, maxFileDiffBytes: 400, maxTotalDiffBytes: 1000, recentCommitCount: 0 });
		const small = ctx.fileDiffs.find((d) => d.file === "small.txt");
		const bigD = ctx.fileDiffs.find((d) => d.file === "big.txt");
		assert.ok(small && !small.diff.includes("truncated"), "small diff should stay whole");
		assert.ok(bigD.diff.includes("truncated") && bigD.diff.includes("@@"), "big diff should keep a whole hunk");
		fs.rmSync(dir, { recursive: true, force: true });
	});

	await test("files matching .gitignore are listed by name, even when tracked", async () => {
		const { dir, git } = tmpRepo();
		fs.writeFileSync(path.join(dir, "secret.cfg"), "x=1\n");
		fs.writeFileSync(path.join(dir, "src.js"), "const a = 1;\n");
		git("add", "-f", "secret.cfg", "src.js");
		fs.writeFileSync(path.join(dir, ".gitignore"), "*.cfg\n");
		git("add", ".gitignore");
		const ctx = await gatherCommitContext(dir, FIXED_BUDGET);
		assert.ok(ctx.omitted.includes("secret.cfg"));
		assert.ok(!ctx.fileDiffs.some((d) => d.file === "secret.cfg"));
		assert.ok(ctx.fileDiffs.some((d) => d.file === "src.js"));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	await test("a clean repository raises NoChangesError", async () => {
		const { dir } = tmpRepo();
		await assert.rejects(() => gatherCommitContext(dir, FIXED_BUDGET), NoChangesError);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	await test("parsePorcelain handles renames", () => {
		const { files, untracked } = parsePorcelain("R  new.txt\0old.txt\0?? other.txt\0 M mod.txt\0");
		assert.deepStrictEqual(files, ["new.txt", "other.txt", "mod.txt"]);
		assert.ok(untracked.has("other.txt"));
	});

	await test("the prompt carries recent commits and the stat summary", async () => {
		const { dir, git } = tmpRepo();
		git("commit", "-q", "--allow-empty", "-m", "feat(x): repo style");
		fs.writeFileSync(path.join(dir, "a.txt"), "hi\n");
		git("add", ".");
		const ctx = await gatherCommitContext(dir, FIXED_BUDGET);
		const msg = buildUserMessage(ctx);
		assert.ok(msg.includes("feat(x): repo style"), "recent commits missing");
		assert.ok(msg.includes("Change summary"), "stat summary missing");
		assert.ok(msg.includes("a.txt"));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	await test("the system prompt changes with the style setting", () => {
		const conv = buildSystemPrompt(baseConfig());
		const plain = buildSystemPrompt(baseConfig({ style: "plain" }));
		assert.ok(conv.includes("<type>(<scope>)"));
		assert.ok(!plain.includes("<type>(<scope>)"));
		assert.ok(buildSystemPrompt(baseConfig()).includes("single line"));
		assert.ok(buildSystemPrompt(baseConfig({ includeBody: true })).includes("WHY"));
	});

	console.log("\n--- custom prompt ---");

	await test("custom instructions are appended and declared as taking precedence", () => {
		const base = buildSystemPrompt(baseConfig());
		const custom = buildSystemPrompt(
			baseConfig({ customInstructions: "Always prefix with the JIRA ticket." }),
		);
		assert.ok(custom.startsWith(base), "the built-in rules should still be there, first");
		assert.ok(custom.includes("Always prefix with the JIRA ticket."), "instructions missing");
		assert.match(custom, /conflict with the rules above, follow these/i);
	});

	await test("blank custom instructions change nothing", () => {
		assert.strictEqual(
			buildSystemPrompt(baseConfig({ customInstructions: "   \n  " })),
			buildSystemPrompt(baseConfig()),
		);
	});

	await test("a system prompt override replaces the built-in rules", () => {
		const overridden = buildSystemPrompt(
			baseConfig({ systemPromptOverride: "Reply with a haiku about the diff." }),
		);
		assert.ok(overridden.includes("haiku"));
		assert.ok(!overridden.includes("<type>(<scope>)"), "built-in rules leaked into the override");
	});

	await test("an override still gets the custom instructions on top", () => {
		const both = buildSystemPrompt(
			baseConfig({ systemPromptOverride: "Base rules.", customInstructions: "In German." }),
		);
		assert.ok(both.includes("Base rules."));
		assert.ok(both.includes("In German."));
	});

	await test("changing the prompt respawns the agent instead of reusing a stale process", async () => {
		// The process is spawned with --system-prompt, so a changed prompt must
		// not keep serving from the warm process.
		let instructions = "";
		process.env.PI_STUB_MODE = "success";
		const agents = new AgentManager(
			() => baseConfig({ customInstructions: instructions }),
			quiet,
		);
		const first = await agents.ready(process.cwd());
		instructions = "Now write in Portuguese.";
		const second = await agents.ready(process.cwd());
		assert.notStrictEqual(first.client, second.client, "reused the process with a stale prompt");
		agents.dispose();
	});

	console.log("\n--- manifest ---");

	await test("every command is self-identifying in menus that hide the category", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
		for (const cmd of manifest.contributes.commands) {
			// The SCM "..." overflow shows only the title, never the category.
			assert.ok(
				cmd.title.startsWith("pi IDE Commiter:"),
				`${cmd.command} would show as a bare "${cmd.title}" in the overflow menu`,
			);
		}
	});

	await test("no when-clause hides commands from the palette", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
		const palette = manifest.contributes.menus.commandPalette ?? [];
		const gated = palette.filter((entry) => entry.when);
		assert.deepStrictEqual(
			gated,
			[],
			"a gated palette entry makes the extension look broken in a non-git folder",
		);
	});

	await test("menu entries and settings match the declared ids", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
		const declared = new Set(manifest.contributes.commands.map((c) => c.command));
		for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
			for (const entry of entries) {
				if (!entry.command) continue;
				assert.ok(declared.has(entry.command), `${menu} references undeclared ${entry.command}`);
			}
		}
		for (const key of manifest.contributes.configuration.flatMap((c) => Object.keys(c.properties))) {
			assert.ok(key.startsWith("pi-ide-commiter."), `setting ${key} has the wrong prefix`);
		}
	});

	console.log("\n--- pi discovery ---");

	await test("an explicit valid path is accepted", async () => {
		clearPiPathCache();
		const found = await resolvePiPath(STUB, quiet);
		assert.strictEqual(found, STUB);
	});

	await test("an explicit invalid path blames the setting, not the search", async () => {
		clearPiPathCache();
		await assert.rejects(
			() => resolvePiPath("/path/that/does/not/exist/pi", quiet),
			/pi-ide-commiter\.piPath/,
		);
	});

	await test("finds pi even when PATH lacks it (the GUI-launcher case)", async () => {
		const realPi = await (async () => {
			try {
				clearPiPathCache();
				return await resolvePiPath("", quiet);
			} catch {
				return undefined;
			}
		})();
		if (!realPi) {
			console.log("      (skipped: pi is not installed on this machine)");
			return;
		}

		const savedPath = process.env.PATH;
		try {
			// Reproduces a GUI app environment: minimal PATH, no ~/.bun/bin.
			process.env.PATH = "/usr/bin:/bin";
			clearPiPathCache();
			const found = await resolvePiPath("", quiet);
			assert.ok(found, "did not find pi with a reduced PATH");
			assert.ok(fs.existsSync(found), `invalid path: ${found}`);
		} finally {
			process.env.PATH = savedPath;
			clearPiPathCache();
		}
	});

	await test("with no pi anywhere, the error is an actionable PiNotFoundError", async () => {
		const savedPath = process.env.PATH;
		const savedShell = process.env.SHELL;
		try {
			process.env.PATH = "/does/not/exist";
			process.env.SHELL = "/does/not/exist/shell";
			clearPiPathCache();
			await assert.rejects(
				() => resolvePiPath("", quiet),
				(err) => {
					assert.ok(err instanceof PiNotFoundError, "wrong error type");
					assert.match(err.message, /pi-ide-commiter\.piPath/);
					return true;
				},
			);
		} finally {
			process.env.PATH = savedPath;
			process.env.SHELL = savedShell;
			clearPiPathCache();
		}
	});

	console.log("\n--- automatic budget ---");

	await test("the budget scales with the context window", () => {
		const small = resolveBudget(NO_BUDGET, 32768);
		const large = resolveBudget(NO_BUDGET, 262144);
		assert.ok(large.maxTotalDiffBytes > small.maxTotalDiffBytes, "it did not scale");
		assert.ok(large.maxFileDiffBytes > small.maxFileDiffBytes);
		assert.ok(small.maxTotalDiffBytes >= 16000, "floor not respected");
		assert.ok(resolveBudget(NO_BUDGET, 10_000_000).maxTotalDiffBytes <= 120000, "ceiling not respected");
		assert.strictEqual(large.auto, true);
	});

	await test("an explicit value beats the automatic one, field by field", () => {
		const b = resolveBudget({ maxFiles: 5, maxFileDiffBytes: 0, maxTotalDiffBytes: 9000 }, 262144);
		assert.strictEqual(b.maxFiles, 5);
		assert.strictEqual(b.maxTotalDiffBytes, 9000);
		assert.ok(b.maxFileDiffBytes > 0, "the automatic field should have been filled in");
		assert.strictEqual(b.auto, false);
	});

	await test("with no known model, falls back to a conservative window", () => {
		const b = resolveBudget(NO_BUDGET, undefined);
		assert.ok(b.maxTotalDiffBytes >= 16000);
		assert.strictEqual(b.contextWindow, undefined);
	});

	await test("the automatic budget is far larger than the old fixed 12000", () => {
		const b = resolveBudget(NO_BUDGET, 200000);
		assert.ok(b.maxTotalDiffBytes > 12000 * 5, `expected real headroom, got ${b.maxTotalDiffBytes}`);
	});

	console.log("\n--- model catalog ---");

	await test("lists pi's models for the picker", async () => {
		const agents = makeAgent("success");
		const models = await agents.listModels(process.cwd());
		assert.strictEqual(models.length, 3);
		assert.deepStrictEqual([...new Set(models.map((m) => m.provider))].sort(), ["acme", "zeta"]);
		assert.ok(models.every((m) => m.id && m.provider), "a model without id/provider passed the filter");
		agents.dispose();
	});

	await test("the active model comes from get_state and feeds the budget", async () => {
		const agents = makeAgent("success");
		const { model } = await agents.ready(process.cwd());
		assert.strictEqual(model.id, "big-model");
		assert.strictEqual(model.contextWindow, 200000);
		const b = resolveBudget(NO_BUDGET, model.contextWindow);
		assert.strictEqual(b.contextWindow, 200000);
		agents.dispose();
	});

	console.log(`\n${passed} passed, ${failures.length} failed\n`);
	process.exit(failures.length ? 1 : 0);
})();
