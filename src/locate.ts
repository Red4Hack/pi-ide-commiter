/**
 * pi executable discovery.
 *
 * VS Code launched from a GUI launcher (system menu, dock) does not inherit the
 * shell PATH — anyone who installed pi via bun/nvm/npm-global ends up with a
 * `pi` that works in the terminal but not in the extension. So trusting the
 * inherited PATH is not enough: we ask the user's login shell and, as a last
 * resort, scan the known install directories.
 */

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const isWindows = platform() === "win32";

/** Directories used by the package managers that typically install pi. */
function knownInstallPaths(): string[] {
	const home = homedir();
	const names = isWindows ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
	const dirs = isWindows
		? [
				join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"),
				join(home, ".bun", "bin"),
				join(home, ".local", "bin"),
			]
		: [
				join(home, ".bun", "bin"),
				join(home, ".local", "bin"),
				join(home, ".local", "share", "pnpm"),
				join(home, ".npm-global", "bin"),
				join(home, ".volta", "bin"),
				join(home, ".deno", "bin"),
				"/usr/local/bin",
				"/opt/homebrew/bin",
				"/usr/bin",
			];

	const out: string[] = [];
	for (const dir of dirs) for (const name of names) out.push(join(dir, name));
	return out;
}

/** Confirms the candidate really is pi, and not some other file with that name. */
async function verify(candidate: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(candidate, ["--version"], {
			timeout: 10_000,
			encoding: "utf8",
			env: { ...process.env, NO_COLOR: "1" },
		});
		if (/\d+\.\d+/.test(stdout)) return candidate;
	} catch {
		/* not executable, does not exist, or is not pi */
	}
	return undefined;
}

/** Asks the user's login shell where pi lives. */
async function askLoginShell(): Promise<string[]> {
	if (isWindows) {
		try {
			const { stdout } = await execFileAsync("where", ["pi"], {
				timeout: 10_000,
				encoding: "utf8",
			});
			return stdout
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter(Boolean);
		} catch {
			return [];
		}
	}

	const shell = process.env.SHELL || "/bin/sh";
	const found: string[] = [];
	// -lic picks up PATH set in interactive rc files (.zshrc, where bun/nvm write);
	// -lc picks up login profiles (.profile, .zprofile).
	for (const flags of ["-lic", "-lc"]) {
		try {
			const { stdout } = await execFileAsync(shell, [flags, "command -v pi"], {
				timeout: 10_000,
				encoding: "utf8",
				env: { ...process.env, NO_COLOR: "1" },
			});
			for (const line of stdout.split("\n")) {
				const path = line.trim();
				// A noisy rc file may print other things; only absolute paths matter.
				if (path.startsWith("/") && !found.includes(path)) found.push(path);
			}
		} catch {
			/* shell did not cooperate; try the next strategy */
		}
	}
	return found;
}

export class PiNotFoundError extends Error {
	constructor(tried: string[]) {
		super(
			`pi executable not found. Searched the inherited PATH, the login shell and the known install directories${
				tried.length ? ` (${tried.length} candidates tested)` : ""
			}. Install pi, or set an absolute path in pi-ide-commiter.piPath (the output of "which pi").`,
		);
	}
}

let cached: string | undefined;

export function clearPiPathCache(): void {
	cached = undefined;
}

/**
 * Resolves the pi path. An empty `configured` (the default) triggers the
 * automatic search; an explicit path is used as given — if it is wrong, the
 * error must point at the setting rather than at the search.
 */
export async function resolvePiPath(
	configured: string,
	log: (line: string) => void,
): Promise<string> {
	const explicit = configured.trim();
	if (explicit) {
		try {
			await access(explicit, constants.X_OK);
		} catch {
			// It may be a bare name on the PATH rather than a path; let verify decide.
		}
		const ok = await verify(explicit);
		if (ok) return ok;
		throw new Error(
			`pi-ide-commiter.piPath points at "${explicit}", which did not answer "pi --version". Fix it, or leave it empty for automatic detection.`,
		);
	}

	if (cached) return cached;

	const tried: string[] = [];

	// 1. Inherited PATH — works when VS Code was launched from a terminal.
	tried.push("pi");
	const onPath = await verify(isWindows ? "pi.cmd" : "pi");
	if (onPath) {
		log("[locate] found pi on the inherited PATH");
		cached = onPath;
		return onPath;
	}

	// 2. Login shell — covers the GUI launcher case.
	for (const candidate of await askLoginShell()) {
		tried.push(candidate);
		const ok = await verify(candidate);
		if (ok) {
			log(`[locate] found pi via login shell: ${ok}`);
			cached = ok;
			return ok;
		}
	}

	// 3. Known install directories.
	for (const candidate of knownInstallPaths()) {
		tried.push(candidate);
		const ok = await verify(candidate);
		if (ok) {
			log(`[locate] found pi in a known location: ${ok}`);
			cached = ok;
			return ok;
		}
	}

	log(`[locate] pi not found; ${tried.length} candidates tested`);
	throw new PiNotFoundError(tried);
}
