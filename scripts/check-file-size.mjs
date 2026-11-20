#!/usr/bin/env node
// Keep the code branches lean: no tracked file over the limit unless listed
// below. Site media belongs on the `website` branch; large release media on a
// GitHub Release.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const LIMIT = 1.5 * 1024 * 1024;
const ALLOWED = new Set([
  'docs/assets/desktop-visor/approved-transparent-hud.png',
  'assets/demos/cat-sofa-guard/cat-sofa-guard.mp4',
]);

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0').filter(Boolean);
const tooLarge = files
  .filter(f => !ALLOWED.has(f))
  .map(f => { try { return [f, statSync(f).size]; } catch { return [f, 0]; } })
  .filter(([, size]) => size > LIMIT);

if (tooLarge.length) {
  for (const [f, size] of tooLarge) console.error(`${f}: ${(size / 1048576).toFixed(1)} MB`);
  console.error(`\n${tooLarge.length} file(s) exceed ${LIMIT / 1048576} MB. Compress them, move site media to the website branch, or add a reviewed entry to ALLOWED in scripts/check-file-size.mjs.`);
  process.exit(1);
}
console.log(`file sizes ok (${files.length} files, limit ${LIMIT / 1048576} MB)`);
