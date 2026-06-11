/**
 * ardur-article-synthesizer — public entrypoint.
 *
 * Stage 4 of the Ardur content pipeline: take the `Top10Artifact` (what to write
 * about) plus the `AggregationArtifact` (the 20–30 clustered sources per topic),
 * and emit an `ArticleArtifact` containing one ORIGINAL, copyright-safe article
 * per Top-10 entry, rendered in-app with no navigation away.
 */
import { synthesizeCycle } from "./synthesize.js";
import { createProvider } from "./provider.js";
export * from "./contracts.js";
export { buildChartBlocks } from "./assemble.js";
/**
 * Synthesize one cycle's articles and return the artifact.
 *
 * Guarantees:
 *  - One `SynthesizedArticle` per `Top10Entry`, never more.
 *  - Every article passes the copyright guard (original text, quotes < 25 words,
 *    no reproduced bodies, attribution + canonical links present).
 *  - Every article carries provenance mapping each claim to supporting sources.
 *  - A model failure/budget exhaustion degrades that article to the deterministic
 *    path and records a `warning` — it never aborts the run.
 */
export function runSynthesis(options) {
    const provider = options.provider ?? createProvider();
    const now = options.now ?? new Date();
    return synthesizeCycle({
        top10: options.top10,
        aggregation: options.aggregation,
        provider,
        maxGenerations: options.maxGenerations ?? 20,
        perCallTimeoutMs: options.perCallTimeoutMs ?? 20_000,
        now,
        ...(options.runId !== undefined ? { runId: options.runId } : {}),
    });
}
