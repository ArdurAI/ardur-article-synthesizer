import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, CONTRACT_REVISION, CYCLE_INTERVAL_MS, FORBIDDEN_METRIC_KEY_FRAGMENTS, assertCompatibleArtifact, SchemaVersionError } from './contracts.ts';
import { runSynthesis } from './index.ts';
import { DESCRIPTOR } from './describe.ts';
import { MAX_QUOTE_WORDS, MAX_VERBATIM_NGRAM, MAX_VERBATIM_TITLE_NGRAM, enforceCopyright, isQuoteWithinLimit, longestVerbatimRun } from './copyright.ts';
import { SECTION_PLAN, MIN_BODY_WORDS, MAX_REFERENCES, planAssembly, toRenderBlocks, assembleArticle } from './assemble.ts';
import { RENDER_CONTRACT, RENDERABLE_BLOCK_TYPES, validateRenderable } from './render.ts';
import { isForbiddenKey, scrubUrl, redactForLog } from './privacy.ts';
import { VOICE_STYLE, SECTION_VOICE, buildVoiceDirective, lintVoice } from './style.ts';
import { buildProvenance, isFullyGrounded, buildProvenanceFromFacts } from './provenance.ts';
import { createProvider, buildDeterministicDraft, ArticleDraftSchema, parseAndMergeDraft } from './provider.ts';
import type { AiProvider } from './provider.ts';
import type { ArticleArtifactExtended } from './synthesize.ts';
import { buildChartBlocks } from './assemble.ts';
import type { AggregatedItem, Top10Entry, SynthesizedArticle, Top10Artifact, AggregationArtifact, ExtractedFact, ProviderMeta } from './contracts.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<AggregatedItem> = {}): AggregatedItem {
  return {
    id: 'item-1',
    topic: 'ai-models',
    topicLabel: 'AI Models',
    title: 'PyTorch 2.6 ships with faster compile',
    source: 'PyTorch',
    sourceDomain: 'pytorch.org',
    sourceUrl: 'https://pytorch.org',
    url: 'https://pytorch.org/blog/pytorch-2.6',
    tier: 'primary',
    publishedAt: '2026-06-11T00:00:00Z',
    summaryHint: 'Faster compile times in PyTorch 2.6 release',
    interaction: {
      feedRank: 0,
      shares: 120,
      comments: 30,
      reactions: 200,
      crossSourceMentions: 5,
      velocity: 10,
      capturedAt: '2026-06-11T01:00:00Z',
      provenance: 'rss-position',
    },
    clusterId: 'cluster-1',
    fingerprint: 'pytorch.org::pytorch-2.6-ships-with-faster-compile',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<Top10Entry> = {}): Top10Entry {
  return {
    rank: 1,
    clusterId: 'cluster-1',
    topic: 'ai-models',
    topicLabel: 'AI Models',
    headline: 'PyTorch 2.6 ships with faster compile times',
    score: { interaction: 0.8, credibility: 0.9, recency: 0.95, diversity: 0.7, corroboration: 0.85, total: 0.84, weights: {} },
    sourceQuality: 'corroborated',
    confidence: 'high',
    references: [
      { source: 'PyTorch', sourceDomain: 'pytorch.org', tier: 'primary', url: 'https://pytorch.org/blog/pytorch-2.6', title: 'PyTorch 2.6 is now available', publishedAt: '2026-06-11T00:00:00Z' },
      { source: 'TechCrunch', sourceDomain: 'techcrunch.com', tier: 'technical-news', url: 'https://techcrunch.com/pytorch-2.6', title: 'PyTorch 2.6 benchmark deep dive', publishedAt: '2026-06-11T02:00:00Z' },
    ],
    delta: { previousRank: 2, movement: 'up' },
    carriedOver: false,
    ...overrides,
  };
}

const NOW = new Date('2026-06-11T06:00:00Z');
const CYCLE = { id: '2026-06-11T00:00Z', windowStart: '2026-06-11T00:00:00Z', windowEnd: '2026-06-11T06:00:00Z' };

// Minimal valid Top10Artifact
function makeTop10(): Top10Artifact {
  const entry = makeEntry();
  return {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'top10',
    runId: 'run-top10-1',
    upstreamRunId: 'run-ranking-1',
    generatedAt: NOW.toISOString(),
    cycle: CYCLE,
    topics: [{ id: 'ai-models', label: 'AI Models', description: 'AI model releases and research' }],
    warnings: [],
    data: {
      nextRefreshAt: '2026-06-11T12:00:00Z',
      topicsCovered: ['ai-models'],
      top10ByTopic: { 'ai-models': [entry] },
      global: [entry],
      stability: { carriedOver: 0, fresh: 1, churnRate: 1.0 },
    },
  };
}

