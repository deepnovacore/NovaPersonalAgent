import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readFile,writeFile,rename,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {FAILED_REFERENCE_PREFIX,RECOVERY_STATUS} from './patch-acp-recovery.mjs'

// shortcut: npm reinstalls overwrite this version-pinned patch; reapply after upgrades.
const ORIGINAL_SHA256='f9affe2aed036a3a3ee8486b82e77b176a2a4b21f7bed721074c1c1e4a312e65'
const BEFORE='eA.input=HistoryUtils.filterApiErrorMessages(eA.input)'
const AFTER='eA.input=process.platform==="win32"&&process.argv.includes("--acp")?novaWindowsCodeBuddyRecovery(eA.input):eA.input,'+BEFORE

/** Provider-input copies only: native error records must be inspected before upstream removes them. */
export function codebuddyRecoveryInput(input,reference,status) {
  const realUser=item=>item?.type==='message'&&item.role==='user'&&!item.providerData?.skipRun&&!item.providerData?.isMeta&&!item.providerData?.isCompactInternal&&item.providerData?.startsNewUserRequest!==false&&item.providerData?.agent!=='compact'
  let output=input,prior=-1
  for(let current=0;current<input.length;current++){
    if(!realUser(input[current])) continue
    if(prior>=0){
      const turn=input.slice(prior+1,current)
      const failed=turn.some(item=>item.type==='message'&&item.role==='assistant'&&item.providerData?.error)
      const progress=turn.some(item=>item.type==='function_call'||item.type==='function_call_output'||item.type==='function_call_result'||(item.type==='message'&&item.role==='assistant'&&!item.providerData?.error&&(typeof item.content==='string'?item.content.trim().length>0:Array.isArray(item.content)&&item.content.some(block=>block.type!=='output_text'||(typeof block.text==='string'&&block.text.trim().length>0)))))
      if(failed&&!progress){
        if(output===input) output=input.slice()
        const user=input[prior]
        const quote=text=>text.startsWith(reference)?text:reference+JSON.stringify(text)
        output[prior]={...user,content:typeof user.content==='string'?quote(user.content):user.content.map(block=>block.type==='input_text'?{...block,text:quote(block.text)}:block)}
      }
    }
    prior=current
  }
  if(output===input) return input
  const result=[]
  for(let i=0;i<output.length;i++){
    result.push(output[i])
    if(output[i]!==input[i]&&realUser(input[i])&&output[i].content!==input[i].content){
      result.push({id:input[i].id+':nova-recovery-status',type:'message',role:'assistant',content:[{type:'output_text',text:status}],providerData:{novaRuntimeRecovery:true}})
    }
  }
  return result
}

const HELPER='\nfunction novaWindowsCodeBuddyRecovery(input){return ('+codebuddyRecoveryInput.toString()+')(input,'+JSON.stringify(FAILED_REFERENCE_PREFIX)+','+JSON.stringify(RECOVERY_STATUS)+')}\n'
const LEGACY_HELPER=HELPER.replace("||item.type==='function_call_result'",'').replace("typeof item.content==='string'?item.content.trim().length>0:Array.isArray(item.content)&&item.content.some(block=>block.type!=='output_text'||(typeof block.text==='string'&&block.text.trim().length>0))","typeof item.content==='string'?item.content.length>0:Array.isArray(item.content)&&item.content.length>0")
export function patchCodebuddySource(source){
 assert.equal(source.split(BEFORE).length,2,'Unexpected CodeBuddy history interceptor')
 return source.replace(BEFORE,()=>AFTER)+HELPER
}
export async function patchCodebuddyRecovery(root){
 assert.equal(process.platform,'win32','CodeBuddy recovery patch installs only on Windows')
 const meta=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
 assert(meta.name==='@tencent-ai/codebuddy-code'&&meta.version==='2.164.0','Recheck CodeBuddy recovery before upgrading')
 const path=join(root,'dist/codebuddy-headless.js'),source=await readFile(path,'utf8')
 const original=source.replace(AFTER,()=>BEFORE).replace(HELPER,'').replace(LEGACY_HELPER,'')
 assert.equal(createHash('sha256').update(original).digest('hex'),ORIGINAL_SHA256,'Unexpected CodeBuddy ACP bundle integrity')
 const patched=patchCodebuddySource(original)
 if(patched===source)return {version:meta.version,changed:false}
 const temporary=path+'.nova-'+randomUUID()
 try{await writeFile(temporary,patched,{flag:'wx'});await rename(temporary,path)}finally{await rm(temporary,{force:true})}
 return {version:meta.version,changed:true}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert(process.argv[2],'Usage: patch-codebuddy-recovery.mjs WINDOWS_CODEBUDDY_PACKAGE_ROOT')
 console.log(JSON.stringify(await patchCodebuddyRecovery(resolve(process.argv[2]))))
}
