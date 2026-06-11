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

import type {
  ArticleArtifact,
  AggregationArtifact,
  Top10Artifact,
  Top10Entry,
  SynthesizedArticle,
  AggregatedItem,
  SourceRef,
  ExtractedFact,
  ArticleBlock,
  ChartBlock,
} from './contracts.ts';
import { SCHEMA_VERSION, CONTRACT_REVISION, assertCompatibleArtifact } from './contracts.ts';
import type { AiProvider } from './provider.ts';
import { buildDeterministicDraft } from './provider.ts';
import { planAssembly, toRenderBlocks, assembleArticle, buildChartBlocks } from './assemble.ts';
import type { SectionId } from './assemble.ts';
import { buildVoiceDirective } from './style.ts';
import { buildProvenanceFromFacts, buildProvenance, isFullyGrounded } from './provenance.ts';
import type { ClaimInput } from './provenance.ts';
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
  /** Override the artifact run ID for deterministic replay (--run-id). */
  runId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the cluster members backing one Top-10 entry from the aggregation. */
export function resolveClusterMembers(
  entry: Top10Entry,
  aggregation: AggregationArtifact,
): AggregatedItem[] {
  const { itemsByTopic, clustersByTopic } = aggregation.data;

  const topicClusters = clustersByTopic[entry.topic] ?? [];
  const cluster = topicClusters.find((c) => c.clusterId === entry.clusterId);

  if (!cluster) {
    for (const clusters of Object.values(clustersByTopic)) {
      const found = clusters.find((c) => c.clusterId === entry.clusterId);
      if (found) return resolveMemberItems(found.memberIds, itemsByTopic);
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

/**
 * Resolve ExtractedFacts for one cluster from the aggregation.
 * Returns [] when no facts are available (rev-2 aggregator).
 */
function resolveFacts(
  entry: Top10Entry,
  aggregation: AggregationArtifact,
): ExtractedFact[] {
  return (aggregation.data.factsByCluster ?? {})[entry.clusterId] ?? [];
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

/**
 * Extract claim-bearing sentences from the article body for the provenance gate.
 * Headings and callouts are editorial framing (not fact-gated).
 */
function extractClaimsFromBlocks(blocks: ArticleBlock[]): ClaimInput[] {
  const claims: ClaimInput[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as { type?: string; text?: string; items?: string[] };
    if (!block) continue;
    if (block.type === 'chart' || block.type === 'image' || block.type === 'gif' || block.type === 'embed') continue;
    const isEditorial = block.type === 'heading' || block.type === 'callout';
    const text = block.text ?? (block.items ?? []).join('; ');
    if (text.trim()) {
      claims.push({ text: text.trim(), blockIndex: i, isEditorial });
    }
  }
  return claims;
}

/**
 * Build a held article (LLM unavailable or grounding failed).
 * Uses the deterministic draft content but marks the article as held.
 * HELD articles are never published to readers; they surface in the editorial queue.
 */
function buildHeldArticle(
  entry: Top10Entry,
  members: AggregatedItem[],
  heldReason: string,
  upstreamRunId: string,
  now: Date,
): SynthesizedArticle {
  const refs = toSourceRefs(members.length > 0 ? members : entryReferencesToItems(entry));
  const plan = planAssembly(entry, members.length > 0 ? members : entryReferencesToItems(entry));
  const heldDraft = buildDeterministicDraft(
    { topic: entry.topic, topicLabel: entry.topicLabel, headline: entry.headline, references: refs, voiceDirective: buildVoiceDirective() },
    entry.confidence,
  );
  const blocks = toRenderBlocks(plan, heldDraft.sections as Record<SectionId, string>);
  const base = assembleArticle(
    plan,
    blocks,
    heldDraft,
    { provider: 'deterministic', model: 'rules/v1', status: 'fallback', reason: heldReason, generatedAt: now.toISOString() },
    upstreamRunId,
    now,
  );
  // editorialStatus is additive (Rev 3); cast through unknown for type compatibility
  // with rev-2 consumers that don't know the field. The field is optional in contracts Rev 3.
  return { ...base, editorialStatus: 'held' } as SynthesizedArticle;
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

/** Merge item-level claims into an article's tags (additive, deduped). */
function withItemClaims(article: SynthesizedArticle, itemClaims: string[]): SynthesizedArticle {
  if (itemClaims.length === 0) return article;
  return { ...article, tags: [...new Set([...article.tags, ...itemClaims])] };
}

// ---------------------------------------------------------------------------
// Per-article synthesis (S1-S4)
// ---------------------------------------------------------------------------

/** Synthesize a single article. Resolves even on failure (HOLD or null). */
export async function synthesizeOne(
  entry: Top10Entry,
  ctx: SynthesizeContext,
): Promise<{ article: SynthesizedArticle | null; warnings: string[] }> {
  const warnings: string[] = [];
  const { provider, now } = ctx;

  // Step 1: resolve cluster members + facts (S1)
  const clusterMembers = resolveClusterMembers(entry, ctx.aggregation);
  const clusterFacts = resolveFacts(entry, ctx.aggregation);
  const hasFacts = clusterFacts.length > 0;

  if (clusterMembers.length === 0) {
    warnings.push(`No cluster members found for clusterId=${entry.clusterId} (topic=${entry.topic})`);
  }

  const effectiveMembers: AggregatedItem[] =
    clusterMembers.length > 0 ? clusterMembers : entryReferencesToItems(entry);

  const itemClaims = [...new Set(effectiveMembers.flatMap((m) => m.claims ?? []))];

  // Step 2: build assembly plan
  const plan = planAssembly(entry, effectiveMembers);
  const refs = toSourceRefs(plan.references);

  // Build deterministic draft for context (NOT for publishing — only for the prompt fallback field)
  const deterministicDraft = buildDeterministicDraft(
    { topic: entry.topic, topicLabel: entry.topicLabel, headline: entry.headline, references: refs, voiceDirective: buildVoiceDirective() },
    entry.confidence,
  );

  // Step 3: AI-primary synthesis (S2) — if provider is unavailable → HOLD
  if (!provider.canGenerate()) {
    warnings.push(`AI budget exhausted for entry ${entry.rank} — article held`);
    return { article: withItemClaims(buildHeldArticle(entry, effectiveMembers, 'ai-budget-exhausted', ctx.top10.runId, now), itemClaims), warnings };
  }

  const genResult = await provider.generate({
    topic: entry.topic,
    topicLabel: entry.topicLabel,
    headline: entry.headline,
    references: refs,
    ...(hasFacts ? { facts: clusterFacts } : {}),
    fallback: deterministicDraft,
    voiceDirective: buildVoiceDirective(),
  });

  // S2: deterministic result (provider unavailable or forced) → HOLD, not flat-publish
  if (genResult.meta.provider === 'deterministic' || genResult.meta.status === 'fallback') {
    const reason = genResult.meta.reason ?? 'ai-unavailable';
    warnings.push(`AI unavailable for entry ${entry.rank} (${reason}) — article held`);
    return { article: withItemClaims(buildHeldArticle(entry, effectiveMembers, reason, ctx.top10.runId, now), itemClaims), warnings };
  }

  // LLM generated successfully — build initial blocks
  const textBlocks = toRenderBlocks(plan, genResult.draft.sections as Record<SectionId, string>);

  // Step 4: S4 — build chart blocks from real extracted numbers
  const chartBlocks: ChartBlock[] = buildChartBlocks(clusterFacts, refs);

  // Insert charts after the first heading section for max readability
  const allBlocks: ArticleBlock[] = insertVisualBlocks(textBlocks, chartBlocks);

  // Build the initial article (will be replaced on re-ask)
  let article = assembleArticle(plan, allBlocks, genResult.draft, genResult.meta, ctx.top10.runId, now);

  // Step 5: S3 — claim-level provenance gate
  const claims = extractClaimsFromBlocks(allBlocks);

  if (hasFacts) {
    // Primary gate: fact-grounded
    const provenanceResult = buildProvenanceFromFacts(article.id, claims, clusterFacts);

    if (!provenanceResult.isGrounded) {
      // One bounded re-ask
      const ungroundedTexts = provenanceResult.ungroundedClaims.map((c) => c.text);
      warnings.push(
        `${ungroundedTexts.length} ungrounded claim(s) in entry ${entry.rank} — attempting re-ask`,
      );

      if (provider.canGenerate()) {
        const reaskResult = await provider.generate({
          topic: entry.topic,
          topicLabel: entry.topicLabel,
          headline: entry.headline,
          references: refs,
          facts: clusterFacts,
          fallback: deterministicDraft,
          voiceDirective: buildVoiceDirective(),
          reaskClaims: ungroundedTexts,
        });

        if (reaskResult.meta.provider === 'deterministic' || reaskResult.meta.status === 'fallback') {
          warnings.push(`Re-ask returned deterministic for entry ${entry.rank} — article held`);
          return { article: withItemClaims(buildHeldArticle(entry, effectiveMembers, 'ungrounded-after-regrounding', ctx.top10.runId, now), itemClaims), warnings };
        }

        // Rebuild with re-asked content
        const reaskTextBlocks = toRenderBlocks(plan, reaskResult.draft.sections as Record<SectionId, string>);
        const reaskAllBlocks: ArticleBlock[] = insertVisualBlocks(reaskTextBlocks, chartBlocks);
        article = assembleArticle(plan, reaskAllBlocks, reaskResult.draft, reaskResult.meta, ctx.top10.runId, now);

        const reaskClaims = extractClaimsFromBlocks(reaskAllBlocks);
        const reaskProvenanceResult = buildProvenanceFromFacts(article.id, reaskClaims, clusterFacts);

        if (!reaskProvenanceResult.isGrounded) {
          warnings.push(`Ungrounded claims persist after re-ask for entry ${entry.rank} — article held`);
          return { article: withItemClaims(buildHeldArticle(entry, effectiveMembers, 'ungrounded-after-regrounding', ctx.top10.runId, now), itemClaims), warnings };
        }

        // Re-ask succeeded — attach provenance
        const publishedArticle = buildPublishedArticle(article, reaskProvenanceResult.claims, clusterFacts, itemClaims);
        return await runFinalGates(publishedArticle, effectiveMembers, entry.rank, warnings);
      } else {
        warnings.push(`Re-ask budget exhausted for entry ${entry.rank} — article held`);
        return { article: withItemClaims(buildHeldArticle(entry, effectiveMembers, 'ungrounded-after-regrounding', ctx.top10.runId, now), itemClaims), warnings };
      }
    }

    const publishedArticle = buildPublishedArticle(article, provenanceResult.claims, clusterFacts, itemClaims);
    return await runFinalGates(publishedArticle, effectiveMembers, entry.rank, warnings);
  } else {
    // Legacy gate: title-token heuristic (rev-2 aggregator, no facts)
    const legacyProvenanceMap = buildProvenance(article.id, claims, refs);

    if (!isFullyGrounded(legacyProvenanceMap)) {
      warnings.push(
        `${legacyProvenanceMap.unsupportedClaimCount} ungrounded claim(s) in entry ${entry.rank} (rev-2 gate, no facts) — article held`,
      );
      return { article: withItemClaims(buildHeldArticle(entry, effectiveMembers, 'ungrounded-no-facts', ctx.top10.runId, now), itemClaims), warnings };
    }

    const publishedArticle = withItemClaims(
      { ...article, editorialStatus: 'published' as const } as SynthesizedArticle,
      itemClaims,
    );
    return await runFinalGates(publishedArticle, effectiveMembers, entry.rank, warnings);
  }
}

/** Merge ClaimProvenance[] and facts into the article for the wire format. */
function buildPublishedArticle(
  base: SynthesizedArticle,
  claimProvenances: import('./contracts.ts').ClaimProvenance[],
  facts: ExtractedFact[],
  itemClaims: string[],
): SynthesizedArticle {
  const merged = {
    ...base,
    editorialStatus: 'published' as const,
    facts,
    claims: claimProvenances,
    tags: [...new Set([...base.tags, ...itemClaims])],
  } as SynthesizedArticle;
  return merged;
}

/** Insert visual blocks after the first heading+paragraph pair. */
function insertVisualBlocks(textBlocks: ArticleBlock[], visuals: ChartBlock[]): ArticleBlock[] {
  if (visuals.length === 0) return textBlocks;
  const firstHeadingIdx = textBlocks.findIndex((b) => b.type === 'heading');
  // Insert after the first heading plus one content block
  const insertAt = firstHeadingIdx >= 0 ? Math.min(firstHeadingIdx + 2, textBlocks.length) : textBlocks.length;
  return [
    ...textBlocks.slice(0, insertAt),
    ...visuals,
    ...textBlocks.slice(insertAt),
  ];
}

/** Run copyright + render gates on a publishable article. */
async function runFinalGates(
  article: SynthesizedArticle,
  corpus: AggregatedItem[],
  rank: number,
  warnings: string[],
): Promise<{ article: SynthesizedArticle | null; warnings: string[] }> {
  const copyrightResult = enforceCopyright(article, corpus);
  if (!copyrightResult.ok) {
    const kinds = copyrightResult.violations.map((v) => v.kind).join(', ');
    warnings.push(`Copyright gate failed for rank ${rank} (${kinds}); article dropped — failing closed`);
    return { article: null, warnings };
  }

  const renderViolations = validateRenderable(article);
  if (renderViolations.length > 0) {
    const kinds = renderViolations.map((v) => v.kind).join(', ');
    warnings.push(`Render gate failed for rank ${rank} (${kinds}); article dropped — failing closed`);
    return { article: null, warnings };
  }

  return { article, warnings };
}

// ---------------------------------------------------------------------------
// Cycle-level synthesis
// ---------------------------------------------------------------------------

/** Synthesize every Top-10 entry into the final ArticleArtifact. */
export async function synthesizeCycle(ctx: SynthesizeContext): Promise<ArticleArtifact> {
  const { top10, aggregation, now } = ctx;

  const gateWarnings: string[] = [];
  const { warnings: w1 } = assertCompatibleArtifact(top10 as unknown, 'top10');
  gateWarnings.push(...w1);
  const { warnings: w2 } = assertCompatibleArtifact(aggregation as unknown, 'aggregation');
  gateWarnings.push(...w2);

  const cycleWarnings: string[] = [...gateWarnings];
  if (top10.cycle.id !== aggregation.cycle.id) {
    cycleWarnings.push(
      `Cycle id mismatch: top10=${top10.cycle.id} aggregation=${aggregation.cycle.id} — weaving from Top-10 references only`,
    );
  }

  const allEntries = [
    ...top10.data.global,
    ...Object.values(top10.data.top10ByTopic).flat(),
  ];

  const seenClusterIds = new Set<string>();
  const uniqueEntries = allEntries.filter((entry) => {
    if (seenClusterIds.has(entry.clusterId)) return false;
    seenClusterIds.add(entry.clusterId);
    return true;
  });

  const articles: SynthesizedArticle[] = [];
  const warnings: string[] = [...cycleWarnings];
  let dropped = 0;
  let held = 0;
  let generated = 0;

  for (const entry of uniqueEntries) {
    const { article, warnings: entryWarnings } = await synthesizeOne(entry, ctx);
    warnings.push(...entryWarnings);

    if (article === null) {
      dropped++;
    } else {
      const status = (article as { editorialStatus?: string }).editorialStatus;
      if (status === 'held') held++;
      else generated++;
      articles.push(article);
    }
  }

  if (dropped > 0) warnings.push(`${dropped} article(s) dropped (copyright/render gate failures)`);
  if (held > 0) warnings.push(`${held} article(s) held (AI unavailable or grounding failed)`);

  const generationsUsed = ctx.provider.generationsUsed();
  if (generationsUsed > 0) {
    warnings.push(`AI provider used ${generationsUsed}/${ctx.maxGenerations} generation budget`);
  }
  if (generated === 0 && articles.length > 0) {
    warnings.push(`All ${articles.length} article(s) are held — no AI-generated content published`);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    contractRevision: CONTRACT_REVISION,
    artifact: 'articles',
    runId: ctx.runId ?? `synth-${top10.runId}-${now.toISOString()}`,
    upstreamRunId: top10.runId,
    generatedAt: now.toISOString(),
    cycle: top10.cycle,
    topics: top10.topics,
    provider: {
      provider: ctx.provider.name,
      model: 'mixed',
      status: generated > 0 ? 'generated' : 'fallback',
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