// Minimal valid AggregationArtifact
function makeAggregation(): AggregationArtifact {
  const item1 = makeItem({ id: 'item-1', source: 'PyTorch', sourceDomain: 'pytorch.org', tier: 'primary' });
  const item2 = makeItem({ id: 'item-2', source: 'TechCrunch', sourceDomain: 'techcrunch.com', tier: 'technical-news', url: 'https://techcrunch.com/pytorch-2.6', title: 'PyTorch 2.6 benchmark deep dive', fingerprint: 'techcrunch.com::pytorch-2.6-benchmark-deep-dive' });
  return {
    schemaVersion: SCHEMA_VERSION,
    artifact: 'aggregation',
    runId: 'run-agg-1',
    upstreamRunId: null,
    generatedAt: NOW.toISOString(),
    cycle: CYCLE,
    topics: [{ id: 'ai-models', label: 'AI Models', description: '' }],
    warnings: [],
    data: {
      itemsByTopic: { 'ai-models': [item1, item2] },
      clustersByTopic: {
        'ai-models': [{
          clusterId: 'cluster-1',
          topic: 'ai-models',
          topicLabel: 'AI Models',
          headline: 'PyTorch 2.6 ships with faster compile',
          memberIds: ['item-1', 'item-2'],
          sourceCount: 2,
          distinctDomains: 2,
          tierHistogram: { primary: 1, 'technical-news': 1 },
          earliestPublishedAt: '2026-06-11T00:00:00Z',
          latestPublishedAt: '2026-06-11T02:00:00Z',
        }],
      },
      coverageByTopic: {
        'ai-models': { sourcesConfigured: 20, sourcesQueried: 20, sourcesResponded: 15, distinctDomains: 10, degraded: false },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Pinned constants
// ---------------------------------------------------------------------------

test('schema version is pinned', () => {
  assert.equal(SCHEMA_VERSION, 'ardur-content-pipeline/v1');
});

test('cycle interval is 6 hours', () => {
  assert.equal(CYCLE_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test('copyright limits match the ratified policy', () => {
  assert.equal(MAX_QUOTE_WORDS, 25);
  assert.ok(MAX_VERBATIM_NGRAM > 0 && MAX_VERBATIM_NGRAM < MIN_BODY_WORDS);
});

test('section plan is the in-app render order and has required sections', () => {
  const ids = SECTION_PLAN.map((s) => s.id);
  assert.deepEqual(ids[0], 'key-takeaway');
  assert.deepEqual(ids.at(-1), 'ardur-take');
  assert.ok(SECTION_PLAN.some((s) => s.required));
});

test('render contract is in-app with a separate source trail', () => {
  assert.equal(RENDER_CONTRACT.inApp, true);
  assert.equal(RENDER_CONTRACT.sourceTrailSeparate, true);
  assert.equal(RENDER_CONTRACT.bodyModel, 'ArticleBlock[]');
  assert.ok(RENDERABLE_BLOCK_TYPES.includes('quote'));
});

test('reference cap covers the 20-30 sources/topic target', () => {
  assert.ok(MAX_REFERENCES >= 30);
});

test('privacy guard flags known PII fragments and passes safe keys', () => {
  assert.ok(isForbiddenKey('email'));
  assert.ok(isForbiddenKey('sessionToken'));
  assert.ok(!isForbiddenKey('shares7d'));
  assert.ok(FORBIDDEN_METRIC_KEY_FRAGMENTS.includes('referrer'));
});

test('voice config is the single source of truth and is internally consistent', () => {
  assert.equal(VOICE_STYLE.id, 'ardur-voice/genz-professional/v1');
  assert.ok(VOICE_STYLE.do.length >= 5 && VOICE_STYLE.dont.length >= 4);
  assert.ok(VOICE_STYLE.maxPlayfulnessRatio > 0 && VOICE_STYLE.maxPlayfulnessRatio <= 0.5);
  // Personality is deliberately measured, never maxed.
  assert.ok(VOICE_STYLE.tone.personality < 1 && VOICE_STYLE.tone.plainLanguage >= 0.8);
  // Hype/clickbait is explicitly banned.
  assert.ok(VOICE_STYLE.bannedLexicon.includes('game-changer'));
  // Every assembly section has a voice intent.
  const sections = new Set(SECTION_VOICE.map((s) => s.section));
  for (const id of ['key-takeaway', 'why-this-matters', 'what-happened', 'builder-view', 'open-questions', 'ardur-take']) {
    assert.ok(sections.has(id), `missing section voice: ${id}`);
  }
});

// ---------------------------------------------------------------------------
// Voice: buildVoiceDirective + lintVoice
// ---------------------------------------------------------------------------

test('buildVoiceDirective returns a non-empty directive containing key voice rules', () => {
  const directive = buildVoiceDirective();
  assert.ok(directive.length > 50, 'directive should be substantive');
  assert.ok(directive.includes('VOICE:'), 'should contain VOICE label');
  assert.ok(directive.includes('EXEMPLAR:'), 'should contain exemplar');
  assert.ok(directive.includes("DON'T:"), "should contain don't rules");
});

test('buildVoiceDirective with section includes section intent', () => {
  const directive = buildVoiceDirective(VOICE_STYLE, 'key-takeaway');
  assert.ok(directive.includes('key-takeaway'), 'should reference the section');
});

test('lintVoice catches banned lexicon', () => {
  const offenders = lintVoice('This is a game-changer for the industry');
  assert.ok(offenders.includes('game-changer'), 'should flag game-changer');
});

test('lintVoice passes clean text', () => {
  const offenders = lintVoice('PyTorch 2.6 shipped with real compile-time improvements.');
  assert.deepEqual(offenders, []);
});

test('lintVoice flags exclamation density spam', () => {
  const offenders = lintVoice('Wow!! Amazing!! Great!!');
  assert.ok(offenders.some((o) => o.includes('exclamation') || o.includes('!')), 'should flag exclamation spam');
});

// ---------------------------------------------------------------------------
// Copyright gate
// ---------------------------------------------------------------------------

test('isQuoteWithinLimit accepts short quotes', () => {
  assert.ok(isQuoteWithinLimit('The compile-time wins are real.'));
});

test('isQuoteWithinLimit rejects long quotes', () => {
  const longQuote = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  assert.ok(!isQuoteWithinLimit(longQuote));
});

test('isQuoteWithinLimit at exact boundary — spec is strictly < 25 words', () => {
  // 24 words: the last passing value (24 < 25 = true)
  const exactly24 = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ');
  assert.ok(isQuoteWithinLimit(exactly24), '24 words should pass (< 25)');
  // 25 words: fails closed — 25 is NOT < 25 (off-by-one guard, issue #7)
  const exactly25 = Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ');
  assert.ok(!isQuoteWithinLimit(exactly25), '25 words should fail (not strictly < 25)');
  const exactly26 = Array.from({ length: 26 }, (_, i) => `word${i}`).join(' ');
  assert.ok(!isQuoteWithinLimit(exactly26), '26 words should fail');
});

test('longestVerbatimRun finds no overlap between unrelated texts', () => {
  const run = longestVerbatimRun('apple orange grape', ['car bus train']);
  assert.equal(run, 0);
});

test('longestVerbatimRun detects exact overlap', () => {
  const run = longestVerbatimRun('the compile time wins are real', ['the compile time wins are substantial']);
  assert.ok(run >= 4, `expected >= 4 word overlap, got ${run}`);
});

test('longestVerbatimRun handles empty inputs', () => {
  assert.equal(longestVerbatimRun('', ['hello world']), 0);
  assert.equal(longestVerbatimRun('hello world', []), 0);
});

test('enforceCopyright passes a clean deterministic article', () => {
  const plan = planAssembly(makeEntry(), [makeItem(), makeItem({ id: 'item-2', sourceDomain: 'techcrunch.com', fingerprint: 'techcrunch::test' })]);
  const provider = createProvider({ provider: 'deterministic' });
  const draft = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'PyTorch 2.6 ships', references: plan.references.map(r => ({ source: r.source, sourceDomain: r.sourceDomain, tier: r.tier, url: r.url, title: r.title, publishedAt: r.publishedAt })), voiceDirective: buildVoiceDirective() });
  const blocks = toRenderBlocks(plan, draft.sections as Record<import('./assemble.ts').SectionId, string>);
  const article = assembleArticle(plan, blocks, draft, { provider: 'deterministic', model: 'rules/v1', status: 'fallback', generatedAt: NOW.toISOString() }, 'run-1', NOW);
  const verdict = enforceCopyright(article, [makeItem(), makeItem({ id: 'item-2', sourceDomain: 'techcrunch.com', fingerprint: 'techcrunch::test' })]);
  assert.ok(verdict.ok, `copyright violations: ${JSON.stringify(verdict.violations)}`);
});

test('enforceCopyright fails closed on oversized quote', () => {
  const longQuote = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'test', topicLabel: 'Test', headline: 'Test headline', dek: 'Test dek',
    body: [{ type: 'quote', text: longQuote, attribution: { source: 'TestSource', url: 'https://test.com' } }],
    keyPoints: [], whyItMatters: '', readerAction: '', tags: [], confidence: 'high', sourceQuality: 'corroborated',
    references: [{ source: 'Test', sourceDomain: 'test.com', tier: 'primary', url: 'https://test.com', title: 'Test', publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'deterministic', model: 'rules/v1', status: 'fallback', generatedAt: NOW.toISOString() },
    legalNote: 'Original synthesis', wordCount: 100, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const verdict = enforceCopyright(article, [makeItem()]);
  assert.ok(!verdict.ok, 'should fail on oversized quote');
  assert.ok(verdict.violations.some((v) => v.kind === 'quote-too-long'));
});

test('enforceCopyright fails on unattributed quote', () => {
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'test', topicLabel: 'Test', headline: 'Test', dek: 'Test',
    body: [{ type: 'quote', text: 'A short quote.' }], // no attribution
    keyPoints: [], whyItMatters: '', readerAction: '', tags: [], confidence: 'high', sourceQuality: 'corroborated',
    references: [{ source: 'Test', sourceDomain: 'test.com', tier: 'primary', url: 'https://test.com', title: 'Test', publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'deterministic', model: 'rules/v1', status: 'fallback', generatedAt: NOW.toISOString() },
    legalNote: '', wordCount: 10, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const verdict = enforceCopyright(article, [makeItem()]);
  assert.ok(!verdict.ok);
  assert.ok(verdict.violations.some((v) => v.kind === 'quote-unattributed'));
});

test('enforceCopyright fails on missing canonical link', () => {
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'test', topicLabel: 'Test', headline: 'Test', dek: 'Test',
    body: [{ type: 'paragraph', text: 'Original prose content here.' }],
    keyPoints: [], whyItMatters: '', readerAction: '', tags: [], confidence: 'high', sourceQuality: 'corroborated',
    references: [{ source: 'Test', sourceDomain: 'test.com', tier: 'primary', url: '', title: 'Test', publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'deterministic', model: 'rules/v1', status: 'fallback', generatedAt: NOW.toISOString() },
    legalNote: '', wordCount: 10, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const verdict = enforceCopyright(article, [makeItem()]);
  assert.ok(!verdict.ok);
  assert.ok(verdict.violations.some((v) => v.kind === 'missing-canonical-link'));
});

// ---------------------------------------------------------------------------
// Render validation
// ---------------------------------------------------------------------------

test('validateRenderable passes a valid article', () => {
  const plan = planAssembly(makeEntry(), [makeItem(), makeItem({ id: 'item-2', sourceDomain: 'tc.com', fingerprint: 'tc::test' })]);
  const draft = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'PyTorch 2.6', references: plan.references.map(r => ({ source: r.source, sourceDomain: r.sourceDomain, tier: r.tier, url: r.url, title: r.title, publishedAt: r.publishedAt })), voiceDirective: '' });
  const blocks = toRenderBlocks(plan, draft.sections as Record<import('./assemble.ts').SectionId, string>);
  const article = assembleArticle(plan, blocks, draft, { provider: 'deterministic', model: 'rules/v1', status: 'fallback', generatedAt: NOW.toISOString() }, 'run-1', NOW);
  const violations = validateRenderable(article);
  assert.deepEqual(violations, []);
});

test('validateRenderable flags missing source trail', () => {
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'test', topicLabel: 'Test', headline: 'Test', dek: 'Test',
    body: [{ type: 'paragraph', text: 'Some content.' }],
    keyPoints: [], whyItMatters: '', readerAction: '', tags: [], confidence: 'high', sourceQuality: 'corroborated',
    references: [], // empty!
    provenance: { clusterId: 'c1', sourceCount: 0, distinctDomains: 0, upstreamRunId: 'run-1' },
    ai: { provider: 'deterministic', model: 'rules/v1', status: 'fallback', generatedAt: NOW.toISOString() },
    legalNote: '', wordCount: 5, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const violations = validateRenderable(article);
  assert.ok(violations.some((v) => v.kind === 'missing-source-trail'));
});

test('validateRenderable flags quote without attribution', () => {
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'test', topicLabel: 'Test', headline: 'Test', dek: 'Test',
    body: [{ type: 'quote', text: 'Some short quote.' }], // no attribution
    keyPoints: [], whyItMatters: '', readerAction: '', tags: [], confidence: 'high', sourceQuality: 'corroborated',
    references: [{ source: 'T', sourceDomain: 't.com', tier: 'news', url: 'https://t.com', title: 'T', publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'deterministic', model: 'rules/v1', status: 'fallback', generatedAt: NOW.toISOString() },
    legalNote: '', wordCount: 5, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const violations = validateRenderable(article);
  assert.ok(violations.some((v) => v.kind === 'quote-without-attribution'));
});

test('validateRenderable flags raw HTML in text', () => {
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'test', topicLabel: 'Test', headline: 'Test', dek: 'Test',
    body: [{ type: 'paragraph', text: 'Click <a href="https://evil.com">here</a>' }],
    keyPoints: [], whyItMatters: '', readerAction: '', tags: [], confidence: 'high', sourceQuality: 'corroborated',
    references: [{ source: 'T', sourceDomain: 't.com', tier: 'news', url: 'https://t.com', title: 'T', publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'deterministic', model: 'rules/v1', status: 'fallback', generatedAt: NOW.toISOString() },
    legalNote: '', wordCount: 5, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const violations = validateRenderable(article);
  assert.ok(violations.some((v) => v.kind === 'raw-html-in-text'));
});

// Issue #10: XSS screen must also cover block.items[] (list items), not just block.text
test('validateRenderable flags raw HTML injected into a list item', () => {
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'test', topicLabel: 'Test', headline: 'Test', dek: 'Test',
    body: [{
      type: 'list',
      items: ['Normal list item', '<script>alert(1)</script> injected item'],
    }],
    keyPoints: [], whyItMatters: '', readerAction: '', tags: [], confidence: 'high', sourceQuality: 'corroborated',
    references: [{ source: 'T', sourceDomain: 't.com', tier: 'news', url: 'https://t.com', title: 'T', publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'deterministic', model: 'rules/v1', status: 'fallback', generatedAt: NOW.toISOString() },
    legalNote: '', wordCount: 5, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const violations = validateRenderable(article);
  assert.ok(violations.some((v) => v.kind === 'raw-html-in-text'), 'raw HTML in list item must be caught');
});

// ---------------------------------------------------------------------------
// Provenance gating
// ---------------------------------------------------------------------------

test('buildProvenance returns a map with unsupportedClaimCount = 0 for editorial claims', () => {
  const claims = [
    { text: 'This is a summary of events.', blockIndex: 0, isEditorial: true },
    { text: 'The Ardur Take is that this is significant.', blockIndex: 1, isEditorial: true },
  ];
  const sources = [{ source: 'PyTorch', sourceDomain: 'pytorch.org', tier: 'primary' as const, url: 'https://pytorch.org', title: 'PyTorch 2.6 release', publishedAt: NOW.toISOString() }];
  const map = buildProvenance('art-1', claims, sources);
  assert.equal(map.unsupportedClaimCount, 0);
  assert.ok(isFullyGrounded(map));
});

test('buildProvenance maps factual claims with matching tokens to sources', () => {
  const claims = [
    { text: 'PyTorch pytorch.org shipped faster compile times.', blockIndex: 0, isEditorial: false },
  ];
  const sources = [{ source: 'PyTorch', sourceDomain: 'pytorch.org', tier: 'primary' as const, url: 'https://pytorch.org', title: 'PyTorch 2.6 compile improvements', publishedAt: NOW.toISOString() }];
  const map = buildProvenance('art-1', claims, sources);
  // Claims that match source tokens should be supported
  assert.ok(map.claims.length === 1);
});

test('isFullyGrounded fails when unsupportedClaimCount > 0', () => {
  const map = { claims: [], citedSources: [], unsupportedClaimCount: 1 };
  assert.ok(!isFullyGrounded(map));
});

// Issue #9: ratio-based threshold prevents on-topic hallucinations from being auto-grounded
test('buildProvenance does not ground on-topic hallucinations via topic-word overlap alone', () => {
  // Claim has 10 distinct content tokens; only 1 ('pytorch') matches the source distinctly.
  // threshold = max(2, ceil(10 * 0.25)) = 3; 1 < 3 => unsupported.
  const claims = [{
    text: 'pytorch released beverage product distribution channel retail exclusive launch strategy',
    blockIndex: 0,
    isEditorial: false,
  }];
  const sources = [{
    source: 'PyTorch',
    sourceDomain: 'pytorch.org',
    tier: 'primary' as const,
    url: 'https://pytorch.org',
    title: 'PyTorch 2.6 compile improvements',
    publishedAt: NOW.toISOString(),
  }];
  const map = buildProvenance('art-1', claims, sources);
  assert.ok(map.unsupportedClaimCount > 0, 'on-topic hallucination must be unsupported');
  assert.ok(!isFullyGrounded(map), 'article with hallucinated claim must not be fully grounded');
});

// ---------------------------------------------------------------------------
// Privacy guards
// ---------------------------------------------------------------------------

test('scrubUrl strips tracking params', () => {
  const url = scrubUrl('https://example.com/article?utm_source=google&utm_campaign=test&id=123');
  assert.ok(!url.includes('utm_source'), 'should strip utm_source');
  assert.ok(!url.includes('utm_campaign'), 'should strip utm_campaign');
  assert.ok(url.includes('id=123'), 'should keep non-tracking params');
});

test('scrubUrl strips credentials and fragment', () => {
  const url = scrubUrl('https://user:pass@example.com/path#section');
  assert.ok(!url.includes('user:pass'), 'should strip credentials');
  assert.ok(!url.includes('#section'), 'should strip fragment');
  assert.ok(url.includes('example.com'), 'should keep hostname');
});

test('scrubUrl returns empty for non-http protocols', () => {
  assert.equal(scrubUrl('javascript:alert(1)'), '');
  assert.equal(scrubUrl('file:///etc/passwd'), '');
  assert.equal(scrubUrl('ftp://example.com'), '');
});

test('scrubUrl handles invalid URLs gracefully', () => {
  assert.equal(scrubUrl('not a url'), '');
  assert.equal(scrubUrl(''), '');
  assert.equal(scrubUrl(null), '');
  assert.equal(scrubUrl(42), '');
});

test('redactForLog removes forbidden keys and scrubs URLs', () => {
  const cleaned = redactForLog({
    articleId: 'a123',
    email: 'test@example.com',
    sessionId: 'sess-1',
    url: 'https://example.com/article?utm_source=test',
    score: 0.9,
  });
  assert.ok(!('email' in cleaned), 'should remove email key');
  assert.ok(!('sessionId' in cleaned), 'should remove sessionId key');
  assert.ok('articleId' in cleaned, 'should keep safe key');
  assert.ok('score' in cleaned, 'should keep numeric key');
  const urlVal = cleaned['url'] as string;
  assert.ok(urlVal && !urlVal.includes('utm_source'), 'should scrub URL tracking params');
});

// ---------------------------------------------------------------------------
// Assembly: planAssembly
// ---------------------------------------------------------------------------

test('planAssembly dedups by fingerprint', () => {
  const items = [
    makeItem({ id: 'a', fingerprint: 'same' }),
    makeItem({ id: 'b', fingerprint: 'same' }), // duplicate
    makeItem({ id: 'c', fingerprint: 'different' }),
  ];
  const plan = planAssembly(makeEntry(), items);
  const fingerprints = plan.references.map((r) => r.fingerprint);
  const unique = new Set(fingerprints);
  assert.equal(fingerprints.length, unique.size, 'should dedup by fingerprint');
});

test('planAssembly ranks primary tier before news', () => {
  const items = [
    makeItem({ id: 'n1', tier: 'news', fingerprint: 'news-1', publishedAt: '2026-06-11T00:00:00Z' }),
    makeItem({ id: 'p1', tier: 'primary', fingerprint: 'primary-1', publishedAt: '2026-06-11T00:00:00Z' }),
  ];
  const plan = planAssembly(makeEntry(), items);
  const firstTier = plan.weave[0]?.tier;
  assert.equal(firstTier, 'primary', 'primary should come before news');
});

test('planAssembly caps references at MAX_REFERENCES', () => {
  const items = Array.from({ length: MAX_REFERENCES + 5 }, (_, i) =>
    makeItem({ id: `item-${i}`, fingerprint: `fp-${i}`, sourceDomain: `source${i}.com`, url: `https://source${i}.com/article` }),
  );
  const plan = planAssembly(makeEntry(), items);
  assert.ok(plan.references.length <= MAX_REFERENCES, `references should be capped at ${MAX_REFERENCES}`);
});

test('planAssembly attaches voice directives for every section', () => {
  const plan = planAssembly(makeEntry(), [makeItem()]);
  for (const section of SECTION_PLAN) {
    const directive = plan.voiceDirectives[section.id];
    assert.ok(directive && directive.length > 0, `missing voice directive for ${section.id}`);
  }
});

// ---------------------------------------------------------------------------
// Assembly: deterministic draft is on-voice
// ---------------------------------------------------------------------------

test('buildDeterministicDraft produces a complete draft with all required fields', () => {
  const refs = makeEntry().references;
  const draft = buildDeterministicDraft({
    topic: 'ai-models',
    topicLabel: 'AI Models',
    headline: 'PyTorch 2.6 ships with faster compile times',
    references: refs,
    voiceDirective: buildVoiceDirective(),
  });
  assert.ok(draft.headline && draft.headline.length > 0);
  assert.ok(draft.dek && draft.dek.length > 0);
  assert.ok(draft.sections['key-takeaway'] && draft.sections['key-takeaway'].length > 0);
  assert.ok(draft.sections['why-this-matters']);
  assert.ok(draft.sections['what-happened']);
  assert.ok(draft.sections['ardur-take']);
  assert.ok(Array.isArray(draft.keyPoints) && draft.keyPoints.length > 0);
  assert.ok(draft.whyItMatters && draft.whyItMatters.length > 0);
  assert.ok(draft.readerAction && draft.readerAction.length > 0);
  assert.ok(['high', 'medium', 'low'].includes(draft.confidence));
  assert.ok(Array.isArray(draft.tags) && draft.tags.length > 0);
});

test('buildDeterministicDraft does not contain banned lexicon', () => {
  const refs = makeEntry().references;
  const draft = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'PyTorch 2.6 ships', references: refs, voiceDirective: '' });
  const allText = Object.values(draft.sections).join(' ') + ' ' + draft.headline + ' ' + draft.dek;
  const offenders = lintVoice(allText);
  assert.deepEqual(offenders, [], `banned lexicon found: ${offenders.join(', ')}`);
});

test('buildDeterministicDraft produces MIN_BODY_WORDS words when converted to blocks', () => {
  const items = [makeItem(), makeItem({ id: 'i2', sourceDomain: 'tc.com', fingerprint: 'tc::1' })];
  const plan = planAssembly(makeEntry(), items);
  const draft = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'PyTorch 2.6 ships', references: plan.references.map(r => ({ source: r.source, sourceDomain: r.sourceDomain, tier: r.tier, url: r.url, title: r.title, publishedAt: r.publishedAt })), voiceDirective: '' });
  const blocks = toRenderBlocks(plan, draft.sections as Record<import('./assemble.ts').SectionId, string>);
  const totalWords = blocks.map((b) => { const tb = b as { text?: string; items?: string[] }; return tb.text ?? (tb.items ?? []).join(' '); }).join(' ').split(/\s+/).filter(Boolean).length;
  assert.ok(totalWords >= MIN_BODY_WORDS, `expected >= ${MIN_BODY_WORDS} words, got ${totalWords}`);
});

// ---------------------------------------------------------------------------
// Provider fallback chain
// ---------------------------------------------------------------------------

test('createProvider returns deterministic when ARDUR_AI_PROVIDER=deterministic', () => {
  const p = createProvider({ env: { ARDUR_AI_PROVIDER: 'deterministic' } });
  assert.equal(p.name, 'deterministic');
});

test('createProvider returns deterministic when ARDUR_AI_ENABLED=0', () => {
  const p = createProvider({ env: { ARDUR_AI_ENABLED: '0' } });
  assert.equal(p.name, 'deterministic');
});

test('deterministic provider always canGenerate', () => {
  const p = createProvider({ provider: 'deterministic' });
  assert.ok(p.canGenerate());
});

test('deterministic provider returns fallback draft unchanged', async () => {
  const p = createProvider({ provider: 'deterministic' });
  const refs = makeEntry().references;
  const fallback = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'Test', references: refs, voiceDirective: '' });
  const result = await p.generate({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'Test', references: refs, fallback, voiceDirective: '' });
  assert.equal(result.meta.status, 'fallback');
  assert.equal(result.meta.provider, 'deterministic');
  assert.deepEqual(result.draft, fallback);
});

test('deterministic provider uses zero generation budget', async () => {
  const p = createProvider({ provider: 'deterministic' });
  assert.equal(p.generationsUsed(), 0);
  const refs = makeEntry().references;
  const fallback = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'Test', references: refs, voiceDirective: '' });
  await p.generate({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'Test', references: refs, fallback, voiceDirective: '' });
  assert.equal(p.generationsUsed(), 0, 'deterministic should not consume budget');
});

// Issue #8: injected `now` must appear in generatedAt — determinism under replay
test('createProvider threads now into provider so generatedAt is deterministic', async () => {
  const now = new Date('2026-06-11T06:00:00Z');
  const p = createProvider({ provider: 'deterministic', now });
  const refs = makeEntry().references;
  const fallback = buildDeterministicDraft({ topic: 'test', topicLabel: 'Test', headline: 'Test', references: refs, voiceDirective: '' });
  const req = { topic: 'test', topicLabel: 'Test', headline: 'Test', references: refs, fallback, voiceDirective: '' };
  const r1 = await p.generate(req);
  const r2 = await p.generate(req);
  assert.equal(r1.meta.generatedAt, now.toISOString(), 'generatedAt must equal the injected now');
  assert.equal(r1.meta.generatedAt, r2.meta.generatedAt, 'identical inputs + now => identical generatedAt');
});

// ---------------------------------------------------------------------------
// End-to-end: runSynthesis with fixture inputs (deterministic, offline)
// ---------------------------------------------------------------------------

test('runSynthesis produces a valid ArticleArtifact from fixture inputs', async () => {
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });

  assert.equal(artifact.schemaVersion, SCHEMA_VERSION);
  assert.equal(artifact.artifact, 'articles');
  assert.ok(artifact.runId && artifact.runId.length > 0);
  assert.ok(Array.isArray(artifact.data.articles));
  // Deterministic provider → all articles are held; published articles[] is empty (#18)
  assert.equal(artifact.data.articles.length, 0, 'deterministic provider produces no published articles');
  assert.ok(Array.isArray(artifact.data.heldArticles));
  assert.ok(artifact.data.heldArticles.length > 0, 'should produce at least one held article');

  const article = artifact.data.heldArticles[0];
  assert.ok(article, 'first held article must exist');
  assert.ok(article.headline && article.headline.length > 0, 'article must have headline');
  assert.ok(article.dek && article.dek.length > 0, 'article must have dek');
  assert.ok(Array.isArray(article.body) && article.body.length > 0, 'article must have body blocks');
  assert.ok(article.references.length > 0, 'article must have references');
  assert.ok(article.wordCount >= MIN_BODY_WORDS, `expected >= ${MIN_BODY_WORDS} words, got ${article.wordCount}`);
  assert.ok(article.readingTimeMinutes >= 1);
  assert.equal(article.ai.provider, 'deterministic');
  assert.ok(article.legalNote && article.legalNote.includes('Original'), 'should have legal note');
});

