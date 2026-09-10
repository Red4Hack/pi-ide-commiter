/**
 * Diff budget.
 *
 * Fixed numbers are wrong in both directions: too tight and a normal commit gets
 * truncated, so the message turns imprecise; too wide and small models blow up.
 * In automatic mode (the default) the budget is derived from the context window
 * of the model pi actually picked.
 */

export interface BudgetConfig {
	maxFiles: number;
	maxFileDiffBytes: number;
	maxTotalDiffBytes: number;
}

export interface ResolvedBudget extends BudgetConfig {
	auto: boolean;
	contextWindow: number | undefined;
}

/** Rough chars-per-token for code and diffs. */
const CHARS_PER_TOKEN = 3.5;

/** Share of the context window reserved for the diff. The rest is prompt plus reply. */
const CONTEXT_SHARE = 0.15;

/** Floor and ceiling for the total budget, in chars. The ceiling caps per-commit cost. */
const TOTAL_MIN = 16_000;
const TOTAL_MAX = 120_000;

/** With no model information, assume a conservative window. */
const FALLBACK_CONTEXT = 128_000;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * An explicit setting (> 0) always wins. Zero means "automatic", and each field
 * is decided independently — you can pin just the total and leave the rest auto.
 */
export function resolveBudget(cfg: BudgetConfig, contextWindow: number | undefined): ResolvedBudget {
	const context = contextWindow && contextWindow > 0 ? contextWindow : FALLBACK_CONTEXT;

	const autoTotal = clamp(context * CONTEXT_SHARE * CHARS_PER_TOKEN, TOTAL_MIN, TOTAL_MAX);
	const total = cfg.maxTotalDiffBytes > 0 ? cfg.maxTotalDiffBytes : autoTotal;

	// A single file should not eat the whole budget, but must still fit a large
	// rewritten file.
	const autoPerFile = clamp(total / 6, 4_000, 30_000);
	const perFile = cfg.maxFileDiffBytes > 0 ? cfg.maxFileDiffBytes : autoPerFile;

	const autoFiles = clamp(context / 6_000, 20, 80);
	const files = cfg.maxFiles > 0 ? cfg.maxFiles : autoFiles;

	return {
		maxFiles: files,
		maxFileDiffBytes: perFile,
		maxTotalDiffBytes: total,
		auto: cfg.maxTotalDiffBytes <= 0 && cfg.maxFileDiffBytes <= 0 && cfg.maxFiles <= 0,
		contextWindow: contextWindow && contextWindow > 0 ? contextWindow : undefined,
	};
}
