/** Desktop-owned wrapper; the standalone server retains its headless lifecycle. */
import {runServerEntry} from './server-entry.js'
import {installDesktopStopSources, type DesktopStopParentSource} from './desktop-session.js'
const parentPort = (process as NodeJS.Process & {parentPort?: DesktopStopParentSource & {postMessage(value: unknown): void}}).parentPort
const stop = new AbortController()
const binding = installDesktopStopSources({processEvents: process, stdin: process.stdin, stop,
  ...(parentPort === undefined ? {} : {parentPort})})
const code = await runServerEntry({stop, onDiagnostic: line => {
  if (line.startsWith('[server-ready]')) parentPort?.postMessage({type: 'nova.phone.ready'})
  else if (line.startsWith('[runtime-diagnostic]')) process.stderr.write(`${line}\n`)
}})
binding.dispose()
await new Promise<void>(resolve => process.stderr.write('', () => resolve()))
process.exit(code)
