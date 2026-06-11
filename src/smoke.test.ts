import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, CONTRACT_REVISION, CYCLE_INTERVAL_MS, FORBIDDEN_METRIC_KEY_FRAGMENTS, assertCompatibleArtifact, SchemaVersionError } from './contracts.ts';
import { runSynthesis } from './index.ts';
import { MAX_QUOTE_WORDS, MAX_VERBATIM_NGRAM, enforceCopyright, isQuoteWithinLimit, longestVerbatimRun } from './copyright.ts';
import { SECTION_PLAN, MIN_BODY_WORDS, MAX_REFERENCES, planAssembly, toRenderBlocks, assembleArticle } from './assemble.ts';
import { RENDER_CONTRACT, RENDERABLE_BLOCK_TYPES, validateRenderable } from './render.ts';
import { isForbiddenKey, scrubUrl, redactForLog } from './privacy.ts';
import { VOICE_STYLE, SECTION_VOICE, buildVoiceDirective, lintVoice } from './style.ts';
import { buildProvenance, isFullyGrounded } from './provenance.ts';
import { createProvider, buildDeterministicDraft } from './provider.ts';
import type { AggregatedItem, Top10Entry, SynthesizedArticle, Top10Artifact, AggregationArtifact } from './contracts.ts';

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
  const totalWords = blocks.map((b) => b.text ?? (b.items ?? []).join(' ')).join(' ').split(/\s+/).filter(Boolean).length;
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
  assert.ok(artifact.data.articles.length > 0, 'should produce at least one article');

  const article = artifact.data.articles[0];
  assert.ok(article, 'first article must exist');
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

  const article = artifact.data.articles[0];
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
  const article = artifact.data.articles[0];
  assert.ok(article, 'article must exist');
  // makeAggregation() items have no claims — tags come from the draft only
  assert.ok(article.tags.length >= 1, 'should still have at least one tag from deterministic draft');
});
