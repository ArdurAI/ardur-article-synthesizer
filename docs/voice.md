# Ardur Article Voice & Style Spec

> **Authoritative voice spec for `ardur-article-synthesizer`.** Confirmed by the
> product owner. Encoded as code in [`../src/style.ts`](../src/style.ts)
> (`VOICE_STYLE`, `SECTION_VOICE`) and threaded into assembly + the provider.
> Referenced from [`spec.md`](./spec.md) and the [README](../README.md).
>
> Voice id: `ardur-voice/genz-professional/v1`

## The voice in one line

**GenZ-but-professional.** Credible, accurate, and fully sourced — but **not dry
newswire.** Plain-language, engaging, a little irreverent, genuinely interesting.
**Short but dense**, synthesized from many sources into a few high-signal lines.

### Target-voice example

> "PyTorch just dropped 2.6 and the compile-time wins are real — here's what
> actually changed and why your training loop cares."

Why this works: it leads with **what changed** (PyTorch 2.6), signals **why a
builder cares** (compile-time wins, your training loop), uses **plain active
language**, and carries **a little personality** ("the … wins are real") —
without hype, without sacrificing a single fact.

## DO

- **Plain language.** Write so a busy builder gets it on the first read. No
  jargon for jargon's sake.
- **Active voice.** "PyTorch shipped X," not "X was shipped by PyTorch."
- **Lead with what changed + why a builder cares.** The first sentence earns the
  rest. Put the payload up front.
- **Concrete specifics.** Versions, numbers, names, dates. "2.6 cut cold-start
  compile ~40%" beats "significant performance improvements."
- **Light personality.** A little irreverence and a human turn of phrase make it
  genuinely interesting. Personality comes from phrasing, not punctuation.
- **Short but dense.** Synthesize 20–30 sources into a tight, high-signal piece.
  Every sentence should carry weight.

## DON'T

- **No hype or clickbait.** Banned: "game-changer," "you won't believe,"
  "breaking," "mind-blowing," "revolutionary," "must-read." If it reads like a
  YouTube thumbnail, rewrite it.
- **No slang that ages badly.** Skip "no cap," "slaps," "rizz," "goes hard,"
  "lowkey/highkey." GenZ-*professional* means the energy of good plain writing,
  not a meme that's stale in six months.
- **Never trade accuracy or sourcing for tone.** Facts and citations win, every
  time. If a punchy phrasing overstates the evidence, it loses.
- **No PII.** Never in prose, links, examples, or metadata. (Enforced by
  [`privacy.ts`](../src/privacy.ts).)
- **No exclamation-point spam.** At most rare, deliberate use. Excitement is
  shown by what you say, not how many `!` you add.

## Before → after

Three dry-newswire openers rewritten into the Ardur voice. Same facts, same
sources, same accuracy — different read.

**1. Model release**

- **Before (dry newswire):** "Anthropic announced the release of a new model on
  Tuesday, which the company says offers improved performance on coding
  benchmarks."
- **After (Ardur voice):** "Anthropic's new model is out, and the headline is
  code: it posts the company's best coding-benchmark numbers yet — here's where
  the gains actually land."

**2. Infra / Kubernetes**

- **Before:** "Version 1.31 of Kubernetes was made generally available,
  introducing several enhancements to its networking subsystem."
- **After:** "Kubernetes 1.31 just went GA, and the networking changes are the
  part worth your attention — fewer foot-guns in how Services route traffic."

**3. Research / paper**

- **Before:** "A recently published paper proposes a novel method that the
  authors claim reduces inference latency in large language models."
- **After:** "A new paper says you can shave LLM inference latency without
  retraining — the method is clever, the benchmarks are early, and we flag what
  still needs independent confirmation."

Note how each "after" still hedges where the evidence is thin ("benchmarks are
early," "what still needs confirmation") — voice never outruns sourcing.

## Tone guardrails

- **Personality budget.** At most ~20% of an article (`maxPlayfulnessRatio`) is
  light/personality-driven; the rest is straight signal. The opener
  (*Key Takeaway*) and *Ardur Take* carry the most; *What Happened* stays tight
  and factual. See `SECTION_VOICE` in [`style.ts`](../src/style.ts).
- **Professional floor.** It can be casual, never sloppy. No profanity, no
  punching down, no in-jokes that exclude readers.
- **Confidence honesty.** Match assertiveness to `confidence`/`sourceQuality`.
  Single-source claims are hedged ("according to…"); corroborated facts are
  stated plainly. A punchy line on a thin source is a bug.
- **One quote, max, per section.** Short (< 25 words), attributed, and only when
  a primary source's exact wording earns it.

## Copyright-safe voice

Voice is a **prose layer**. It never weakens the copyright gate
([`copyright.ts`](../src/copyright.ts)):

- **Original phrasing only.** Personality means *our* sentences, not a livelier
  remix of someone else's. The verbatim-overlap check (`longestVerbatimRun`)
  applies to on-voice prose exactly as it does to plain prose.
- **Quotes < 25 words, attributed.** A snappy tone is never an excuse to quote
  more.
- **Never republish bodies.** The synthesizer only ever sees metadata (titles,
  sources, dates, links); it cannot reproduce what it never reads.
- **Sourcing is non-negotiable.** Every material claim stays mapped to its
  supporting sources ([`provenance.ts`](../src/provenance.ts)) regardless of how
  the sentence is styled.

Order of precedence when they tension: **accuracy → sourcing → copyright →
privacy → render → voice.** Voice yields to all of them.

## Voice within the cost-guarded provider

The voice must hold on **every** path, including budget = 0 (today's production
reality — see [`spec.md` §8](./spec.md#8-cost-guarded-pluggable-ai-provider)):

- A **single source of truth** (`VOICE_STYLE` in `style.ts`) feeds both paths.
- **LLM path:** `buildVoiceDirective()` renders `VOICE_STYLE` (+ the section's
  `SECTION_VOICE` intent) into a directive that is threaded into the provider
  prompt via `GenerateRequest.voiceDirective`.
- **Deterministic / fallback path:** the rules-based assembler parameterizes its
  sentence templates from the **same** `VOICE_STYLE` — leading with what changed,
  active voice, concrete specifics, a measured dose of personality. A budget=0
  article reads as Ardur, **not** as a newswire stub.
- **Final lint:** `lintVoice()` runs on both outputs to catch banned lexicon,
  hype, and punctuation spam, downgrading off-voice phrasing to plainer wording.
  It **never blocks** — by the time voice lint runs, the accuracy, sourcing, and
  copyright gates have already passed; voice only polishes.

## How the voice is wired

| Layer | Where | Role |
|-------|-------|------|
| Config | `src/style.ts` (`VOICE_STYLE`, `SECTION_VOICE`) | single source of truth |
| Directive builder | `src/style.ts` (`buildVoiceDirective`) | config → prompt/template directive |
| Voice lint | `src/style.ts` (`lintVoice`) | guardrail pass on both outputs |
| Assembly | `src/assemble.ts` (`AssemblyPlan.voiceDirectives`) | per-section directives attached to the plan |
| Provider | `src/provider.ts` (`GenerateRequest.voiceDirective`) | LLM prompt carries the voice; fallback shares config |
