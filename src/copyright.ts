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
 * summaryHint before it is treated as reproduced text.
 */
export const MAX_VERBATIM_NGRAM = 8;

/**
 * Largest verbatim n-gram (in words) the body may share with any source's
 * title field (#21). Higher than the summaryHint threshold because the
 * deterministic draft legitimately embeds short cluster headlines;
 * threshold > 12 catches verbatim title reproduction without regressing on
 * normal headline references (see issue #11 history).
 */
export const MAX_VERBATIM_TITLE_NGRAM = 12;

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

  // 3. Verbatim overlap: non-quote body text vs. source summaryHints AND titles.
  // SummaryHints use MAX_VERBATIM_NGRAM (8).
  // Titles use MAX_VERBATIM_TITLE_NGRAM (12) — #21: titles were previously excluded
  // (issue #11) because the deterministic draft embeds the cluster headline verbatim
  // via buildKeyTakeaway. A threshold above the longest typical headline (~12 tokens
  // after normalisation) lets us catch true verbatim title reproduction without
  // regressing on the legitimate headline embedding pattern.
  const summaryHintTexts = corpus.map((item) => item.summaryHint).filter(Boolean);
  const titleTexts = corpus.map((item) => item.title).filter(Boolean);
  const bodyText = article.body
    .filter((b) => b.type !== 'quote') // quotes are expected to share wording
    .map((b) => { const tb = b as { text?: string; items?: string[] }; return tb.text ?? (tb.items ?? []).join(' '); })
    .join(' ');

  if (bodyText.trim()) {
    const hintOverlap = longestVerbatimRun(bodyText, summaryHintTexts);
    if (hintOverlap > MAX_VERBATIM_NGRAM) {
      violations.push({
        kind: 'verbatim-overlap',
        detail: `Body has a ${hintOverlap}-word verbatim run against source summaryHints (limit: ${MAX_VERBATIM_NGRAM})`,
      });
    }
    const titleOverlap = longestVerbatimRun(bodyText, titleTexts);
    if (titleOverlap > MAX_VERBATIM_TITLE_NGRAM) {
      violations.push({
        kind: 'verbatim-overlap',
        detail: `Body has a ${titleOverlap}-word verbatim run against source titles (limit: ${MAX_VERBATIM_TITLE_NGRAM})`,
      });
    }
  }

  // 4. Credential/secret leak screen (ported from validate-articles.mjs).
  // #22: extend to cover all LLM-generated metadata fields — keyPoints, tags,
  // whyItMatters and readerAction were previously unscreened.
  const fullText = [
    article.headline,
    article.dek,
    ...article.body.map((b) => { const tb = b as { text?: string; items?: string[] }; return tb.text ?? (tb.items ?? []).join(' '); }),
    article.legalNote,
    ...(Array.isArray(article.keyPoints) ? article.keyPoints : []),
    ...(Array.isArray(article.tags) ? article.tags : []),
    article.whyItMatters ?? '',
    article.readerAction ?? '',
  ].filter(Boolean).join(' ');

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
 * Maximum words scanned per source/candidate to bound the O(n²) DP (issue #26:
 * DoS via unbounded summaryHint/title from upstream sources).
 */
const MAX_VERBATIM_SCAN_WORDS = 600;

/**
 * Longest verbatim word-run shared between `candidate` and any string in
 * `sources`. Used to catch accidental reproduction of source phrasing.
 *
 * Algorithm: longest-common-substring DP (O(m*n)), bounded by
 * MAX_VERBATIM_SCAN_WORDS per input to prevent crafted-source DoS (issue #26).
 */
export function longestVerbatimRun(candidate: string, sources: readonly string[]): number {
  if (sources.length === 0) return 0;

  const candWords = normalizeWords(candidate).slice(0, MAX_VERBATIM_SCAN_WORDS);
  if (candWords.length === 0) return 0;

  let longest = 0;

  for (const source of sources) {
    const srcWords = normalizeWords(source).slice(0, MAX_VERBATIM_SCAN_WORDS);
    if (srcWords.length === 0) continue;

    // Space-optimized DP: dp[j] = longest common suffix of srcWords[0..i] and candWords[0..j].
    let prev = new Array<number>(candWords.length + 1).fill(0);
    for (let i = 0; i < srcWords.length; i++) {
      const curr = new Array<number>(candWords.length + 1).fill(0);
      for (let j = 0; j < candWords.length; j++) {
        if (srcWords[i] === candWords[j]) {
          curr[j + 1] = (prev[j] ?? 0) + 1;
          if ((curr[j + 1] ?? 0) > longest) longest = curr[j + 1] ?? 0;
        }
      }
      prev = curr;
    }
  }

  return longest;
}
