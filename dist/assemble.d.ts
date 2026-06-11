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
import type { ArticleBlock, SynthesizedArticle, AggregatedItem, Top10Entry, ProviderMeta, ExtractedFact, ChartBlock } from './contracts.ts';
import { VOICE_STYLE, SECTION_VOICE, buildVoiceDirective, type VoiceStyle } from './style.ts';
import type { ArticleDraft } from './provider.ts';
export { VOICE_STYLE, SECTION_VOICE, buildVoiceDirective };
/** Canonical section ids, in render order. */
export type SectionId = 'key-takeaway' | 'why-this-matters' | 'what-happened' | 'builder-view' | 'open-questions' | 'ardur-take';
export interface SectionSpec {
    id: SectionId;
    heading: string;
    /** Whether the section is required for a publishable article. */
    required: boolean;
    /** Soft word target — guides the provider, not a hard cap. */
    targetWords: number;
}
/** The fixed section plan (order matters; it is the render contract). */
export declare const SECTION_PLAN: readonly SectionSpec[];
/** Default cap on how many references the source-trail block lists. */
export declare const MAX_REFERENCES = 30;
/** Minimum body length (words) for a publishable, non-`idea` article. */
export declare const MIN_BODY_WORDS = 150;
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
export declare function planAssembly(entry: Top10Entry, clusterMembers: readonly AggregatedItem[], voice?: VoiceStyle): AssemblyPlan;
/**
 * Convert generated section prose into the in-app `ArticleBlock[]` render model
 * (headings, paragraphs, lists, an optional attributed quote, callouts). The
 * prose is expected to already be on-voice; `lintVoice` (style.ts) is applied
 * here as a final pass, downgrading off-voice phrasing to plainer wording
 * (never blocking — accuracy/copyright gates run separately).
 */
export declare function toRenderBlocks(plan: AssemblyPlan, sectionProse: Record<SectionId, string>): ArticleBlock[];
/**
 * Final assembly: combine plan + prose + provenance into a `SynthesizedArticle`,
 * computing wordCount/readingTime and the reference list. Does NOT run the
 * copyright gate — the caller (synthesize.ts) does that and may reject.
 */
export declare function assembleArticle(plan: AssemblyPlan, blocks: ArticleBlock[], draft: ArticleDraft, providerMeta: ProviderMeta, upstreamRunId: string, now: Date): SynthesizedArticle;
/**
 * Build ChartBlock[] from the quantitative ExtractedFacts for a cluster.
 * Only facts with a `quantity` field produce chart datapoints — no invented numbers.
 *
 * Groups facts by `quantity.metric` and builds one bar chart per metric that
 * has ≥2 comparable datapoints. Single-datapoint metrics are skipped (a bar
 * chart of one value is not informative).
 */
export declare function buildChartBlocks(facts: readonly ExtractedFact[], refs: readonly {
    source: string;
    url: string;
    sourceDomain: string;
}[]): ChartBlock[];
