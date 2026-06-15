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
 * True iff `hostname` is a private, loopback, link-local, or metadata range
 * that must not appear in published reference URLs (SSRF guard, issue #31).
 */
function isPrivateHost(hostname: string): boolean {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();

  // Reject bare hostnames without a dot (e.g. "localhost", "intranet")
  if (!lower.includes('.') && !lower.includes(':')) return true;

  // Reject known private/metadata hostnames
  if (lower === 'localhost') return true;

  // IPv4 ranges
  const v4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b] = v4.map(Number) as [string, number, number, number, number];
    if (a === 127) return true;              // 127.0.0.0/8 loopback
    if (a === 10) return true;              // 10.0.0.0/8 private
    if (a === 0) return true;               // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / EC2 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }

  // IPv6: loopback, ULA (fc00::/7), link-local (fe80::/10)
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe80')) return true;

  return false;
}

/**
 * Normalize a public URL for storage/logging: enforce https-only, block private
 * IPs (SSRF guard per spec §13), drop credentials/fragment/tracking params.
 * Returns '' for anything unsafe. PII never reaches the artifact.
 */
export function scrubUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return '';
  }

  // Enforce https-only (spec §13) — reject http, file, data, javascript, etc.
  if (url.protocol !== 'https:') return '';

  // Block private/loopback/link-local/metadata hosts to prevent SSRF (spec §13).
  if (isPrivateHost(url.hostname)) return '';

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
