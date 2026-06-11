/**
 * Article assembly rules — how 20–30 sources become ONE original piece.
 *
 * SCAFFOLD ONLY — signatures are final; bodies are stubs.
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

import type { ArticleBlock, SynthesizedArticle, AggregatedItem, Top10Entry } from './contracts.ts';
import { VOICE_STYLE, SECTION_VOICE, buildVoiceDirective, type VoiceStyle } from './style.ts';

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
  _entry: Top10Entry,
  _clusterMembers: readonly AggregatedItem[],
  _voice: VoiceStyle = VOICE_STYLE,
): AssemblyPlan {
  throw new Error('not implemented: dedup + rank cluster members into weave order, attach voice directives');
}

/**
 * Convert generated section prose into the in-app `ArticleBlock[]` render model
 * (headings, paragraphs, lists, an optional attributed quote, callouts). The
 * prose is expected to already be on-voice; `lintVoice` (style.ts) is applied
 * here as a final pass, downgrading off-voice phrasing to plainer wording
 * (never blocking — accuracy/copyright gates run separately).
 */
export function toRenderBlocks(
  _plan: AssemblyPlan,
  _sectionProse: Record<SectionId, string>,
): ArticleBlock[] {
  throw new Error('not implemented: prose -> ArticleBlock[] (with voice lint pass)');
}

/**
 * Final assembly: combine plan + prose + provenance into a `SynthesizedArticle`,
 * computing wordCount/readingTime and the reference list. Does NOT run the
 * copyright gate — the caller (synthesize.ts) does that and may reject.
 */
export function assembleArticle(
  _plan: AssemblyPlan,
  _blocks: ArticleBlock[],
): SynthesizedArticle {
  throw new Error('not implemented: assemble SynthesizedArticle');
}
