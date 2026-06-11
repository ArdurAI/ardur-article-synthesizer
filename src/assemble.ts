/**
 * Article assembly rules — how 20–30 sources become ONE original piece.
 *
 * Mirrors the section order from ardur.ai's content-engine contract so the
 * in-app render matches the existing site:
 *   Key Takeaway -> Why This Matters -> What Happened -> Builder View ->
 *   Open Questions -> Ardur Take
 *
 * The assembler:
 *  - dedups and ranks the cluster's members into a weave order (primary/paper
 *    sources first, then corroborating news), capping the reference list.
 *  - asks the provider for original prose per section, grounded in metadata only.
 *  - converts prose into the `ArticleBlock[]` in-app render model.
 *  - inserts at most one short (< 25-word) attributed quote where a primary
 *    source's exact wording is editorially necessary.
 *  - computes wordCount + readingTime and the source-trail block.
 *
 * VOICE: every section is assembled in the Ardur house voice
 * ("GenZ-but-professional", see `style.ts` + docs/voice.md). The plan carries a
 * per-section voice directive that is threaded into BOTH the provider prompt and
 * the deterministic fallback templates, so a budget=0 article still reads in
 * voice rather than as dry newswire. Voice never overrides the copyright,
 * provenance, or render gates.
 */

import type { ArticleBlock, SynthesizedArticle, AggregatedItem, Top10Entry, ArticleReference, SourceTier, ProviderMeta } from './contracts.ts';
import { VOICE_STYLE, SECTION_VOICE, buildVoiceDirective, lintVoice, type VoiceStyle } from './style.ts';
import { scrubUrl } from './privacy.ts';
import type { ArticleDraft } from './provider.ts';

export { VOICE_STYLE, SECTION_VOICE, buildVoiceDirective };

/** Canonical section ids, in render order. */
export type SectionId =
  | 'key-takeaway'
  | 'why-this-matters'
  | 'what-happened'
  | 'builder-view'
  | 'open-questions'
  | 'ardur-take';

export interface SectionSpec {
  id: SectionId;
  heading: string;
  /** Whether the section is required for a publishable article. */
  required: boolean;
  /** Soft word target — guides the provider, not a hard cap. */
  targetWords: number;
}

/** The fixed section plan (order matters; it is the render contract). */
export const SECTION_PLAN: readonly SectionSpec[] = [
  { id: 'key-takeaway', heading: 'Key Takeaway', required: true, targetWords: 60 },
  { id: 'why-this-matters', heading: 'Why This Matters', required: true, targetWords: 110 },
  { id: 'what-happened', heading: 'What Happened', required: true, targetWords: 140 },
  { id: 'builder-view', heading: 'Builder View', required: false, targetWords: 120 },
  { id: 'open-questions', heading: 'Open Questions', required: false, targetWords: 80 },
  { id: 'ardur-take', heading: 'Ardur Take', required: true, targetWords: 90 },
];

/** Default cap on how many references the source-trail block lists. */
export const MAX_REFERENCES = 30;

/** Minimum body length (words) for a publishable, non-`idea` article. */
export const MIN_BODY_WORDS = 150;

/** Tier priority for weave ordering (lower index = more authoritative). */
const TIER_ORDER: SourceTier[] = ['primary', 'paper', 'technical-news', 'security-news', 'news'];

function tierWeight(tier: SourceTier): number {
  const idx = TIER_ORDER.indexOf(tier);
  return idx === -1 ? TIER_ORDER.length : idx;
}

/** The ordered weave plan for one topic before prose is generated. */
export interface AssemblyPlan {
  entry: Top10Entry;
  /** Cluster members in weave order (most authoritative first). */
  weave: AggregatedItem[];
  /** Reference list after dedup + cap. */
  references: AggregatedItem[];
  sections: readonly SectionSpec[];
  /** The voice this article is written in (defaults to VOICE_STYLE). */
  voice: VoiceStyle;
  /**
   * Per-section voice directive (from `buildVoiceDirective`), threaded into both
   * the provider prompt and the deterministic fallback so both paths sound the
   * same. Keyed by SectionId.
   */
  voiceDirectives: Record<SectionId, string>;
}

