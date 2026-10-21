import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {executeLocalShell} from '../runtime/dist/src/personal-agent/local-shell.js'
import {loadWindowsGuardianFactoryFromResources} from '../runtime/dist/src/executors/native-process.js'
import {prepareWorkbenchTestResources} from '../clients/desktop/scripts/workbench-test-resources.mjs'

const root = await mkdtemp(join(tmpdir(), 'nova-shell-diagnostic-'))
try {
  const resourcesPath = await prepareWorkbenchTestResources(join(root, 'resources'))
  const native = loadWindowsGuardianFactoryFromResources({resourcesPath, platform: process.platform, arch: process.arch})
  for (const [name, names] of [
    ['minimal', []],
    ['full', null],
    ['program-directories', ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'ALLUSERSPROFILE', 'SystemDrive']],
    ['module-path', ['PSModulePath']],
    ['machine', ['PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS', 'COMPUTERNAME', 'USERNAME', 'USERDOMAIN']],
    ['minimal-again', []],
  ]) {
    const factory = {spawn(spec, control) {
      const environment = names === null ? process.env : {...spec.environment, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => names.some(name => name.toLowerCase() === key.toLowerCase())))}
      return native.spawn({...spec, environment}, control)
    }}
    const started = Date.now()
    const result = await executeLocalShell({command: "[Console]::Out.Write('NOVA_SHELL_READY'); exit 0", cwd: root, timeout: 10}, new AbortController().signal, {factory}).catch(error => ({error: error.code ?? error.name}))
    console.log(JSON.stringify({name, elapsed: Date.now()-started, ...result}))
  }
} finally {await rm(root, {recursive:true, force:true})}
