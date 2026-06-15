/**
 * ardur-article-synthesizer — public entrypoint.
 *
 * Stage 4 of the Ardur content pipeline: take the `Top10Artifact` (what to write
 * about) plus the `AggregationArtifact` (the 20–30 clustered sources per topic),
 * and emit an `ArticleArtifact` containing one ORIGINAL, copyright-safe article
 * per Top-10 entry, rendered in-app with no navigation away.
 */

import type {
  ArticleArtifact,
  AggregationArtifact,
  Top10Artifact,
  CycleMeta,
} from './contracts.ts';
import { synthesizeCycle } from './synthesize.ts';
import type { ArticleArtifactExtended } from './synthesize.ts';
import { createProvider } from './provider.ts';
import type { AiProvider } from './provider.ts';

export * from './contracts.ts';
export type { ArticleArtifactExtended } from './synthesize.ts';
export type { AiProvider, ProviderName, GenerateRequest, GenerateResult } from './provider.ts';
export type {
  ClaimInput,
  LegacyClaimProvenance,
  ProvenanceMap,
  FactProvenanceResult,
  SupportStrength,
} from './provenance.ts';
export type { CopyrightVerdict, CopyrightViolation } from './copyright.ts';
export type { RenderContract, RenderViolation, RenderViolationKind } from './render.ts';
export type { AssemblyPlan, SectionSpec } from './assemble.ts';
export { buildChartBlocks } from './assemble.ts';

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
  provider?: AiProvider;
  /** Override the artifact run ID for deterministic replay (--run-id). */
  runId?: string;
}

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
export function runSynthesis(options: SynthesisOptions): Promise<ArticleArtifactExtended> {
  const now = options.now ?? new Date();
  // Thread caller-supplied budget/timeout/now into the auto-created provider so
  // the library API honours these options (issue #32).
  const provider = options.provider ?? createProvider({
    ...(options.maxGenerations !== undefined ? { maxGenerations: options.maxGenerations } : {}),
    ...(options.perCallTimeoutMs !== undefined ? { timeoutMs: options.perCallTimeoutMs } : {}),
    now,
  });

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
