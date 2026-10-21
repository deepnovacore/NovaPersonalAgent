import {spawnSync} from 'node:child_process'
import {homedir, tmpdir} from 'node:os'
import {posix, win32} from 'node:path'

const OUTPUT_LIMIT = 64 * 1024

export function candidateScratchParent({
  platform = process.platform,
  home = homedir(),
  temporary = tmpdir(),
} = {}) {
  const parent = platform === 'win32' ? home : temporary
  const pathApi = platform === 'win32' ? win32 : posix
  if (typeof parent !== 'string' || !pathApi.isAbsolute(parent)) {
    throw new Error('installed_candidate_invalid')
  }
  return pathApi.resolve(parent)
}

export function prepareWindowsSmokeHomeOwnership({
  platform = process.platform,
  home,
  environment,
  run = spawnSync,
}) {
  if (platform !== 'win32') return
  const systemRoot = environment?.SystemRoot ?? environment?.WINDIR
  if (typeof home !== 'string' || !win32.isAbsolute(home)
    || typeof systemRoot !== 'string' || !win32.isAbsolute(systemRoot)) {
    throw new Error('installed_candidate_invalid')
  }
  const options = {
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
  const identity = run(win32.join(systemRoot, 'System32', 'whoami.exe'), [
    '/user', '/fo', 'csv', '/nh',
  ], options)
  const match = typeof identity?.stdout === 'string'
    ? /^"[^"\r\n]{1,256}","(S-1-(?:[0-9]+-){1,15}[0-9]+)"\r?\n?$/u.exec(identity.stdout)
    : null
  if (identity?.status !== 0 || identity?.error !== undefined || identity?.signal !== null
    || match === null) throw new Error('installed_candidate_invalid')
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  // Use the framework directly: a PowerShell 7 parent can pass a PSModulePath that prevents
  // Windows PowerShell 5 from loading Get-Acl's security module.
  const script = `$ErrorActionPreference = 'Stop'; $path = '${home.replaceAll("'", "''")}'; $section = [System.Security.AccessControl.AccessControlSections]::Owner; if ([System.IO.Directory]::Exists($path)) { $acl = [System.IO.Directory]::GetAccessControl($path, $section) } else { $acl = [System.IO.File]::GetAccessControl($path, $section) }; $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value`
  const readOwner = () => {
    const result = run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], options)
    if (result?.status !== 0 || result?.error !== undefined || result?.signal !== null
      || typeof result.stdout !== 'string' || !/^S-1-(?:[0-9]+-){1,15}[0-9]+$/u.test(result.stdout.trim())) throw new Error('installed_candidate_invalid')
    return result.stdout.trim()
  }
  // Ordinary users can own a fixture without holding WRITE_OWNER. Do not request an unnecessary
  // ownership change; still verify the actual SID rather than treating access denied as success.
  if (readOwner() === match[1]) return
  const ownership = run(win32.join(systemRoot, 'System32', 'icacls.exe'), [
    home, '/setowner', `*${match[1]}`, '/Q',
  ], options)
  if (ownership?.status !== 0 || ownership?.error !== undefined || ownership?.signal !== null
    || readOwner() !== match[1]) {
    throw new Error('installed_candidate_invalid')
  }
}