/**
 * Build the deterministic weave/reference plan for a Top-10 entry from its
 * cluster members. No prose yet — this decides ordering, dedup, caps, AND the
 * per-section voice directives (from `style.ts`) that downstream prose obeys.
 */
export function planAssembly(
  entry: Top10Entry,
  clusterMembers: readonly AggregatedItem[],
  voice: VoiceStyle = VOICE_STYLE,
): AssemblyPlan {
  // 1. Dedup by fingerprint (normalized source+title, per spec §5.1)
  const seen = new Set<string>();
  const deduped: AggregatedItem[] = [];
  for (const item of clusterMembers) {
    if (!seen.has(item.fingerprint)) {
      seen.add(item.fingerprint);
      deduped.push(item);
    }
  }

  // 2. Rank for weave: tier first, then recency, then cross-source corroboration
  const sorted = [...deduped].sort((a, b) => {
    const tierDiff = tierWeight(a.tier) - tierWeight(b.tier);
    if (tierDiff !== 0) return tierDiff;
    // More recent first within the same tier
    const dateA = new Date(a.publishedAt).getTime();
    const dateB = new Date(b.publishedAt).getTime();
    if (dateB !== dateA) return dateB - dateA;
    // More corroborated first (higher cross-source mentions)
    return (b.interaction.crossSourceMentions ?? 0) - (a.interaction.crossSourceMentions ?? 0);
  });

  // 3. Cap reference list at MAX_REFERENCES
  const references = sorted.slice(0, MAX_REFERENCES);
  // Full weave order for prose generation (all deduped, uncapped)
  const weave = sorted;

  // 4. Build per-section voice directives
  const voiceDirectives = {} as Record<SectionId, string>;
  for (const section of SECTION_PLAN) {
    voiceDirectives[section.id] = buildVoiceDirective(voice, section.id);
  }

  return { entry, weave, references, sections: SECTION_PLAN, voice, voiceDirectives };
}

// ---------------------------------------------------------------------------
// Block conversion helpers
// ---------------------------------------------------------------------------

/** Rough word count of a string. */
function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

/** Remove raw HTML tags from text (safety, belt-and-suspenders). */
function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

/**
 * Apply voice lint to a text, replacing banned phrases with plainer wording.
 * Non-blocking — accuracy and copyright gates already passed.
 */
