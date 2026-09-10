/**
 * Manages the background pi processes (one per repository) and runs the
 * message generation flow.
 */

import { PiRpcClient, type RpcEvent } from "./rpc.js";
import type { PromptConfig } from "./prompt.js";
import { buildSystemPrompt, sanitizeMessage } from "./prompt.js";
import { clearPiPathCache, resolvePiPath } from "./locate.js";

export interface ModelInfo {
	id: string;
	name?: string;
	provider: string;
	contextWindow?: number;
	reasoning?: boolean;
	cost?: { input?: number; output?: number };
}

export interface AgentConfig extends PromptConfig {
	piPath: string;
	provider: string;
	model: string;
	thinking: string;
	extraArgs: string[];
	timeoutMs: number;
	idleShutdownMs: number;
}

interface Entry {
	client: PiRpcClient;
	idleTimer: NodeJS.Timeout | undefined;
	/** Signature of the config used to spawn the process; a change means respawn. */
	signature: string;
	/** The model pi actually picked — the basis for the automatic budget. */
	model: ModelInfo | undefined;
}

function signatureOf(cfg: AgentConfig, resolvedPiPath: string): string {
	return JSON.stringify([
		resolvedPiPath,
		cfg.provider,
		cfg.model,
		cfg.thinking,
		cfg.extraArgs,
		buildSystemPrompt(cfg),
	]);
}

export class GenerationError extends Error {}

export class AgentManager {
	private readonly entries = new Map<string, Entry>();

	constructor(
		private readonly getConfig: (cwd: string) => AgentConfig,
		private readonly log: (line: string) => void,
	) {}

	/** Spawns the process without generating anything, so the first commit skips the cold start. */
	async warm(cwd: string): Promise<void> {
		await this.ready(cwd);
		this.scheduleIdleShutdown(cwd);
	}

	/** Ensures the process is up and returns the active model. */
	async ready(cwd: string): Promise<{ client: PiRpcClient; model: ModelInfo | undefined }> {
		const entry = await this.ensureEntry(cwd);
		await entry.client.start();

		if (!entry.model) {
			const state = await entry.client.send({ type: "get_state" }, 15_000);
			if (state.success) {
				const model = (state.data as { model?: ModelInfo } | undefined)?.model;
				if (model) {
					entry.model = model;
					this.log(
						`[agent] active model: ${model.provider}/${model.id} (context ${model.contextWindow ?? "?"})`,
					);
				}
			}
		}

		return { client: entry.client, model: entry.model };
	}

	/** The catalog of models configured in pi, for the picker. */
	async listModels(cwd: string): Promise<ModelInfo[]> {
		const { client } = await this.ready(cwd);
		const res = await client.send({ type: "get_available_models" }, 30_000);
		if (!res.success) {
			throw new GenerationError(res.error ?? "could not list models");
		}
		return ((res.data as { models?: ModelInfo[] } | undefined)?.models ?? []).filter(
			(m) => m && m.id && m.provider,
		);
	}

	private async ensureEntry(cwd: string): Promise<Entry> {
		const cfg = this.getConfig(cwd);
		const piPath = await resolvePiPath(cfg.piPath, this.log);
		const signature = signatureOf(cfg, piPath);
		const existing = this.entries.get(cwd);

		if (existing) {
			if (existing.signature === signature && existing.client.running) return existing;
			// Config changed (or the process died): drop it and start over.
			this.log(`[agent] respawning process for ${cwd}`);
			this.disposeEntry(cwd);
		}

		const entry: Entry = {
			client: new PiRpcClient({
				piPath,
				cwd,
				provider: cfg.provider || undefined,
				model: cfg.model || undefined,
				thinking: cfg.thinking || undefined,
				systemPrompt: buildSystemPrompt(cfg),
				extraArgs: cfg.extraArgs,
				log: this.log,
			}),
			idleTimer: undefined,
			signature,
			model: undefined,
		};
		this.entries.set(cwd, entry);
		return entry;
	}

