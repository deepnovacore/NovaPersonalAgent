import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readdirSync, realpathSync, writeFileSync, symlinkSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// No implicit output location: local developers must select their mounted build disk.
const args = process.argv.slice(2);
const outputRoot = args[args.indexOf('--output-root') + 1];
const runId = args[args.indexOf('--run-id') + 1];
if (!args.includes('--output-root') || !outputRoot || !isAbsolute(outputRoot) ||
    !args.includes('--run-id') || !runId || !/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) {
  console.error('Usage: npm test --workspace @nova-personal-agent/relay -- --output-root /mounted/build-root --run-id chat-id');
  process.exit(1);
}
// Root must already exist: a missing mount must never silently fall back to another disk.
const root = realpathSync(outputRoot);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worktree = realpathSync(resolve(packageDir, '..'));
const namespace = createHash('sha256').update(worktree).digest('hex').slice(0, 16);
const output = join(root, `nova-relay-${namespace}`, runId);
mkdirSync(output, {recursive: true});
// Node ESM resolves runtime dependencies from the isolated output's ancestry.
const dependencyLink = join(output, 'node_modules');
if (!existsSync(dependencyLink)) symlinkSync(join(worktree, 'node_modules'), dependencyLink, 'dir');
writeFileSync(join(output, 'package.json'), '{"type":"module"}\n');
const require = createRequire(import.meta.url);
const compiler = require.resolve('typescript/bin/tsc');
const compile = spawnSync(process.execPath, [compiler, '-p', join(packageDir, 'tsconfig.json'),
  '--noEmit', 'false', '--outDir', output], {stdio: 'inherit'});
if (compile.error) throw compile.error;
if (compile.status !== 0) process.exit(compile.status ?? 1);
const tests = readdirSync(join(packageDir, 'test')).filter(name => name.endsWith('.test.ts'))
  .sort().map(name => join(output, 'test', name.replace(/\.ts$/, '.js')));
if (!tests.length) throw new Error('No relay tests found');
// A separate process per file also works on the minimum Node 22 release.
for (const file of tests) {
  const result = spawnSync(process.execPath, [file], {stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
