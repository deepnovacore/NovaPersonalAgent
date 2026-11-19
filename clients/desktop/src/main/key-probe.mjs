// Live check for the one or two keys a first run needs. Each probe is a cheap
// authenticated model listing; the key never appears in the result.
const PROBES = Object.freeze({
  dashscopeApiKey: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
  deepseekApiKey: 'https://api.deepseek.com/models',
  arkApiKey: 'https://ark.cn-beijing.volces.com/api/v3/models',
  openaiApiKey: 'https://api.openai.com/v1/models',
  stepfunApiKey: 'https://api.stepfun.com/v1/models',
})
// The Volcengine speech key has no cheap authenticated read; it is checked by the first connection.
const DEFERRED = new Set(['doubaoBigmodelApiKey'])
const PROBE_TIMEOUT_MS = 8_000

/** Keys the settings page can test; others show no test button. */
export function canProbeKey(key) { return Object.hasOwn(PROBES, key) || DEFERRED.has(key) }

const REALTIME_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
const REALTIME_MODEL = 'qwen-audio-3.0-realtime-plus'

/**
 * A DashScope key can list models yet still be refused by the realtime endpoint (another region, no realtime entitlement), so the
 * voice path is checked with the same handshake the runtime performs. Only the HTTP status or a class survives; never the key or URL.
 */
export async function probeDashscopeRealtime(value, {WebSocketImpl, url = REALTIME_URL, model = REALTIME_MODEL, timeoutMs = PROBE_TIMEOUT_MS} = {}) {
  const WebSocket = WebSocketImpl ?? (await import('ws')).default
  return new Promise(resolve => {
    let settled = false
    const socket = new WebSocket(`${url}?model=${encodeURIComponent(model)}`, {headers: {Authorization: `Bearer ${value.trim()}`}, handshakeTimeout: timeoutMs, perMessageDeflate: false})
    const finish = outcome => { if (settled) return; settled = true; try { socket.terminate() } catch { /* already closed */ } resolve(Object.freeze(outcome)) }
    socket.once('open', () => finish({status: 'ok'}))
    socket.once('unexpected-response', (_request, response) => {
      const code = response?.statusCode
      finish(code === 401 ? {status: 'rejected', httpStatus: 401} : code === 403 ? {status: 'forbidden', httpStatus: 403} : {status: 'network', httpStatus: code})
    })
    socket.once('error', error => {
      const match = /^Unexpected server response: (\d{3})$/u.exec(error?.message ?? '')
      if (match) finish(match[1] === '401' ? {status: 'rejected', httpStatus: 401} : match[1] === '403' ? {status: 'forbidden', httpStatus: 403} : {status: 'network', httpStatus: Number(match[1])})
      else finish({status: 'network'})
    })
    setTimeout(() => finish({status: 'network'}), timeoutMs + 500).unref?.()
  })
}

/** The result a settings page shows: the model-list check, and for DashScope also the realtime handshake. */
export async function probeKeyForSettings(key, value, options = {}) {
  const base = await probeApiKey(key, value, options)
  if (key !== 'dashscopeApiKey' || base.status !== 'ok') return base
  const realtime = await probeDashscopeRealtime(value, options)
  return Object.freeze({...base, realtime: realtime.status, ...(realtime.httpStatus ? {realtimeHttpStatus: realtime.httpStatus} : {})})
}

export async function probeApiKey(key, value, {fetch = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS} = {}) {
  if (typeof value !== 'string' || value.trim() === '' || /[\u0000-\u001f\u007f]/u.test(value)) return Object.freeze({status: 'missing'})
  if (DEFERRED.has(key)) return Object.freeze({status: 'deferred'})
  if (!Object.hasOwn(PROBES, key)) return Object.freeze({status: 'unsupported'})
  try {
    const response = await fetch(PROBES[key], {
      headers: {authorization: `Bearer ${value.trim()}`},
      signal: AbortSignal.timeout(timeoutMs),
    })
    await response.body?.cancel().catch(() => {})
    if (response.ok) return Object.freeze({status: 'ok'})
    if (response.status === 401 || response.status === 403) return Object.freeze({status: 'rejected', httpStatus: response.status})
    return Object.freeze({status: 'network', httpStatus: response.status})
  } catch {
    return Object.freeze({status: 'network'})
  }
}
