/**
 * Article assembly rules — how 20–30 sources become ONE original piece.
 *
 * Mirrors the section order from ardur.ai's content-engine contract so the
 * in-app render matches the existing site:
 *   Key Takeaway -> Why This Matters -> What Happened -> Builder View ->
 *   Open Questions -> Ardur Take
 *
 * The assembler:
 *  - dedups and ranks the cluster's members into a weave order (primary/paper
 *    sources first, then corroborating news), capping the reference list.
 *  - asks the provider for original prose per section, grounded in metadata only.
 *  - converts prose into the `ArticleBlock[]` in-app render model.
 *  - inserts at most one short (< 25-word) attributed quote where a primary
 *    source's exact wording is editorially necessary.
 *  - computes wordCount + readingTime and the source-trail block.
 *
 * VOICE: every section is assembled in the Ardur house voice
 * ("GenZ-but-professional", see `style.ts` + docs/voice.md). The plan carries a
 * per-section voice directive that is threaded into BOTH the provider prompt and
 * the deterministic fallback templates, so a budget=0 article still reads in
 * voice rather than as dry newswire. Voice never overrides the copyright,
 * provenance, or render gates.
 */
import { VOICE_STYLE, SECTION_VOICE, buildVoiceDirective, lintVoice } from "./style.js";
import { scrubUrl } from "./privacy.js";
export { VOICE_STYLE, SECTION_VOICE, buildVoiceDirective };
/** The fixed section plan (order matters; it is the render contract). */
export const SECTION_PLAN = [
    { id: 'key-takeaway', heading: 'Key Takeaway', required: true, targetWords: 60 },
    { id: 'why-this-matters', heading: 'Why This Matters', required: true, targetWords: 110 },
    { id: 'what-happened', heading: 'What Happened', required: true, targetWords: 140 },
    { id: 'builder-view', heading: 'Builder View', required: false, targetWords: 120 },
    { id: 'open-questions', heading: 'Open Questions', required: false, targetWords: 80 },
    { id: 'ardur-take', heading: 'Ardur Take', required: true, targetWords: 90 },
];
/** Default cap on how many references the source-trail block lists. */
export const MAX_REFERENCES = 30;
/** Minimum body length (words) for a publishable, non-`idea` article. */
export const MIN_BODY_WORDS = 150;
/** Tier priority for weave ordering (lower index = more authoritative). */
const TIER_ORDER = ['primary', 'paper', 'technical-news', 'security-news', 'news'];
function tierWeight(tier) {
    const idx = TIER_ORDER.indexOf(tier);
    return idx === -1 ? TIER_ORDER.length : idx;
}
/**
 * Build the deterministic weave/reference plan for a Top-10 entry from its
 * cluster members. No prose yet — this decides ordering, dedup, caps, AND the
 * per-section voice directives (from `style.ts`) that downstream prose obeys.
 */
export function planAssembly(entry, clusterMembers, voice = VOICE_STYLE) {
    // 1. Dedup by fingerprint (normalized source+title, per spec §5.1)
    const seen = new Set();
    const deduped = [];
    for (const item of clusterMembers) {
        if (!seen.has(item.fingerprint)) {
            seen.add(item.fingerprint);
            deduped.push(item);
        }
    }
    // 2. Rank for weave: tier first, then recency, then cross-source corroboration
    const sorted = [...deduped].sort((a, b) => {
        const tierDiff = tierWeight(a.tier) - tierWeight(b.tier);
        if (tierDiff !== 0)
            return tierDiff;
        // More recent first within the same tier
        const dateA = new Date(a.publishedAt).getTime();
        const dateB = new Date(b.publishedAt).getTime();
        if (dateB !== dateA)
            return dateB - dateA;
        // More corroborated first (higher cross-source mentions)
        return (b.interaction.crossSourceMentions ?? 0) - (a.interaction.crossSourceMentions ?? 0);
    });
    // 3. Cap reference list at MAX_REFERENCES
    const references = sorted.slice(0, MAX_REFERENCES);
    // Full weave order for prose generation (all deduped, uncapped)
    const weave = sorted;
    // 4. Build per-section voice directives
    const voiceDirectives = {};
    for (const section of SECTION_PLAN) {
        voiceDirectives[section.id] = buildVoiceDirective(voice, section.id);
    }
    return { entry, weave, references, sections: SECTION_PLAN, voice, voiceDirectives };
}
// ---------------------------------------------------------------------------
// Block conversion helpers
// ---------------------------------------------------------------------------
/** Rough word count of a string. */
function wordCount(text) {
    return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}
