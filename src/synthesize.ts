/**
 * Core synthesis orchestration (stage 4 body).
 *
 * SCAFFOLD ONLY — signatures are final; bodies are stubs.
 *
 * Per Top-10 entry, in order:
 *   1. resolve the entry's cluster members from the AggregationArtifact.
 *   2. planAssembly() -> weave + reference plan.
 *   3. provider.generate() -> original section prose (deterministic if budget
 *      spent / provider disabled / call fails).
 *   4. toRenderBlocks() + assembleArticle() -> SynthesizedArticle draft.
 *   5. buildProvenance() -> require every factual claim is grounded.
 *   6. enforceCopyright() + validateRenderable() -> reject unsafe/unrenderable
 *      articles; degrade to a stricter deterministic article and warn.
 *
 * The function is idempotent per cycle id and never throws on per-article
 * failure — failures become `warnings` on the artifact.
 */

import type {
  ArticleArtifact,
  AggregationArtifact,
  Top10Artifact,
  Top10Entry,
  SynthesizedArticle,
  AggregatedItem,
} from './contracts.ts';
import type { AiProvider } from './provider.ts';

export interface SynthesizeContext {
  top10: Top10Artifact;
  aggregation: AggregationArtifact;
  provider: AiProvider;
  maxGenerations: number;
  perCallTimeoutMs: number;
  now: Date;
}

/** Resolve the cluster members backing one Top-10 entry from the aggregation. */
export function resolveClusterMembers(
  _entry: Top10Entry,
  _aggregation: AggregationArtifact,
): AggregatedItem[] {
  throw new Error('not implemented: map entry.clusterId -> AggregatedItem[]');
}

/** Synthesize a single article (steps 2–6 above). Resolves even on failure. */
export function synthesizeOne(
  _entry: Top10Entry,
  _ctx: SynthesizeContext,
): Promise<{ article: SynthesizedArticle | null; warnings: string[] }> {
  throw new Error('not implemented: assemble -> generate -> guard one article');
}

/** Synthesize every Top-10 entry into the final ArticleArtifact. */
export function synthesizeCycle(_ctx: SynthesizeContext): Promise<ArticleArtifact> {
  throw new Error('not implemented: fan out over top10 entries, collect ArticleArtifact');
}
