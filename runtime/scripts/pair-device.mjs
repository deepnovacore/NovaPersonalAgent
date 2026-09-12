/** Pair an existing runtime; host credentials stay on the loopback connection. */
import {spawn} from 'node:child_process'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'

// An SSH hangup delivers SIGHUP; unhandled it would exit before the invitation is cancelled.
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
import QRCode from 'qrcode'
import {WebSocket} from 'ws'
import {loadServerConfig} from '../dist/src/server-config.js'
import {pairingEndpoint} from '../dist/src/client-pairing.js'

function request(config, frame) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${config.port}/client/pair-admin`, {maxPayload: 65536})
    const timer = setTimeout(() => finish(), 5000)
    let finished = false
    function finish(value) {
      if (finished) return
      finished = true; clearTimeout(timer); socket.terminate()
      value ? resolve(value) : reject(new Error('配对请求失败，请检查服务、认证配置和设备数量。'))
    }
    socket.on('error', () => finish())
    socket.on('close', () => finish())
    socket.on('open', () => socket.send(JSON.stringify({...frame, token: config.token})))
    socket.on('message', (bytes, binary) => {
      try {
        const value = JSON.parse(String(bytes))
        if (binary || !['nova.pair', 'pair.devices'].includes(value.type)) throw new Error()
        finish(value)
      } catch { finish() }
    })
  })
}

export async function terminalQr(payload) {
  // Byte mode keeps preflight dimensions identical for every random pairing code.
  const data = [{data: JSON.stringify(payload), mode: 'byte'}]
  const options = {type: 'terminal', small: true, errorCorrectionLevel: 'M'}
  const width = QRCode.create(data, options).modules.size + 8
  const white = '\x1b[47m', reset = '\x1b[0m'
  const border = white + ' '.repeat(width) + reset + '\n'
  // qrcode's compact renderer has a one-module margin; extend it to four.
  const rows = (await QRCode.toString(data, options)).split('\n').slice(0, -1)
  return {width, text: border.repeat(2) + rows.map(row => white + '   ' + row + white + '   ' + reset + '\n').join('') + border.repeat(2)}
}

export async function terminalPair(config, {input = process.stdin, output = process.stdout, events = process} = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('请在交互终端运行配对命令；SSH 请使用 -t，不要重定向输出。')
  const server = pairingEndpoint(config.server)
  const template = {type: 'nova.pair', version: 1, server, code: 'a'.repeat(32)}
  const preview = await terminalQr(template)
  if (!Number.isInteger(output.columns) || output.columns <= preview.width) {
    throw new Error(`终端太窄，请扩展到至少 ${preview.width + 1} 列后重试。`)
  }
  const stop = new AbortController()
  const cancel = () => stop.abort()
  for (const event of SIGNALS) events.on(event, cancel)
  for (const event of ['end', 'close']) input.on(event, cancel)
  input.resume()
  let code
  try {
    const payload = await request(config, {type: 'pair.create', server})
    if (payload.type !== 'nova.pair' || payload.version !== 1 || payload.server !== server
      || typeof payload.code !== 'string' || !/^[a-f0-9]{32}$/.test(payload.code)) throw new Error('主机返回的配对信息无效。')
    code = payload.code
    if (stop.signal.aborted) return
    const qr = await terminalQr({...template, code})
    if (stop.signal.aborted) return
    output.write(`使用 iPhone Nova 扫码连接：${server}\n${qr.text}仅可使用一次。Ctrl+C 取消配对；重新运行此命令可生成新码。\n`)
    while (!stop.signal.aborted) {
      await delay(3000, undefined, {signal: stop.signal}).catch(() => {})
      if (stop.signal.aborted) break
      const status = await request(config, {type: 'pair.list', code})
      if (status.type !== 'pair.devices' || typeof status.pairing_active !== 'boolean') throw new Error('主机返回的配对状态无效。')
      if (!status.pairing_active) { output.write('二维码已使用或失效。\n'); break }
    }
  } finally {
    if (code) {
      await request(config, {type: 'pair.cancel', code}).catch(() => {
        output.write('无法确认配对码已取消；请恢复服务后重新生成二维码或重启服务，使旧码失效。\n')
      })
    }
    input.pause()
    for (const event of SIGNALS) events.off(event, cancel)
    for (const event of ['end', 'close']) input.off(event, cancel)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const window = args[0] === '--window'
  if (window) args.shift()
  if (args.length !== 1 || args[0].startsWith('-')) throw new Error('用法：npm run server:pair --workspace @nova-audio-agent/runtime -- [--window] wss://你的主机')
  if (window && process.platform !== 'darwin') throw new Error('--window 仅支持 macOS；请使用默认终端模式。')
  let config
  try { config = {...loadServerConfig(), server: pairingEndpoint(args[0])} }
  catch { throw new Error('无法读取主机配置：请检查 SERVER_PORT、私有 SERVER_TOKEN_FILE 和 wss:// 地址；仅支持 macOS/Linux。') }
  if (!window) return terminalPair(config)
  const child = spawn('/usr/bin/swift', [fileURLToPath(new URL('./pair-device.swift', import.meta.url))], {stdio: ['pipe', 'inherit', 'inherit']})
  child.stdin.on('error', () => {})
  child.stdin.end(JSON.stringify(config))
  child.on('error', () => { console.error('无法打开配对窗口，请确认已安装 Xcode Command Line Tools。'); process.exitCode = 1 })
  child.on('exit', code => { process.exitCode = code ?? 1 })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
