/**
 * Pluggable, cost-guarded AI provider.
 *
 * SCAFFOLD ONLY — signatures are final; bodies are stubs.
 *
 * Extracted and generalized from `ardur.ai/main:src/lib/aiProvider.mjs`
 * (`generateSignalBrief`). That module already implements the exact behaviour we
 * need; promote it from single-paragraph briefs to full articles:
 *
 *   - provider order: deterministic (default, zero-cost) -> ollama (local-first,
 *     cloud only if OLLAMA_API_KEY set) -> openai (optional).
 *   - `ARDUR_AI_ENABLED=0` or `ARDUR_AI_PROVIDER=deterministic` forces the
 *     deterministic path with NO network calls (this is the CI default).
 *   - every model call is wrapped in a timeout; any failure (non-JSON, HTTP
 *     error, timeout, budget exhausted) falls back to deterministic output and
 *     records the reason in `ProviderMeta.reason`.
 *   - a per-run generation budget (`ARDUR_AI_MAX_GENERATIONS`) caps model calls;
 *     once spent, every remaining article is deterministic.
 *
 * The deterministic path is NOT a degraded stub: it is a real rules-based
 * assembler over the cluster's metadata (headlines, sources, dates) and MUST
 * produce a valid, copyright-safe article on its own. AI only improves prose.
 *
 * VOICE: both paths share the Ardur house voice ("GenZ-but-professional", see
 * `style.ts` + docs/voice.md). The LLM path receives `GenerateRequest.voiceDirective`
 * in its prompt; the deterministic path parameterizes its templates from the
 * same `VOICE_STYLE`, so a budget=0 article reads on-voice — not as dry newswire.
 */

import type { ProviderMeta, Confidence, SourceRef } from './contracts.ts';

export type ProviderName = 'deterministic' | 'ollama' | 'openai';

/** Inputs the provider is allowed to see — metadata only, never article bodies. */
export interface GenerateRequest {
  topic: string;
  topicLabel: string;
  /** The representative cluster headline (factual title, may be quoted as a name). */
  headline: string;
  /** Copyright-safe references: title + source + link + date. NO body text. */
  references: SourceRef[];
  /** Deterministic draft used as the fallback AND as grounding for the model. */
  fallback: ArticleDraft;
  /**
   * The Ardur house-voice directive (from `style.ts:buildVoiceDirective`),
   * threaded verbatim into the model prompt. The SAME directive parameterizes
   * the deterministic fallback templates, so budget=0 output reads on-voice too.
   * See docs/voice.md.
   */
  voiceDirective: string;
}

/** The structured draft a provider returns. Validated against ARTICLE_SCHEMA. */
export interface ArticleDraft {
  headline: string;
  dek: string;
  /** Ordered section bodies keyed by canonical section id (see assemble.ts). */
  sections: Record<string, string>;
  keyPoints: string[];
  whyItMatters: string;
  readerAction: string;
  confidence: Confidence;
  tags: string[];
}

export interface GenerateResult {
  draft: ArticleDraft;
  meta: ProviderMeta;
}

/**
 * JSON-schema the model output is validated against (strict for OpenAI, repaired
 * for Ollama). Mirrors `SIGNAL_BRIEF_SCHEMA` but for the article shape. Any field
 * that fails validation is replaced from the deterministic `fallback`.
 */
export const ARTICLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'dek', 'sections', 'keyPoints', 'whyItMatters', 'readerAction', 'confidence', 'tags'],
} as const;

/**
 * A provider generates one article draft from metadata. Implementations:
 *  - `DeterministicProvider` — rules over metadata, zero cost, always succeeds.
 *  - `OllamaProvider` — local-first; cloud iff OLLAMA_API_KEY.
 *  - `OpenAiProvider` — optional API, strict json_schema.
 */
export interface AiProvider {
  readonly name: ProviderName;
  /** True if a model call is permitted right now (budget remaining, enabled). */
  canGenerate(): boolean;
  /** Generate a draft. MUST resolve (never reject) — failures return fallback. */
  generate(request: GenerateRequest): Promise<GenerateResult>;
  /** Model calls spent this run (for warnings + run report). */
  generationsUsed(): number;
}

export interface ProviderConfig {
  provider?: ProviderName;
  enabled?: boolean;
  maxGenerations?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the provider chain from env/config. Defaults to the deterministic,
 * zero-cost provider — matching ardur.ai's existing `budget=0` posture.
 */
export function createProvider(_config: ProviderConfig = {}): AiProvider {
  throw new Error('not implemented: port the provider chain from ardur.ai/main:src/lib/aiProvider.mjs');
}
