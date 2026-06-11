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
import { readFileSync, writeFileSync } from 'node:fs';
import { runSynthesis } from "./index.js";
import { assertCompatibleArtifact, SchemaVersionError } from "./contracts.js";
import { createProvider } from "./provider.js";
import { DESCRIPTOR } from "./describe.js";
export { DESCRIPTOR };
function emitError(code, message, detail) {
    const env = {
        error: {
            code,
            message,
            stage: 'synthesizer',
            ...(detail !== undefined ? { detail } : {}),
        },
    };
    process.stdout.write(JSON.stringify(env) + '\n');
    process.exit(1);
}
function parseArgs(argv) {
    let describe = false;
    let inPath;
    let out;
    let provider;
    let now;
    let runId;
    let top10;
    let aggregation;
    for (let i = 0; i < argv.length; i++) {
        const cur = argv[i];
        const next = argv[i + 1];
        if (cur === '--describe') {
            describe = true;
        }
        else if (cur === '--in' && next) {
            inPath = next;
            i++;
        }
        else if (cur === '--out' && next) {
            out = next;
            i++;
        }
        else if (cur === '--provider' && next) {
            provider = next;
            i++;
        }
        else if (cur === '--now' && next) {
            now = next;
            i++;
        }
        else if (cur === '--run-id' && next) {
            runId = next;
            i++;
        }
        else if (cur === '--top10' && next) {
            top10 = next;
            i++;
        }
        else if (cur === '--aggregation' && next) {
            aggregation = next;
            i++;
        }
    }
    return { describe, inPath, out, provider, now, runId, top10, aggregation };
}
// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------
function readRawJson(pathOrDash) {
    let raw;
    try {
        raw = pathOrDash === '-' ? readFileSync(0, 'utf8') : readFileSync(pathOrDash, 'utf8');
    }
    catch (err) {
        emitError('READ_ERROR', `Failed to read ${pathOrDash}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        return JSON.parse(raw);
    }
    catch (err) {
        emitError('PARSE_ERROR', `JSON parse failed for ${pathOrDash}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function gateTop10(raw) {
    try {
        const { envelope, warnings } = assertCompatibleArtifact(raw, 'top10');
        for (const w of warnings)
            process.stderr.write(`[warn] top10 gate: ${w}\n`);
        return envelope;
    }
    catch (err) {
        if (err instanceof SchemaVersionError) {
            emitError('SCHEMA_GATE_FAILED', `top10 schema gate failed: ${err.message}`, JSON.stringify(err.detail));
        }
        throw err;
    }
}
function gateAggregation(raw) {
    try {
        const { envelope, warnings } = assertCompatibleArtifact(raw, 'aggregation');
        for (const w of warnings)
            process.stderr.write(`[warn] aggregation gate: ${w}\n`);
        return envelope;
    }
    catch (err) {
        if (err instanceof SchemaVersionError) {
            emitError('SCHEMA_GATE_FAILED', `aggregation schema gate failed: ${err.message}`, JSON.stringify(err.detail));
        }
        throw err;
    }
}
function writeOutput(outPath, data) {
    if (outPath && outPath !== '-') {
        writeFileSync(outPath, data, 'utf8');
        process.stderr.write(`ArticleArtifact written to ${outPath}\n`);
    }
    else {
        process.stdout.write(data);
    }
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.describe) {
        process.stdout.write(JSON.stringify(DESCRIPTOR, null, 2) + '\n');
        return;
    }
    let top10Raw;
    let aggregationRaw;
    let explicitProvider;
    if (args.inPath !== undefined) {
        // Uniform path: --in carries combined { top10, aggregation }.
        const combined = readRawJson(args.inPath);
        if (typeof combined !== 'object' || combined === null || Array.isArray(combined)) {
            emitError('INVALID_INPUT', '--in must be a JSON object with "top10" and "aggregation" fields');
        }
        const c = combined;
        if (!('top10' in c) || !('aggregation' in c)) {
            emitError('INVALID_INPUT', '--in JSON must contain "top10" and "aggregation" fields');
        }
        top10Raw = c['top10'];
        aggregationRaw = c['aggregation'];
        if (!args.provider) {
            emitError('MISSING_PROVIDER', '--provider is required with --in (no implicit env-driven network mode)');
        }
        explicitProvider = args.provider;
    }
    else if (args.top10 !== undefined && args.aggregation !== undefined) {
        // Legacy path — ardur-pipeline backward compat.
        top10Raw = readRawJson(args.top10);
        aggregationRaw = readRawJson(args.aggregation);
        if (args.provider !== undefined)
            explicitProvider = args.provider;
    }
    else {
        emitError('MISSING_INPUT', [
            'Uniform:  cli.ts --in <file|-> --provider <name> [--out <file|->] [--now <iso>] [--run-id <id>]',
            'Legacy:   cli.ts --top10 <file> --aggregation <file> [--out <file>]',
            'Describe: cli.ts --describe',
        ].join('\n'));
    }
    const top10 = gateTop10(top10Raw);
    const aggregation = gateAggregation(aggregationRaw);
    let now;
    if (args.now !== undefined) {
        now = new Date(args.now);
        if (isNaN(now.getTime())) {
            emitError('INVALID_NOW', `--now is not a valid ISO 8601 date: ${args.now}`);
        }
    }
    else {
        now = new Date();
    }
    const provider = createProvider({
        ...(explicitProvider !== undefined ? { provider: explicitProvider } : {}),
        now,
    });
    const artifact = await runSynthesis({
        top10,
        aggregation,
        provider,
        now,
        ...(args.runId !== undefined ? { runId: args.runId } : {}),
    });
    writeOutput(args.out, JSON.stringify(artifact, null, 2));
    for (const w of artifact.warnings) {
        process.stderr.write(`[warn] ${w}\n`);
    }
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    const env = {
        error: { code: 'UNEXPECTED_ERROR', message, stage: 'synthesizer' },
    };
    process.stdout.write(JSON.stringify(env) + '\n');
    process.exit(1);
});
