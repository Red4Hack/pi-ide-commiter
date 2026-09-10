/**
 * Git context gathering.
 *
 * The rule driving this module: send the SMALLEST context that still describes
 * the change. A raw diff from a large repository blows the context window and
 * makes the message worse — hence a per-file budget and a total budget, with
 * graceful degradation to `--stat` when the diff does not fit.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Files whose diff is huge and says nothing about the intent of the change. */
const NOISY_FILES = [
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
	"bun.lock",
	"Cargo.lock",
	"poetry.lock",
	"composer.lock",
	"Gemfile.lock",
	"go.sum",
	"flake.lock",
];

export interface GitContextOptions {
	maxFiles: number;
	maxFileDiffBytes: number;
	maxTotalDiffBytes: number;
	recentCommitCount: number;
}

export interface CommitContext {
	branch: string;
	/** true = committing the index; false = nothing staged, looking at the tree. */
	staged: boolean;
	files: string[];
	statSummary: string;
	fileDiffs: Array<{ file: string; diff: string }>;
	recentSubjects: string[];
	/** Some diff was cut for budget reasons. */
	truncated: boolean;
	/** Files skipped as noise (lockfiles) or for exceeding maxFiles. */
	omitted: string[];
}

export class NoChangesError extends Error {}

export async function runGit(
	cwd: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, {
			cwd,
			maxBuffer: 64 * 1024 * 1024,
			encoding: "utf8",
		});
		return { code: 0, stdout, stderr };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
		return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
	}
}

/** Parses `git status --porcelain -z`, handling renames (which emit two records). */
export function parsePorcelain(stdout: string): { files: string[]; untracked: Set<string> } {
	const entries = stdout.split("\0").filter((e) => e.length > 0);
	const files: string[] = [];
	const untracked = new Set<string>();

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 3) continue;
		const code = entry.slice(0, 2);
		const path = entry.slice(3);

		files.push(path);
		if (code === "??") untracked.add(path);
		// Rename/copy: the next record is the original path — consume it.
		if (code[0] === "R" || code[0] === "C") i++;
	}

	return { files, untracked };
}

function isNoisy(file: string): boolean {
	const base = file.split("/").pop() ?? file;
	return NOISY_FILES.includes(base);
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (text.length <= maxBytes) return { text, truncated: false };
	return { text: `${text.slice(0, maxBytes)}\n… (diff truncated)`, truncated: true };
}

export async function gatherCommitContext(
	cwd: string,
	opts: GitContextOptions,
): Promise<CommitContext> {
	const [branchRes, stagedRes, statusRes] = await Promise.all([
		runGit(cwd, ["branch", "--show-current"]),
		runGit(cwd, ["diff", "--cached", "--name-only", "-z"]),
		runGit(cwd, ["status", "--porcelain", "-z"]),
	]);

	const stagedFiles = stagedRes.stdout.split("\0").filter((f) => f.length > 0);
	const staged = stagedFiles.length > 0;

	const { files: worktreeFiles, untracked } = parsePorcelain(statusRes.stdout);
	const allFiles = staged ? stagedFiles : worktreeFiles;

	if (allFiles.length === 0) {
		throw new NoChangesError("No changes found. Make (or stage) some changes first.");
	}

	// Diff base: the index when something is staged, otherwise HEAD (working tree).
	const diffBase = staged ? ["diff", "--cached"] : ["diff", "HEAD"];

	const [statRes, logRes] = await Promise.all([
		runGit(cwd, [...diffBase, "--stat"]),
		opts.recentCommitCount > 0
			? runGit(cwd, ["log", `-${opts.recentCommitCount}`, "--format=%s"])
			: Promise.resolve({ code: 0, stdout: "", stderr: "" }),
	]);

	const omitted: string[] = [];
	const candidates: string[] = [];
	for (const file of allFiles) {
		if (isNoisy(file)) omitted.push(file);
		else candidates.push(file);
	}
	if (candidates.length > opts.maxFiles) {
		omitted.push(...candidates.slice(opts.maxFiles));
	}
	const diffFiles = candidates.slice(0, opts.maxFiles);

	let truncated = omitted.length > 0;
	let budget = opts.maxTotalDiffBytes;
	const fileDiffs: Array<{ file: string; diff: string }> = [];

	for (const file of diffFiles) {
		if (budget <= 0) {
			truncated = true;
			break;
		}

		let raw: string;
		if (!staged && untracked.has(file)) {
			// Untracked files do not show up in `git diff`; diff against /dev/null
			// to get a real diff instead of dumping the whole file.
			const res = await runGit(cwd, ["diff", "--no-index", "--", "/dev/null", file]);
			raw = res.stdout.trim();
			if (!raw) continue;
		} else {
			const res = await runGit(cwd, [...diffBase, "--", file]);
			raw = res.stdout.trim();
			if (!raw) continue;
		}

		const perFile = Math.min(opts.maxFileDiffBytes, budget);
		const { text, truncated: cut } = truncate(raw, perFile);
		if (cut) truncated = true;
		budget -= text.length;
		fileDiffs.push({ file, diff: text });
	}

	return {
		branch: branchRes.stdout.trim(),
		staged,
		files: allFiles,
		statSummary: statRes.stdout.trim(),
		fileDiffs,
		recentSubjects: logRes.stdout
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean),
		truncated,
		omitted,
	};
}
