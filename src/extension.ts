import * as vscode from "vscode";

import { AgentManager, type AgentConfig, GenerationError, type ModelInfo } from "./agent.js";
import { resolveBudget } from "./budget.js";
import { gatherCommitContext, NoChangesError } from "./git.js";
import type { GitExtension, Repository } from "./git-extension.js";
import { PiNotFoundError } from "./locate.js";
import { buildUserMessage } from "./prompt.js";

const SECTION = "pi-ide-commiter";

let output: vscode.OutputChannel;
let agents: AgentManager;

function log(line: string): void {
	output.appendLine(`${new Date().toISOString()} ${line}`);
}

function readConfig(scope?: vscode.Uri): AgentConfig {
	const cfg = vscode.workspace.getConfiguration(SECTION, scope);
	return {
		piPath: cfg.get<string>("piPath", ""),
		provider: cfg.get<string>("provider", ""),
		model: cfg.get<string>("model", ""),
		thinking: cfg.get<string>("thinking", "off"),
		extraArgs: cfg.get<string[]>("extraArgs", []),
		timeoutMs: cfg.get<number>("timeoutMs", 90_000),
		idleShutdownMs: cfg.get<number>("idleShutdownMs", 1_800_000),
		style: cfg.get<"conventional" | "plain">("style", "conventional"),
		includeBody: cfg.get<boolean>("includeBody", false),
		maxSubjectLength: cfg.get<number>("maxSubjectLength", 72),
		language: cfg.get<string>("language", "english"),
		customInstructions: cfg.get<string>("customInstructions", ""),
		systemPromptOverride: cfg.get<string>("systemPrompt", ""),
	};
}

type GitAPIOrUndefined = ReturnType<GitExtension["getAPI"]> | undefined;

async function getGitApi(): Promise<GitAPIOrUndefined> {
	const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
	if (!ext) return undefined;
	const api = ext.isActive ? ext.exports : await ext.activate();
	return api.enabled ? api.getAPI(1) : undefined;
}

/**
 * Figures out which repository to act on. The Source Control button passes the
 * matching `SourceControl`; outside it, fall back to the active editor and then
 * to a quick pick.
 */
async function resolveRepository(arg: unknown): Promise<Repository | undefined> {
	const api = await getGitApi();
	if (!api) {
		vscode.window.showErrorMessage("pi IDE Commiter: the VS Code Git extension is not active.");
		return undefined;
	}

	const rootUri = (arg as { rootUri?: vscode.Uri } | undefined)?.rootUri;
	if (rootUri) {
		const repo = api.getRepository(rootUri);
		if (repo) return repo;
	}

	const repos = api.repositories;
	if (repos.length === 0) {
		vscode.window.showErrorMessage("pi IDE Commiter: no git repository is open.");
		return undefined;
	}
	if (repos.length === 1) return repos[0];

	const active = vscode.window.activeTextEditor?.document.uri;
	if (active) {
		const repo = api.getRepository(active);
		if (repo) return repo;
	}

	const picked = await vscode.window.showQuickPick(
		repos.map((repo) => ({
			label: vscode.workspace.asRelativePath(repo.rootUri, false) || repo.rootUri.fsPath,
			repo,
		})),
		{ placeHolder: "Which repository?" },
	);
	return picked?.repo;
}

/** Environment errors deserve a shortcut to the setting, not just text. */
async function reportError(err: unknown): Promise<void> {
	const detail = err instanceof Error ? err.message : String(err);
	log(`[error] ${detail}`);

	const actions = err instanceof PiNotFoundError ? ["Set pi path", "Open log"] : ["Open log"];
	const action = await vscode.window.showErrorMessage(`pi IDE Commiter: ${detail}`, ...actions);

	if (action === "Open log") output.show(true);
	if (action === "Set pi path") {
		await vscode.commands.executeCommand("workbench.action.openSettings", `${SECTION}.piPath`);
	}
}

async function generateCommand(arg: unknown): Promise<void> {
	const repo = await resolveRepository(arg);
	if (!repo) return;

	const cwd = repo.rootUri.fsPath;
	const settings = vscode.workspace.getConfiguration(SECTION, repo.rootUri);

	const existing = repo.inputBox.value.trim();
	if (existing && !settings.get<boolean>("replaceExistingMessage", false)) {
		const choice = await vscode.window.showWarningMessage(
			"There is already a message in the commit box. Replace it?",
			{ modal: true },
			"Replace",
		);
		if (choice !== "Replace") return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.SourceControl,
			title: "pi: generating commit message…",
			cancellable: true,
		},
		async (_progress, token) => {
			try {
				// Start pi before gathering the diff: the budget depends on the
				// context window of the model it actually picked.
				const { model } = await agents.ready(cwd);
				const budget = resolveBudget(
					{
						maxFiles: settings.get<number>("maxFiles", 0),
						maxFileDiffBytes: settings.get<number>("maxFileDiffBytes", 0),
						maxTotalDiffBytes: settings.get<number>("maxTotalDiffBytes", 0),
					},
					model?.contextWindow,
				);

				const context = await gatherCommitContext(cwd, {
					...budget,
					recentCommitCount: settings.get<number>("recentCommitCount", 10),
				});

				const cfg = readConfig(repo.rootUri);
				const promptNote = cfg.systemPromptOverride.trim()
					? ", custom system prompt"
					: cfg.customInstructions.trim()
						? ", custom instructions"
						: "";

				const userMessage = buildUserMessage(context);
				log(
					`[gen] ${cwd} — ${context.files.length} file(s), ${context.staged ? "staged" : "working tree"}, ${budget.auto ? "auto" : "manual"} budget ${budget.maxTotalDiffBytes}, prompt ${userMessage.length} chars${promptNote}`,
				);

				const message = await agents.generate(cwd, userMessage, () => token.isCancellationRequested);

				repo.inputBox.value = message;
				log(`[gen] ok: ${message.split("\n")[0]}`);
			} catch (err) {
				if (err instanceof NoChangesError) {
					vscode.window.showInformationMessage(`pi IDE Commiter: ${err.message}`);
					return;
				}
				if (err instanceof GenerationError && err.message === "cancelled") {
					log("[gen] cancelled by the user");
					return;
				}
				await reportError(err);
			}
		},
	);
}

