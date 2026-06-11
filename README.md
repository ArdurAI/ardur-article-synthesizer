# ardur-article-synthesizer

> **Stage 4 of the [Ardur AI content pipeline](./ARCHITECTURE.md).** Turns each
> Top-10 topic and its 20–30 clustered sources into **one original,
> copyright-safe article**, rendered **in-app** with no navigation away.

[![CI](https://github.com/ArdurAI/ardur-article-synthesizer/actions/workflows/ci.yml/badge.svg)](https://github.com/ArdurAI/ardur-article-synthesizer/actions/workflows/ci.yml)
&nbsp;Schema: `ardur-content-pipeline/v1` · License: MIT · Node ≥ 22

---

## What it does

Every 6 hours, the upstream engines decide **what** is worth reading. This engine
decides **how it reads**:

```
aggregator ─► (NewsItem[], TopicCluster[]) ─► ranking-engine ─► RankedItem[]
   ─► top10-engine (every 6h) ─► Top10Entry[] ─► article-synthesizer ─► SynthesizedArticle[]
   ─► ardur.ai in-app render
```

For each `Top10Entry`, the synthesizer:

1. **Resolves** the entry's cluster members (20–30 sources) from the
   `AggregationArtifact`.
2. **Plans the weave** — dedups and orders sources (primary/paper first), caps
   the reference list.
3. **Generates original prose** per section via a **cost-guarded, pluggable AI
   provider** (deterministic → Ollama → OpenAI), with a deterministic fallback
   that remains in the Ardur voice and is held for editorial review when AI
   generation is unavailable.
4. **Assembles** the prose into the in-app `ArticleBlock[]` render model.
5. **Proves provenance** — every factual claim is mapped to the sources that
   support it; ungrounded claims are dropped.
6. **Gates on copyright + renderability** — original text only, quotes < 25
   words with attribution, canonical links for every source, no reproduced
   bodies. Anything that fails the gate degrades to a stricter deterministic
   article and records a warning. **It never aborts the cycle.**

The output is an `ArticleArtifact` with published `articles` and a separate
`heldArticles` editorial queue for deterministic or ungrounded fallbacks.

## Baked-in guarantees

| Guarantee | How it is enforced | Module |
|-----------|--------------------|--------|
| **Copyright-safe** | Original text only; quotes < 25 words + attribution; canonical link per source; verbatim-overlap + credential screens; **never** reproduce article bodies. Fails **closed**. | [`src/copyright.ts`](./src/copyright.ts) |
| **Cost-guarded AI** | Provider order `deterministic → ollama → openai`. `ARDUR_AI_MAX_GENERATIONS` budget + per-call timeout; any failure falls back to deterministic. CI is always deterministic (zero cost, no network). | [`src/provider.ts`](./src/provider.ts) |
| **Provenance per claim** | Every factual claim is tied to its supporting sources; ungrounded claims never ship. | [`src/provenance.ts`](./src/provenance.ts) |
| **Privacy** | No PII in URLs or logs; tracking params stripped; metric/log keys screened against `FORBIDDEN_METRIC_KEY_FRAGMENTS`. | [`src/privacy.ts`](./src/privacy.ts) |
| **In-app render** | Typed `ArticleBlock[]`, source trail kept separate from prose, no external navigation. | [`src/render.ts`](./src/render.ts) |
| **House voice** | "GenZ-but-professional" — engaging, plain-language, fully sourced, never dry newswire or hype. Same voice on the LLM **and** budget=0 paths. | [`src/style.ts`](./src/style.ts) · [`docs/voice.md`](./docs/voice.md) |

## Quick start

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test (deterministic, zero network)
npm run build       # tsc -> dist/
npm run test:package # pack + fresh consumer import smoke

# run deterministic synthesis against local artifacts:
ARDUR_AI_PROVIDER=deterministic npm run synthesize \
  --top10 data/runtime/top10.json \
  --aggregation data/runtime/aggregation.json \
  > data/runtime/articles.json
```

Configuration lives in [`.env.example`](./.env.example) — provider, kill switch,
generation budget, timeout, and optional Ollama/OpenAI settings.

## Public API

```ts
import { runSynthesis } from '@ardurai/article-synthesizer';
import type { Top10Artifact, AggregationArtifact, ArticleArtifact } from '@ardurai/article-synthesizer/contracts';

const articles: ArticleArtifact = await runSynthesis({
  top10,        // Top10Artifact  — what to write about
  aggregation,  // AggregationArtifact — the sources to weave (same cycle.id)
});
```

`runSynthesis` returns a cycle artifact with `articles` for publishable,
AI-grounded output and `heldArticles` for deterministic or ungrounded fallbacks.
Each synthesized article carries `body: ArticleBlock[]`, `references`,
`provenance`, `ai` (provider meta), and a `legalNote`. See
[`src/contracts.ts`](./src/contracts.ts), the package shim over the shared
contract.

## Relationship to the existing ardur.ai system

This engine **extracts and generalizes** working code on
[`ardur.ai`](https://github.com/ArdurAI/ardur.ai) `main` (the "Hermes" content
engine): `src/lib/aiProvider.mjs` (`generateSignalBrief`), the digest assembly in
`scripts/build-news-digests.mjs`, the privacy/metrics policy in
`scripts/refresh-article-intelligence.mjs`, and the in-app source-trail render in
`src/components/ArticleSourceTrail.astro`. The promotion is **single-paragraph
briefs → full original articles**. Migration points are documented in
[`docs/spec.md` §10](./docs/spec.md#10-migration-from-ardurai-hermes).

## Repository layout

```
ARCHITECTURE.md        Pipeline-wide architecture (mirrored across all 4 repos)
README.md              This file
docs/spec.md           Full design specification (diagrams, schemas, rules)
docs/voice.md          Authoritative voice & style spec (GenZ-but-professional)
src/contracts.ts       Shared wire contract (vendored, identical across repos)
src/index.ts           Public entrypoint: runSynthesis()
src/synthesize.ts      Cycle orchestration
src/provider.ts        Pluggable, cost-guarded AI provider chain
src/assemble.ts        Article assembly rules (weave + sections + blocks + voice)
src/style.ts           Voice & style config (VOICE_STYLE) wired into assembly
src/copyright.ts       Copyright-safety gate
src/provenance.ts      Per-claim provenance
src/render.ts          In-app render contract
src/privacy.ts         PII / URL scrubbing
src/cli.ts             CLI runner
src/smoke.test.ts      Scaffold smoke tests
```

## License

[MIT](./LICENSE)
