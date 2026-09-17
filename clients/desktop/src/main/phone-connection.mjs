import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {existsSync} from 'node:fs'
const exec = promisify(execFile)

export function inspectPhoneNetwork(status, serve, port) {
  if (status?.BackendState !== 'Running') return {state: 'needs_login'}
  if (Object.values(serve?.AllowFunnel ?? {}).some(Boolean)) return {state: 'public_endpoint'}
  const host = status.Self?.DNSName?.replace(/\.$/, '')
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) return {state: 'needs_login'}
  for (const [address, config] of Object.entries(serve?.Web ?? {})) {
    const endpoint = new URL(`https://${address}`)
    if (endpoint.hostname !== host || !serve.TCP?.[endpoint.port || '443']?.HTTPS) continue
    if (Object.keys(config?.Handlers ?? {}).some(path => path !== '/' && ['/client/v1', '/client/pair', '/client/pair-admin'].some(route => route === path || route.startsWith(path.endsWith('/') ? path : `${path}/`)))) return {state: 'conflict'}
    const proxy = config?.Handlers?.['/']?.Proxy
    if (proxy === `http://127.0.0.1:${port}` || proxy === `http://localhost:${port}`) {
      if (serve.AllowFunnel?.[address]) return {state: 'public_endpoint'}
      return {state: 'ready', url: `wss://${address.replace(/:443$/, '')}`}
    }
  }
  return {state: serve?.TCP?.['443'] || Object.keys(serve?.Web ?? {}).length ? 'conflict' : 'needs_serve'}
}

function tailscaleBinary() {
  return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'].find(existsSync)
}
export async function phoneNetwork(port, configure = false) {
  const binary = tailscaleBinary()
  if (!binary) return {state: 'not_installed'}
  const run = args => exec(binary, args, {env: {...process.env, TAILSCALE_BE_CLI: '1'}, timeout: 8000, maxBuffer: 1024 * 1024})
  try {
    const status = JSON.parse((await run(['status', '--json'])).stdout)
    const serve = JSON.parse((await run(['serve', 'status', '--json'])).stdout)
    const result = inspectPhoneNetwork(status, serve, port)
    if (!configure || result.state !== 'needs_serve') return result
    await run(['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`])
    return inspectPhoneNetwork(status, JSON.parse((await run(['serve', 'status', '--json'])).stdout), port)
  } catch { return {state: 'unavailable'} }
}

export function createManagedPhoneService({launch, shutdown, timeoutMs = 30000}) {
  let child, pending, closing, ready = false
  return {
    get running() { return ready },
    start() {
      if (closing) return closing.then(() => this.start())
      if (ready) return Promise.resolve()
      if (pending) return pending
      pending = (async () => {
        child = await launch()
        const owned = child
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => done(new Error('service_timeout')), timeoutMs)
          const done = error => { clearTimeout(timer); owned.off('message', message); owned.off('exit', exited); owned.off('error', failed); error ? reject(error) : resolve() }
          const message = value => { if (value?.type === 'nova.phone.ready') { ready = true; done() } }
          const exited = () => done(new Error('service_unavailable'))
          const failed = () => done(new Error('service_unavailable'))
          owned.on('message', message)
          owned.once('error', failed)
          owned.once('exit', exited)
          owned.once('exit', () => { if (child === owned) { child = undefined; ready = false } })
        })
      })().catch(async error => {
        if (child) await shutdown(child)
        child = undefined; ready = false
        throw error
      }).finally(() => { pending = undefined })
      return pending
    },
    stop() {
      if (closing) return closing
      closing = (async () => {
        // Wait for ownership of a launching child before requesting its shutdown.
        if (!child && pending) await pending.catch(() => {})
        if (child) await shutdown(child)
        await pending?.catch(() => {})
        child = undefined; ready = false
      })().finally(() => { closing = undefined })
      return closing
    },
  }
}

export function requestPhonePairing(config, frame, Socket = WebSocket) {
  return new Promise((resolve, reject) => {
    const socket = new Socket(`ws://127.0.0.1:${config.port}/client/pair-admin`)
    const timer = setTimeout(() => finish(new Error('service_unavailable')), 5000)
    const finish = (error, value) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value) }
    socket.addEventListener('open', () => socket.send(JSON.stringify({...frame, token: config.token})), {once: true})
    socket.addEventListener('error', () => finish(new Error('service_unavailable')), {once: true})
    socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 16384) throw new Error()
        const value = JSON.parse(event.data)
        if (!['nova.pair', 'pair.devices'].includes(value.type)) throw new Error()
        finish(null, value)
      } catch { finish(new Error('pairing_unavailable')) }
    }, {once: true})
  })
}

export async function renderPhoneQr(scriptPath, payload) {
  // Only the single-use code is rendered; the host credential never leaves main.
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/swift', [scriptPath, '--render-qr'], {timeout: 20000, maxBuffer: 512 * 1024}, (error, stdout) => {
      if (error || !/^[A-Za-z0-9+/=]+$/.test(stdout)) reject(new Error('qr_unavailable'))
      else resolve(`data:image/png;base64,${stdout}`)
    })
    child.stdin.on('error', () => reject(new Error('qr_unavailable')))
    child.stdin.end(JSON.stringify(payload))
  })
}