function applyVoiceLint(text: string, voice: VoiceStyle): string {
  const offenders = lintVoice(text, voice);
  if (offenders.length === 0) return text;

  let cleaned = text;
  // Replace banned lexicon items with plainer alternatives
  const REPLACEMENTS: Record<string, string> = {
    'game-changer': 'meaningful shift',
    'game changer': 'meaningful shift',
    "you won't believe": 'note that',
    'breaking': 'new',
    'shocking': 'notable',
    'mind-blowing': 'impressive',
    'insane': 'substantial',
    'revolutionary': 'significant',
    'unprecedented': 'notable',
    'must-read': 'worth reading',
    'thread': 'post',
    'no cap': '',
    'slaps': 'works well',
    'goes hard': 'delivers',
    'lowkey': '',
    'highkey': '',
    'rizz': 'appeal',
  };

  for (const offender of offenders) {
    const replacement = REPLACEMENTS[offender];
    if (replacement !== undefined) {
      const re = new RegExp(offender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      cleaned = cleaned.replace(re, replacement);
    }
  }

  // Normalize consecutive exclamation marks
  cleaned = cleaned.replace(/!{2,}/g, '!');

  return cleaned;
}

/**
 * Split prose into sentences (simple period/question-mark/exclamation split).
 * Doesn't split on abbreviations like "U.S." but good enough for article prose.
 */
function splitSentences(prose: string): string[] {
  return prose
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Convert generated section prose into the in-app `ArticleBlock[]` render model
 * (headings, paragraphs, lists, an optional attributed quote, callouts). The
 * prose is expected to already be on-voice; `lintVoice` (style.ts) is applied
 * here as a final pass, downgrading off-voice phrasing to plainer wording
 * (never blocking — accuracy/copyright gates run separately).
 */
export function toRenderBlocks(
  plan: AssemblyPlan,
  sectionProse: Record<SectionId, string>,
): ArticleBlock[] {
  const blocks: ArticleBlock[] = [];

  for (const section of SECTION_PLAN) {
    const prose = sectionProse[section.id];
    if (!prose || !prose.trim()) continue;

    // Heading block
    blocks.push({ type: 'heading', text: section.heading });

    // Clean + lint the prose
    const cleaned = applyVoiceLint(stripHtml(prose.trim()), plan.voice);

    // Break into paragraph(s) — split on blank lines first, then on sentence density
    const paragraphs = cleaned.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);

    for (const para of paragraphs) {
      // If the paragraph is very long (>80 words), split into two
      const words = wordCount(para);
      if (words > 80) {
        const sentences = splitSentences(para);
        const midpoint = Math.ceil(sentences.length / 2);
        const first = sentences.slice(0, midpoint).join(' ');
        const second = sentences.slice(midpoint).join(' ');
        if (first.trim()) blocks.push({ type: 'paragraph', text: first.trim() });
        if (second.trim()) blocks.push({ type: 'paragraph', text: second.trim() });
      } else {
        blocks.push({ type: 'paragraph', text: para });
      }
    }
  }

  return blocks;
}

/**
 * Final assembly: combine plan + prose + provenance into a `SynthesizedArticle`,
 * computing wordCount/readingTime and the reference list. Does NOT run the
 * copyright gate — the caller (synthesize.ts) does that and may reject.
 */
export function assembleArticle(
  plan: AssemblyPlan,
  blocks: ArticleBlock[],
  draft: ArticleDraft,
  providerMeta: ProviderMeta,
  upstreamRunId: string,
  now: Date,
): SynthesizedArticle {
  // Convert AggregatedItem[] references to ArticleReference[]
  const references: ArticleReference[] = plan.references.map((item) => ({
    source: item.source,
    sourceDomain: item.sourceDomain,
    tier: item.tier,
    url: scrubUrl(item.url) || item.url, // fallback to original if scrub returns ''
    title: item.title,
    publishedAt: item.publishedAt,
  }));

  // Word count over all block text
  const allText = blocks
    .map((b) => b.text ?? (b.items ?? []).join(' '))
    .join(' ');
  const wc = wordCount(allText);

  // ~238 words per minute reading speed (standard estimate)
  const readingTimeMinutes = Math.max(1, Math.round(wc / 238));

  const distinctDomains = new Set(plan.references.map((r) => r.sourceDomain)).size;

  return {
    id: `${plan.entry.clusterId}::${now.toISOString()}`,
    rank: plan.entry.rank,
    topic: plan.entry.topic,
    topicLabel: plan.entry.topicLabel,
    headline: draft.headline,
    dek: draft.dek,
    body: blocks,
    keyPoints: draft.keyPoints,
    whyItMatters: draft.whyItMatters,
    readerAction: draft.readerAction,
    tags: draft.tags,
    confidence: draft.confidence,
    sourceQuality: plan.entry.sourceQuality,
    references,
    provenance: {
      clusterId: plan.entry.clusterId,
      sourceCount: plan.references.length,
      distinctDomains,
      upstreamRunId,
    },
    ai: providerMeta,
    legalNote:
      'Original Ardur synthesis from headline/feed metadata; references preserved; no article body copied.',
    wordCount: wc,
    readingTimeMinutes,
    generatedAt: now.toISOString(),
  };
}
