/**
 * CLI — run one synthesis cycle and write the ArticleArtifact.
 *
 * Uniform agent-ready CLI (hermes-agent-layer.md §4):
 *
 *   --describe
 *     Emit engine descriptor JSON and exit.
 *
 *   --in <file|->  --provider <name>  [--out <file|->]  [--now <iso>]  [--run-id <id>]
 *     Read combined { top10, aggregation } JSON; write ArticleArtifact to --out (or stdout).
 *
 * Legacy (ardur-pipeline backward compat — no behaviour change):
 *   --top10 <file>  --aggregation <file>  [--out <file>]
 *
 * Exit codes: 0 = success; 1 = error.
 * On error: { error: { code, message, stage, detail? } } emitted to stdout, diagnostics on stderr.
 */
import { DESCRIPTOR } from './describe.ts';
export { DESCRIPTOR };
