import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanSourceIdentity, writeSourceBuildReceipt } from '../src/runtimes/execution-source-receipt.ts';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '../..');
const before = cleanSourceIdentity(repoRoot);
const require = createRequire(import.meta.url);
// Rebuild the runtime dependency graph inside the same source snapshot. An
// old contracts/platform dist must never inherit the new checkout's identity.
const pnpmPath = process.env.npm_execpath;
if (!pnpmPath) throw new Error('Run the daemon build through pnpm.');
const dependencies = spawnSync(process.execPath, [pnpmPath, '--filter', '@open-design/daemon^...', '--workspace-concurrency=4', '--if-present', 'run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
if (dependencies.error) throw dependencies.error;
if (dependencies.status !== 0) process.exit(dependencies.status ?? 1);
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(packageRoot, 'tsconfig.json')], { cwd: packageRoot, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
writeSourceBuildReceipt(repoRoot, before);
