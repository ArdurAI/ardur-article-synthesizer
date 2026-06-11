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
export const VOICE_STYLE = {
    id: 'ardur-voice/genz-professional/v1',
    summary: 'GenZ-but-professional: credible, fully sourced, plain-language, engaging, a little irreverent — never dry newswire, never hype.',
    exemplar: "PyTorch just dropped 2.6 and the compile-time wins are real — here's what actually changed and why your training loop cares.",
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
/**
 * Section-level voice plan. The opener (key-takeaway) and Ardur Take carry the
 * most personality; What Happened stays tight and factual.
 */
export const SECTION_VOICE = [
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
export function buildVoiceDirective(style = VOICE_STYLE, section) {
    const sectionVoice = section
        ? SECTION_VOICE.find((s) => s.section === section)
        : undefined;
    const lines = [
        `VOICE: ${style.summary}`,
        `EXEMPLAR: "${style.exemplar}"`,
        '',
        'DO:',
        ...style.do.map((r) => `- ${r}`),
        '',
        "DON'T:",
        ...style.dont.map((r) => `- ${r}`),
        '',
        `BANNED WORDS: ${style.bannedLexicon.join(', ')}`,
    ];
    if (sectionVoice) {
        lines.push('', `SECTION (${sectionVoice.section}): ${sectionVoice.intent}`);
        if (sectionVoice.personality < 0.3) {
            lines.push('Keep this section tight and factual — minimal personality.');
        }
        else if (sectionVoice.personality >= 0.5) {
            lines.push('Light personality welcome here — be engaging while staying accurate.');
        }
    }
    return lines.join('\n');
}
/**
 * Lint a finished string against the voice guardrails (banned lexicon, hype,
 * exclamation spam). Returns the offending fragments; empty array == clean.
 * Used to keep BOTH the LLM and deterministic outputs on-voice; failures are
 * downgraded to plainer phrasing (never blocked — accuracy already passed).
 */
export function lintVoice(text, style = VOICE_STYLE) {
    const offenders = [];
    const lower = text.toLowerCase();
    for (const lexeme of style.bannedLexicon) {
        if (lower.includes(lexeme.toLowerCase())) {
            offenders.push(lexeme);
        }
    }
    // Consecutive exclamation marks are always banned
    if (/!!/.test(text)) {
        offenders.push('consecutive-exclamations');
    }
    // More than one exclamation per 200 characters is spammy
    const exclamationCount = (text.match(/!/g) ?? []).length;
    if (exclamationCount > 0 && (exclamationCount / text.length) * 200 > 1) {
        offenders.push(`exclamation-density (${exclamationCount} in ${text.length} chars)`);
    }
    return offenders;
}
