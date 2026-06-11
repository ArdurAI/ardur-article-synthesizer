import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, CYCLE_INTERVAL_MS, FORBIDDEN_METRIC_KEY_FRAGMENTS } from './contracts.ts';
import { runSynthesis } from './index.ts';
import { MAX_QUOTE_WORDS, MAX_VERBATIM_NGRAM } from './copyright.ts';
import { SECTION_PLAN, MIN_BODY_WORDS, MAX_REFERENCES } from './assemble.ts';
import { RENDER_CONTRACT, RENDERABLE_BLOCK_TYPES } from './render.ts';
import { isForbiddenKey } from './privacy.ts';

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

test('runSynthesis is wired but not yet implemented', async () => {
  await assert.rejects(
    async () => runSynthesis({ top10: undefined as never, aggregation: undefined as never }),
    /not implemented/,
  );
});
