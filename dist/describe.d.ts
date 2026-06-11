/**
 * Engine self-description for --describe, tool registry, and MCP server.
 * Imported by cli.ts (emitted to stdout) and by tests (structural assertions).
 */
export declare const DESCRIPTOR: {
    readonly name: "ardur-article-synthesizer";
    readonly stage: "articles";
    readonly contract: {
        readonly schemaVersion: "ardur-content-pipeline/v1";
        readonly contractRevision: 3;
    };
    readonly input: {
        readonly type: "object";
        readonly required: readonly ["top10", "aggregation"];
        readonly properties: {
            readonly top10: {
                readonly $ref: "Top10Artifact";
                readonly description: "Top-10 selection from ardur-top10-engine";
            };
            readonly aggregation: {
                readonly $ref: "AggregationArtifact";
                readonly description: "Clustered sources from ardur-news-aggregator";
            };
        };
    };
    readonly output: {
        readonly $ref: "ArticleArtifact";
        readonly description: "Copyright-safe synthesized articles";
    };
    readonly flags: readonly [{
        readonly flag: "--in";
        readonly type: "file|-";
        readonly description: "Combined { top10, aggregation } JSON (or - for stdin)";
    }, {
        readonly flag: "--out";
        readonly type: "file|-";
        readonly default: "-";
        readonly description: "Output path or - for stdout";
    }, {
        readonly flag: "--provider";
        readonly type: "string";
        readonly enum: readonly ["deterministic", "ollama", "openai"];
        readonly description: "AI provider (required with --in; no implicit env-driven network mode)";
    }, {
        readonly flag: "--now";
        readonly type: "iso8601";
        readonly description: "Deterministic wall-clock instant for replay";
    }, {
        readonly flag: "--run-id";
        readonly type: "string";
        readonly description: "Deterministic run ID for replay";
    }, {
        readonly flag: "--describe";
        readonly type: "boolean";
        readonly description: "Print this descriptor and exit";
    }, {
        readonly flag: "--top10";
        readonly type: "file";
        readonly deprecated: true;
        readonly description: "Legacy: Top10Artifact path (use --in instead)";
    }, {
        readonly flag: "--aggregation";
        readonly type: "file";
        readonly deprecated: true;
        readonly description: "Legacy: AggregationArtifact path (use --in instead)";
    }];
};
