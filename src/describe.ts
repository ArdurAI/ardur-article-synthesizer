/**
 * Engine self-description for --describe, tool registry, and MCP server.
 * Imported by cli.ts (emitted to stdout) and by tests (structural assertions).
 */

import { SCHEMA_VERSION, CONTRACT_REVISION } from './contracts.ts';

export const DESCRIPTOR = {
  name: 'ardur-article-synthesizer',
  stage: 'articles',
  contract: { schemaVersion: SCHEMA_VERSION, contractRevision: CONTRACT_REVISION },
  input: {
    type: 'object',
    required: ['top10', 'aggregation'],
    properties: {
      top10: { $ref: 'Top10Artifact', description: 'Top-10 selection from ardur-top10-engine' },
      aggregation: {
        $ref: 'AggregationArtifact',
        description: 'Clustered sources from ardur-news-aggregator',
      },
    },
  },
  output: { $ref: 'ArticleArtifact', description: 'Copyright-safe synthesized articles' },
  flags: [
    {
      flag: '--in',
      type: 'file|-',
      description: 'Combined { top10, aggregation } JSON (or - for stdin)',
    },
    { flag: '--out', type: 'file|-', default: '-', description: 'Output path or - for stdout' },
    {
      flag: '--provider',
      type: 'string',
      enum: ['deterministic', 'ollama', 'openai'],
      description: 'AI provider (required with --in; no implicit env-driven network mode)',
    },
    {
      flag: '--now',
      type: 'iso8601',
      description: 'Deterministic wall-clock instant for replay',
    },
    { flag: '--run-id', type: 'string', description: 'Deterministic run ID for replay' },
    { flag: '--describe', type: 'boolean', description: 'Print this descriptor and exit' },
    {
      flag: '--top10',
      type: 'file',
      deprecated: true,
      description: 'Legacy: Top10Artifact path (use --in instead)',
    },
    {
      flag: '--aggregation',
      type: 'file',
      deprecated: true,
      description: 'Legacy: AggregationArtifact path (use --in instead)',
    },
  ],
} as const;
