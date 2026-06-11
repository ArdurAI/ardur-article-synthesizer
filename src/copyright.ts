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

/** Credential regex patterns ported from validate-articles.mjs */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/, // OpenAI-style secret key
  /\bAIza[A-Za-z0-9_-]{30,}\b/, // Google API key
  /\bghp_[A-Za-z0-9]{36,}\b/, // GitHub personal access token
  /\bglpat-[A-Za-z0-9_-]{20,}\b/, // GitLab PAT
  /password\s*[:=]\s*\S{6,}/i,
  /secret\s*[:=]\s*\S{6,}/i,
  /api[_-]?key\s*[:=]\s*\S{6,}/i,
  /bearer\s+[A-Za-z0-9_.-]{20,}/i,
];

/** Normalize text for verbatim comparison (lowercase, strip punctuation). */
function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * Validate a finished article against every copyright rule. `corpus` is the set
 * of cluster members whose metadata the article was synthesized from — used for
 * verbatim-overlap detection.
 */
export function enforceCopyright(
  article: SynthesizedArticle,
  corpus: AggregatedItem[],
): CopyrightVerdict {
  const violations: CopyrightViolation[] = [];

  // 1. Quote blocks: < 25 words and must carry attribution
  for (let i = 0; i < article.body.length; i++) {
    const block = article.body[i];
    if (!block || block.type !== 'quote') continue;

    if (block.text && !isQuoteWithinLimit(block.text)) {
      violations.push({
        kind: 'quote-too-long',
        detail: `Quote in block ${i} must be strictly less than ${MAX_QUOTE_WORDS} words (${block.text.split(/\s+/).length} words found)`,
        locator: String(i),
      });
    }

    if (!block.attribution?.source || !block.attribution?.url) {
      violations.push({
        kind: 'quote-unattributed',
        detail: `Quote block at index ${i} is missing attribution (source + url required)`,
        locator: String(i),
      });
    }
  }

  // 2. Every referenced source needs a canonical URL
  for (const ref of article.references) {
    if (!ref.url || !ref.url.startsWith('http')) {
      violations.push({
        kind: 'missing-canonical-link',
        detail: `Reference "${ref.title}" from ${ref.source} has no valid canonical URL`,
        locator: ref.source,
      });
    }
  }

  // 3. Verbatim overlap: non-quote body text vs. source summaryHints ONLY.
  // Issue #11: article titles are factual identifiers (not protectable expression);
  // including them in the corpus caused a deadlock where the deterministic fallback's
  // legitimate headline references triggered the gate on clusters with ≥8-word titles.
  const sourceTexts = corpus.map((item) => item.summaryHint).filter(Boolean);
  const bodyText = article.body
    .filter((b) => b.type !== 'quote') // quotes are expected to share wording
    .map((b) => { const tb = b as { text?: string; items?: string[] }; return tb.text ?? (tb.items ?? []).join(' '); })
    .join(' ');

  if (bodyText.trim()) {
    const overlap = longestVerbatimRun(bodyText, sourceTexts);
    if (overlap > MAX_VERBATIM_NGRAM) {
      violations.push({
        kind: 'verbatim-overlap',
        detail: `Body has a ${overlap}-word verbatim run against source metadata (limit: ${MAX_VERBATIM_NGRAM})`,
      });
    }
  }

  // 4. Credential/secret leak screen (ported from validate-articles.mjs)
  const fullText = [
    article.headline,
    article.dek,
    ...article.body.map((b) => { const tb = b as { text?: string; items?: string[] }; return tb.text ?? (tb.items ?? []).join(' '); }),
    article.legalNote,
  ].join(' ');

  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(fullText)) {
      violations.push({
        kind: 'credential-leak',
        detail: 'Potential credential or secret detected in article text',
      });
      break; // one violation per article is enough to fail it
    }
  }

  return { ok: violations.length === 0, violations };
}

/** True iff `text` is a quote of strictly < MAX_QUOTE_WORDS words. */
export function isQuoteWithinLimit(text: string, maxWords: number = MAX_QUOTE_WORDS): boolean {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  return words.length < maxWords;
}

/**
 * Longest verbatim word-run shared between `candidate` and any string in
 * `sources`. Used to catch accidental reproduction of source phrasing.
 *
 * Algorithm: for every (source_start, candidate_start) pair where the first
 * words match, extend the run and record the maximum.
 * Complexity: O(|sources| * |src_words| * |cand_words| * run_len) — acceptable
 * for article-sized text (a few hundred words each).
 */
export function longestVerbatimRun(candidate: string, sources: readonly string[]): number {
  if (sources.length === 0) return 0;

  const candWords = normalizeWords(candidate);
  if (candWords.length === 0) return 0;

  let longest = 0;

  for (const source of sources) {
    const srcWords = normalizeWords(source);
    if (srcWords.length === 0) continue;

    for (let si = 0; si < srcWords.length; si++) {
      for (let ci = 0; ci < candWords.length; ci++) {
        if (srcWords[si] !== candWords[ci]) continue;
        // Words match at (si, ci) — extend the run
        let run = 1;
        while (
          si + run < srcWords.length &&
          ci + run < candWords.length &&
          srcWords[si + run] === candWords[ci + run]
        ) {
          run++;
        }
        if (run > longest) longest = run;
      }
    }
  }

  return longest;
}
