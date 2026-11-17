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
	input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const pending = execFileAsync("git", args, {
			cwd,
			maxBuffer: 64 * 1024 * 1024,
			encoding: "utf8",
		});
		if (input !== undefined) pending.child.stdin?.end(input);
		const { stdout, stderr } = await pending;
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

/** Generated, bundled or binary files: their diff says nothing about intent. */
const GENERATED = /(^|\/)(dist|build|out|coverage|node_modules|vendor)\/|\.(min\.js|min\.css|map|snap|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|vsix)$/i;

function isNoisy(file: string): boolean {
	const base = file.split("/").pop() ?? file;
	return NOISY_FILES.includes(base) || GENERATED.test(file);
}

/** Lower = more informative about intent, so it gets budget first. */
function rank(file: string): number {
	if (/(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i.test(file)) return 2;
	if (/\.(md|mdx|rst)$/i.test(file) || /(^|\/)docs?\//i.test(file)) return 3;
	if (/\.(json|ya?ml|toml|ini|cfg)$/i.test(file)) return 1;
	return 0;
}

/** The "### file ###" header already names the file; drop diff --git/index/---/+++ lines. */
function stripHeader(diff: string): string {
	const lines = diff.split("\n");
	const hunk = lines.findIndex((l) => l.startsWith("@@"));
	const end = hunk < 0 ? lines.length : hunk;
	const head = lines.slice(0, end).filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l));
	return [...head, ...lines.slice(end)].join("\n").trim();
}

const NOTE = "\n… (diff truncated)";

/** Keeps whole hunks while they fit; only cuts inside a hunk when even the first one is too big. */
function truncateByHunks(diff: string, limit: number): { text: string; truncated: boolean } {
	if (diff.length <= limit) return { text: diff, truncated: false };
	const room = Math.max(0, limit - NOTE.length);
	let out = "";
	for (const hunk of diff.split(/\n(?=@@ )/)) {
		const next = out ? `${out}\n${hunk}` : hunk;
		if (next.length > room) break;
		out = next;
	}
	if (!out) {
		const head = diff.slice(0, room);
		out = head.slice(0, head.lastIndexOf("\n") > 0 ? head.lastIndexOf("\n") : room);
	}
	return { text: out + NOTE, truncated: true };
}

/** Water-filling: small diffs stay whole, the leftover budget flows to the big ones. */
function allocate(sizes: number[], total: number, perFile: number): number[] {
	const order = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
	const limits = new Array<number>(sizes.length).fill(0);
	let left = total;
	order.forEach((i, k) => {
		limits[i] = Math.min(sizes[i], perFile, Math.floor(left / (order.length - k)));
		left -= limits[i];
	});
	return limits;
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
	// --no-index also flags tracked files that match .gitignore (e.g. a committed node_modules).
	const ignored = new Set(
		(await runGit(cwd, ["check-ignore", "--no-index", "-z", "--stdin"], allFiles.join("\0"))).stdout
			.split("\0")
			.filter(Boolean),
	);
	for (const file of allFiles) {
		if (ignored.has(file) || isNoisy(file)) omitted.push(file);
		else candidates.push(file);
	}
	// Stable sort: source before config, tests, docs; git order within a tier.
	candidates.sort((a, b) => rank(a) - rank(b));
	omitted.push(...candidates.slice(opts.maxFiles));

	let truncated = omitted.length > 0;

	const fetched = (
		await Promise.all(
			candidates.slice(0, opts.maxFiles).map(async (file) => {
				const args =
					!staged && untracked.has(file)
						? ["diff", "-U2", "--no-index", "--", "/dev/null", file] // untracked: not in `git diff`
						: [...diffBase, "-U2", "--", file];
				const diff = stripHeader((await runGit(cwd, args)).stdout);
				return diff ? { file, diff } : undefined;
			}),
		)
	).filter((d): d is { file: string; diff: string } => d !== undefined);

	// Too many files for a meaningful slice each: drop the lowest-ranked ones.
	const minShare = Math.min(300, opts.maxFileDiffBytes);
	const sizes = () => fetched.map((d) => d.diff.length);
	let limits = allocate(sizes(), opts.maxTotalDiffBytes, opts.maxFileDiffBytes);
	while (fetched.length > 1 && limits.some((l, i) => l < Math.min(fetched[i].diff.length, minShare))) {
		omitted.push(fetched.pop()!.file);
		truncated = true;
		limits = allocate(sizes(), opts.maxTotalDiffBytes, opts.maxFileDiffBytes);
	}

	const fileDiffs = fetched.map(({ file, diff }, i) => {
		const cutRes = truncateByHunks(diff, limits[i]);
		if (cutRes.truncated) truncated = true;
		return { file, diff: cutRes.text };
	});

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
