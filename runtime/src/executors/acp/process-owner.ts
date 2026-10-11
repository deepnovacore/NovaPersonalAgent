import {execFile} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {promisify} from 'node:util'
import type {CodexProcessOwnerFactory, OwnedCodexProcess} from '../codex/process-owner.js'
import {PosixCodexProcessOwnerFactory, unconfirmedCodexProcessOwnerError, takeUnconfirmedCodexProcessOwner} from '../codex/process-owner.js'
import {CodexTransportError} from '../codex/app-server-transport.js'

const execFileAsync = promisify(execFile)
const SCOPE_ENV = 'NOVA_ACP_PROCESS_SCOPE'

/** ACP tools can leave their agent's process group. Scope survives ordinary fork/exec and reparenting. */
export function scopedAcpProcessFactory(factory: CodexProcessOwnerFactory): CodexProcessOwnerFactory {
  if (process.platform === 'win32') return factory // The native Job Object owns the Windows tree.
  return {spawn: async (spec, control) => {
    const token = randomUUID()
    const scope = new AcpProcessScope(token)
    await scope.members() // Refuse before launching when ownership cannot be observed.
    let owner: OwnedCodexProcess
    try {owner = await factory.spawn({...spec, environment: {...spec.environment, [SCOPE_ENV]: token}}, control)}
    catch (error) {
      const unconfirmed = takeUnconfirmedCodexProcessOwner(error)
      if (unconfirmed) throw unconfirmedCodexProcessOwnerError(wrapOwner(unconfirmed, scope))
      throw error
    }
    const wrapped = wrapOwner(owner, scope)
    if (factory instanceof PosixCodexProcessOwnerFactory) {
      try {
        if (!(await scope.members()).has(owner.pid)) throw new Error('scope marker missing')
      } catch {throw unconfirmedCodexProcessOwnerError(wrapped)}
    }
    return wrapped
  }}
}

function wrapOwner(owner: OwnedCodexProcess, scope: AcpProcessScope): OwnedCodexProcess {
  return {stdin: owner.stdin, stdout: owner.stdout, stderr: owner.stderr, pid: owner.pid, exit: owner.exit,
    closeStdin: () => owner.closeStdin(), dispose: () => owner.dispose(),
    terminateTree: async () => {await owner.terminateTree(); await scope.signal('SIGTERM')},
    killTree: async () => {await owner.killTree(); await scope.signal('SIGKILL')},
    waitTreeGone: async graceMs => {
      const expires = Date.now() + graceMs
      if (!await owner.waitTreeGone(graceMs)) return false
      do {
        if ((await scope.members()).size === 0) return true
        const remaining = expires - Date.now()
        if (remaining <= 0) return false
        await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)))
      } while (Date.now() <= expires)
      return false
    },
  }
}

class AcpProcessScope {
  readonly #token: string
  constructor(token: string) {this.#token = token}
  async members(): Promise<Map<number, string>> {
    try {
      // Never return/log this output: process environments can contain credentials.
      const {stdout} = await execFileAsync('/bin/ps', ['axeww', '-o', 'pid=,lstart=,stat=,command='], {
        env: {...process.env, LC_ALL: 'C', TZ: 'UTC'}, timeout: 3000, maxBuffer: 32 * 1024 * 1024,
      })
      const marker = `${SCOPE_ENV}=${this.#token}`
      const result = new Map<number, string>()
      const rows: string[] = []
      const heading = /^\s*\d+\s+\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}\s+\S+\s/u
      for (const line of stdout.split('\n')) {
        if (heading.test(line) || rows.length === 0) rows.push(line)
        else rows[rows.length - 1] += ` ${line}`
      }
      for (const line of rows) {
        if (!line.split(/\s+/u).includes(marker)) continue
        const fields = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s/u.exec(line)
        if (!fields) throw new Error('invalid process identity')
        const pid = Number(fields[1])
        if (pid > 1 && pid !== process.pid && !fields[3]!.includes('Z')) result.set(pid, fields[2]!)
      }
      return result
    } catch {throw new CodexTransportError('transport_lost')}
  }
  async signal(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    const observed = await this.members()
    const current = await this.members()
    for (const [pid, started] of observed) {
      // Recheck both inherited scope and start time; never signal a name/ancestry-only match.
      if (current.get(pid) !== started) continue
      try {process.kill(pid, signal)}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new CodexTransportError('transport_lost')}
    }
  }
  // shortcut: env-sanitizing tools can discard scope; use OS containment before certifying those chains.
}
