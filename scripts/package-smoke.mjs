/* global process */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');
const tempRoot = await mkdtemp(join(tmpdir(), 'ardur-article-synthesizer-pack-'));
const consumerRoot = join(tempRoot, 'consumer');

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd ?? repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
}

try {
  const { stdout } = await run('npm', ['pack', '--json', '--pack-destination', tempRoot]);
  const [packed] = JSON.parse(stdout);
  const tarball = join(tempRoot, packed.filename);

  await mkdir(consumerRoot);
  await run('npm', ['init', '-y'], { cwd: consumerRoot });
  await run('npm', ['install', '--ignore-scripts', tarball], { cwd: consumerRoot });

  const packageJson = JSON.parse(
    await readFile(join(consumerRoot, 'node_modules', '@ardurai', 'article-synthesizer', 'package.json'), 'utf8'),
  );
  assert.equal(packageJson.name, '@ardurai/article-synthesizer');

  const smoke = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const mod = await import('@ardurai/article-synthesizer'); const contracts = await import('@ardurai/article-synthesizer/contracts'); if (typeof mod.runSynthesis !== 'function') throw new Error('missing runSynthesis export'); if (!Number.isFinite(mod.CONTRACT_REVISION)) throw new Error('missing CONTRACT_REVISION export'); if (!Number.isFinite(contracts.CONTRACT_REVISION)) throw new Error('missing contracts subpath export'); console.log('article synthesizer package import ok');",
    ],
    { cwd: consumerRoot },
  );

  process.stdout.write(smoke.stdout);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
