import {createHash} from 'node:crypto'
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {buildWindowsJobGuardian} from './build-windows-job-guardian.mjs'

/** Build only this runner's guardian; never touch the shared desktop build directory. */
export async function prepareWorkbenchTestResources(outputRoot){
 if(process.platform!=='win32')return null
 await mkdir(outputRoot,{recursive:true});const resources=await realpath(outputRoot)
 const binary=await buildWindowsJobGuardian({packageRoot:resolve(import.meta.dirname,'..'),outputRoot:resources,platform:process.platform,arch:process.arch})
 const bytes=await readFile(binary)
 await writeFile(resolve(resources,'native-resources-v1.json'),JSON.stringify({schema_version:1,target:`win32-${process.arch}`,resources:[{logical_id:'windows_job_guardian',relative_path:'native/windows-job-guardian.exe',byte_size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),kind:'executable',platform:'win32',architecture:process.arch,electron_abi:null,build_contract_version:1}]}))
 return resources
}
