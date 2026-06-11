/**
 * CLI — run one synthesis cycle and write the ArticleArtifact to stdout/a file.
 *
 * SCAFFOLD ONLY. Usage (once implemented):
 *   node --experimental-strip-types src/cli.ts \
 *     --top10 data/runtime/top10.json \
 *     --aggregation data/runtime/aggregation.json \
 *     > data/runtime/articles.json
 *
 * Reads the two upstream artifacts as JSON, runs `runSynthesis`, and prints the
 * resulting `ArticleArtifact`. CI runs this with ARDUR_AI_PROVIDER=deterministic.
 */

import { runSynthesis } from './index.ts';

async function main(): Promise<void> {
  // Stub: arg parsing + artifact loading wired during implementation.
  const top10 = undefined as never;
  const aggregation = undefined as never;
  const artifact = await runSynthesis({ top10, aggregation });
  process.stdout.write(JSON.stringify(artifact, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
