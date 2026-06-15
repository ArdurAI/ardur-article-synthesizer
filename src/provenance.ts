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

import type { SourceRef, ExtractedFact, ClaimProvenance, Confidence } from './contracts.ts';

// ---------------------------------------------------------------------------
// Internal claim shape (used by both gate modes)
// ---------------------------------------------------------------------------

export interface ClaimInput {
  text: string;
  blockIndex: number;
  isEditorial: boolean;
}

// ---------------------------------------------------------------------------
// Gate mode 1: Fact-grounded (Rev 3)
// ---------------------------------------------------------------------------

export interface FactProvenanceResult {
  claims: ClaimProvenance[];
  ungroundedClaims: ClaimInput[];
  isGrounded: boolean;
}

/**
 * Extract inline [FACT:id] citations from a claim sentence.
 * Returns the set of fact IDs cited.
 */
function extractInlineCitations(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\[FACT:([^\]]+)\]/g)) {
    const id = match[1]?.trim();
    if (id) ids.add(id);
  }
  return ids;
}

/** Meaningful content tokens (stop words removed, min length 3). */
const STOP_WORDS_FACT = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'and', 'in', 'for', 'on', 'with', 'that', 'this', 'from',
  'it', 'its', 'at', 'by', 'or', 'but', 'as', 'has', 'have', 'had',
  'not', 'all', 'will', 'can', 'may', 'could', 'would', 'should',
]);

function contentTokensFact(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\[FACT:[^\]]+\]/g, ' ') // strip citations before tokenizing
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS_FACT.has(w)),
  );
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
export function buildProvenanceFromFacts(
  articleId: string,
  claims: readonly ClaimInput[],
  facts: readonly ExtractedFact[],
): FactProvenanceResult {
  const factById = new Map(facts.map((f) => [f.id, f]));
  const resultClaims: ClaimProvenance[] = [];
  const ungroundedClaims: ClaimInput[] = [];

  for (const claim of claims) {
    if (claim.isEditorial) {
      resultClaims.push({
        blockIndex: claim.blockIndex,
        text: claim.text,
        isEditorial: true,
        factIds: [],
        corroboration: 0,
        confidence: 'high',
      });
      continue;
    }

    // Step 1: inline citations
    const citedIds = extractInlineCitations(claim.text);
    const validIds = [...citedIds].filter((id) => factById.has(id));

    // Compute claim tokens once — reused for citation verification and the backstop.
    const claimTokens = contentTokensFact(claim.text);

    // Step 2: verify each cited fact has entity/token overlap with the claim.
    // Inline citations are LLM-supplied hints, not proof (issue #25, CWE-345).
    // A model that learns to append a known-good fact-id bypasses the gate unless
    // we check that the cited fact actually supports the claim.
    const verifiedIds = validIds.filter((id) => {
      const fact = factById.get(id);
      if (!fact) return false;
      // Entity gate: at least one fact entity must appear in the claim
      const factEntityTokens = contentTokensFact(fact.entities.join(' '));
      if ([...factEntityTokens].some((t) => claimTokens.has(t))) return true;
      // Fallback: significant token overlap between claim and fact content
      const factTokens = contentTokensFact(
        `${fact.statement} ${fact.entities.join(' ')} ${fact.quantity?.metric ?? ''}`,
      );
      const matchCount = [...factTokens].filter((t) => claimTokens.has(t)).length;
      return matchCount >= Math.max(2, Math.ceil(Math.min(claimTokens.size, factTokens.size) * 0.25));
    });

    let supportingFactIds = verifiedIds;

    // Step 3: backstop overlap when no verified inline citations.
    // #20 (CWE-345): pure lexical overlap is insufficient — require at least one
    // named entity from the fact to appear in the claim, plus a raised token
    // threshold, so topic-vocabulary coincidence cannot fabricate support.
    if (supportingFactIds.length === 0 && facts.length > 0) {
      const threshold = Math.max(3, Math.ceil(claimTokens.size * 0.35));
      for (const fact of facts) {
        // Entity gate: the claim must mention at least one of the fact's named entities.
        const factEntityTokens = contentTokensFact(fact.entities.join(' '));
        const hasEntityOverlap = [...factEntityTokens].some((t) => claimTokens.has(t));
        if (!hasEntityOverlap) continue;

        const factTokens = contentTokensFact(
          `${fact.statement} ${fact.entities.join(' ')} ${fact.quantity?.metric ?? ''}`,
        );
        const matchCount = [...factTokens].filter((t) => claimTokens.has(t)).length;
        if (matchCount >= threshold) {
          supportingFactIds.push(fact.id);
        }
      }
    }

    if (supportingFactIds.length === 0) {
      ungroundedClaims.push(claim);
    }

    // Compute corroboration from the supporting facts
    const corrobDomains = new Set<string>();
    for (const id of supportingFactIds) {
      const fact = factById.get(id);
      if (fact) {
        for (const p of fact.provenance) corrobDomains.add(p.sourceDomain);
      }
    }

    const confidence: Confidence = supportingFactIds.length === 0
      ? 'low'
      : corrobDomains.size >= 2 ? 'high' : 'medium';

    resultClaims.push({
      blockIndex: claim.blockIndex,
      text: claim.text,
      isEditorial: false,
      factIds: supportingFactIds,
      corroboration: corrobDomains.size,
      confidence,
    });
  }

  const isGrounded = ungroundedClaims.length === 0;
  return { claims: resultClaims, ungroundedClaims, isGrounded };
}

// ---------------------------------------------------------------------------
// Gate mode 2: Title-token (Rev 2 legacy fallback)
// ---------------------------------------------------------------------------

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

/** Derive a stable id for a SourceRef. */
function sourceRefId(ref: SourceRef): string {
  return `${ref.sourceDomain}::${encodeURIComponent(ref.title)}`;
}

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
 * Legacy title-token provenance gate. Used when no ExtractedFacts are available
 * (rev-2 aggregator). Matches claim token vocabulary against source titles.
 */
export function buildProvenance(
  articleId: string,
  claims: readonly { text: string; blockIndex: number; isEditorial: boolean }[],
  sources: readonly SourceRef[],
): ProvenanceMap {
  const citedSourceIdSet = new Set<string>();
  const resultClaims: LegacyClaimProvenance[] = [];

  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    if (!claim) continue;
    const supportingSourceIds: string[] = [];

    if (!claim.isEditorial) {
      const claimTokens = new Set(contentTokens(claim.text));
      const threshold = Math.max(2, Math.ceil(claimTokens.size * 0.25));

      for (const source of sources) {
        const srcTokens = contentTokens(`${source.title} ${source.source} ${source.sourceDomain}`);
        const matchCount = new Set(srcTokens.filter((t) => claimTokens.has(t))).size;
        if (matchCount >= threshold) {
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

/** True iff every factual claim has >= 1 supporting source (legacy gate). */
export function isFullyGrounded(map: ProvenanceMap): boolean {
  return map.unsupportedClaimCount === 0;
}
