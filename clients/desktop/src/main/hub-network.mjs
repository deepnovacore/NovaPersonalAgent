import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {existsSync} from 'node:fs'
const exec = promisify(execFile)
const record = value => value && typeof value === 'object' && !Array.isArray(value)

export function inspectHubNetwork(status, serve, port = 8787) {
  if (!record(status) || !record(serve)) return {state:'unavailable'}
  if (status.BackendState !== 'Running') return {state:'needs_login'}
  const host = status.Self?.DNSName?.replace(/\.$/, '')
  if (!host || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/i.test(host)) return {state:'needs_login'}
  for (const key of ['TCP','Web','AllowFunnel']) if (serve[key] !== undefined && !record(serve[key])) return {state:'unavailable'}
  if (Object.entries(serve.AllowFunnel ?? {}).some(([key, value]) => key.endsWith(':8443') && value)) return {state:'public_endpoint'}
  const web = Object.entries(serve.Web ?? {}).filter(([key]) => key.endsWith(':8443'))
  if (!serve.TCP?.['8443'] && !web.length) return {state:'needs_serve'}
  if (serve.TCP?.['8443']?.HTTPS !== true || web.length !== 1 || web[0][0] !== `${host}:8443`) return {state:'conflict'}
  const handlers = web[0][1]?.Handlers
  if (!record(handlers) || Object.keys(handlers).length !== 1 || handlers['/']?.Proxy !== `http://127.0.0.1:${port}`) return {state:'conflict'}
  return {state:'ready', url:`https://${host}:8443`}
}

export function createHubNetwork({run, binary, port = 8787} = {}) {
  const locate = () => binary ?? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale','/opt/homebrew/bin/tailscale','/usr/local/bin/tailscale'].find(existsSync)
  return async (action = 'status') => {
    const executable = locate()
    if (!executable) return {state:'not_installed'}
    const command = run ?? (args => exec(executable, args, {env:{...process.env,TAILSCALE_BE_CLI:'1'},timeout:15000,maxBuffer:1024*1024}))
    try {
      const status = JSON.parse((await command(['status','--json'])).stdout)
      const serve = JSON.parse((await command(['serve','status','--json'])).stdout)
      const result = inspectHubNetwork(status, serve, port)
      if (action === 'configure' && result.state === 'needs_serve') {
        await command(['serve','--bg','--https=8443',`http://127.0.0.1:${port}`])
        const checked = inspectHubNetwork(status, JSON.parse((await command(['serve','status','--json'])).stdout), port)
        return {...checked,created:checked.state === 'ready'}
      }
      if (action === 'remove') {
        if (result.state !== 'ready') return result
        await command(['serve','--bg','--https=8443',`http://127.0.0.1:${port}`,'off'])
        return {state:'needs_serve',removed:true}
      }
      return result
    } catch { return {state:'unavailable'} }
  }
}
