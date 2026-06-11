/**
 * Core synthesis orchestration (stage 4 body) — Rev 3 redesign.
 *
 * Per Top-10 entry:
 *   1. Resolve cluster members + ExtractedFacts from the AggregationArtifact.
 *   2. planAssembly() → weave + reference plan.
 *   3. provider.generate(facts) → LLM writes article FROM facts (AI-primary).
 *      If provider returns deterministic fallback → HOLD (never flat-publish).
 *   4. toRenderBlocks() → ArticleBlock[] text body.
 *   5. buildChartBlocks(facts) → ChartBlock[] visual blocks (S4).
 *   6. Claim-level provenance gate (S3):
 *      - With facts: buildProvenanceFromFacts() → inline [FACT:id] + overlap.
 *      - Without facts (rev-2 aggregator): legacy title-token gate.
 *      - Ungrounded → one bounded re-ask → still ungrounded → HOLD.
 *   7. enforceCopyright() + validateRenderable() on publishable articles only.
 *      Copyright fails → DROP (fail closed). HOLD articles bypass gates.
 *   8. Assemble SynthesizedArticle with editorialStatus + facts + claims.
 *
 * HOLD articles appear in the artifact with editorialStatus: 'held'.
 * The pipeline (P1) must NOT publish held articles to readers.
 * Dropped articles (copyright/render gate failure) are omitted entirely.
 */
import type { ArticleArtifact, AggregationArtifact, Top10Artifact, Top10Entry, SynthesizedArticle, AggregatedItem } from './contracts.ts';
/**
 * ArticleArtifact extended with a separate held-articles queue (#18).
 * `data.articles` contains ONLY published articles.
 * `data.heldArticles` contains articles that passed copyright/render/credential
 * gates but were held for editorial reasons (AI unavailable, ungrounded claims,
 * no-facts path). The pipeline must NOT serve held articles to readers.
 */
export type ArticleArtifactExtended = Omit<ArticleArtifact, 'data'> & {
    data: ArticleArtifact['data'] & {
        heldArticles: SynthesizedArticle[];
    };
};
import type { AiProvider } from './provider.ts';
export interface SynthesizeContext {
    top10: Top10Artifact;
    aggregation: AggregationArtifact;
    provider: AiProvider;
    maxGenerations: number;
    perCallTimeoutMs: number;
    now: Date;
    /** Override the artifact run ID for deterministic replay (--run-id). */
    runId?: string;
}
/** Resolve the cluster members backing one Top-10 entry from the aggregation. */
export declare function resolveClusterMembers(entry: Top10Entry, aggregation: AggregationArtifact): AggregatedItem[];
/** Synthesize a single article. Resolves even on failure (HOLD or null). */
export declare function synthesizeOne(entry: Top10Entry, ctx: SynthesizeContext): Promise<{
    article: SynthesizedArticle | null;
    warnings: string[];
}>;
/** Synthesize every Top-10 entry into the final ArticleArtifact. */
export declare function synthesizeCycle(ctx: SynthesizeContext): Promise<ArticleArtifactExtended>;
