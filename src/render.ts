/**
 * In-app render contract — the article is read INSIDE ardur.ai with no
 * navigation to another page.
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

/** Raw HTML tags smuggled inside block text — catches <script>, <a href>, etc. */
const RAW_HTML_PATTERN = /<[a-z][a-z0-9]*[\s/>]/i;

/**
 * Validate that an article can be rendered in-app under RENDER_CONTRACT.
 * Catches unknown block types, unattributed quotes, raw HTML smuggled into
 * `text`, and a missing source trail.
 */
export function validateRenderable(article: SynthesizedArticle): RenderViolation[] {
  const violations: RenderViolation[] = [];

  for (let i = 0; i < article.body.length; i++) {
    const block = article.body[i];
    if (!block) continue;

    // 1. Unknown block type
    if (!RENDERABLE_BLOCK_TYPES.includes(block.type)) {
      violations.push({
        kind: 'unknown-block-type',
        detail: `Unknown block type "${block.type}" at index ${i}`,
        blockIndex: i,
      });
    }

    // 2. Quote must carry visible attribution
    if (block.type === 'quote' && (!block.attribution?.source || !block.attribution?.url)) {
      violations.push({
        kind: 'quote-without-attribution',
        detail: `Quote block at index ${i} missing attribution (source and url required)`,
        blockIndex: i,
      });
    }

    // 3. Raw HTML in text or list items (XSS guard — all content renders as plain text in-app)
    const textContent = block.text ?? '';
    const hasRawHtml =
      RAW_HTML_PATTERN.test(textContent) ||
      (block.items ?? []).some((item) => RAW_HTML_PATTERN.test(item));
    if (hasRawHtml) {
      violations.push({
        kind: 'raw-html-in-text',
        detail: `Raw HTML detected in block at index ${i}`,
        blockIndex: i,
      });
    }

    // 4. Empty blocks produce dead whitespace in-app
    const isEmpty =
      !textContent.trim() &&
      (!block.items || block.items.length === 0 || block.items.every((it) => !it.trim()));
    if (isEmpty) {
      violations.push({
        kind: 'empty-block',
        detail: `Empty block at index ${i} (type: ${block.type})`,
        blockIndex: i,
      });
    }
  }

  // 5. Total block count
  if (article.body.length > RENDER_CONTRACT.maxBlocks) {
    violations.push({
      kind: 'too-many-blocks',
      detail: `${article.body.length} blocks exceeds the in-app limit of ${RENDER_CONTRACT.maxBlocks}`,
    });
  }

  // 6. Source trail — at least one reference required for readers to audit
  if (!article.references || article.references.length === 0) {
    violations.push({
      kind: 'missing-source-trail',
      detail: 'Article has no references — source trail block cannot be rendered',
    });
  }

  return violations;
}
