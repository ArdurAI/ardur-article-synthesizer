/**
 * In-app render contract — the article is read INSIDE ardur.ai with no
 * navigation to another page.
 *
 * SCAFFOLD ONLY — signatures are final; bodies are stubs.
 *
 * The app consumes `SynthesizedArticle` directly; there is no HTML page hop and
 * no Markdown round-trip at read time. `body: ArticleBlock[]` is the render model.
 * This module defines the contract the app and the synthesizer agree on, and a
 * validator that fails any article the app could not safely render in place.
 *
 * Render order (matches `ArticleSourceTrail.astro` + content-engine contract):
 *   1. headline (original)
 *   2. dek (original standfirst)
 *   3. meta strip: confidence · sourceQuality · readingTime · generatedAt
 *   4. keyPoints (scannable)
 *   5. body blocks (the SECTION_PLAN order)
 *   6. "Why it matters" + "Reader action" callouts
 *   7. SOURCE TRAIL block: numbered canonical links, kept SEPARATE from prose so
 *      readers can audit without cluttering the body (per ArticleSourceTrail).
 *   8. legal/citation posture line.
 */

import type { ArticleBlock, SynthesizedArticle } from './contracts.ts';

/** Allowed block types the in-app renderer knows how to draw. */
export const RENDERABLE_BLOCK_TYPES: readonly ArticleBlock['type'][] = [
  'paragraph',
  'heading',
  'list',
  'quote',
  'callout',
];

/**
 * The render contract the synthesizer guarantees and the app relies on.
 * Encoded as data so both sides can assert against the same object.
 */
export interface RenderContract {
  /** No external navigation: every interactive element stays in-app. */
  inApp: true;
  /** Body is a typed block array, not raw HTML/Markdown. */
  bodyModel: 'ArticleBlock[]';
  /** Source trail renders as a discrete block, never interleaved in prose. */
  sourceTrailSeparate: true;
  /** Quotes render with visible attribution + canonical link. */
  quotesAttributed: true;
  /** Max blocks before the renderer paginates/virtualizes in-app. */
  maxBlocks: number;
}

export const RENDER_CONTRACT: RenderContract = {
  inApp: true,
  bodyModel: 'ArticleBlock[]',
  sourceTrailSeparate: true,
  quotesAttributed: true,
  maxBlocks: 120,
};

export type RenderViolationKind =
  | 'unknown-block-type'
  | 'quote-without-attribution'
  | 'raw-html-in-text'
  | 'empty-block'
  | 'too-many-blocks'
  | 'missing-source-trail';

export interface RenderViolation {
  kind: RenderViolationKind;
  detail: string;
  blockIndex?: number;
}

/**
 * Validate that an article can be rendered in-app under RENDER_CONTRACT.
 * Catches unknown block types, unattributed quotes, raw HTML smuggled into
 * `text`, and a missing source trail.
 */
export function validateRenderable(_article: SynthesizedArticle): RenderViolation[] {
  throw new Error('not implemented: assert article against RENDER_CONTRACT');
}
