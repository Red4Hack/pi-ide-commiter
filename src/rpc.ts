/**
 * RPC client for pi (pi.dev).
 *
 * Keeps a `pi --mode rpc` process alive in the background and talks to it over
 * JSONL on stdin/stdout. The protocol requires strict framing: LF is the ONLY
 * record delimiter. That is why parsing is done by hand — Node's `readline`
 * also splits on U+2028/U+2029, which are valid inside JSON strings and do
 * show up in diffs.
 */

import { type ChildProcess, spawn } from "node:child_process";

export interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	error?: string;
	data?: Record<string, unknown>;
}

export interface RpcEvent {
	type: string;
	[key: string]: unknown;
}

export interface PiRpcOptions {
	piPath: string;
	cwd: string;
	provider?: string;
	model?: string;
	thinking?: string;
	systemPrompt: string;
	extraArgs?: string[];
	log: (line: string) => void;
}

type EventHandler = (event: RpcEvent) => void;

export class PiRpcClient {
	private proc: ChildProcess | undefined;
	private buffer = "";
	private seq = 0;
	private readonly pending = new Map<string, (res: RpcResponse) => void>();
	private readonly handlers = new Set<EventHandler>();
	private startPromise: Promise<void> | undefined;

	constructor(private readonly opts: PiRpcOptions) {}

	get running(): boolean {
		return this.proc !== undefined && this.proc.exitCode === null && !this.proc.killed;
	}

	/**
	 * Starts the process. Concurrent callers share the same start.
	 * Resolves only after a `get_state` answers — that is, when the agent is
	 * actually ready to take prompts.
	 */
	start(): Promise<void> {
		if (this.running) return Promise.resolve();
		if (this.startPromise) return this.startPromise;

		this.startPromise = this.spawnProcess().finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}

	private async spawnProcess(): Promise<void> {
		const args = ["--mode", "rpc", "--no-session"];

		// Minimal context — the core pi.dev idea. Every flag here removes tokens
		// that would enter the prompt without helping write a commit message:
		args.push("--no-tools"); // no tool definitions in context
		args.push("--no-extensions"); // no extensions (pi-lens and friends)
		args.push("--no-skills");
		args.push("--no-prompt-templates");
		args.push("--no-context-files"); // no AGENTS.md / CLAUDE.md
		args.push("--no-themes");
		args.push("--offline"); // no network calls at startup

		args.push("--system-prompt", this.opts.systemPrompt);

		if (this.opts.provider) args.push("--provider", this.opts.provider);
		if (this.opts.model) args.push("--model", this.opts.model);
		if (this.opts.thinking) args.push("--thinking", this.opts.thinking);
		if (this.opts.extraArgs?.length) args.push(...this.opts.extraArgs);

		this.opts.log(`[rpc] starting: ${this.opts.piPath} ${args.join(" ")}`);

		const proc = spawn(this.opts.piPath, args, {
			cwd: this.opts.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1" },
		});
		this.proc = proc;
		this.buffer = "";

		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk: string) => {
			const text = chunk.trim();
			if (text) this.opts.log(`[pi stderr] ${text}`);
		});

		proc.on("exit", (code, signal) => {
			this.opts.log(`[rpc] process exited (code=${code} signal=${signal})`);
			this.failAllPending(`pi process exited (code=${code} signal=${signal})`);
			if (this.proc === proc) this.proc = undefined;
		});

		const spawned = new Promise<void>((resolve, reject) => {
			proc.once("spawn", () => resolve());
			proc.once("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "ENOENT") {
					reject(new Error(`pi executable not found: "${this.opts.piPath}".`));
				} else {
					reject(err);
				}
			});
		});

		await spawned;

		// Handshake: only considered ready once the agent actually answers.
		const state = await this.send({ type: "get_state" }, 20_000);
		if (!state.success) throw new Error(`handshake failed: ${state.error ?? "unknown error"}`);

		// No auto-retry: a provider 401/403 must fail fast and visibly. With retry
		// on, the RPC stream hangs silently for minutes.
		await this.send({ type: "set_auto_retry", enabled: false }, 10_000).catch(() => undefined);

		this.opts.log("[rpc] agent ready");
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;

		// Split on \n ONLY, as the protocol requires.
		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			let line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1); // tolerate CRLF input
			if (line.trim()) this.dispatch(line);
			index = this.buffer.indexOf("\n");
		}
	}

	private dispatch(line: string): void {
		let parsed: RpcEvent | RpcResponse;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.opts.log(`[rpc] ignored non-JSON line: ${line.slice(0, 200)}`);
			return;
		}

		if (parsed.type === "response") {
			const res = parsed as RpcResponse;
			const id = res.id;
			if (id && this.pending.has(id)) {
				this.pending.get(id)?.(res);
				this.pending.delete(id);
			}
			return;
		}

		for (const handler of this.handlers) {
			try {
				handler(parsed as RpcEvent);
			} catch (err) {
				this.opts.log(`[rpc] handler threw: ${String(err)}`);
			}
		}
	}

	private failAllPending(reason: string): void {
		for (const [id, resolve] of this.pending) {
			resolve({ id, type: "response", command: "unknown", success: false, error: reason });
		}
		this.pending.clear();
	}

	/** Sends a command and waits for the response correlated by id. */
	send(command: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResponse> {
		const proc = this.proc;
		if (!proc?.stdin?.writable) {
			return Promise.resolve({
				type: "response",
				command: String(command.type ?? "unknown"),
				success: false,
				error: "pi process is not running",
			});
		}

		const id = `vsc-${++this.seq}`;
		const payload = JSON.stringify({ ...command, id });

		return new Promise<RpcResponse>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({
					id,
					type: "response",
					command: String(command.type ?? "unknown"),
					success: false,
					error: `timed out after ${timeoutMs}ms`,
				});
			}, timeoutMs);

			this.pending.set(id, (res) => {
				clearTimeout(timer);
				resolve(res);
			});

			proc.stdin?.write(`${payload}\n`, (err) => {
				if (err) {
					clearTimeout(timer);
					this.pending.delete(id);
					resolve({
						id,
						type: "response",
						command: String(command.type ?? "unknown"),
						success: false,
						error: `failed to write to stdin: ${err.message}`,
					});
				}
			});
		});
	}

	onEvent(handler: EventHandler): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	dispose(): void {
		this.failAllPending("client disposed");
		this.handlers.clear();
		const proc = this.proc;
		this.proc = undefined;
		if (!proc) return;
		try {
			proc.stdin?.end();
			proc.kill();
		} catch {
			/* process already gone */
		}
	}
}