	private scheduleIdleShutdown(cwd: string): void {
		const entry = this.entries.get(cwd);
		if (!entry) return;
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;

		const { idleShutdownMs } = this.getConfig(cwd);
		if (idleShutdownMs <= 0) return;

		entry.idleTimer = setTimeout(() => {
			this.log(`[agent] shutting down idle process for ${cwd}`);
			this.disposeEntry(cwd);
		}, idleShutdownMs);
		entry.idleTimer.unref?.();
	}

	/**
	 * Generates the message. Every call starts with `new_session`, so no
	 * generation ever sees the previous diff — the context is always just this
	 * commit.
	 */
	async generate(cwd: string, userMessage: string, isCancelled: () => boolean): Promise<string> {
		const cfg = this.getConfig(cwd);
		const { client } = await this.ready(cwd);

		const entry = this.entries.get(cwd);
		if (entry?.idleTimer) {
			clearTimeout(entry.idleTimer);
			entry.idleTimer = undefined;
		}

		const reset = await client.send({ type: "new_session" }, 15_000);
		if (!reset.success) {
			// A dirty session would produce a message contaminated by the last commit.
			throw new GenerationError(`could not clear the session: ${reset.error ?? "error"}`);
		}

		try {
			return await this.runPrompt(client, userMessage, cfg.timeoutMs, isCancelled);
		} finally {
			this.scheduleIdleShutdown(cwd);
		}
	}

	private runPrompt(
		client: PiRpcClient,
		userMessage: string,
		timeoutMs: number,
		isCancelled: () => boolean,
	): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let assistantText = "";
			let settled = false;

			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				clearInterval(cancelPoll);
				unsubscribe();
				fn();
			};

			const timer = setTimeout(() => {
				client.send({ type: "abort" }, 5_000).catch(() => undefined);
				finish(() =>
					reject(
						new GenerationError(
							`pi did not answer within ${Math.round(timeoutMs / 1000)}s. Check the provider/model settings and the extension log.`,
						),
					),
				);
			}, timeoutMs);

			const cancelPoll = setInterval(() => {
				if (isCancelled()) {
					client.send({ type: "abort" }, 5_000).catch(() => undefined);
					finish(() => reject(new GenerationError("cancelled")));
				}
			}, 200);

			const unsubscribe = client.onEvent((event: RpcEvent) => {
				if (event.type === "message_end") {
					const message = event.message as
						| {
								role?: string;
								content?: Array<{ type: string; text?: string }>;
								stopReason?: string;
								errorMessage?: string;
						  }
						| undefined;
					if (message?.role !== "assistant") return;

					// Provider errors (401/403/rate limit) arrive here, not as a command
					// response: stopReason "error" plus errorMessage.
					if (message.stopReason === "error") {
						finish(() =>
							reject(new GenerationError(message.errorMessage ?? "the model returned an error")),
						);
						return;
					}

					const text = (message.content ?? [])
						.filter((block) => block.type === "text" && typeof block.text === "string")
						.map((block) => block.text as string)
						.join("");
					if (text.trim()) assistantText = text;
					return;
				}

				if (event.type === "agent_settled") {
					const cleaned = sanitizeMessage(assistantText);
					if (!cleaned) {
						finish(() => reject(new GenerationError("pi returned no text")));
					} else {
						finish(() => resolve(cleaned));
					}
				}
			});

			client
				.send({ type: "prompt", message: userMessage }, 20_000)
				.then((res) => {
					if (!res.success) {
						finish(() => reject(new GenerationError(res.error ?? "pi rejected the prompt")));
					}
				})
				.catch((err: unknown) => finish(() => reject(err)));
		});
	}

	private disposeEntry(cwd: string): void {
		const entry = this.entries.get(cwd);
		if (!entry) return;
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.client.dispose();
		this.entries.delete(cwd);
	}

	restartAll(): void {
		clearPiPathCache();
		for (const cwd of [...this.entries.keys()]) this.disposeEntry(cwd);
	}

	dispose(): void {
		this.restartAll();
	}
}
