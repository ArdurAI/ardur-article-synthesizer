/**
 * Provenance — every generated claim is traceable to the sources that support it.
 *
 * The shared `SynthesizedArticle.provenance` (in contracts.ts) is article-level:
 * clusterId, sourceCount, distinctDomains, upstreamRunId. That stays the wire
 * format. This module adds the FINER-GRAINED, per-claim model the synthesizer
 * uses internally to *prove* each sentence is grounded before it is allowed into
 * the body.
 *
 * Per-claim provenance is surfaced on the wire in two ratified ways today:
 *   1. Quote blocks carry `attribution { source, url }` (contracts.ts).
 *   2. The article-level `provenance` aggregates source coverage.
 * A richer `claims?: ClaimProvenance[]` on `SynthesizedArticle` is a PROPOSED
 * ADDITIVE field (see docs/spec.md §"Provenance"): additive => no schema bump,
 * but it must be ratified in lockstep across all four repos before contracts.ts
 * changes. Until then this type lives only in the synthesizer.
 */

import type { SourceRef } from './contracts.ts';

/** How strongly the cited sources back a claim. */
export type SupportStrength = 'corroborated' | 'single-source' | 'inferred';

/** One atomic, checkable assertion made in the article body. */
export interface ClaimProvenance {
  /** Stable id, e.g. `${articleId}#c03`. */
  id: string;
  /** The claim text as it appears (or is paraphrased) in the body. */
  claim: string;
  /** Which render block (by index) the claim was emitted into. */
  blockIndex: number;
  /** Source ids (SourceRef-derived) that support this exact claim. */
  supportingSourceIds: string[];
  strength: SupportStrength;
  /** True if the claim is the synthesizer's own framing, not a sourced fact. */
  isEditorial: boolean;
}

/** Article-wide provenance roll-up, keyed by claim id. */
export interface ProvenanceMap {
  claims: ClaimProvenance[];
  /** Distinct sources actually cited by at least one claim. */
  citedSources: SourceRef[];
  /** Claims with zero supporting sources and `isEditorial=false` — must be 0. */
  unsupportedClaimCount: number;
}

/** Derive a stable id for a SourceRef (not in contracts.ts). */
function sourceRefId(ref: SourceRef): string {
  return `${ref.sourceDomain}::${encodeURIComponent(ref.title)}`;
}

/** Meaningful content tokens — stop words removed, min length 3. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'and', 'in', 'for', 'on', 'with', 'that', 'this', 'from',
  'it', 'its', 'at', 'by', 'or', 'but', 'as', 'has', 'have', 'had',
  'not', 'all', 'will', 'can', 'may', 'could', 'would', 'should',
]);

function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Build the provenance map for a drafted article. Aligns each claim to cluster
 * sources by entity/title token overlap; any factual (non-editorial) claim with
 * no supporting source is counted as unsupported (must be 0 to pass the gate).
 */
export function buildProvenance(
  articleId: string,
  claims: readonly { text: string; blockIndex: number; isEditorial: boolean }[],
  sources: readonly SourceRef[],
): ProvenanceMap {
  const citedSourceIdSet = new Set<string>();
  const resultClaims: ClaimProvenance[] = [];

  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    if (!claim) continue;
    const supportingSourceIds: string[] = [];

    if (!claim.isEditorial) {
      const claimTokens = new Set(contentTokens(claim.text));

      for (const source of sources) {
        const srcTokens = contentTokens(`${source.title} ${source.source} ${source.sourceDomain}`);
        // At least 2 meaningful token matches qualifies as support
        const matchCount = srcTokens.filter((t) => claimTokens.has(t)).length;
        if (matchCount >= 2) {
          const sid = sourceRefId(source);
          supportingSourceIds.push(sid);
          citedSourceIdSet.add(sid);
        }
      }
    }

    let strength: SupportStrength;
    if (claim.isEditorial) {
      strength = 'inferred';
    } else if (supportingSourceIds.length >= 2) {
      strength = 'corroborated';
    } else if (supportingSourceIds.length === 1) {
      strength = 'single-source';
    } else {
      strength = 'inferred';
    }

    resultClaims.push({
      id: `${articleId}#c${String(i).padStart(2, '0')}`,
      claim: claim.text,
      blockIndex: claim.blockIndex,
      supportingSourceIds,
      strength,
      isEditorial: claim.isEditorial,
    });
  }

  const citedSources = sources.filter((s) => citedSourceIdSet.has(sourceRefId(s)));
  const unsupportedClaimCount = resultClaims.filter(
    (c) => !c.isEditorial && c.supportingSourceIds.length === 0,
  ).length;

  return {
    claims: resultClaims,
    citedSources: [...citedSources],
    unsupportedClaimCount,
  };
}

/** True iff every factual claim has >= 1 supporting source. */
export function isFullyGrounded(map: ProvenanceMap): boolean {
  return map.unsupportedClaimCount === 0;
}
