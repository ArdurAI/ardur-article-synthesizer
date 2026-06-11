/**
 * Provenance — every generated claim is traceable to the sources that support it.
 *
 * Two gate modes:
 *
 * 1. FACT-GROUNDED (Rev 3, S3) — primary mode when ExtractedFact[] are available.
 *    Claim sentences are mapped to fact IDs via:
 *      a) Inline [FACT:id] citations the LLM embedded in its output.
 *      b) Entity/number overlap as a backstop against bad citations.
 *    Returns ClaimProvenance[] (contracts Rev 3) for the article wire format.
 *
 * 2. TITLE-TOKEN (Rev 2, legacy) — fallback when no facts are available (rev-2
 *    aggregator). Matches claim tokens against source title + domain vocabulary.
 *    Preserved exactly from the prior implementation.
 *
 * The gate is fail-closed: articles with ≥1 ungrounded factual sentence are
 * either re-asked (one bounded attempt) or HELD — never published flat.
 */
import type { SourceRef, ExtractedFact, ClaimProvenance } from './contracts.ts';
export interface ClaimInput {
    text: string;
    blockIndex: number;
    isEditorial: boolean;
}
export interface FactProvenanceResult {
    claims: ClaimProvenance[];
    ungroundedClaims: ClaimInput[];
    isGrounded: boolean;
}
/**
 * Build fact-grounded provenance. Primary gate mode (S3).
 *
 * For each factual claim sentence:
 *   1. Collect [FACT:id] inline citations.
 *   2. Validate each cited ID exists in the provided facts.
 *   3. Backstop: if no valid inline citations, check entity/number overlap.
 *   4. Claims with zero supporting facts are ungrounded.
 */
export declare function buildProvenanceFromFacts(articleId: string, claims: readonly ClaimInput[], facts: readonly ExtractedFact[]): FactProvenanceResult;
/** How strongly the cited sources back a claim (legacy mode). */
export type SupportStrength = 'corroborated' | 'single-source' | 'inferred';
/** One atomic, checkable assertion (legacy internal format). */
export interface LegacyClaimProvenance {
    id: string;
    claim: string;
    blockIndex: number;
    supportingSourceIds: string[];
    strength: SupportStrength;
    isEditorial: boolean;
}
/** Article-wide provenance roll-up (legacy mode), keyed by claim id. */
export interface ProvenanceMap {
    claims: LegacyClaimProvenance[];
    citedSources: SourceRef[];
    unsupportedClaimCount: number;
}
/**
 * Legacy title-token provenance gate. Used when no ExtractedFacts are available
 * (rev-2 aggregator). Matches claim token vocabulary against source titles.
 */
export declare function buildProvenance(articleId: string, claims: readonly {
    text: string;
    blockIndex: number;
    isEditorial: boolean;
}[], sources: readonly SourceRef[]): ProvenanceMap;
/** True iff every factual claim has >= 1 supporting source (legacy gate). */
export declare function isFullyGrounded(map: ProvenanceMap): boolean;
