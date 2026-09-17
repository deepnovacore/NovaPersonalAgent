import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {chmod} from 'node:fs/promises'
import {resolve} from 'node:path'

export async function generateSmokeCertificate({certificate, privateKey}) {
  const commands = ['openssl']
  if (process.platform === 'win32') commands.push(resolve(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/usr/bin/openssl.exe'))
  let result
  for (const command of commands) {
    result = spawnSync(command, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
      '-subj', '/CN=Nova local smoke', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', privateKey, '-out', certificate], {encoding: 'utf8', timeout: 30_000, windowsHide: true})
    if (result.error?.code !== 'ENOENT') break
  }
  assert.equal(result?.status, 0, 'local smoke TLS certificate generation failed')
  await chmod(privateKey, 0o600)
}