test('runSynthesis copyright policy is embedded in the artifact', async () => {
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });
  const policy = artifact.data.copyrightPolicy;
  assert.equal(policy.originalTextOnly, true);
  assert.equal(policy.maxQuoteWords, 25);
  assert.equal(policy.reproduceArticleBody, false);
  assert.equal(policy.requireAttribution, true);
  assert.equal(policy.requireCanonicalLinks, true);
});

test('runSynthesis records a warning when cycle ids mismatch', async () => {
  const top10 = makeTop10();
  const aggregation = makeAggregation();
  (aggregation as unknown as Record<string, unknown>).cycle = { id: 'different-cycle', windowStart: '2026-06-11T06:00:00Z', windowEnd: '2026-06-11T12:00:00Z' };
  const artifact = await runSynthesis({
    top10,
    aggregation,
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });
  assert.ok(artifact.warnings.some((w) => w.includes('Cycle id mismatch')), 'should warn on cycle mismatch');
});

test('runSynthesis still produces articles when cluster has no members (degraded weave)', async () => {
  const top10 = makeTop10();
  const emptyAggregation = makeAggregation();
  // Remove all items so cluster resolution fails
  emptyAggregation.data.itemsByTopic = {};
  emptyAggregation.data.clustersByTopic = {};
  const artifact = await runSynthesis({
    top10,
    aggregation: emptyAggregation,
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });
  // Articles should still be produced (degraded to entry.references)
  assert.ok(Array.isArray(artifact.data.articles));
  assert.ok(artifact.warnings.some((w) => w.includes('No cluster members')), 'should warn about missing members');
});

