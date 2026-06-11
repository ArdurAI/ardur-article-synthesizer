/**
 * Copyright-safety guards — the non-negotiable gate every article must pass.
 *
 * SCAFFOLD ONLY — signatures are final; bodies are stubs.
 *
 * The rules (ratified in ARCHITECTURE.md §6 and ardur.ai's content-engine
 * contract):
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
export const MAX_QUOTE_WORDS = 25;

/**
 * Largest verbatim n-gram (in words) the body may share with any source's
 * title/summaryHint before it is treated as reproduced text rather than an
 * original sentence that happens to name the same entities.
 */
export const MAX_VERBATIM_NGRAM = 8;

export type CopyrightViolationKind =
  | 'quote-too-long'
  | 'quote-unattributed'
  | 'missing-canonical-link'
  | 'source-unattributed'
  | 'verbatim-overlap'
  | 'reproduced-body'
  | 'credential-leak';

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
export function enforceCopyright(
  _article: SynthesizedArticle,
  _corpus: AggregatedItem[],
): CopyrightVerdict {
  throw new Error('not implemented: quote/attribution/overlap/credential checks');
}

/** True iff `text` is a quote of <= MAX_QUOTE_WORDS words. */
export function isQuoteWithinLimit(_text: string, _maxWords: number = MAX_QUOTE_WORDS): boolean {
  throw new Error('not implemented');
}

/**
 * Longest verbatim word-run shared between `candidate` and any string in
 * `sources`. Used to catch accidental reproduction of source phrasing.
 */
export function longestVerbatimRun(_candidate: string, _sources: readonly string[]): number {
  throw new Error('not implemented');
}
