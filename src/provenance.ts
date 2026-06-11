/**
 * Provenance — every generated claim is traceable to the sources that support it.
 *
 * SCAFFOLD ONLY — signatures are final; bodies are stubs.
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

/**
 * Build the provenance map for a drafted article. Implementation aligns each
 * claim to cluster sources by entity/title overlap; any factual (non-editorial)
 * claim with no supporting source is a hard failure (the claim is dropped or the
 * article degrades to deterministic).
 */
export function buildProvenance(
  _articleId: string,
  _claims: readonly { text: string; blockIndex: number; isEditorial: boolean }[],
  _sources: readonly SourceRef[],
): ProvenanceMap {
  throw new Error('not implemented: align claims to supporting sources');
}

/** True iff every factual claim has >= 1 supporting source. */
export function isFullyGrounded(_map: ProvenanceMap): boolean {
  throw new Error('not implemented');
}