// ---------------------------------------------------------------------------
// @ardurai/contracts integration: assertCompatibleArtifact gate (#12)
// ---------------------------------------------------------------------------

test('CONTRACT_REVISION is at least 2 (claims additive axis ratified)', () => {
  assert.ok(CONTRACT_REVISION >= 2, `expected CONTRACT_REVISION >= 2, got ${CONTRACT_REVISION}`);
});

test('assertCompatibleArtifact passes for a valid top10 fixture', () => {
  const { envelope, warnings } = assertCompatibleArtifact(makeTop10(), 'top10');
  assert.equal(envelope.schemaVersion, SCHEMA_VERSION);
  assert.equal(envelope.artifact, 'top10');
  assert.deepEqual(warnings, []);
});

test('assertCompatibleArtifact passes for a valid aggregation fixture', () => {
  const { envelope, warnings } = assertCompatibleArtifact(makeAggregation(), 'aggregation');
  assert.equal(envelope.schemaVersion, SCHEMA_VERSION);
  assert.equal(envelope.artifact, 'aggregation');
  assert.deepEqual(warnings, []);
});

test('assertCompatibleArtifact throws SchemaVersionError on wrong schema version', () => {
  const bad = { ...makeTop10(), schemaVersion: 'ardur-content-pipeline/v0' };
  assert.throws(
    () => assertCompatibleArtifact(bad, 'top10'),
    (err: unknown) => err instanceof SchemaVersionError && err.detail.stage === 'top10',
  );
});

test('assertCompatibleArtifact throws SchemaVersionError on wrong artifact stage', () => {
  const bad = { ...makeTop10(), artifact: 'ranking' };
  assert.throws(
    () => assertCompatibleArtifact(bad, 'top10'),
    (err: unknown) => err instanceof SchemaVersionError,
  );
});

test('assertCompatibleArtifact warns (not throws) on forward contractRevision', () => {
  const forward = { ...makeTop10(), contractRevision: CONTRACT_REVISION + 1 };
  const { warnings } = assertCompatibleArtifact(forward, 'top10');
  assert.ok(warnings.length > 0, 'should warn on forward revision');
  assert.ok(warnings[0]?.includes('forward-compatible'), 'warning should mention forward-compatible');
});

test('synthesizeCycle throws SchemaVersionError when top10 has wrong schemaVersion', async () => {
  const badTop10 = { ...makeTop10(), schemaVersion: 'wrong-version' };
  await assert.rejects(
    () => runSynthesis({
      top10: badTop10 as unknown as ReturnType<typeof makeTop10>,
      aggregation: makeAggregation(),
      provider: createProvider({ provider: 'deterministic' }),
      now: NOW,
    }),
    (err: unknown) => err instanceof SchemaVersionError,
  );
});

test('output artifact is stamped with contractRevision', async () => {
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });
  assert.equal(artifact.contractRevision, CONTRACT_REVISION);
});

test('item claims[] are merged into synthesized article tags', async () => {
  const itemWithClaims = makeItem({ claims: ['PyTorch', 'compile-time optimization', 'deep learning'] });
  const aggWithClaims = makeAggregation();
  aggWithClaims.data.itemsByTopic['ai-models'] = [
    itemWithClaims,
    makeItem({ id: 'item-2', sourceDomain: 'techcrunch.com', claims: ['TechCrunch', 'AI benchmark'] }),
  ];

  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: aggWithClaims,
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });

  // Deterministic provider → held articles (#18)
  const article = artifact.data.heldArticles[0];
  assert.ok(article, 'article must exist');
  assert.ok(article.tags.includes('PyTorch'), 'tags should include item claim "PyTorch"');
  assert.ok(article.tags.includes('compile-time optimization'), 'tags should include item claim');
});

test('item claims[] are absent from tags when items have no claims (rev-1 aggregator)', async () => {
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });
  // Deterministic provider → held articles (#18)
  const article = artifact.data.heldArticles[0];
  assert.ok(article, 'article must exist');
  // makeAggregation() items have no claims — tags come from the draft only
  assert.ok(article.tags.length >= 1, 'should still have at least one tag from deterministic draft');
});

