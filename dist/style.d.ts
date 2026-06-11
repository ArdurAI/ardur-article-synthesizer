/**
 * Voice & style configuration — the Ardur house voice, as code.
 *
 * VOICE = "GenZ-but-professional." Credible, accurate, fully sourced — but NOT
 * dry newswire. Plain-language, engaging, a little irreverent, genuinely
 * interesting. Short but dense, synthesized from many sources.
 *
 * This module is the SINGLE place the voice is encoded so every consumer agrees:
 *  - the provider prompt (LLM path) is built from `VOICE_STYLE` (see provider.ts).
 *  - the deterministic / budget=0 fallback assembler reads from the SAME config,
 *    so a zero-cost article still sounds like Ardur, not a newswire.
 *  - the assembly stage tags each section with its voice intent (`SectionVoice`).
 *
 * The voice is a PROSE layer only. It never overrides the copyright, provenance,
 * privacy, or render gates — see docs/voice.md §"Copyright-safe voice". Accuracy
 * and sourcing always win over tone.
 */
export type VoiceRule = string;
/** The authoritative, machine-referenceable voice spec. See docs/voice.md. */
export interface VoiceStyle {
    /** Stable id surfaced in run reports / ai provenance for auditability. */
    id: string;
    /** One-line description of the voice. */
    summary: string;
    /** A canonical sentence that exemplifies the target voice. */
    exemplar: string;
    /** Things every article SHOULD do. */
    do: VoiceRule[];
    /** Things every article must NOT do (hard guardrails). */
    dont: VoiceRule[];
    /** Tone dials, each 0..1 (0 = off, 1 = maxed). Guidance, not literal weights. */
    tone: {
        plainLanguage: number;
        activeVoice: number;
        personality: number;
        density: number;
        formality: number;
    };
    /** Max share of an article that may be light/personality-driven (0..1). */
    maxPlayfulnessRatio: number;
    /** Lexical bans — slang/hype that ages badly or reads as clickbait. */
    bannedLexicon: string[];
}
export declare const VOICE_STYLE: VoiceStyle;
/** Per-section voice intent — how strongly personality may show per section. */
export interface SectionVoice {
    /** Matches assemble.ts SectionId. */
    section: string;
    /** 0..1 — how much personality this section may carry. */
    personality: number;
    /** Short instruction threaded into the prompt + fallback for this section. */
    intent: string;
}
/**
 * Section-level voice plan. The opener (key-takeaway) and Ardur Take carry the
 * most personality; What Happened stays tight and factual.
 */
export declare const SECTION_VOICE: readonly SectionVoice[];
/**
 * Build the voice instruction block that is appended to the provider prompt
 * (LLM path) AND used to parameterize the deterministic fallback templates, so
 * both paths produce the SAME voice. Returns a compact, prompt-ready string.
 */
export declare function buildVoiceDirective(style?: VoiceStyle, section?: string): string;
/**
 * Lint a finished string against the voice guardrails (banned lexicon, hype,
 * exclamation spam). Returns the offending fragments; empty array == clean.
 * Used to keep BOTH the LLM and deterministic outputs on-voice; failures are
 * downgraded to plainer phrasing (never blocked — accuracy already passed).
 */
export declare function lintVoice(text: string, style?: VoiceStyle): string[];
