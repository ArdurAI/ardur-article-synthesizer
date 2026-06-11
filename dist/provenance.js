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
/**
 * Extract inline [FACT:id] citations from a claim sentence.
 * Returns the set of fact IDs cited.
 */
function extractInlineCitations(text) {
    const ids = new Set();
    for (const match of text.matchAll(/\[FACT:([^\]]+)\]/g)) {
        const id = match[1]?.trim();
        if (id)
            ids.add(id);
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
function contentTokensFact(text) {
    return new Set(text
        .toLowerCase()
        .replace(/\[FACT:[^\]]+\]/g, ' ') // strip citations before tokenizing
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOP_WORDS_FACT.has(w)));
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
export function buildProvenanceFromFacts(articleId, claims, facts) {
    const factById = new Map(facts.map((f) => [f.id, f]));
    const resultClaims = [];
    const ungroundedClaims = [];
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
        let supportingFactIds = validIds;
        // Step 2: backstop overlap when no valid inline citations.
        // #20 (CWE-345): pure lexical overlap is insufficient — require at least one
        // named entity from the fact to appear in the claim, plus a raised token
        // threshold, so topic-vocabulary coincidence cannot fabricate support.
        if (supportingFactIds.length === 0 && facts.length > 0) {
            const claimTokens = contentTokensFact(claim.text);
            const threshold = Math.max(3, Math.ceil(claimTokens.size * 0.35));
            for (const fact of facts) {
                // Entity gate: the claim must mention at least one of the fact's named entities.
                const factEntityTokens = contentTokensFact(fact.entities.join(' '));
                const hasEntityOverlap = [...factEntityTokens].some((t) => claimTokens.has(t));
                if (!hasEntityOverlap)
                    continue;
                const factTokens = contentTokensFact(`${fact.statement} ${fact.entities.join(' ')} ${fact.quantity?.metric ?? ''}`);
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
        const corrobDomains = new Set();
        for (const id of supportingFactIds) {
            const fact = factById.get(id);
            if (fact) {
                for (const p of fact.provenance)
                    corrobDomains.add(p.sourceDomain);
            }
        }
        const confidence = supportingFactIds.length === 0
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
/** Derive a stable id for a SourceRef. */
function sourceRefId(ref) {
    return `${ref.sourceDomain}::${encodeURIComponent(ref.title)}`;
}
const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'to', 'of', 'and', 'in', 'for', 'on', 'with', 'that', 'this', 'from',
    'it', 'its', 'at', 'by', 'or', 'but', 'as', 'has', 'have', 'had',
    'not', 'all', 'will', 'can', 'may', 'could', 'would', 'should',
]);
function contentTokens(text) {
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
export function buildProvenance(articleId, claims, sources) {
    const citedSourceIdSet = new Set();
    const resultClaims = [];
    for (let i = 0; i < claims.length; i++) {
        const claim = claims[i];
        if (!claim)
            continue;
        const supportingSourceIds = [];
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
        let strength;
        if (claim.isEditorial) {
            strength = 'inferred';
        }
        else if (supportingSourceIds.length >= 2) {
            strength = 'corroborated';
        }
        else if (supportingSourceIds.length === 1) {
            strength = 'single-source';
        }
        else {
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
    const unsupportedClaimCount = resultClaims.filter((c) => !c.isEditorial && c.supportingSourceIds.length === 0).length;
    return {
        claims: resultClaims,
        citedSources: [...citedSources],
        unsupportedClaimCount,
    };
}
/** True iff every factual claim has >= 1 supporting source (legacy gate). */
export function isFullyGrounded(map) {
    return map.unsupportedClaimCount === 0;
}