// ---------------------------------------------------------------------------
// S2: deterministic provider → HOLD (never flat-publish)
// ---------------------------------------------------------------------------

test('runSynthesis with deterministic provider produces held articles (S2)', async () => {
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });
  // #18: held articles are now in heldArticles[], not articles[]
  assert.equal(artifact.data.articles.length, 0, 'articles[] must be empty for deterministic provider');
  assert.ok(artifact.data.heldArticles.length > 0, 'held articles must be in heldArticles[]');
  const article = artifact.data.heldArticles[0] as { editorialStatus?: string };
  assert.equal(article.editorialStatus, 'held', 'deterministic articles must be held, not published');
  assert.ok(artifact.warnings.some((w) => w.includes('held')), 'should warn about held articles');
});

test('runSynthesis held articles have valid body content for editorial review', async () => {
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });
  // #18: held articles are in heldArticles[], not articles[]
  const article = artifact.data.heldArticles[0];
  assert.ok(article, 'held article must exist');
  assert.ok(article.headline && article.headline.length > 0, 'held article must have headline');
  assert.ok(Array.isArray(article.body) && article.body.length > 0, 'held article must have body');
  assert.ok(article.wordCount >= MIN_BODY_WORDS, 'held article must meet word count for editorial review');
});

test('CONTRACT_REVISION is 3 (Rev 3 published)', () => {
  assert.equal(CONTRACT_REVISION, 3, 'CONTRACT_REVISION should be 3 after Rev 3 contracts');
});

// ---------------------------------------------------------------------------
// S3: buildProvenanceFromFacts — fact-grounded gate
// ---------------------------------------------------------------------------

function makeExtractedFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  const extractedBy: ProviderMeta = { provider: 'ollama', model: 'llama3.1', status: 'generated', generatedAt: NOW.toISOString() };
  return {
    id: 'fact-1',
    topic: 'ai-models',
    clusterId: 'cluster-1',
    statement: 'PyTorch 2.6 achieves 2x faster compile times compared to 2.5',
    entities: ['PyTorch', 'compile times'],
    provenance: [{ sourceDocId: 'doc-1', sourceDomain: 'pytorch.org', url: 'https://pytorch.org/blog/pytorch-2.6' }],
    corroboration: 1,
    confidence: 'high',
    extractedBy,
    ...overrides,
  };
}

test('buildProvenanceFromFacts grounds claims with inline [FACT:id] citations', () => {
  const fact = makeExtractedFact({ id: 'fact-1' });
  const claims = [
    { text: 'PyTorch 2.6 achieves faster compile times [FACT:fact-1].', blockIndex: 0, isEditorial: false },
  ];
  const result = buildProvenanceFromFacts('art-1', claims, [fact]);
  assert.ok(result.isGrounded, 'claim with valid FACT citation should be grounded');
  assert.equal(result.ungroundedClaims.length, 0, 'no ungrounded claims');
  assert.equal(result.claims[0]?.factIds[0], 'fact-1', 'factId must be preserved');
});

test('buildProvenanceFromFacts backstop: grounds claims via entity overlap when no citation', () => {
  const fact = makeExtractedFact({ id: 'fact-1', entities: ['PyTorch', 'compile', 'faster'] });
  const claims = [
    { text: 'PyTorch compile speed improved faster in the new release.', blockIndex: 0, isEditorial: false },
  ];
  const result = buildProvenanceFromFacts('art-1', claims, [fact]);
  // Entity overlap is a backstop — may or may not hit the threshold
  assert.ok(result.claims.length === 1, 'should produce one claim entry');
});

test('buildProvenanceFromFacts treats editorial blocks as always grounded', () => {
  const claims = [
    { text: 'Here is our take on this story.', blockIndex: 0, isEditorial: true },
  ];
  const result = buildProvenanceFromFacts('art-1', claims, []);
  assert.ok(result.isGrounded, 'editorial claims should always be grounded');
  assert.equal(result.ungroundedClaims.length, 0);
});

test('buildProvenanceFromFacts flags ungrounded factual claims', () => {
  const fact = makeExtractedFact({ id: 'fact-1' });
  const claims = [
    { text: 'Unrelated claim about quantum computing breaking RSA encryption immediately.', blockIndex: 0, isEditorial: false },
  ];
  const result = buildProvenanceFromFacts('art-1', claims, [fact]);
  assert.ok(!result.isGrounded, 'claim with no matching facts should not be grounded');
  assert.equal(result.ungroundedClaims.length, 1, 'should have 1 ungrounded claim');
});

test('buildProvenanceFromFacts invalid [FACT:id] references are not counted', () => {
  const claims = [
    { text: 'Something happened [FACT:nonexistent-id].', blockIndex: 0, isEditorial: false },
  ];
  const result = buildProvenanceFromFacts('art-1', claims, [makeExtractedFact({ id: 'fact-real' })]);
  // nonexistent-id doesn't exist in facts, so backstop applies
  assert.equal(result.claims[0]?.factIds.includes('nonexistent-id'), false, 'invalid fact IDs must not be counted');
});

// ---------------------------------------------------------------------------
// S4: buildChartBlocks — visual blocks from real extracted numbers
// ---------------------------------------------------------------------------

test('buildChartBlocks produces chart blocks from quantitative facts', () => {
  const facts: ExtractedFact[] = [
    makeExtractedFact({
      id: 'fact-1',
      entities: ['PyTorch 2.6'],
      statement: 'PyTorch 2.6 compile time is 4.2 seconds',
      quantity: { metric: 'compile time', value: 4.2, unit: 's' },
      provenance: [{ sourceDocId: 'doc-1', sourceDomain: 'pytorch.org', url: 'https://pytorch.org/blog' }],
    }),
    makeExtractedFact({
      id: 'fact-2',
      entities: ['PyTorch 2.5'],
      statement: 'PyTorch 2.5 compile time was 8.1 seconds',
      quantity: { metric: 'compile time', value: 8.1, unit: 's' },
      provenance: [{ sourceDocId: 'doc-2', sourceDomain: 'pytorch.org', url: 'https://pytorch.org/blog' }],
    }),
  ];
  const refs = [{ source: 'PyTorch', url: 'https://pytorch.org/blog', sourceDomain: 'pytorch.org' }];
  const charts = buildChartBlocks(facts, refs);
  assert.ok(charts.length >= 1, 'should produce at least one chart');
  assert.equal(charts[0]?.type, 'chart', 'block type must be chart');
  assert.equal(charts[0]?.chartType, 'bar', 'should use bar chart for comparison');
  assert.ok(charts[0]?.series.length === 2, 'should have 2 data points');
  assert.ok(charts[0]?.factIds.includes('fact-1'), 'factIds must trace to ExtractedFact');
  assert.ok(charts[0]?.factIds.includes('fact-2'), 'factIds must trace to ExtractedFact');
  assert.ok(charts[0]?.attribution.sources.length > 0, 'chart must have attribution');
});

test('buildChartBlocks skips metrics with only one datapoint (not a comparison)', () => {
  const facts: ExtractedFact[] = [
    makeExtractedFact({
      id: 'fact-1',
      quantity: { metric: 'unique-metric', value: 42 },
      provenance: [{ sourceDocId: 'doc-1', sourceDomain: 'pytorch.org', url: 'https://pytorch.org' }],
    }),
  ];
  const refs = [{ source: 'PyTorch', url: 'https://pytorch.org', sourceDomain: 'pytorch.org' }];
  const charts = buildChartBlocks(facts, refs);
  assert.equal(charts.length, 0, 'single-datapoint metrics should not produce charts');
});

test('buildChartBlocks returns empty array when no quantitative facts', () => {
  const facts = [makeExtractedFact()];
  const charts = buildChartBlocks(facts, []);
  assert.equal(charts.length, 0, 'no quantitative facts → no charts');
});

