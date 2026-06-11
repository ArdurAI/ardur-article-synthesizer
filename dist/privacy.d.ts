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
export declare const STRIPPED_URL_PARAMS: readonly string[];
/**
 * Normalize a public URL for storage/logging: drop credentials, fragment, and
 * tracking params. Returns '' for anything unsafe (delegates host/IP/protocol
 * safety to the shared source-safety port). PII never reaches the artifact.
 */
export declare function scrubUrl(value: unknown): string;
/** True iff a metric/log key contains any forbidden PII fragment. */
export declare function isForbiddenKey(key: string): boolean;
/**
 * Redact a log/run-report record in place semantics (returns a safe copy):
 * removes forbidden keys and scrubs any string value that looks like a URL.
 */
export declare function redactForLog(record: Record<string, unknown>): Record<string, unknown>;
