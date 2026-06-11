/**
 * Privacy guards — no PII in URLs or logs, aggregate-only metrics.
 *
 * Reuses the shared `FORBIDDEN_METRIC_KEY_FRAGMENTS` from contracts.ts (the same
 * screen ardur.ai's `refresh-article-intelligence.mjs` applies). The synthesizer
 * touches URLs (references) and emits logs/run reports; both must be scrubbed.
 */

import { FORBIDDEN_METRIC_KEY_FRAGMENTS } from './contracts.ts';

export { FORBIDDEN_METRIC_KEY_FRAGMENTS };

/** Query/fragment params stripped from every reference URL before it is stored. */
export const STRIPPED_URL_PARAMS: readonly string[] = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'msclkid', 'mc_eid', 'mc_cid', 'ref', 'referrer',
];

/**
 * Normalize a public URL for storage/logging: drop credentials, fragment, and
 * tracking params. Returns '' for anything unsafe (delegates host/IP/protocol
 * safety to the shared source-safety port). PII never reaches the artifact.
 */
export function scrubUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return '';
  }

  // Only allow https and http (no file://, data://, javascript:, etc.)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';

  // Drop credentials — never store user:password@ in any artifact
  url.username = '';
  url.password = '';

  // Drop fragment — client-side navigation hint, not canonical
  url.hash = '';

  // Drop tracking params
  for (const param of STRIPPED_URL_PARAMS) {
    url.searchParams.delete(param);
  }

  return url.toString();
}

/** True iff a metric/log key contains any forbidden PII fragment. */
export function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  return FORBIDDEN_METRIC_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/**
 * Redact a log/run-report record in place semantics (returns a safe copy):
 * removes forbidden keys and scrubs any string value that looks like a URL.
 */
export function redactForLog(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (isForbiddenKey(key)) continue;

    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      result[key] = scrubUrl(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}
