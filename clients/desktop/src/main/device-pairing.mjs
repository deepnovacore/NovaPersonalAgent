import {spawn} from 'node:child_process'

// Reuse the Mac pairing window; credentials never enter argv or diagnostics.
export function launchDevicePairing({config, scriptPath, spawnProcess = spawn}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('/usr/bin/swift', [scriptPath], {stdio: ['pipe', 'ignore', 'ignore']})
    const failed = () => reject(new Error('pairing window failed'))
    child.on('error', failed)
    child.stdin.on('error', failed)
    child.on('exit', code => code === 0 ? resolve() : failed())
    child.stdin.end(JSON.stringify({port: config.port, token: config.token, server: config.server ?? ''}))
  })
}
