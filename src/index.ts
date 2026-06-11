/**
 * ardur-article-synthesizer — public entrypoint.
 *
 * Stage 4 of the Ardur content pipeline: take the `Top10Artifact` (what to write
 * about) plus the `AggregationArtifact` (the 20–30 clustered sources per topic),
 * and emit an `ArticleArtifact` containing one ORIGINAL, copyright-safe article
 * per Top-10 entry, rendered in-app with no navigation away.
 *
 * SCAFFOLD ONLY — wiring/signatures are final; module bodies are stubs. The
 * synthesis logic is intentionally NOT implemented here (see docs/spec.md).
 */

import type {
  ArticleArtifact,
  AggregationArtifact,
  Top10Artifact,
  CycleMeta,
} from './contracts.ts';

export * from './contracts.ts';
export type { AiProvider, ProviderName, GenerateRequest, GenerateResult } from './provider.ts';
export type { ClaimProvenance, ProvenanceMap } from './provenance.ts';
export type { CopyrightVerdict, CopyrightViolation } from './copyright.ts';
export type { RenderContract, RenderViolation } from './render.ts';
export type { AssemblyPlan, SectionSpec } from './assemble.ts';

export interface SynthesisOptions {
  /**
   * The upstream Top-10 selection — defines WHICH topics get an article and the
   * rank/confidence/references carried forward.
   */
  top10: Top10Artifact;
  /**
   * The aggregation artifact for the SAME cycle — supplies the cluster members
   * (20–30 sources/topic) that are woven into each article. Must share
   * `cycle.id` with `top10`; mismatches are recorded as warnings.
   */
  aggregation: AggregationArtifact;
  /** Override the cycle (defaults to `top10.cycle`). */
  cycle?: CycleMeta;
  /**
   * Hard cap on AI model calls for this run (default `ARDUR_AI_MAX_GENERATIONS`,
   * else 20). Once exhausted, remaining articles use the deterministic path.
   */
  maxGenerations?: number;
  /** Per-model-call timeout before deterministic fallback (default 20000ms). */
  perCallTimeoutMs?: number;
  /** Override the wall clock (testing/replay). */
  now?: Date;
  /** Injected provider for tests; defaults to the env-resolved provider chain. */
  provider?: import('./provider.ts').AiProvider;
}

/**
 * Synthesize one cycle's articles and return the artifact.
 *
 * Guarantees (enforced even in stubs once implemented):
 *  - One `SynthesizedArticle` per `Top10Entry`, never more.
 *  - Every article passes the copyright guard (original text, quotes < 25 words,
 *    no reproduced bodies, attribution + canonical links present).
 *  - Every article carries provenance mapping each claim to supporting sources.
 *  - A model failure/budget exhaustion degrades that article to the deterministic
 *    path and records a `warning` — it never aborts the run.
 */
export function runSynthesis(_options: SynthesisOptions): Promise<ArticleArtifact> {
  throw new Error(
    'not implemented: top10 -> gather cluster members -> assemble -> provider -> copyright + provenance guards -> ArticleArtifact',
  );
}
