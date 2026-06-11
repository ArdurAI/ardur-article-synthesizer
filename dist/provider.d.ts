/**
 * Pluggable, cost-guarded AI provider.
 *
 * Extracted and generalized from `ardur.ai/main:src/lib/aiProvider.mjs`
 * (`generateSignalBrief`).
 *
 * Provider order: deterministic (default, zero-cost) -> ollama (local-first,
 * cloud only if OLLAMA_API_KEY set) -> openai (optional).
 *
 * `ARDUR_AI_ENABLED=0` or `ARDUR_AI_PROVIDER=deterministic` forces the
 * deterministic path with NO network calls (this is the CI default).
 *
 * Every model call is wrapped in a timeout; any failure (non-JSON, HTTP error,
 * timeout, budget exhausted) falls back to deterministic output and records the
 * reason in `ProviderMeta.reason`.
 *
 * A per-run generation budget (`ARDUR_AI_MAX_GENERATIONS`) caps model calls;
 * once spent, every remaining article is deterministic.
 *
 * VOICE: both paths share the Ardur house voice ("GenZ-but-professional").
 * The LLM path receives `GenerateRequest.voiceDirective` in its prompt;
 * the deterministic path applies the same VOICE_STYLE to its templates so a
 * budget=0 article reads on-voice — not as dry newswire.
 */
import { z } from 'zod';
import type { ProviderMeta, Confidence, SourceRef, ExtractedFact } from './contracts.ts';
export type ProviderName = 'deterministic' | 'ollama' | 'openai';
/** Inputs the provider is allowed to see — metadata only, never article bodies. */
export interface GenerateRequest {
    topic: string;
    topicLabel: string;
    /** The representative cluster headline (factual title, may be quoted as a name). */
    headline: string;
    /** Copyright-safe references: title + source + link + date. NO body text. */
    references: SourceRef[];
    /**
     * S1/S3 — Rev 3: structured facts extracted from source bodies.
     * When present, these are the PRIMARY synthesis input; the LLM writes the
     * article FROM the facts, citing `[FACT:id]` inline. When absent (rev-2
     * aggregator), the model falls back to reference-metadata-only synthesis.
     */
    facts?: ExtractedFact[];
    /** Deterministic draft used as grounding context in the prompt (never published). */
    fallback: ArticleDraft;
    /**
     * The Ardur house-voice directive (from `style.ts:buildVoiceDirective`),
     * threaded verbatim into the model prompt.
     */
    voiceDirective: string;
    /**
     * S3 — When set, the model is asked to re-ground or drop these specific
     * ungrounded claim sentences (one bounded re-ask before HOLD).
     */
    reaskClaims?: string[];
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
export declare const ARTICLE_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["headline", "dek", "sections", "keyPoints", "whyItMatters", "readerAction", "confidence", "tags"];
};
/**
 * Zod schema for LLM-generated ArticleDraft (#22). Used in parseAndMergeDraft as
 * a first-pass structural validator before the field-by-field merge fallback.
 * passthrough() preserves any extra provider-specific fields without error.
 */
export declare const ArticleDraftSchema: z.ZodObject<{
    headline: z.ZodString;
    dek: z.ZodString;
    sections: z.ZodRecord<z.ZodString, z.ZodString>;
    keyPoints: z.ZodArray<z.ZodString, "many">;
    whyItMatters: z.ZodString;
    readerAction: z.ZodString;
    confidence: z.ZodEnum<["high", "medium", "low"]>;
    tags: z.ZodArray<z.ZodString, "many">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    headline: z.ZodString;
    dek: z.ZodString;
    sections: z.ZodRecord<z.ZodString, z.ZodString>;
    keyPoints: z.ZodArray<z.ZodString, "many">;
    whyItMatters: z.ZodString;
    readerAction: z.ZodString;
    confidence: z.ZodEnum<["high", "medium", "low"]>;
    tags: z.ZodArray<z.ZodString, "many">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    headline: z.ZodString;
    dek: z.ZodString;
    sections: z.ZodRecord<z.ZodString, z.ZodString>;
    keyPoints: z.ZodArray<z.ZodString, "many">;
    whyItMatters: z.ZodString;
    readerAction: z.ZodString;
    confidence: z.ZodEnum<["high", "medium", "low"]>;
    tags: z.ZodArray<z.ZodString, "many">;
}, z.ZodTypeAny, "passthrough">>;
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
    /** Injected wall-clock instant; threads into all providers so generatedAt is deterministic under replay. */
    now?: Date;
}
/** Build a complete on-voice ArticleDraft from metadata alone. No network. */
export declare function buildDeterministicDraft(request: Omit<GenerateRequest, 'fallback'>, confidence?: Confidence): ArticleDraft;
/**
 * Parse model JSON output, falling back field-by-field from the deterministic draft.
 * #22: first try Zod structural validation; if that passes the whole object is used.
 * On Zod failure, merge field-by-field so partial-valid output still contributes.
 */
export declare function parseAndMergeDraft(raw: string, fallback: ArticleDraft): ArticleDraft;
/**
 * Resolve the provider chain from env/config. Defaults to the deterministic,
 * zero-cost provider — matching ardur.ai's existing `budget=0` posture.
 */
export declare function createProvider(config?: ProviderConfig): AiProvider;
