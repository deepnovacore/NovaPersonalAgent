import {readFile, writeFile} from 'node:fs/promises'
import ts from 'typescript'
const source = new URL('../src/config/capability-registry.ts', import.meta.url)
const target = new URL('../../cli/src/capability-registry.mjs', import.meta.url)
const output = '// Generated from runtime/src/config/capability-registry.ts; run node runtime/scripts/check-capabilities.mjs --write.\n'
  + ts.transpileModule(await readFile(source, 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext},
  }).outputText
// The CLI has no dependencies, so the desktop key probe is copied rather than imported.
const probeSource = new URL('../../clients/desktop/src/main/key-probe.mjs', import.meta.url)
const probeTarget = new URL('../../cli/src/key-probe.mjs', import.meta.url)
const probeOutput = '// Generated from clients/desktop/src/main/key-probe.mjs; run node runtime/scripts/check-capabilities.mjs --write.\n'
  + await readFile(probeSource, 'utf8')
// `npa doctor` demands the same voice credentials as the runtime's blocking check.
const voiceSource = new URL('../src/config/voice-credentials.ts', import.meta.url)
const voiceTarget = new URL('../../cli/src/voice-credentials.mjs', import.meta.url)
const voiceOutput = '// Generated from runtime/src/config/voice-credentials.ts; run node runtime/scripts/check-capabilities.mjs --write.\n'
  + ts.transpileModule(await readFile(voiceSource, 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext},
  }).outputText
// Every entry point resolves and migrates the data root by the same rules; CLI and desktop get emitted copies.
const dataRootSource = new URL('../src/config/data-root.ts', import.meta.url)
const dataRootTargets = [
  new URL('../../cli/src/data-root.mjs', import.meta.url),
  new URL('../../clients/desktop/src/main/data-root.mjs', import.meta.url),
]
const dataRootOutput = '// Generated from runtime/src/config/data-root.ts; run node runtime/scripts/check-capabilities.mjs --write.\n'
  + ts.transpileModule(await readFile(dataRootSource, 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext},
  }).outputText
const dataRootStale = async () => {
  for (const target of dataRootTargets) if (await readFile(target, 'utf8').catch(() => '') !== dataRootOutput) return true
  return false
}
if (process.argv[2] === '--write') {
  for (const target of dataRootTargets) await writeFile(target, dataRootOutput)
  await writeFile(target, output)
  await writeFile(probeTarget, probeOutput)
  await writeFile(voiceTarget, voiceOutput)
} else if (await readFile(target, 'utf8') !== output) throw new Error('CLI capability validator is stale; run node runtime/scripts/check-capabilities.mjs --write')
else if (await readFile(probeTarget, 'utf8').catch(() => '') !== probeOutput) throw new Error('CLI key probe is stale; run node runtime/scripts/check-capabilities.mjs --write')
else if (await readFile(voiceTarget, 'utf8').catch(() => '') !== voiceOutput) throw new Error('CLI voice credential table is stale; run node runtime/scripts/check-capabilities.mjs --write')
else if (await dataRootStale()) throw new Error('CLI/desktop data-root helper is stale; run node runtime/scripts/check-capabilities.mjs --write')
else process.stdout.write('Shared capability validator drift check passed\n')
