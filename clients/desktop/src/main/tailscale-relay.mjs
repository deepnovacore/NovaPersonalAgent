import {execFile, spawn} from 'node:child_process'
import {randomBytes, randomUUID} from 'node:crypto'
import {constants} from 'node:fs'
import {access, lstat, mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {setTimeout as wait} from 'node:timers/promises'
import {fileURLToPath} from 'node:url'

const HTTPS_PORT = 8443
const HTTPS_PORTS = [8443, 9443, 10443]
const execute = promisify(execFile)
const fail = code => new Error(code)
const isMissing = error => { if (error?.code !== 'ENOENT') throw error; return null }

export function tailscaleEndpoint(status, port = HTTPS_PORT) {
  if (status?.BackendState !== 'Running') throw fail('tailscale_not_running')
  const name = status.Self?.DNSName?.replace(/\.$/u, '')
  if (typeof name !== 'string' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/u.test(name)
    || !status.CertDomains?.includes(name)) throw fail('tailscale_https_required')
  return `https://${name}:${port}`
}

export function assertServePortFree(config, port = HTTPS_PORT) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw fail('tailscale_serve_failed')
  if (config.TCP?.[port] || Object.keys(config.Web ?? {}).some(key => key.endsWith(`:${port}`))
    || Object.entries(config.AllowFunnel ?? {}).some(([key, value]) => value && key.endsWith(`:${port}`))) throw fail('tailscale_port_in_use')
  for (const foreground of Object.values(config.Foreground ?? {})) assertServePortFree(foreground, port)
}

function serves(config, host, target) {
  const port = new URL(`https://${host}`).port || '443'
  return Boolean(config?.TCP?.[port]?.HTTPS && config?.Web?.[host]?.Handlers?.['/']?.Proxy === target)
    || Object.values(config?.Foreground ?? {}).some(value => serves(value, host, target))
}

async function executable() {
  const candidates = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']
    : process.platform === 'win32' ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')] : ['/usr/bin/tailscale', '/usr/local/bin/tailscale']
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path } catch { /* Try the next installed location. */ }
  }
  throw fail('tailscale_not_installed')
}

async function runTailscale(args) {
  const file = await executable()
  try {
    const {stdout} = await execute(file, args, {encoding:'utf8', timeout:5000, maxBuffer:1024*1024, windowsHide:true})
    return JSON.parse(stdout)
  } catch { throw fail('tailscale_unavailable') }
}

// Foreground Serve belongs to this process; stopping it removes only this session.
async function startServe({relayUrl, target, run}) {
  const file = await executable()
  const child = spawn(process.execPath, [fileURLToPath(new URL('./tailscale-serve-process.mjs', import.meta.url)),
    file, 'serve', `--https=${new URL(relayUrl).port}`, target], {
    stdio:['pipe','ignore','ignore'], windowsHide:true, env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},
  })
  let exited = false
  const ended = new Promise(resolve => {
    child.once('exit', () => { exited = true; resolve() })
    child.once('error', () => { exited = true; resolve() })
  })
  const close = async () => {
    if (exited) return
    child.stdin.end()
    const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL') }, 2000)
    try { await ended } finally { clearTimeout(timer) }
  }
  try {
    const host = new URL(relayUrl).host, deadline = Date.now() + 15000
    while (!exited && Date.now() < deadline) {
      const config = await run(['serve', 'status', '--json'])
      if (!exited && serves(config, host, target)) return {alive:() => !exited, close}
      await wait(200)
    }
    throw fail('tailscale_serve_failed')
  } catch { await close(); throw fail('tailscale_serve_failed') }
}

async function privateDirectory(path) {
  await mkdir(path, {recursive:true, mode:0o700})
  const info = await lstat(path)
  if (!info.isDirectory() || (process.platform !== 'win32' && (info.mode & 0o077))) throw fail('space_directory_not_private')
}

async function marker(path) {
  const info = await lstat(path).catch(isMissing)
  if (!info) return null
  if (!info.isFile() || info.size > 4096 || (process.platform !== 'win32' && (info.mode & 0o077))) throw fail('space_config_invalid')
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value.v !== 1 || typeof value.relayUrl !== 'string') throw fail('space_config_invalid')
    return value
  } catch { throw fail('space_config_invalid') }
}

