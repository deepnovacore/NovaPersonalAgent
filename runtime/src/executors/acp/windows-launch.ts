import {createHash} from 'node:crypto'
import {readFileSync, realpathSync, statSync} from 'node:fs'
import {basename, dirname, isAbsolute, join, relative, sep} from 'node:path'
import type {AcpBackendDefinition} from './backends.js'

const ENTRIES = {opencode: 'bin/opencode.exe', codebuddy: 'bin/codebuddy', pi: 'dist/index.js', deepseek: 'lib/bin.js'} as const

function regular(path: string): string {
  const canonical=realpathSync(path)
  if(!statSync(canonical).isFile()) throw new Error('Windows ACP executable is not a regular file')
  return canonical
}

/** Resolve host-installed npm launchers without executing cmd.exe or accepting script-selected argv. */
export function resolveWindowsAcpLaunch(backend: AcpBackendDefinition, configured: string|undefined, args: readonly string[], env: NodeJS.ProcessEnv): {command:string;args:readonly string[]} {
  const directories=[...(env.PATH??env.Path??'').split(';'), ...(env.APPDATA?[join(env.APPDATA,'npm')]:[])].filter(isAbsolute)
  let candidate=configured
  if(candidate===undefined){
    for(const directory of directories){
      for(const suffix of ['.exe','.cmd']){
        try{candidate=regular(join(directory,backend.command+suffix));break}catch{/* Try the next installed launcher. */}
      }
      if(candidate!==undefined) break
    }
  }
  if(candidate===undefined || !isAbsolute(candidate)) throw new Error('Windows ACP executable not found')
  candidate=regular(candidate)
  if(candidate.toLowerCase().endsWith('.exe')) return {command:candidate,args}
  if(basename(candidate).toLowerCase()!==`${backend.command}.cmd`) throw new Error('Unsupported Windows ACP launcher')
  const packageRoot=realpathSync(join(dirname(candidate),'node_modules',backend.packageName))
  const manifest=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8')) as {name?:unknown;bin?:unknown}
  const expected=ENTRIES[backend.id]
  const bin=typeof manifest.bin==='string'?manifest.bin:(manifest.bin as Record<string,unknown>|undefined)?.[backend.command]
  const declared=typeof bin==='string'?bin.replace(/^\.\//u,''):null
  // OpenCode postinstall replaces its npm script with a native Windows executable.
  if(manifest.name!==backend.packageName || (declared!==expected && !(backend.id==='opencode' && declared==='bin/opencode'))) throw new Error('Unverified Windows ACP package entry')
  const entry=regular(join(packageRoot,expected)), within=relative(packageRoot,entry)
  if(within==='' || within==='..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Windows ACP entry escapes its package')
  if(backend.id==='opencode') return {command:entry,args}
  for(const directory of directories){
    try{return {command:regular(join(directory,'node.exe')),args:[entry,...args]}}catch{/* Try the next installed Node executable. */}
  }
  throw new Error('Windows ACP npm launcher requires native Node')
}

/** Refuse silent regression after npm reinstalls replace the Windows recovery patch. */
export function verifyWindowsCodebuddyRecovery(entry: string): void {
  if (!isAbsolute(entry) || !entry.endsWith('codebuddy')) throw new Error('Windows CodeBuddy requires the verified npm ACP entry')
  const root = dirname(dirname(entry))
  const meta = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {name?: unknown; version?: unknown}
  const source = readFileSync(join(root, 'dist/codebuddy-headless.js'))
  if (meta.name !== '@tencent-ai/codebuddy-code' || meta.version !== '2.164.0'
    || createHash('sha256').update(source).digest('hex') !== 'd1eddce5d8293bf37ca99dc231dda6313c1e5ea70e94f80bfadd2227285a5b85') {
    throw new Error('Reapply the Windows CodeBuddy recovery patch after reinstalling or upgrading')
  }
}
