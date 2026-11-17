/**
 * Prompt assembly and output cleanup.
 *
 * The system prompt replaces pi's default "coding assistant" prompt (via
 * --system-prompt). That is deliberate: the default prompt describes an agent
 * with tools and an editing workflow, none of which helps write a commit
 * message, and it would occupy context on every generation.
 */

import type { CommitContext } from "./git.js";

export interface PromptConfig {
	style: "conventional" | "plain";
	includeBody: boolean;
	maxSubjectLength: number;
	language: string;
	/** Appended to the rules below. Empty means no extra instructions. */
	customInstructions: string;
	/** Replaces the built-in rules entirely. Empty means use the built-in ones. */
	systemPromptOverride: string;
}

export function buildSystemPrompt(cfg: PromptConfig): string {
	const override = (cfg.systemPromptOverride ?? "").trim();
	if (override) {
		// Full override: the user takes responsibility for the whole contract,
		// including "reply with the message only".
		return withCustomInstructions(override, cfg.customInstructions);
	}

	const lines = [
		"You write git commit messages from a diff.",
		"You have no tools and must not ask for more information.",
		"Reply with ONLY the commit message: no preamble, no explanation, no markdown fences.",
		`Write the message in ${cfg.language}.`,
	];

	if (cfg.style === "conventional") {
		lines.push(
			"Subject format: <type>(<scope>): <subject>",
			"type is one of feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.",
			"scope is optional; use it only when there is an obvious module or area.",
		);
	} else {
		lines.push("Subject format: a short imperative phrase, with no type prefix.");
	}

	lines.push(
		`The subject is at most ${cfg.maxSubjectLength} characters, in the imperative present tense ("add", not "added"), with no trailing period.`,
	);

	if (cfg.includeBody) {
		lines.push(
			"After the subject, leave a blank line and write a short body explaining WHY the change was made.",
			"Omit the body when the change is trivial and the subject already says enough.",
		);
	} else {
		lines.push("Reply with a single line: the subject only, no body.");
	}

	lines.push(
		"Describe what the change does, not which files were touched.",
		"Do not invent changes that are not in the diff.",
	);

	return withCustomInstructions(lines.join("\n"), cfg.customInstructions);
}

/**
 * User instructions go last and are declared as taking precedence, so they can
 * actually override a built-in rule (a different subject length, a required
 * ticket prefix, a house style) instead of quietly conflicting with it.
 */
function withCustomInstructions(base: string, custom: string | undefined): string {
	const extra = (custom ?? "").trim();
	if (!extra) return base;
	return `${base}\n\nAdditional instructions from the user. Where these conflict with the rules above, follow these:\n${extra}`;
}

export function buildUserMessage(ctx: CommitContext): string {
	const parts: string[] = [];

	if (ctx.branch) parts.push(`Branch: ${ctx.branch}`);
	parts.push(
		ctx.staged
			? "Scope: staged changes (what is about to be committed)."
			: "Scope: nothing staged — all uncommitted changes in the working tree.",
	);

	if (ctx.recentSubjects.length > 0) {
		parts.push(
			"",
			"Recent commits in this repository (match this style):",
			...ctx.recentSubjects.map((s) => `- ${s}`),
		);
	}

	if (ctx.statSummary) {
		parts.push("", "Change summary:", "```", ctx.statSummary, "```");
	}

	if (ctx.fileDiffs.length > 0) {
		parts.push("", "Diff:");
		for (const { file, diff } of ctx.fileDiffs) {
			parts.push("", `--- ${file} ---`, "```diff", diff, "```");
		}
	}

	if (ctx.omitted.length > 0) {
		parts.push(
			"",
			`Changed files whose diff was not sent (lockfiles, generated/binary files or over the file limit): ${ctx.omitted.join(", ")}`,
		);
	}

	if (ctx.truncated) {
		parts.push(
			"",
			"Part of the diff was truncated for size. Rely on the summary above for the full picture.",
		);
	}

	parts.push("", "Write the commit message for these changes.");

	return parts.join("\n");
}

/**
 * Models like to wrap their answer. Strips markdown fences, preamble lines
 * ("Here's the commit message:") and surrounding quotes.
 */
export function sanitizeMessage(raw: string): string {
	let text = raw.trim();

	// A markdown fence wrapping everything.
	const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
	if (fence) text = fence[1].trim();

	// Preamble before a fence ("Sure! Here it is:\n```\n...\n```").
	const inner = text.match(/```[a-zA-Z]*\n([\s\S]*?)\n?```/);
	if (inner && text.includes("```")) text = inner[1].trim();

	// A preamble line followed by the actual message.
	const lines = text.split("\n");
	if (lines.length > 1 && /^(here'?s|sure|okay|ok)\b.*:$/i.test(lines[0].trim())) {
		text = lines.slice(1).join("\n").trim();
	}

	// Quotes wrapping the whole message.
	if (
		(text.startsWith('"') && text.endsWith('"')) ||
		(text.startsWith("'") && text.endsWith("'"))
	) {
		const stripped = text.slice(1, -1);
		if (!stripped.includes("\n")) text = stripped;
	}

	return text.trim();
}
