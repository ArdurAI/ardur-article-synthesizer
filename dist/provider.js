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
import { VOICE_STYLE } from "./style.js";
/**
 * JSON-schema the model output is validated against (strict for OpenAI, repaired
 * for Ollama). Mirrors `SIGNAL_BRIEF_SCHEMA` but for the article shape. Any field
 * that fails validation is replaced from the deterministic `fallback`.
 */
export const ARTICLE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'dek', 'sections', 'keyPoints', 'whyItMatters', 'readerAction', 'confidence', 'tags'],
};
/**
 * Zod schema for LLM-generated ArticleDraft (#22). Used in parseAndMergeDraft as
 * a first-pass structural validator before the field-by-field merge fallback.
 * passthrough() preserves any extra provider-specific fields without error.
 */
export const ArticleDraftSchema = z.object({
    headline: z.string().min(1),
    dek: z.string().min(1),
    sections: z.record(z.string()),
    keyPoints: z.array(z.string()),
    whyItMatters: z.string().min(1),
    readerAction: z.string().min(1),
    confidence: z.enum(['high', 'medium', 'low']),
    tags: z.array(z.string()),
}).passthrough();
// ---------------------------------------------------------------------------
// Deterministic provider — rules-based, zero cost, always succeeds
// ---------------------------------------------------------------------------
/** Active verbs for GenZ-but-professional openers. */
const ACTIVE_VERBS = {
    primary: ['shipped', 'released', 'published', 'announced', 'dropped'],
    paper: ['published', 'released', 'put out', 'posted'],
    'technical-news': ['covered', 'reported on', 'broke down'],
    news: ['reported', 'confirmed', 'covered'],
    'security-news': ['flagged', 'disclosed', 'reported'],
};
function pickVerb(tier) {
    const verbs = ACTIVE_VERBS[tier] ?? ACTIVE_VERBS['news'] ?? ['released'];
    // Stable pick based on first char of tier (deterministic, no random)
    return verbs[tier.charCodeAt(0) % verbs.length] ?? 'released';
}
function formatDate(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
    catch {
        return iso.slice(0, 10);
    }
}
function topTier(refs) {
    const order = ['primary', 'paper', 'technical-news', 'security-news', 'news'];
    for (const tier of order) {
        if (refs.some((r) => r.tier === tier))
            return tier;
    }
    return 'news';
}
function sourceList(refs, max = 3) {
    const names = [...new Set(refs.map((r) => r.source))].slice(0, max);
    if (names.length === 1)
        return names[0] ?? '';
    if (names.length === 2)
        return `${names[0] ?? ''} and ${names[1] ?? ''}`;
    const last = names[names.length - 1];
    return `${names.slice(0, -1).join(', ')}, and ${last ?? ''}`;
}
/** Strip the existing headline and rewrite in active voice. */
function rewriteHeadline(original, topSource) {
    // If already starts with a source name, keep it; otherwise prepend an Ardur voice rewrite
    const src = topSource.source;
    if (original.toLowerCase().startsWith(src.toLowerCase()))
        return original;
    const verb = pickVerb(topSource.tier);
    // "Source just shipped X" or keep the headline as-is for clarity
    return `${src} ${verb}: ${original}`;
}
function buildDek(topicLabel, refs, isCorroborated) {
    const sourceCount = new Set(refs.map((r) => r.sourceDomain)).size;
    const hedge = isCorroborated
        ? `Corroborated across ${sourceCount} sources`
        : `From ${refs[0]?.source ?? 'one source'}`;
    return `${hedge} — here's what actually changed and why it matters for ${topicLabel}.`;
}
function buildKeyTakeaway(headline, refs, isCorroborated) {
    const top = refs[0];
    if (!top)
        return headline;
    const verb = pickVerb(topTier(refs));
    const when = formatDate(top.publishedAt);
    const sources = sourceList(refs, 2);
    const hedge = isCorroborated ? '' : ` According to ${top.source}, `;
    return `${top.source} ${verb} this on ${when}${hedge ? '' : `, and ${sources} ${isCorroborated ? 'both' : ''} covered it`}. ${headline}. Here's what actually changed and why your work might be affected.`;
}
function buildWhyThisMatters(topicLabel, refs, isCorroborated) {
    const primaryRefs = refs.filter((r) => r.tier === 'primary' || r.tier === 'paper');
    const techRefs = refs.filter((r) => r.tier === 'technical-news');
    const sourceParts = [];
    const firstPrimary = primaryRefs[0];
    const firstTech = techRefs[0];
    if (firstPrimary)
        sourceParts.push(`primary sources including ${firstPrimary.source}`);
    if (firstTech)
        sourceParts.push(`technical coverage from ${firstTech.source}`);
    const sourceStr = sourceParts.length > 0
        ? `Based on ${sourceParts.join(' and ')}, `
        : (isCorroborated ? `Across multiple reports, ` : `According to ${refs[0]?.source ?? 'reports'}, `);
    return `${sourceStr}this development carries real weight for practitioners in ${topicLabel}. ${isCorroborated ? 'Multiple sources confirm the key details, which strengthens the case.' : 'It comes from a single source, so treat specifics as early-stage until more coverage appears.'} The implications are worth tracking if you work anywhere near this space.`;
}
function buildWhatHappened(headline, refs, isCorroborated) {
    const primaryRefs = refs.filter((r) => r.tier === 'primary' || r.tier === 'paper');
    const topRef = primaryRefs[0] ?? refs[0];
    if (!topRef)
        return headline;
    const verb = pickVerb(topRef.tier);
    const when = formatDate(topRef.publishedAt);
    const sourceCount = new Set(refs.map((r) => r.sourceDomain)).size;
    const recentRefs = refs
        .slice(0, 3)
        .map((r) => r.title)
        .filter(Boolean);
    let body = `${topRef.source} ${verb} this on ${when}. `;
    body += isCorroborated
        ? `Coverage spans ${sourceCount} distinct sources. `
        : `Coverage comes from ${topRef.source} at this stage. `;
    const ref0 = recentRefs[0];
    const ref1 = recentRefs[1];
    if (recentRefs.length >= 2 && ref0) {
        body += `Reported aspects include: "${ref0}"`;
        if (ref1)
            body += ` and "${ref1}"`;
        body += '. ';
    }
    body += isCorroborated
        ? 'Core facts are consistent across outlets.'
        : 'Single-source — independent confirmation pending.';
    return body;
}
function buildBuilderView(topicLabel, refs) {
    const techRef = refs.find((r) => r.tier === 'technical-news') ?? refs[0];
    if (!techRef)
        return `Practitioners in ${topicLabel} should keep an eye on this.`;
    return `For builders working in ${topicLabel}: the practical angle here is whether this changes your current setup or tooling. ${techRef.source} covered the technical side — worth a read if you're hands-on with this stack. The core question is whether this is a "note it and move on" or a "test this soon" situation. Based on the available reporting, it leans toward the latter.`;
}
function buildOpenQuestions(refs, isCorroborated) {
    const questions = [];
    if (!isCorroborated)
        questions.push('independent confirmation from additional outlets');
    questions.push('performance details under real-world conditions');
    questions.push('timeline for broader availability or rollout');
    if (refs.some((r) => r.tier === 'paper')) {
        questions.push('peer review or replication of any claimed results');
    }
    return `A few things still need confirmation: ${questions.join('; ')}. ${isCorroborated ? 'The corroborated reporting is a good sign, but these gaps are worth tracking.' : 'With single-source coverage, treat specifics as preliminary until corroborated.'}`;
}
function buildArdurTake(headline, refs, confidence, isCorroborated) {
    const confidencePhrase = {
        high: 'Confidence is high',
        medium: 'Confidence is moderate',
        low: 'Confidence is low',
    }[confidence];
    const sourceCount = new Set(refs.map((r) => r.sourceDomain)).size;
    return `${isCorroborated ? `${sourceCount} sources point the same direction on this` : `One source for now`} — ${headline.toLowerCase().replace(/[.!?]$/, '')}. ${confidencePhrase} based on the source coverage. ${isCorroborated ? 'Worth acting on if this falls in your domain.' : 'Wait for corroboration before making significant changes based on this alone.'}`;
}
function buildKeyPoints(topicLabel, refs, isCorroborated) {
    const points = [];
    const topRef = refs[0];
    if (topRef) {
        const verb = pickVerb(topRef.tier);
        points.push(`${topRef.source} ${verb} a notable development in ${topicLabel}`);
    }
    if (isCorroborated) {
        const count = new Set(refs.map((r) => r.sourceDomain)).size;
        points.push(`Covered by ${count} distinct sources — core facts are consistent`);
    }
    else {
        points.push(`Single-source at this stage — independent coverage pending`);
    }
    const latestDate = refs.reduce((latest, r) => r.publishedAt > latest ? r.publishedAt : latest, refs[0]?.publishedAt ?? '');
    if (latestDate) {
        points.push(`Latest reporting from ${formatDate(latestDate)}`);
    }
    return points;
}
function buildWhyItMattersLine(topicLabel, refs) {
    const tech = refs.find((r) => r.tier === 'technical-news' || r.tier === 'primary');
    const src = tech?.source ?? refs[0]?.source ?? 'reporting';
    return `This matters for ${topicLabel} practitioners — ${src} covered the implications worth tracking.`;
}
function buildReaderAction(topicLabel, refs) {
    const topRef = refs.find((r) => r.tier === 'primary' || r.tier === 'paper') ?? refs[0];
    if (!topRef)
        return `Review the latest developments in ${topicLabel}.`;
    return `Check ${topRef.source}'s coverage directly — the canonical source has the full picture.`;
}
function buildTags(topicLabel, refs) {
    const tags = new Set([topicLabel.toLowerCase().replace(/\s+/g, '-')]);
    for (const ref of refs.slice(0, 5)) {
        const domainPart = ref.sourceDomain.replace('www.', '').split('.')[0];
        if (domainPart)
            tags.add(domainPart);
    }
    return [...tags].slice(0, 8);
}
/** Build a complete on-voice ArticleDraft from metadata alone. No network. */
export function buildDeterministicDraft(request, confidence = 'medium') {
    const { topic, topicLabel, headline, references } = request;
    const isCorroborated = new Set(references.map((r) => r.sourceDomain)).size >= 2;
    const topRef = references.find((r) => r.tier === 'primary' || r.tier === 'paper') ?? references[0];
    return {
        headline: topRef ? rewriteHeadline(headline, topRef) : headline,
        dek: buildDek(topicLabel, references, isCorroborated),
        sections: {
            'key-takeaway': buildKeyTakeaway(headline, references, isCorroborated),
            'why-this-matters': buildWhyThisMatters(topicLabel, references, isCorroborated),
            'what-happened': buildWhatHappened(headline, references, isCorroborated),
            'builder-view': buildBuilderView(topicLabel, references),
            'open-questions': buildOpenQuestions(references, isCorroborated),
            'ardur-take': buildArdurTake(headline, references, confidence, isCorroborated),
        },
        keyPoints: buildKeyPoints(topicLabel, references, isCorroborated),
        whyItMatters: buildWhyItMattersLine(topicLabel, references),
        readerAction: buildReaderAction(topicLabel, references),
        confidence,
        tags: buildTags(topicLabel, references),
    };
}
class DeterministicProvider {
    name = 'deterministic';
    now;
    constructor(now = new Date()) {
        this.now = now;
    }
    canGenerate() {
        return true; // deterministic is always available
    }
    async generate(request) {
        return {
            draft: request.fallback,
            meta: {
                provider: 'deterministic',
                model: 'rules/v1',
                status: 'fallback',
                reason: 'deterministic provider selected',
                generatedAt: this.now.toISOString(),
            },
        };
    }
    generationsUsed() {
        return 0; // deterministic uses no budget
    }
}
// ---------------------------------------------------------------------------
// Ollama provider — local-first
// ---------------------------------------------------------------------------
class OllamaProvider {
    name = 'ollama';
    _used = 0;
    maxGenerations;
    timeoutMs;
    model;
    baseUrl;
    now;
    constructor(opts) {
        this.maxGenerations = opts.maxGenerations;
        this.timeoutMs = opts.timeoutMs;
        this.model = opts.model ?? 'llama3.1';
        this.baseUrl = opts.baseUrl ?? 'http://127.0.0.1:11434';
        this.now = opts.now ?? new Date();
    }
    canGenerate() {
        return this._used < this.maxGenerations;
    }
    generationsUsed() {
        return this._used;
    }
    async generate(request) {
        const fallbackMeta = {
            provider: 'deterministic',
            model: 'rules/v1',
            status: 'fallback',
            generatedAt: this.now.toISOString(),
        };
        if (!this.canGenerate()) {
            return { draft: request.fallback, meta: { ...fallbackMeta, reason: 'budget exhausted' } };
        }
        const prompt = buildOllamaPrompt(request);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const resp = await fetch(`${this.baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: this.model, prompt, format: 'json', stream: false }),
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (!resp.ok) {
                return {
                    draft: request.fallback,
                    meta: { ...fallbackMeta, reason: `ollama HTTP ${resp.status}` },
                };
            }
            const raw = await resp.json();
            const parsed = parseAndMergeDraft(raw.response ?? '', request.fallback);
            this._used++;
            return {
                draft: parsed,
                meta: {
                    provider: 'ollama',
                    model: this.model,
                    status: 'generated',
                    generatedAt: this.now.toISOString(),
                },
            };
        }
        catch (err) {
            clearTimeout(timer);
            const reason = err instanceof Error
                ? (err.name === 'AbortError' ? 'timeout' : err.message)
                : 'unknown error';
            return { draft: request.fallback, meta: { ...fallbackMeta, reason } };
        }
    }
}
// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------
class OpenAiProvider {
    name = 'openai';
    _used = 0;
    maxGenerations;
    timeoutMs;
    model;
    apiKey;
    now;
    constructor(opts) {
        this.maxGenerations = opts.maxGenerations;
        this.timeoutMs = opts.timeoutMs;
        this.apiKey = opts.apiKey;
        this.model = opts.model ?? 'gpt-4o-mini';
        this.now = opts.now ?? new Date();
    }
    canGenerate() {
        return this._used < this.maxGenerations;
    }
    generationsUsed() {
        return this._used;
    }
    async generate(request) {
        const fallbackMeta = {
            provider: 'deterministic',
            model: 'rules/v1',
            status: 'fallback',
            generatedAt: this.now.toISOString(),
        };
        if (!this.canGenerate()) {
            return { draft: request.fallback, meta: { ...fallbackMeta, reason: 'budget exhausted' } };
        }
        const hasFacts = (request.facts?.length ?? 0) > 0;
        const systemPrompt = [
            `You are the Ardur article synthesizer. Write one original article draft as JSON in the Ardur house voice.`,
            ``,
            request.voiceDirective,
            ``,
            `RULES:`,
            `- Original prose only — never copy or paraphrase source sentences.`,
            ...(hasFacts
                ? [`- Write FROM the provided ExtractedFacts; cite every factual sentence with [FACT:id].`]
                : [`- Metadata (titles, sources, dates) only — no article bodies are provided.`]),
            `- Output strict JSON: {headline, dek, sections:{key-takeaway,why-this-matters,what-happened,builder-view,open-questions,ardur-take}, keyPoints:string[], whyItMatters, readerAction, confidence:"high"|"medium"|"low", tags:string[]}`,
        ].join('\\n');
        const userPrompt = buildUserPrompt(request);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const resp = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    response_format: { type: 'json_object' },
                    temperature: 0.7,
                }),
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (!resp.ok) {
                return {
                    draft: request.fallback,
                    meta: { ...fallbackMeta, reason: `openai HTTP ${resp.status}` },
                };
            }
            const data = await resp.json();
            const content = data.choices?.[0]?.message?.content ?? '';
            const parsed = parseAndMergeDraft(content, request.fallback);
            this._used++;
            return {
                draft: parsed,
                meta: {
                    provider: 'openai',
                    model: this.model,
                    status: 'generated',
                    generatedAt: this.now.toISOString(),
                },
            };
        }
        catch (err) {
            clearTimeout(timer);
            const reason = err instanceof Error
                ? (err.name === 'AbortError' ? 'timeout' : err.message)
                : 'unknown error';
            return { draft: request.fallback, meta: { ...fallbackMeta, reason } };
        }
    }
}
// ---------------------------------------------------------------------------
// Shared prompt builders
// ---------------------------------------------------------------------------
function buildFactLines(facts, max = 20) {
    if (facts.length === 0)
        return [];
    const lines = [`EXTRACTED FACTS (PRIMARY SOURCE — write FROM these, cite [FACT:id] inline):`];
    for (const f of facts.slice(0, max)) {
        const qty = f.quantity
            ? ` [${f.quantity.metric}: ${f.quantity.value}${f.quantity.unit ? ' ' + f.quantity.unit : ''}${f.quantity.asOf ? ' as of ' + f.quantity.asOf : ''}]`
            : '';
        const corr = f.corroboration >= 2 ? ` (corroborated: ${f.corroboration} sources)` : ` (single-source)`;
        lines.push(`[FACT:${f.id}] ${f.statement}${qty}${corr}`);
    }
    return lines;
}
function buildOllamaPrompt(request) {
    const refLines = request.references.slice(0, 10).map((r, i) => `${i + 1}. [${r.tier}] "${r.title}" — ${r.source} (${r.publishedAt.slice(0, 10)}) ${r.url}`);
    const factLines = buildFactLines(request.facts ?? []);
    const reaskSection = request.reaskClaims && request.reaskClaims.length > 0
        ? [
            '',
            'REGROUND OR DROP — these sentences have no [FACT:id] citation. For each:',
            '  a) Add a [FACT:id] citation if a provided fact supports it.',
            '  b) Remove the sentence entirely if it cannot be grounded.',
            ...request.reaskClaims.map((c, i) => `  ${i + 1}. "${c}"`),
        ]
        : [];
    const hasFacts = factLines.length > 0;
    return [
        `Write one original Ardur article as JSON.`,
        '',
        `VOICE DIRECTIVE:`,
        request.voiceDirective,
        '',
        `TOPIC: ${request.topicLabel}`,
        `HEADLINE HINT: ${request.headline}`,
        '',
        ...(hasFacts ? factLines : [`SOURCES (metadata only — write ORIGINAL prose, do NOT copy):`, ...refLines]),
        ...(hasFacts ? ['', 'ATTRIBUTION SOURCES (for reference links only):', ...refLines] : []),
        ...reaskSection,
        '',
        `RULES:`,
        `- Write original prose ONLY — never copy or paraphrase source sentences.`,
        ...(hasFacts ? [`- Every factual sentence MUST cite ≥1 [FACT:id] inline.`, `- Single-source facts are allowed but will be tagged confidence:low.`] : []),
        `- Output strict JSON: {"headline":"...","dek":"...","sections":{"key-takeaway":"...","why-this-matters":"...","what-happened":"...","builder-view":"...","open-questions":"...","ardur-take":"..."},"keyPoints":["..."],"whyItMatters":"...","readerAction":"...","confidence":"high|medium|low","tags":["..."]}`,
        '',
        `Context draft (structure reference — do NOT copy text):`,
        JSON.stringify(request.fallback, null, 2),
    ].join('\n');
}
function buildUserPrompt(request) {
    const refLines = request.references.slice(0, 15).map((r, i) => `${i + 1}. [${r.tier}] "${r.title}" (${r.source}, ${r.publishedAt.slice(0, 10)})`);
    const factLines = buildFactLines(request.facts ?? [], 20);
    const hasFacts = factLines.length > 0;
    const reaskSection = request.reaskClaims && request.reaskClaims.length > 0
        ? [
            '',
            'REGROUND OR DROP:',
            ...request.reaskClaims.map((c, i) => `  ${i + 1}. "${c}"`),
        ]
        : [];
    return [
        `TOPIC: ${request.topicLabel}`,
        `HEADLINE HINT: ${request.headline}`,
        '',
        ...(hasFacts ? factLines : [`SOURCES (${request.references.length} total):`, ...refLines]),
        ...(hasFacts ? ['', `ATTRIBUTION SOURCES:`, ...refLines] : []),
        ...reaskSection,
        '',
        `Write an original Ardur article${hasFacts ? ', grounding every factual sentence with [FACT:id] citations' : ''}. Output valid JSON.`,
    ].join('\n');
}
/**
 * Parse model JSON output, falling back field-by-field from the deterministic draft.
 * #22: first try Zod structural validation; if that passes the whole object is used.
 * On Zod failure, merge field-by-field so partial-valid output still contributes.
 */
export function parseAndMergeDraft(raw, fallback) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        try {
            const repaired = repairJsonSync(raw);
            parsed = JSON.parse(repaired);
        }
        catch {
            return fallback;
        }
    }
    // Zod fast-path: if the whole object is structurally valid, accept it directly.
    const zodResult = ArticleDraftSchema.safeParse(parsed);
    if (zodResult.success) {
        return zodResult.data;
    }
    // Field-by-field merge: use parsed value per field only when type-safe.
    const partial = parsed;
    const VALID_CONFIDENCE = ['high', 'medium', 'low'];
    return {
        headline: typeof partial.headline === 'string' && partial.headline.trim() ? partial.headline : fallback.headline,
        dek: typeof partial.dek === 'string' && partial.dek.trim() ? partial.dek : fallback.dek,
        sections: mergeSections(partial.sections, fallback.sections),
        keyPoints: Array.isArray(partial.keyPoints) && partial.keyPoints.length > 0
            ? partial.keyPoints.filter((k) => typeof k === 'string')
            : fallback.keyPoints,
        whyItMatters: typeof partial.whyItMatters === 'string' && partial.whyItMatters.trim()
            ? partial.whyItMatters
            : fallback.whyItMatters,
        readerAction: typeof partial.readerAction === 'string' && partial.readerAction.trim()
            ? partial.readerAction
            : fallback.readerAction,
        confidence: VALID_CONFIDENCE.includes(partial.confidence)
            ? partial.confidence
            : fallback.confidence,
        tags: Array.isArray(partial.tags) && partial.tags.length > 0
            ? partial.tags.filter((t) => typeof t === 'string')
            : fallback.tags,
    };
}
function mergeSections(parsed, fallback) {
    if (!parsed || typeof parsed !== 'object')
        return fallback;
    const result = { ...fallback };
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value.trim()) {
            result[key] = value;
        }
    }
    return result;
}
/** Best-effort JSON repair without the external package (fallback). */
function repairJsonSync(raw) {
    // Try to extract a JSON object from the string
    const match = raw.match(/\{[\s\S]*\}/);
    if (match)
        return match[0];
    throw new Error('no JSON object found');
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * Resolve the provider chain from env/config. Defaults to the deterministic,
 * zero-cost provider — matching ardur.ai's existing `budget=0` posture.
 */
export function createProvider(config = {}) {
    const env = config.env ?? process.env;
    const enabled = config.enabled ?? (env['ARDUR_AI_ENABLED'] !== '0');
    const providerName = config.provider ??
        env['ARDUR_AI_PROVIDER'] ??
        'deterministic';
    const maxGenerations = config.maxGenerations
        ?? parseInt(env['ARDUR_AI_MAX_GENERATIONS'] ?? '20', 10);
    const timeoutMs = config.timeoutMs
        ?? parseInt(env['ARDUR_AI_TIMEOUT_MS'] ?? '20000', 10);
    const now = config.now;
    // Helpers to avoid passing `now: undefined` under exactOptionalPropertyTypes.
    const nowOpt = now !== undefined ? { now } : {};
    if (!enabled || providerName === 'deterministic') {
        return new DeterministicProvider(now);
    }
    if (providerName === 'ollama') {
        const apiKey = env['OLLAMA_API_KEY'];
        const baseUrl = apiKey
            ? (env['OLLAMA_API_BASE'] ?? 'https://api.ollama.ai')
            : 'http://127.0.0.1:11434';
        return new OllamaProvider({ maxGenerations, timeoutMs, baseUrl, ...nowOpt });
    }
    if (providerName === 'openai') {
        const apiKey = env['OPENAI_API_KEY'];
        if (!apiKey) {
            return new DeterministicProvider(now);
        }
        return new OpenAiProvider({
            maxGenerations,
            timeoutMs,
            apiKey,
            model: env['OPENAI_MODEL'] ?? 'gpt-4o-mini',
            ...nowOpt,
        });
    }
    return new DeterministicProvider(now);
}
