/**
 * Voice & style configuration — the Ardur house voice, as code.
 *
 * SCAFFOLD ONLY — the config object is final; the helpers are stubs.
 *
 * VOICE = "GenZ-but-professional." Credible, accurate, fully sourced — but NOT
 * dry newswire. Plain-language, engaging, a little irreverent, genuinely
 * interesting. Short but dense, synthesized from many sources.
 *
 * Target-voice example:
 *   "PyTorch just dropped 2.6 and the compile-time wins are real — here's what
 *    actually changed and why your training loop cares."
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
    personality: number; // "a little irreverent" — kept deliberately < 1
    density: number; // short but information-dense
    formality: number; // professional floor; never stiff
  };
  /** Max share of an article that may be light/personality-driven (0..1). */
  maxPlayfulnessRatio: number;
  /** Lexical bans — slang/hype that ages badly or reads as clickbait. */
  bannedLexicon: string[];
}

export const VOICE_STYLE: VoiceStyle = {
  id: 'ardur-voice/genz-professional/v1',
  summary: 'GenZ-but-professional: credible, fully sourced, plain-language, engaging, a little irreverent — never dry newswire, never hype.',
  exemplar:
    "PyTorch just dropped 2.6 and the compile-time wins are real — here's what actually changed and why your training loop cares.",
  do: [
    'Use plain language a busy builder understands on the first read.',
    'Write in the active voice.',
    'Lead with WHAT changed and WHY a builder should care.',
    'Use concrete specifics — versions, numbers, names — over vague summary.',
    'Allow light personality and a little irreverence to make it genuinely interesting.',
    'Stay short but dense: synthesize many sources into a few high-signal sentences.',
  ],
  dont: [
    'No hype or clickbait ("you won\'t believe", "game-changer", "breaking").',
    'No slang that ages badly or reads as try-hard.',
    'Never trade accuracy or sourcing for tone — facts and citations win.',
    'No PII, ever — not in prose, links, examples, or metadata.',
    'No exclamation-point spam; personality comes from phrasing, not punctuation.',
  ],
  tone: {
    plainLanguage: 0.9,
    activeVoice: 0.9,
    personality: 0.45,
    density: 0.85,
    formality: 0.55,
  },
  maxPlayfulnessRatio: 0.2,
  bannedLexicon: [
    'game-changer', 'game changer', 'you won\'t believe', 'breaking', 'shocking',
    'mind-blowing', 'insane', 'revolutionary', 'unprecedented', 'must-read',
    'thread', 'no cap', 'slaps', 'goes hard', 'lowkey', 'highkey', 'rizz',
  ],
};

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
export const SECTION_VOICE: readonly SectionVoice[] = [
  { section: 'key-takeaway', personality: 0.6, intent: 'Hook with what changed + why it matters, in one tight line.' },
  { section: 'why-this-matters', personality: 0.45, intent: 'Concrete builder impact; plain language; no hand-waving.' },
  { section: 'what-happened', personality: 0.2, intent: 'Tight, factual, fully sourced; specifics over adjectives.' },
  { section: 'builder-view', personality: 0.5, intent: 'Practitioner-to-practitioner; a little irreverent is fine.' },
  { section: 'open-questions', personality: 0.35, intent: 'Honest about the unknowns; no false certainty.' },
  { section: 'ardur-take', personality: 0.6, intent: 'Clear judgment + confidence; opinionated but accountable.' },
];

/**
 * Build the voice instruction block that is appended to the provider prompt
 * (LLM path) AND used to parameterize the deterministic fallback templates, so
 * both paths produce the SAME voice. Returns a compact, prompt-ready string.
 */
export function buildVoiceDirective(
  _style: VoiceStyle = VOICE_STYLE,
  _section?: string,
): string {
  throw new Error('not implemented: render VOICE_STYLE (+ section intent) into a prompt/template directive');
}

/**
 * Lint a finished string against the voice guardrails (banned lexicon, hype,
 * exclamation spam). Returns the offending fragments; empty array == clean.
 * Used to keep BOTH the LLM and deterministic outputs on-voice; failures are
 * downgraded to plainer phrasing (never blocked — accuracy already passed).
 */
export function lintVoice(_text: string, _style: VoiceStyle = VOICE_STYLE): string[] {
  throw new Error('not implemented: detect banned lexicon / hype / punctuation spam');
}
