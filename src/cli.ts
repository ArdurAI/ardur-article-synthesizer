/**
 * CLI — run one synthesis cycle and write the ArticleArtifact to stdout/a file.
 *
 * Usage:
 *   node --experimental-strip-types src/cli.ts \
 *     --top10 data/runtime/top10.json \
 *     --aggregation data/runtime/aggregation.json \
 *     [--out data/runtime/articles.json]
 *
 * Reads the two upstream artifacts as JSON, runs `runSynthesis`, and prints the
 * resulting `ArticleArtifact`. CI runs this with ARDUR_AI_PROVIDER=deterministic.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { runSynthesis } from './index.ts';
import { assertCompatibleArtifact, SchemaVersionError } from './contracts.ts';
import type { Top10Artifact, AggregationArtifact } from './contracts.ts';

interface ParsedArgs {
  top10: string | undefined;
  aggregation: string | undefined;
  out: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  let top10: string | undefined;
  let aggregation: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    const next = argv[i + 1];
    if (cur === '--top10' && next) { top10 = next; i++; }
    else if (cur === '--aggregation' && next) { aggregation = next; i++; }
    else if (cur === '--out' && next) { out = next; i++; }
  }
  return { top10, aggregation, out };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.top10 || !args.aggregation) {
    console.error('Usage: cli.ts --top10 <path> --aggregation <path> [--out <path>]');
    process.exitCode = 1;
    return;
  }

  let top10: Top10Artifact;
  let aggregation: AggregationArtifact;

  let rawTop10: unknown;
  try {
    rawTop10 = JSON.parse(readFileSync(args.top10, 'utf8'));
  } catch (err) {
    console.error(`Failed to read top10 from ${args.top10}:`, err);
    process.exitCode = 1;
    return;
  }

  try {
    const { envelope, warnings: gateWarnings } = assertCompatibleArtifact(rawTop10, 'top10');
    for (const w of gateWarnings) console.error(`[warn] top10 gate: ${w}`);
    top10 = envelope as Top10Artifact;
  } catch (err) {
    if (err instanceof SchemaVersionError) {
      console.error(`top10 schema gate failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  let rawAggregation: unknown;
  try {
    rawAggregation = JSON.parse(readFileSync(args.aggregation, 'utf8'));
  } catch (err) {
    console.error(`Failed to read aggregation from ${args.aggregation}:`, err);
    process.exitCode = 1;
    return;
  }

  try {
    const { envelope, warnings: gateWarnings } = assertCompatibleArtifact(rawAggregation, 'aggregation');
    for (const w of gateWarnings) console.error(`[warn] aggregation gate: ${w}`);
    aggregation = envelope as AggregationArtifact;
  } catch (err) {
    if (err instanceof SchemaVersionError) {
      console.error(`aggregation schema gate failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const artifact = await runSynthesis({ top10, aggregation });
  const output = JSON.stringify(artifact, null, 2);

  if (args.out) {
    writeFileSync(args.out, output, 'utf8');
    console.error(`ArticleArtifact written to ${args.out}`);
  } else {
    process.stdout.write(output);
  }

  if (artifact.warnings.length > 0) {
    for (const w of artifact.warnings) {
      console.error(`[warn] ${w}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
