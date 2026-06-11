/**
 * Copyright-safety guards — the non-negotiable gate every article must pass.
 *
 * Rules (ratified in ARCHITECTURE.md §6 and ardur.ai's content-engine contract):
 *  - ORIGINAL TEXT ONLY. The synthesizer writes original prose; it never
 *    reproduces an external article body.
 *  - Quotes are < 25 words AND carry attribution (source + canonical url).
 *  - Every source synthesized is attributed with a canonical link.
 *  - No verbatim runs from source metadata beyond factual names/titles
 *    (checked by n-gram overlap against the summaryHint/title corpus).
 *  - No secrets/credentials leak into body or metadata (regex screen ported
 *    from `scripts/validate-articles.mjs`).
 *
 * An article that fails ANY check is rejected by the synthesizer; the offending
 * cycle records a warning and falls back to a stricter deterministic article.
 * Failing closed (drop the article) is preferred to publishing unsafe text.
 */
import type { SynthesizedArticle, AggregatedItem } from './contracts.ts';
/** The default maximum quote length, in words. */
export declare const MAX_QUOTE_WORDS = 25;
/**
 * Largest verbatim n-gram (in words) the body may share with any source's
 * summaryHint before it is treated as reproduced text.
 */
export declare const MAX_VERBATIM_NGRAM = 8;
/**
 * Largest verbatim n-gram (in words) the body may share with any source's
 * title field (#21). Higher than the summaryHint threshold because the
 * deterministic draft legitimately embeds short cluster headlines;
 * threshold > 12 catches verbatim title reproduction without regressing on
 * normal headline references (see issue #11 history).
 */
export declare const MAX_VERBATIM_TITLE_NGRAM = 12;
export type CopyrightViolationKind = 'quote-too-long' | 'quote-unattributed' | 'missing-canonical-link' | 'source-unattributed' | 'verbatim-overlap' | 'reproduced-body' | 'credential-leak';
export interface CopyrightViolation {
    kind: CopyrightViolationKind;
    detail: string;
    /** The block index or reference id the violation was found in, if locatable. */
    locator?: string;
}
export interface CopyrightVerdict {
    ok: boolean;
    violations: CopyrightViolation[];
}
/**
 * Validate a finished article against every copyright rule. `corpus` is the set
 * of cluster members whose metadata the article was synthesized from — used for
 * verbatim-overlap detection.
 */
export declare function enforceCopyright(article: SynthesizedArticle, corpus: AggregatedItem[]): CopyrightVerdict;
/** True iff `text` is a quote of strictly < MAX_QUOTE_WORDS words. */
export declare function isQuoteWithinLimit(text: string, maxWords?: number): boolean;
/**
 * Longest verbatim word-run shared between `candidate` and any string in
 * `sources`. Used to catch accidental reproduction of source phrasing.
 *
 * Algorithm: for every (source_start, candidate_start) pair where the first
 * words match, extend the run and record the maximum.
 * Complexity: O(|sources| * |src_words| * |cand_words| * run_len) — acceptable
 * for article-sized text (a few hundred words each).
 */
export declare function longestVerbatimRun(candidate: string, sources: readonly string[]): number;