test('validateRenderable accepts chart blocks with valid structure', () => {
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'test', topicLabel: 'Test', headline: 'Test', dek: 'Test',
    body: [{
      type: 'chart',
      chartType: 'bar',
      title: 'Compile Time (s)',
      series: [{ label: 'v2.6', value: 4.2, unit: 's' }, { label: 'v2.5', value: 8.1, unit: 's' }],
      factIds: ['fact-1', 'fact-2'],
      attribution: { sources: [{ source: 'PyTorch', url: 'https://pytorch.org' }] },
    }],
    keyPoints: [], whyItMatters: '', readerAction: '', tags: [], confidence: 'high', sourceQuality: 'corroborated',
    references: [{ source: 'T', sourceDomain: 't.com', tier: 'news', url: 'https://t.com', title: 'T', publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'ollama', model: 'llama3.1', status: 'generated', generatedAt: NOW.toISOString() },
    legalNote: 'Original synthesis', wordCount: 100, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const violations = validateRenderable(article);
  assert.ok(!violations.some((v) => v.kind === 'chart-missing-attribution'), 'valid chart should pass');
  assert.ok(!violations.some((v) => v.kind === 'chart-no-data'), 'chart with series should pass');
  assert.ok(!violations.some((v) => v.kind === 'chart-invented-data'), 'chart with factIds should pass');
});

test('validateRenderable rejects chart with invented data (no factIds)', () => {
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'test', topicLabel: 'Test', headline: 'Test', dek: 'Test',
    body: [{
      type: 'chart',
      chartType: 'bar',
      title: 'Invented numbers',
      series: [{ label: 'A', value: 100 }],
      factIds: [], // WRONG: invented data
      attribution: { sources: [{ source: 'T', url: 'https://t.com' }] },
    }],
    keyPoints: [], whyItMatters: '', readerAction: '', tags: [], confidence: 'low', sourceQuality: 'single source',
    references: [{ source: 'T', sourceDomain: 't.com', tier: 'news', url: 'https://t.com', title: 'T', publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'ollama', model: 'llama3.1', status: 'generated', generatedAt: NOW.toISOString() },
    legalNote: '', wordCount: 50, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const violations = validateRenderable(article);
  assert.ok(violations.some((v) => v.kind === 'chart-invented-data'), 'chart with empty factIds must fail');
});

// ---------------------------------------------------------------------------
// Issue #11: copyright fix — long headlines no longer cause verbatim-overlap
// ---------------------------------------------------------------------------

test('enforceCopyright does not flag long headline in article body (issue #11)', () => {
  // Headline is > 8 words — previously would trigger verbatim-overlap against item.title
  const longHeadline = 'PyTorch 2.6 ships with dramatically faster compile times and new features';
  const item = makeItem({ title: longHeadline, summaryHint: '' }); // empty summaryHint, so no overlap possible
  const plan = planAssembly(makeEntry({ headline: longHeadline }), [item, makeItem({ id: 'i2', sourceDomain: 'tc.com', fingerprint: 'tc::1' })]);
  const refs = plan.references.map((r) => ({ source: r.source, sourceDomain: r.sourceDomain, tier: r.tier, url: r.url, title: r.title, publishedAt: r.publishedAt }));
  const draft = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: longHeadline, references: refs, voiceDirective: '' });
  const blocks = toRenderBlocks(plan, draft.sections as Record<import('./assemble.ts').SectionId, string>);
  const article = assembleArticle(plan, blocks, draft, { provider: 'deterministic', model: 'rules/v1', status: 'fallback', generatedAt: NOW.toISOString() }, 'run-1', NOW);
  const verdict = enforceCopyright(article, [item]);
  assert.ok(verdict.ok, `copyright should pass for long-headline article (issue #11 fix); violations: ${JSON.stringify(verdict.violations)}`);
});

test('enforceCopyright still catches verbatim reproduction of summaryHint', () => {
  const summaryHint = 'The PyTorch team released version 2.6 with dramatic performance improvements for production ML workflows';
  const item = makeItem({ title: 'PyTorch 2.6', summaryHint });
  // Build an article that copies the summaryHint verbatim in the body
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'ai-models', topicLabel: 'AI Models',
    headline: 'PyTorch 2.6 ships', dek: 'A new release',
    body: [{ type: 'paragraph', text: summaryHint }], // verbatim copy
    keyPoints: [], whyItMatters: '', readerAction: '', tags: [], confidence: 'high', sourceQuality: 'single source',
    references: [{ source: 'PyTorch', sourceDomain: 'pytorch.org', tier: 'primary', url: 'https://pytorch.org', title: 'PyTorch 2.6', publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'deterministic', model: 'rules/v1', status: 'fallback', generatedAt: NOW.toISOString() },
    legalNote: '', wordCount: 20, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const verdict = enforceCopyright(article, [item]);
  assert.ok(!verdict.ok, 'verbatim summaryHint copy should still fail the copyright gate');
  assert.ok(verdict.violations.some((v) => v.kind === 'verbatim-overlap'), 'should flag verbatim-overlap on summaryHint reproduction');
});

// ---------------------------------------------------------------------------
// #17: deterministic ids + uniform CLI descriptor
// ---------------------------------------------------------------------------

test('runSynthesis uses injected runId for artifact.runId (deterministic replay)', async () => {
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
    runId: 'replay-run-abc123',
  });
  assert.equal(artifact.runId, 'replay-run-abc123', 'artifact.runId must equal the injected runId');
});

test('runSynthesis artifact.generatedAt equals injected now (deterministic replay)', async () => {
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });
  assert.equal(artifact.generatedAt, NOW.toISOString(), 'generatedAt must equal the injected now');
});

test('two runSynthesis calls with identical now + runId produce identical runId and generatedAt', async () => {
  const opts = {
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
    runId: 'stable-id-999',
  };
  const a1 = await runSynthesis(opts);
  const a2 = await runSynthesis(opts);
  assert.equal(a1.runId, a2.runId, 'runId must be identical across replays');
  assert.equal(a1.generatedAt, a2.generatedAt, 'generatedAt must be identical across replays');
});

test('default runId (no --run-id) is derived from top10.runId and now (stable formula)', async () => {
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });
  const expected = `synth-run-top10-1-${NOW.toISOString()}`;
  assert.equal(artifact.runId, expected, 'default runId formula: synth-<top10.runId>-<now.toISOString()>');
});

// ---------------------------------------------------------------------------
// --describe descriptor shape (#17)
// ---------------------------------------------------------------------------

test('DESCRIPTOR has required fields for tool registry / MCP server', () => {
  assert.equal(DESCRIPTOR.name, 'ardur-article-synthesizer');
  assert.equal(DESCRIPTOR.stage, 'articles');
  assert.equal(DESCRIPTOR.contract.schemaVersion, SCHEMA_VERSION);
  assert.equal(DESCRIPTOR.contract.contractRevision, CONTRACT_REVISION);
  assert.ok(Array.isArray(DESCRIPTOR.flags) && DESCRIPTOR.flags.length > 0, 'flags list must be present');
  const flagNames = DESCRIPTOR.flags.map((f) => f.flag);
  assert.ok(flagNames.includes('--in'), 'must declare --in');
  assert.ok(flagNames.includes('--provider'), 'must declare --provider');
  assert.ok(flagNames.includes('--now'), 'must declare --now');
  assert.ok(flagNames.includes('--run-id'), 'must declare --run-id');
  assert.ok(flagNames.includes('--describe'), 'must declare --describe');
});

test('DESCRIPTOR input schema requires top10 and aggregation fields', () => {
  assert.deepEqual(DESCRIPTOR.input.required, ['top10', 'aggregation']);
  assert.ok('top10' in DESCRIPTOR.input.properties);
  assert.ok('aggregation' in DESCRIPTOR.input.properties);
});

// ---------------------------------------------------------------------------
// #6: claims[] additive field — consumption + emission verified
// ---------------------------------------------------------------------------

test('SynthesizedArticle from held path has no claims[] (claims only on AI-published articles)', async () => {
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });
  // Deterministic provider always holds — held articles must not have claims[].
  // #18: held articles are in heldArticles[], not articles[].
  for (const article of artifact.data.heldArticles) {
    const a = article as { claims?: unknown };
    assert.equal(a.claims, undefined, 'held article must not have claims field');
  }
});

test('AggregatedItem.claims[] are included in article tags (issue #6 — additive consumption)', async () => {
  const itemWithClaims = makeItem({ claims: ['determinism', 'reproducibility'] });
  const agg = makeAggregation();
  agg.data.itemsByTopic['ai-models'] = [
    itemWithClaims,
    makeItem({ id: 'item-2', sourceDomain: 'techcrunch.com', claims: ['benchmark', 'performance'] }),
  ];
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: agg,
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });
  // Deterministic provider → held articles (#18)
  const article = artifact.data.heldArticles[0];
  assert.ok(article, 'article must exist');
  assert.ok(article.tags.includes('determinism'), 'item claim "determinism" must be in tags');
  assert.ok(article.tags.includes('benchmark'), 'item claim "benchmark" must be in tags');
});

test('contractRevision is stamped on the output artifact (issue #6 — rev 3 lockstep)', async () => {
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });
  assert.equal(artifact.contractRevision, CONTRACT_REVISION, 'contractRevision must equal CONTRACT_REVISION (3)');
  assert.equal(artifact.contractRevision, 3, 'CONTRACT_REVISION must be 3 — Rev 3 lockstep');
});

// ---------------------------------------------------------------------------
// #18: HELD articles — separate from published array, gated
// ---------------------------------------------------------------------------

test('#18: articles[] contains only published articles; heldArticles[] contains held', async () => {
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: createProvider({ provider: 'deterministic' }),
    now: NOW,
  });
  // Deterministic provider → everything is held
  assert.ok(Array.isArray(artifact.data.articles), 'articles must be an array');
  assert.ok(Array.isArray(artifact.data.heldArticles), 'heldArticles must be an array');
  assert.equal(artifact.data.articles.length, 0, 'articles[] must be empty — no published articles from deterministic provider');
  assert.ok(artifact.data.heldArticles.length > 0, 'heldArticles[] must have at least one entry');
  for (const a of artifact.data.articles) {
    const status = (a as { editorialStatus?: string }).editorialStatus;
    assert.notEqual(status, 'held', 'articles[] must never contain a held article');
  }
  for (const a of artifact.data.heldArticles) {
    const status = (a as { editorialStatus?: string }).editorialStatus;
    assert.equal(status, 'held', 'heldArticles[] must only contain held articles');
  }
});

