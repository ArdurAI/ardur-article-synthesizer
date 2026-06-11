/**
 * Core synthesis orchestration (stage 4 body).
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
  SourceRef,
} from './contracts.ts';
import { SCHEMA_VERSION } from './contracts.ts';
import type { AiProvider } from './provider.ts';
import { buildDeterministicDraft } from './provider.ts';
import { planAssembly, toRenderBlocks, assembleArticle } from './assemble.ts';
import { buildVoiceDirective } from './style.ts';
import { buildProvenance, isFullyGrounded } from './provenance.ts';
import { enforceCopyright } from './copyright.ts';
import { validateRenderable } from './render.ts';
import { scrubUrl } from './privacy.ts';

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
  entry: Top10Entry,
  aggregation: AggregationArtifact,
): AggregatedItem[] {
  const { itemsByTopic, clustersByTopic } = aggregation.data;

  // Find the cluster metadata to get memberIds
  const topicClusters = clustersByTopic[entry.topic] ?? [];
  const cluster = topicClusters.find((c) => c.clusterId === entry.clusterId);

  if (!cluster) {
    // Try a global search across all topics
    for (const clusters of Object.values(clustersByTopic)) {
      const found = clusters.find((c) => c.clusterId === entry.clusterId);
      if (found) {
        // Retrieve items by memberId from whichever topic they live in
        return resolveMemberItems(found.memberIds, itemsByTopic);
      }
    }
    return [];
  }

  return resolveMemberItems(cluster.memberIds, itemsByTopic);
}

function resolveMemberItems(
  memberIds: string[],
  itemsByTopic: Record<string, AggregatedItem[]>,
): AggregatedItem[] {
  const idSet = new Set(memberIds);
  const results: AggregatedItem[] = [];
  for (const items of Object.values(itemsByTopic)) {
    for (const item of items) {
      if (idSet.has(item.id)) results.push(item);
    }
  }
  return results;
}

/** Convert AggregatedItem[] to SourceRef[] for the provider request. */
function toSourceRefs(items: AggregatedItem[]): SourceRef[] {
  return items.map((item) => ({
    source: item.source,
    sourceDomain: item.sourceDomain,
    tier: item.tier,
    url: scrubUrl(item.url) || item.url,
    title: item.title,
    publishedAt: item.publishedAt,
  }));
}

/** Build claim-level items for provenance from the article body. */
function extractClaims(
  blocks: { text?: string; items?: string[] }[],
): { text: string; blockIndex: number; isEditorial: boolean }[] {
  const claims: { text: string; blockIndex: number; isEditorial: boolean }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as { type?: string; text?: string; items?: string[] };
    // Headings and callouts are editorial framing
    const isEditorial = block.type === 'heading' || block.type === 'callout';
    const text = block.text ?? (block.items ?? []).join('; ');
    if (text.trim()) {
      claims.push({ text: text.trim(), blockIndex: i, isEditorial });
    }
  }
  return claims;
}

/** Synthesize a single article (steps 2–6 above). Resolves even on failure. */
export async function synthesizeOne(
  entry: Top10Entry,
  ctx: SynthesizeContext,
): Promise<{ article: SynthesizedArticle | null; warnings: string[] }> {
  const warnings: string[] = [];
  const { provider, now } = ctx;

  // Step 1 is handled by caller (resolveClusterMembers)
  const clusterMembers = resolveClusterMembers(entry, ctx.aggregation);

  if (clusterMembers.length === 0) {
    warnings.push(`No cluster members found for entry clusterId=${entry.clusterId} (topic=${entry.topic})`);
    // Fall through — synthesize from entry.references alone
  }

  // Use entry.references if we have no cluster members (degraded weave)
  const effectiveMembers: AggregatedItem[] =
    clusterMembers.length > 0 ? clusterMembers : entryReferencesToItems(entry);

  // Step 2: Build the assembly plan
  const plan = planAssembly(entry, effectiveMembers);

  // Build source refs for the provider request
  const refs = toSourceRefs(plan.references);

  // Build the deterministic draft first (always — becomes the fallback)
  const deterministicDraft = buildDeterministicDraft(
    {
      topic: entry.topic,
      topicLabel: entry.topicLabel,
      headline: entry.headline,
      references: refs,
      voiceDirective: buildVoiceDirective(),
    },
    entry.confidence,
  );

  // Step 3: Try AI provider (it will fall back to deterministicDraft internally)
  const genResult = await provider.generate({
    topic: entry.topic,
    topicLabel: entry.topicLabel,
    headline: entry.headline,
    references: refs,
    fallback: deterministicDraft,
    voiceDirective: buildVoiceDirective(),
  });

  if (genResult.meta.status === 'fallback' && genResult.meta.reason) {
    warnings.push(`Provider fallback for entry ${entry.rank}: ${genResult.meta.reason}`);
  }

  const draft = genResult.draft;

  // Step 4: Convert prose to render blocks + assemble article
  const blocks = toRenderBlocks(plan, draft.sections as Record<import('./assemble.ts').SectionId, string>);
  const article = assembleArticle(
    plan,
    blocks,
    draft,
    genResult.meta,
    ctx.top10.runId,
    now,
  );

  // Step 5: Provenance — every factual claim must be grounded
  const claims = extractClaims(blocks);
  const provenanceMap = buildProvenance(article.id, claims, refs);

  if (!isFullyGrounded(provenanceMap)) {
    warnings.push(
      `${provenanceMap.unsupportedClaimCount} ungrounded factual claim(s) in article for entry ${entry.rank} — degrading to deterministic`,
    );
    // Degrade: rebuild with the deterministic draft (which only references metadata, always grounded)
    const degradedBlocks = toRenderBlocks(plan, deterministicDraft.sections as Record<import('./assemble.ts').SectionId, string>);
    const degradedArticle = assembleArticle(
      plan,
      degradedBlocks,
      deterministicDraft,
      { ...genResult.meta, provider: 'deterministic', model: 'rules/v1', status: 'fallback', reason: 'ungrounded claims degraded' },
      ctx.top10.runId,
      now,
    );
    return tryFinalGates(degradedArticle, effectiveMembers, entry.rank, warnings);
  }

  return tryFinalGates(article, effectiveMembers, entry.rank, warnings);
}