/** Remove raw HTML tags from text (safety, belt-and-suspenders). */
function stripHtml(text) {
    return text.replace(/<[^>]+>/g, '');
}
/**
 * Apply voice lint to a text, replacing banned phrases with plainer wording.
 * Non-blocking — accuracy and copyright gates already passed.
 */
function applyVoiceLint(text, voice) {
    const offenders = lintVoice(text, voice);
    if (offenders.length === 0)
        return text;
    let cleaned = text;
    // Replace banned lexicon items with plainer alternatives
    const REPLACEMENTS = {
        'game-changer': 'meaningful shift',
        'game changer': 'meaningful shift',
        "you won't believe": 'note that',
        'breaking': 'new',
        'shocking': 'notable',
        'mind-blowing': 'impressive',
        'insane': 'substantial',
        'revolutionary': 'significant',
        'unprecedented': 'notable',
        'must-read': 'worth reading',
        'thread': 'post',
        'no cap': '',
        'slaps': 'works well',
        'goes hard': 'delivers',
        'lowkey': '',
        'highkey': '',
        'rizz': 'appeal',
    };
    for (const offender of offenders) {
        const replacement = REPLACEMENTS[offender];
        if (replacement !== undefined) {
            const re = new RegExp(offender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            cleaned = cleaned.replace(re, replacement);
        }
    }
    // Normalize consecutive exclamation marks
    cleaned = cleaned.replace(/!{2,}/g, '!');
    return cleaned;
}
/**
 * Split prose into sentences (simple period/question-mark/exclamation split).
 * Doesn't split on abbreviations like "U.S." but good enough for article prose.
 */
function splitSentences(prose) {
    return prose
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
/**
 * Convert generated section prose into the in-app `ArticleBlock[]` render model
 * (headings, paragraphs, lists, an optional attributed quote, callouts). The
 * prose is expected to already be on-voice; `lintVoice` (style.ts) is applied
 * here as a final pass, downgrading off-voice phrasing to plainer wording
 * (never blocking — accuracy/copyright gates run separately).
 */
export function toRenderBlocks(plan, sectionProse) {
    const blocks = [];
    for (const section of SECTION_PLAN) {
        const prose = sectionProse[section.id];
        if (!prose || !prose.trim())
            continue;
        // Heading block
        blocks.push({ type: 'heading', text: section.heading });
        // Clean + lint the prose
        const cleaned = applyVoiceLint(stripHtml(prose.trim()), plan.voice);
        // Break into paragraph(s) — split on blank lines first, then on sentence density
        const paragraphs = cleaned.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
        for (const para of paragraphs) {
            // If the paragraph is very long (>80 words), split into two
            const words = wordCount(para);
            if (words > 80) {
                const sentences = splitSentences(para);
                const midpoint = Math.ceil(sentences.length / 2);
                const first = sentences.slice(0, midpoint).join(' ');
                const second = sentences.slice(midpoint).join(' ');
                if (first.trim())
                    blocks.push({ type: 'paragraph', text: first.trim() });
                if (second.trim())
                    blocks.push({ type: 'paragraph', text: second.trim() });
            }
            else {
                blocks.push({ type: 'paragraph', text: para });
            }
        }
    }
    return blocks;
}
/**
 * Final assembly: combine plan + prose + provenance into a `SynthesizedArticle`,
 * computing wordCount/readingTime and the reference list. Does NOT run the
 * copyright gate — the caller (synthesize.ts) does that and may reject.
 */
export function assembleArticle(plan, blocks, draft, providerMeta, upstreamRunId, now) {
    // Convert AggregatedItem[] references to ArticleReference[]
    const references = plan.references.map((item) => ({
        source: item.source,
        sourceDomain: item.sourceDomain,
        tier: item.tier,
        url: scrubUrl(item.url) || item.url, // fallback to original if scrub returns ''
        title: item.title,
        publishedAt: item.publishedAt,
    }));
    // Word count over all block text (text-type blocks only)
    const allText = blocks
        .map((b) => {
        const tb = b;
        return tb.text ?? (tb.items ?? []).join(' ');
    })
        .join(' ');
    const wc = wordCount(allText);
    // ~238 words per minute reading speed (standard estimate)
    const readingTimeMinutes = Math.max(1, Math.round(wc / 238));
    const distinctDomains = new Set(plan.references.map((r) => r.sourceDomain)).size;
    return {
        id: `${plan.entry.clusterId}::${now.toISOString()}`,
        rank: plan.entry.rank,
        topic: plan.entry.topic,
        topicLabel: plan.entry.topicLabel,
        headline: draft.headline,
        dek: draft.dek,
        body: blocks,
        keyPoints: draft.keyPoints,
        whyItMatters: draft.whyItMatters,
        readerAction: draft.readerAction,
        tags: draft.tags,
        confidence: draft.confidence,
        sourceQuality: plan.entry.sourceQuality,
        references,
        provenance: {
            clusterId: plan.entry.clusterId,
            sourceCount: plan.references.length,
            distinctDomains,
            upstreamRunId,
        },
        ai: providerMeta,
        legalNote: 'Original Ardur synthesis from headline/feed metadata; references preserved; no article body copied.',
        wordCount: wc,
        readingTimeMinutes,
        generatedAt: now.toISOString(),
    };
}
// ---------------------------------------------------------------------------
// S4 — Visual blocks from real extracted data
// ---------------------------------------------------------------------------
/**
 * Build ChartBlock[] from the quantitative ExtractedFacts for a cluster.
 * Only facts with a `quantity` field produce chart datapoints — no invented numbers.
 *
 * Groups facts by `quantity.metric` and builds one bar chart per metric that
 * has ≥2 comparable datapoints. Single-datapoint metrics are skipped (a bar
 * chart of one value is not informative).
 */
export function buildChartBlocks(facts, refs) {
    const quantFacts = facts.filter((f) => f.quantity != null);
    if (quantFacts.length === 0)
        return [];
    // Group by metric name
    const byMetric = new Map();
    for (const fact of quantFacts) {
        const metric = fact.quantity.metric;
        const bucket = byMetric.get(metric) ?? [];
        bucket.push(fact);
        byMetric.set(metric, bucket);
    }
    const charts = [];
    for (const [metric, metricFacts] of byMetric) {
        if (metricFacts.length < 2)
            continue; // not enough points for a comparison chart
        const series = metricFacts.map((f) => ({
            label: f.entities[0] ?? f.quantity.asOf ?? f.id.slice(-6),
            value: f.quantity.value,
            ...(f.quantity.unit ? { unit: f.quantity.unit } : {}),
        }));
        const factIds = metricFacts.map((f) => f.id);
        // Build attribution from the refs whose domains match the fact provenance
        const citedDomains = new Set(metricFacts.flatMap((f) => f.provenance.map((p) => p.sourceDomain)));
        const attributionSources = refs
            .filter((r) => citedDomains.has(r.sourceDomain))
            .map((r) => ({ source: r.source, url: r.url }))
            .slice(0, 5);
        if (attributionSources.length === 0)
            continue;
        const unitSuffix = metricFacts[0]?.quantity?.unit ? ` (${metricFacts[0].quantity.unit})` : '';
        charts.push({
            type: 'chart',
            chartType: 'bar',
            title: `${metric}${unitSuffix}`,
            series,
            factIds,
            caption: `Based on extracted data from ${attributionSources.map((s) => s.source).join(', ')}.`,
            attribution: { sources: attributionSources },
        });
    }
    return charts;
}