/** Desktop-owned opaque relay. Only its public origin is saved; bootstrap rotates on every start. */
export function createTailscaleRelay({directory, run = runTailscale, serve = startServe,
  loadRelay = () => import('@nova-personal-agent/relay/server'), retryMs = 5000}) {
  let active = null, pending = null, retry = null, stopping = false
  function monitor(relayUrl) {
    if (retry || stopping) return
    retry = setInterval(() => {
      if (!active?.proxy.alive()) void ensure(relayUrl).catch(() => { /* Keep the saved namespace offline until Tailscale recovers. */ })
    }, retryMs)
    retry.unref()
  }
  async function start(expected) {
    if (active?.proxy.alive()) {
      if (expected && expected !== active.request.relayUrl) throw fail('tailscale_identity_changed')
      monitor(active.request.relayUrl)
      return active.request
    }
    if (active) { await active.proxy.close(); await active.server.close(); active = null }
    const status = await run(['status', '--json'])
    tailscaleEndpoint(status)
    const root = directory(), path = join(root, 'managed.json')
    await privateDirectory(root)
    const saved = await marker(path)
    const pinned = expected ?? saved?.relayUrl
    let port = HTTPS_PORT
    const serving = await run(['serve', 'status', '--json'])
    if (pinned) {
      try { port = Number(new URL(pinned).port) } catch { throw fail('tailscale_identity_changed') }
      if (!HTTPS_PORTS.includes(port) || tailscaleEndpoint(status, port) !== pinned
        || (saved && saved.relayUrl !== pinned)) throw fail('tailscale_identity_changed')
      assertServePortFree(serving, port)
    } else {
      port = HTTPS_PORTS.find(candidate => {
        try { assertServePortFree(serving, candidate); return true }
        catch (error) { if (error.message !== 'tailscale_port_in_use') throw error; return false }
      })
      if (!port) throw fail('tailscale_port_in_use')
    }
    const relayUrl = tailscaleEndpoint(status, port)
    for (const name of ['security.sqlite', 'mailbox.sqlite']) {
      const info = await lstat(join(root, name)).catch(isMissing)
      if (info && !info.isFile()) throw fail('space_config_invalid')
    }
    const bootstrapToken = randomBytes(32).toString('base64url')
    const {RelayServer} = await loadRelay()
    const server = new RelayServer({securityPath:join(root,'security.sqlite'), mailboxPath:join(root,'mailbox.sqlite'),
      bootstrapToken, bind:'127.0.0.1', port:0, externalTls:true, publicUrl:relayUrl, trustedProxyAddresses:['127.0.0.1'],
      // Space voice media for this Host's own paired devices; standalone relays keep it off.
      media:{enabled:true}})
    let proxy
    try {
      const target = await server.listen()
      try { proxy = await serve({relayUrl, target, run}) } catch { throw fail('tailscale_serve_failed') }
      const temporary = join(root, `managed-${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify({v:1,relayUrl})+'\n', {mode:0o600,flag:'wx'})
      await rename(temporary, path)
      active = {server, proxy, request:{relayUrl,bootstrapToken}}
      monitor(relayUrl)
      return active.request
    } catch (error) { await proxy?.close(); await server.close(); throw error }
  }
  function ensure(expected) {
    if (stopping) return Promise.reject(fail('tailscale_serve_failed'))
    if (!pending) {
      pending = start(expected).finally(() => { pending = null })
    }
    return pending
  }
  return {
    ensure,
    async restore(relayUrl) {
      const saved = await marker(join(directory(), 'managed.json'))
      if (saved) {
        if (saved.relayUrl !== relayUrl) throw fail('tailscale_identity_changed')
        monitor(relayUrl)
      }
      return saved ? ensure(relayUrl) : null
    },
    async close() {
      stopping = true; clearInterval(retry); retry = null
      await pending?.catch(() => {})
      const closing = active; active = null
      try { if (closing) { try { await closing.proxy.close() } finally { await closing.server.close() } } }
      finally { stopping = false }
    },
  }
}