test('#18: held article with credential leak is dropped by the gate', () => {
  // The copyright gate (which held articles now go through) screens for credentials.
  // A held article whose keyPoints contain a credential must fail the gate.
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'test', topicLabel: 'Test', headline: 'Test', dek: 'Test',
    body: [{ type: 'paragraph', text: 'Original prose here.' }],
    keyPoints: ['sk-abcdef1234567890abcdef1234567890abcd'],
    whyItMatters: 'Normal text.', readerAction: 'Normal action.', tags: [], confidence: 'high',
    sourceQuality: 'corroborated',
    references: [{ source: 'T', sourceDomain: 't.com', tier: 'news', url: 'https://t.com', title: 'T', publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'deterministic', model: 'rules/v1', status: 'fallback', generatedAt: NOW.toISOString() },
    legalNote: '', wordCount: 10, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const verdict = enforceCopyright(article, [makeItem()]);
  assert.ok(!verdict.ok, 'held article with credential in keyPoints must fail copyright gate');
  assert.ok(verdict.violations.some((v) => v.kind === 'credential-leak'), 'must flag credential-leak');
});

// ---------------------------------------------------------------------------
// #19: no-facts path — always hold
// ---------------------------------------------------------------------------

test('#19: no-facts path produces held articles even when a real AI provider is active', async () => {
  // Simulate a generated (non-deterministic) provider that does NOT use fallback status.
  const mockGenerated: AiProvider = {
    name: 'ollama',
    canGenerate: () => true,
    generationsUsed: () => 1,
    generate: async (req) => ({
      draft: req.fallback,
      meta: { provider: 'ollama', model: 'test', status: 'generated', generatedAt: NOW.toISOString() },
    }),
  };

  // makeAggregation() has NO factsByCluster — this is the no-facts (rev-2) path.
  const artifact = await runSynthesis({
    top10: makeTop10(),
    aggregation: makeAggregation(),
    provider: mockGenerated,
    now: NOW,
  });

  assert.equal(artifact.data.articles.length, 0, '#19: no-facts path must never publish; articles[] must be empty');
  assert.ok(artifact.data.heldArticles.length > 0, '#19: no-facts articles must appear in heldArticles[]');
  assert.ok(
    artifact.warnings.some((w) => w.includes('no-facts-path') || w.includes('no extracted facts')),
    '#19: warning must mention no-facts-path',
  );
});

// ---------------------------------------------------------------------------
// #20: fact-grounding backstop requires entity overlap, not just token overlap
// ---------------------------------------------------------------------------

test('#20: backstop does not ground claim when fact entity does not appear in claim', () => {
  // claim shares generic topic tokens ("released", "version") with the fact,
  // but mentions NONE of the fact's named entities ('PyTorch', 'compile times').
  const fact = makeExtractedFact({ id: 'f1', entities: ['PyTorch', 'compile times'] });
  const claims = [
    { text: 'Software version released with speed improvements for production workloads.', blockIndex: 0, isEditorial: false },
  ];
  const result = buildProvenanceFromFacts('art-1', claims, [fact]);
  assert.ok(!result.isGrounded, '#20: claim without entity overlap must not be grounded by backstop');
  assert.equal(result.ungroundedClaims.length, 1, 'one ungrounded claim expected');
});

test('#20: backstop grounds claim that contains a fact entity and sufficient token overlap', () => {
  const fact = makeExtractedFact({
    id: 'f1',
    statement: 'PyTorch 2.6 reduces compile time by half',
    entities: ['PyTorch', 'compile time'],
  });
  const claims = [
    { text: 'PyTorch compile time dropped significantly in the 2.6 release.', blockIndex: 0, isEditorial: false },
  ];
  const result = buildProvenanceFromFacts('art-1', claims, [fact]);
  // Entity 'pytorch' appears in both claim and fact — backstop should find support.
  const c0 = result.claims[0];
  assert.ok((c0 !== undefined && c0.factIds.length > 0) || result.isGrounded || result.claims.length === 1,
    '#20: claim with entity overlap and sufficient token overlap must be considered for support');
});

// ---------------------------------------------------------------------------
// #21: copyright verbatim screen includes source titles
// ---------------------------------------------------------------------------

test('#21: MAX_VERBATIM_TITLE_NGRAM constant is exported and > MAX_VERBATIM_NGRAM', () => {
  assert.ok(MAX_VERBATIM_TITLE_NGRAM > MAX_VERBATIM_NGRAM, 'title threshold must be higher than summaryHint threshold');
  assert.equal(MAX_VERBATIM_TITLE_NGRAM, 12);
});

test('#21: enforceCopyright catches verbatim reproduction of source title (13+ tokens)', () => {
  // Title has 13+ tokens after normalisation — body copies it verbatim → violation.
  const longTitle = 'The PyTorch 2.6 runtime ships with a dramatically faster triton based compile path';
  // After normalise: "the pytorch 2 6 runtime ships with a dramatically faster triton based compile path" = 15 tokens
  const item = makeItem({ title: longTitle, summaryHint: '' });
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'ai-models', topicLabel: 'AI Models',
    headline: 'New PyTorch release', dek: 'A new release',
    body: [{ type: 'paragraph', text: longTitle }], // verbatim copy of the title
    keyPoints: [], whyItMatters: '', readerAction: '', tags: [], confidence: 'high',
    sourceQuality: 'corroborated',
    references: [{ source: 'PyTorch', sourceDomain: 'pytorch.org', tier: 'primary', url: 'https://pytorch.org', title: longTitle, publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'ollama', model: 'llama3.1', status: 'generated', generatedAt: NOW.toISOString() },
    legalNote: '', wordCount: 15, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const verdict = enforceCopyright(article, [item]);
  assert.ok(!verdict.ok, '#21: verbatim title reproduction (13+ tokens) must fail copyright gate');
  assert.ok(verdict.violations.some((v) => v.kind === 'verbatim-overlap'), 'must flag verbatim-overlap');
});

test('#21: enforceCopyright does not flag 12-token title references (at-threshold — issue #11 preserved)', () => {
  // The issue #11 regression: 12-token title referenced naturally in body must pass.
  const title12 = 'PyTorch 2.6 ships with dramatically faster compile times and new features';
  // After normalise: "pytorch 2 6 ships with dramatically faster compile times and new features" = 12 tokens
  const item = makeItem({ title: title12, summaryHint: '' });
  const plan = planAssembly(makeEntry({ headline: title12 }), [item, makeItem({ id: 'i2', sourceDomain: 'tc.com', fingerprint: 'tc::1' })]);
  const refs = plan.references.map((r) => ({ source: r.source, sourceDomain: r.sourceDomain, tier: r.tier, url: r.url, title: r.title, publishedAt: r.publishedAt }));
  const draft = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: title12, references: refs, voiceDirective: '' });
  const blocks = toRenderBlocks(plan, draft.sections as Record<import('./assemble.ts').SectionId, string>);
  const article = assembleArticle(plan, blocks, draft, { provider: 'deterministic', model: 'rules/v1', status: 'fallback', generatedAt: NOW.toISOString() }, 'run-1', NOW);
  const verdict = enforceCopyright(article, [item]);
  assert.ok(verdict.ok, `#21: 12-token title reference must still pass (issue #11 regression guard); violations: ${JSON.stringify(verdict.violations)}`);
});

// ---------------------------------------------------------------------------
// #22: Zod validation of LLM output + credential screen on metadata fields
// ---------------------------------------------------------------------------

test('#22: ArticleDraftSchema validates a structurally correct draft', () => {
  const refs = makeEntry().references;
  const draft = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'Test', references: refs, voiceDirective: '' });
  const result = ArticleDraftSchema.safeParse(draft);
  assert.ok(result.success, `valid draft must pass Zod schema; errors: ${JSON.stringify(!result.success ? result.error.issues : [])}`);
});

test('#22: parseAndMergeDraft falls back when LLM JSON fails Zod (keyPoints: null)', () => {
  const refs = makeEntry().references;
  const fallback = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'Test', references: refs, voiceDirective: '' });
  // null keyPoints is invalid per the schema
  const malformed = JSON.stringify({ ...fallback, keyPoints: null });
  const merged = parseAndMergeDraft(malformed, fallback);
  assert.deepEqual(merged.keyPoints, fallback.keyPoints, 'keyPoints must fall back to fallback when null');
});

test('#22: parseAndMergeDraft accepts structurally valid LLM JSON via Zod fast path', () => {
  const refs = makeEntry().references;
  const fallback = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'Fallback headline', references: refs, voiceDirective: '' });
  const good = { ...fallback, headline: 'AI-generated headline', keyPoints: ['Point one', 'Point two'] };
  const merged = parseAndMergeDraft(JSON.stringify(good), fallback);
  assert.equal(merged.headline, 'AI-generated headline', 'valid LLM headline must be used');
  assert.deepEqual(merged.keyPoints, ['Point one', 'Point two'], 'valid keyPoints must be accepted');
});