interface ModelPick extends vscode.QuickPickItem {
	model?: ModelInfo;
	clear?: boolean;
}

function describeModel(model: ModelInfo): string {
	const bits: string[] = [];
	if (model.contextWindow) {
		bits.push(`${Math.round(model.contextWindow / 1000)}K context`);
	}
	const input = model.cost?.input;
	const outputCost = model.cost?.output;
	if (input === 0 && outputCost === 0) bits.push("free");
	else if (input !== undefined && outputCost !== undefined) {
		bits.push(`$${input}/$${outputCost} per Mtok`);
	}
	if (model.reasoning) bits.push("thinking");
	return bits.join(" · ");
}

async function selectModelCommand(arg: unknown): Promise<void> {
	const repo = await resolveRepository(arg);
	if (!repo) return;
	const cwd = repo.rootUri.fsPath;

	let models: ModelInfo[];
	try {
		models = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: "pi: loading models…" },
			() => agents.listModels(cwd),
		);
	} catch (err) {
		await reportError(err);
		return;
	}

	if (models.length === 0) {
		vscode.window.showWarningMessage("pi IDE Commiter: pi returned no configured models.");
		return;
	}

	const current = readConfig(repo.rootUri);
	const items: ModelPick[] = [
		{
			label: "$(sparkle) Automatic",
			description: "use pi's default model",
			detail: "Recommended — respects whatever you already configured in pi itself",
			clear: true,
		},
	];

	const byProvider = new Map<string, ModelInfo[]>();
	for (const model of models) {
		const list = byProvider.get(model.provider) ?? [];
		list.push(model);
		byProvider.set(model.provider, list);
	}

	for (const provider of [...byProvider.keys()].sort()) {
		items.push({ label: provider, kind: vscode.QuickPickItemKind.Separator });
		const list = byProvider.get(provider) ?? [];
		list.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
		for (const model of list) {
			const active = current.provider === model.provider && current.model === model.id;
			items.push({
				label: model.name ?? model.id,
				description: describeModel(model),
				detail: model.id,
				picked: active,
				model,
			});
		}
	}

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: `Model used to write commits (${models.length} available)`,
		matchOnDescription: true,
		matchOnDetail: true,
	});
	if (!picked) return;

	const target = vscode.ConfigurationTarget.Global;
	const settings = vscode.workspace.getConfiguration(SECTION);

	if (picked.clear) {
		await settings.update("provider", undefined, target);
		await settings.update("model", undefined, target);
		vscode.window.showInformationMessage("pi IDE Commiter: back to pi's default model.");
		return;
	}

	const model = picked.model;
	if (!model) return;
	await settings.update("provider", model.provider, target);
	await settings.update("model", model.id, target);
	vscode.window.showInformationMessage(
		`pi IDE Commiter: using ${model.provider}/${model.id}${
			model.contextWindow
				? ` — diff budget scaled to the ${Math.round(model.contextWindow / 1000)}K window`
				: ""
		}.`,
	);
}

/**
 * The setting is multiline, so the Settings UI is a better editor than an input
 * box. This just takes the user straight to it.
 */
async function editInstructionsCommand(): Promise<void> {
	await vscode.commands.executeCommand(
		"workbench.action.openSettings",
		`${SECTION}.customInstructions`,
	);
}

export function activate(context: vscode.ExtensionContext): void {
	output = vscode.window.createOutputChannel("pi IDE Commiter");
	agents = new AgentManager((cwd) => readConfig(vscode.Uri.file(cwd)), log);

	context.subscriptions.push(
		output,
		{ dispose: () => agents.dispose() },
		vscode.commands.registerCommand(`${SECTION}.generate`, generateCommand),
		vscode.commands.registerCommand(`${SECTION}.selectModel`, selectModelCommand),
		vscode.commands.registerCommand(`${SECTION}.editInstructions`, editInstructionsCommand),
		vscode.commands.registerCommand(`${SECTION}.showLog`, () => output.show(true)),
		vscode.commands.registerCommand(`${SECTION}.restart`, () => {
			agents.restartAll();
			vscode.window.showInformationMessage("pi IDE Commiter: agent restarted.");
		}),
		// Changing provider/model/style invalidates the already warm process.
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(SECTION)) {
				log("[config] settings changed — restarting agents");
				agents.restartAll();
			}
		}),
	);

	if (vscode.workspace.getConfiguration(SECTION).get<boolean>("warmOnStartup", true)) {
		void warmAll();
	}
}

/** Warming is an optimisation; with many repositories open it would cost more than it saves. */
const MAX_WARM_REPOS = 4;

async function warmAll(): Promise<void> {
	const api = await getGitApi();
	if (!api) return;
	if (api.repositories.length > MAX_WARM_REPOS) {
		log(`[warm] ${api.repositories.length} repositories open — skipping warm-up`);
		return;
	}
	for (const repo of api.repositories) {
		try {
			await agents.warm(repo.rootUri.fsPath);
		} catch (err) {
			// Warming is silent: the real error surfaces when the user clicks.
			log(`[warm] failed for ${repo.rootUri.fsPath}: ${String(err)}`);
		}
	}
}

export function deactivate(): void {
	agents?.dispose();
}