/** Run copyright + render gates; on failure, degrade or drop. */
async function tryFinalGates(
  article: SynthesizedArticle,
  corpus: AggregatedItem[],
  rank: number,
  warnings: string[],
): Promise<{ article: SynthesizedArticle | null; warnings: string[] }> {
  // Step 6a: Copyright gate
  const copyrightResult = enforceCopyright(article, corpus);
  if (!copyrightResult.ok) {
    const kinds = copyrightResult.violations.map((v) => v.kind).join(', ');
    warnings.push(
      `Copyright gate failed for rank ${rank} (${kinds}); article dropped — failing closed`,
    );
    return { article: null, warnings };
  }

  // Step 6b: Render gate
  const renderViolations = validateRenderable(article);
  if (renderViolations.length > 0) {
    const kinds = renderViolations.map((v) => v.kind).join(', ');
    warnings.push(
      `Render gate failed for rank ${rank} (${kinds}); article dropped — failing closed`,
    );
    return { article: null, warnings };
  }

  return { article, warnings };
}

/** Synthesize every Top-10 entry into the final ArticleArtifact. */
export async function synthesizeCycle(ctx: SynthesizeContext): Promise<ArticleArtifact> {
  const { top10, aggregation, now } = ctx;

  // Validate that inputs share the same cycle
  const cycleWarnings: string[] = [];
  if (top10.cycle.id !== aggregation.cycle.id) {
    cycleWarnings.push(
      `Cycle id mismatch: top10=${top10.cycle.id} aggregation=${aggregation.cycle.id} — weaving from Top-10 references only`,
    );
  }

  // Gather all entries: global list + per-topic
  const allEntries = [
    ...top10.data.global,
    ...Object.values(top10.data.top10ByTopic).flat(),
  ];

  // Deduplicate entries by clusterId
  const seenClusterIds = new Set<string>();
  const uniqueEntries = allEntries.filter((entry) => {
    if (seenClusterIds.has(entry.clusterId)) return false;
    seenClusterIds.add(entry.clusterId);
    return true;
  });

  // Fan out: synthesize all entries (sequentially to respect budget ordering)
  const articles: SynthesizedArticle[] = [];
  const warnings: string[] = [...cycleWarnings];
  let dropped = 0;
  let degraded = 0;

  for (const entry of uniqueEntries) {
    const { article, warnings: entryWarnings } = await synthesizeOne(entry, ctx);
    warnings.push(...entryWarnings);

    if (article === null) {
      dropped++;
    } else {
      if (article.ai.status === 'fallback') degraded++;
      articles.push(article);
    }
  }

  // Add summary warnings
  if (dropped > 0) {
    warnings.push(`${dropped} article(s) dropped (copyright/render gate failures)`);
  }
  if (degraded > 0) {
    warnings.push(`${degraded} article(s) used deterministic fallback`);
  }

  const generationsUsed = ctx.provider.generationsUsed();
  if (generationsUsed > 0) {
    warnings.push(`AI provider used ${generationsUsed}/${ctx.maxGenerations} generation budget`);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'articles',
    runId: `synth-${top10.runId}-${now.toISOString()}`,
    upstreamRunId: top10.runId,
    generatedAt: now.toISOString(),
    cycle: top10.cycle,
    topics: top10.topics,
    provider: {
      provider: ctx.provider.name,
      model: 'mixed', // articles may use different providers
      status: generationsUsed > 0 ? 'generated' : 'fallback',
      generatedAt: now.toISOString(),
    },
    warnings,
    data: {
      articles,
      copyrightPolicy: {
        originalTextOnly: true,
        maxQuoteWords: 25,
        reproduceArticleBody: false,
        requireAttribution: true,
        requireCanonicalLinks: true,
      },
    },
  };
}

/**
 * Convert a Top10Entry's SourceRef[] to minimal AggregatedItem[] stubs so the
 * assembler can work when cluster members are unavailable (degraded weave).
 */
function entryReferencesToItems(entry: Top10Entry): AggregatedItem[] {
  return entry.references.map((ref, i) => ({
    id: `${entry.clusterId}-ref-${i}`,
    topic: entry.topic,
    topicLabel: entry.topicLabel,
    title: ref.title,
    source: ref.source,
    sourceDomain: ref.sourceDomain,
    sourceUrl: '',
    url: ref.url,
    tier: ref.tier,
    publishedAt: ref.publishedAt,
    summaryHint: ref.title,
    interaction: {
      feedRank: null,
      shares: null,
      comments: null,
      reactions: null,
      crossSourceMentions: 1,
      velocity: null,
      capturedAt: ref.publishedAt,
      provenance: 'entry-reference',
    },
    clusterId: entry.clusterId,
    fingerprint: `${ref.sourceDomain}::${ref.title.toLowerCase().replace(/\s+/g, '-')}`,
  }));
}