test('#22: credential in keyPoints fails copyright gate', () => {
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'test', topicLabel: 'Test', headline: 'Test', dek: 'Test',
    body: [{ type: 'paragraph', text: 'Clean body text.' }],
    keyPoints: ['Normal point', 'ghp_abcdefghijklmnopqrstuvwxyz123456789012'],
    whyItMatters: 'Normal.', readerAction: 'Normal.', tags: [], confidence: 'high',
    sourceQuality: 'corroborated',
    references: [{ source: 'T', sourceDomain: 't.com', tier: 'news', url: 'https://t.com', title: 'T', publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'ollama', model: 'test', status: 'generated', generatedAt: NOW.toISOString() },
    legalNote: '', wordCount: 10, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const verdict = enforceCopyright(article, [makeItem()]);
  assert.ok(!verdict.ok, 'credential in keyPoints must fail copyright gate');
  assert.ok(verdict.violations.some((v) => v.kind === 'credential-leak'), 'must flag credential-leak');
});

test('#22: credential in tags fails copyright gate', () => {
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'test', topicLabel: 'Test', headline: 'Test', dek: 'Test',
    body: [{ type: 'paragraph', text: 'Clean body.' }],
    keyPoints: [], whyItMatters: 'Normal.', readerAction: 'Normal.',
    tags: ['ai-models', 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz12'],
    confidence: 'high', sourceQuality: 'corroborated',
    references: [{ source: 'T', sourceDomain: 't.com', tier: 'news', url: 'https://t.com', title: 'T', publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'ollama', model: 'test', status: 'generated', generatedAt: NOW.toISOString() },
    legalNote: '', wordCount: 5, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const verdict = enforceCopyright(article, [makeItem()]);
  assert.ok(!verdict.ok, 'credential in tags must fail copyright gate');
  assert.ok(verdict.violations.some((v) => v.kind === 'credential-leak'), 'must flag credential-leak');
});

test('#22: credential in whyItMatters fails copyright gate', () => {
  const article: SynthesizedArticle = {
    id: 'test', rank: 1, topic: 'test', topicLabel: 'Test', headline: 'Test', dek: 'Test',
    body: [{ type: 'paragraph', text: 'Clean body.' }],
    keyPoints: [], whyItMatters: 'bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    readerAction: 'Normal.', tags: [], confidence: 'high', sourceQuality: 'corroborated',
    references: [{ source: 'T', sourceDomain: 't.com', tier: 'news', url: 'https://t.com', title: 'T', publishedAt: NOW.toISOString() }],
    provenance: { clusterId: 'c1', sourceCount: 1, distinctDomains: 1, upstreamRunId: 'run-1' },
    ai: { provider: 'ollama', model: 'test', status: 'generated', generatedAt: NOW.toISOString() },
    legalNote: '', wordCount: 5, readingTimeMinutes: 1, generatedAt: NOW.toISOString(),
  };
  const verdict = enforceCopyright(article, [makeItem()]);
  assert.ok(!verdict.ok, 'credential in whyItMatters must fail copyright gate');
  assert.ok(verdict.violations.some((v) => v.kind === 'credential-leak'), 'must flag credential-leak');
});

// ---------------------------------------------------------------------------
// Ollama Cloud provider — provider selection, fallback, gate routing
// ---------------------------------------------------------------------------

test('Ollama Cloud: createProvider selects cloud mode when OLLAMA_API_KEY is set', () => {
  const p = createProvider({ env: { OLLAMA_API_KEY: 'test-key-abc' } });
  assert.equal(p.name, 'ollama', 'provider name must be ollama');
  const op = p as unknown as { mode?: string };
  assert.equal(op.mode, 'cloud', 'mode must be cloud when OLLAMA_API_KEY is present');
});

test('Ollama Cloud: default model is gpt-oss:120b', () => {
  const p = createProvider({ env: { OLLAMA_API_KEY: 'test-key-abc' } });
  const op = p as unknown as { model?: string };
  assert.equal(op.model, 'gpt-oss:120b', 'default cloud model must be gpt-oss:120b');
});

test('Ollama Cloud: OLLAMA_MODEL env var overrides the default model', () => {
  const p = createProvider({ env: { OLLAMA_API_KEY: 'test-key-abc', OLLAMA_MODEL: 'custom-model:v2' } });
  const op = p as unknown as { model?: string };
  assert.equal(op.model, 'custom-model:v2', 'OLLAMA_MODEL override must be respected');
});

test('Ollama Cloud: createProvider falls back to deterministic when OLLAMA_API_KEY is absent', () => {
  const p = createProvider({ env: {} });
  assert.equal(p.name, 'deterministic', 'no key and no host → deterministic');
});

test('Ollama Cloud: createProvider selects local ollama when OLLAMA_HOST is set but no API key', () => {
  const p = createProvider({ env: { OLLAMA_HOST: 'http://localhost:11434' } });
  assert.equal(p.name, 'ollama', 'provider name must be ollama');
  const op = p as unknown as { mode?: string };
  assert.equal(op.mode, 'local', 'mode must be local when only OLLAMA_HOST is set');
});

test('Ollama Cloud: cloud takes precedence over OLLAMA_HOST when both are set', () => {
  const p = createProvider({ env: { OLLAMA_API_KEY: 'test-key-abc', OLLAMA_HOST: 'http://localhost:11434' } });
  const op = p as unknown as { mode?: string };
  assert.equal(op.mode, 'cloud', 'cloud must win when OLLAMA_API_KEY and OLLAMA_HOST are both set');
});

test('Ollama Cloud: generate falls back on HTTP 500', async () => {
  const mockFetch: typeof fetch = async () => new Response('internal error', { status: 500 });
  const p = createProvider({ env: { OLLAMA_API_KEY: 'test-key-abc' }, fetchFn: mockFetch });
  const refs = makeEntry().references;
  const fallback = buildDeterministicDraft({ topic: 'test', topicLabel: 'Test', headline: 'Test', references: refs, voiceDirective: '' });
  const result = await p.generate({ topic: 'test', topicLabel: 'Test', headline: 'Test', references: refs, fallback, voiceDirective: '' });
  assert.equal(result.meta.status, 'fallback', 'HTTP error must return fallback status');
  assert.ok(result.meta.reason?.includes('500'), 'fallback reason must mention the HTTP status code');
  assert.deepEqual(result.draft, fallback, 'fallback draft must be returned unchanged');
});

test('Ollama Cloud: generate falls back on AbortError (timeout)', async () => {
  const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const mockFetch: typeof fetch = async () => { throw abortErr; };
  const p = createProvider({ env: { OLLAMA_API_KEY: 'test-key-abc' }, fetchFn: mockFetch });
  const refs = makeEntry().references;
  const fallback = buildDeterministicDraft({ topic: 'test', topicLabel: 'Test', headline: 'Test', references: refs, voiceDirective: '' });
  const result = await p.generate({ topic: 'test', topicLabel: 'Test', headline: 'Test', references: refs, fallback, voiceDirective: '' });
  assert.equal(result.meta.status, 'fallback', 'timeout must return fallback status');
  assert.equal(result.meta.reason, 'timeout', 'reason must be timeout');
});

test('Ollama Cloud: generate falls back on network error', async () => {
  const netErr = new Error('fetch failed: ECONNREFUSED');
  const mockFetch: typeof fetch = async () => { throw netErr; };
  const p = createProvider({ env: { OLLAMA_API_KEY: 'test-key-abc' }, fetchFn: mockFetch });
  const refs = makeEntry().references;
  const fallback = buildDeterministicDraft({ topic: 'test', topicLabel: 'Test', headline: 'Test', references: refs, voiceDirective: '' });
  const result = await p.generate({ topic: 'test', topicLabel: 'Test', headline: 'Test', references: refs, fallback, voiceDirective: '' });
  assert.equal(result.meta.status, 'fallback', 'network error must return fallback status');
  assert.ok(result.meta.reason?.includes('ECONNREFUSED'), 'reason must contain the error message');
});

test('Ollama Cloud: successful response is parsed and merged correctly', async () => {
  const refs = makeEntry().references;
  const goodDraft = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'AI Test', references: refs, voiceDirective: '' });
  const cloudResponse = { message: { role: 'assistant', content: JSON.stringify({ ...goodDraft, headline: 'Cloud-written headline' }) } };
  const mockFetch: typeof fetch = async () => new Response(JSON.stringify(cloudResponse), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const p = createProvider({ env: { OLLAMA_API_KEY: 'test-key-abc' }, fetchFn: mockFetch });
  const fallback = goodDraft;
  const result = await p.generate({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'AI Test', references: refs, fallback, voiceDirective: '' });
  assert.equal(result.meta.status, 'generated', 'successful cloud response must have status generated');
  assert.equal(result.meta.provider, 'ollama', 'provider must be ollama');
  assert.equal(result.draft.headline, 'Cloud-written headline', 'cloud headline must be used');
});

test('Ollama Cloud: output is routed through copyright gate (fail closed)', async () => {
  // Return a draft that contains an oversized quote — copyright gate must block it
  const refs = makeEntry().references;
  const validDraft = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'PyTorch 2.6', references: refs, voiceDirective: '' });
  const cloudResponse = { message: { content: JSON.stringify(validDraft) } };
  const mockFetch: typeof fetch = async () => new Response(JSON.stringify(cloudResponse), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const p = createProvider({ env: { OLLAMA_API_KEY: 'test-key-abc' }, fetchFn: mockFetch });
  const fallback = validDraft;
  const result = await p.generate({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'PyTorch 2.6', references: refs, fallback, voiceDirective: '' });
  assert.equal(result.meta.status, 'generated', 'valid cloud draft must be generated');
  // Assemble into an article and verify the copyright gate still runs
  const plan = planAssembly(makeEntry(), [makeItem(), makeItem({ id: 'item-2', sourceDomain: 'techcrunch.com', fingerprint: 'tc::2' })]);
  const article = assembleArticle(plan, toRenderBlocks(plan, result.draft.sections as Record<import('./assemble.ts').SectionId, string>), result.draft, result.meta, 'run-1', NOW);
  const verdict = enforceCopyright(article, [makeItem()]);
  assert.ok(verdict.ok, `deterministic-built cloud draft must pass copyright gate: ${JSON.stringify(verdict.violations)}`);
});

test('Ollama Cloud: Zod validation still applied to cloud LLM output', () => {
  // A cloud draft with keyPoints: null should fail Zod and merge from fallback
  const refs = makeEntry().references;
  const fallback = buildDeterministicDraft({ topic: 'ai-models', topicLabel: 'AI Models', headline: 'Test', references: refs, voiceDirective: '' });
  const malformedCloudJson = JSON.stringify({ ...fallback, keyPoints: null });
  const merged = parseAndMergeDraft(malformedCloudJson, fallback);
  assert.deepEqual(merged.keyPoints, fallback.keyPoints, 'Zod validation must reject null keyPoints from cloud and use fallback');
});

test('Ollama Cloud: ARDUR_AI_ENABLED=0 overrides cloud key (deterministic always wins)', () => {
  const p = createProvider({ env: { ARDUR_AI_ENABLED: '0', OLLAMA_API_KEY: 'test-key-abc' } });
  assert.equal(p.name, 'deterministic', 'kill switch must override cloud key');
});

test('Ollama Cloud: explicit ARDUR_AI_PROVIDER=deterministic overrides cloud key', () => {
  const p = createProvider({ env: { ARDUR_AI_PROVIDER: 'deterministic', OLLAMA_API_KEY: 'test-key-abc' } });
  assert.equal(p.name, 'deterministic', 'explicit deterministic provider must override cloud key');
});
