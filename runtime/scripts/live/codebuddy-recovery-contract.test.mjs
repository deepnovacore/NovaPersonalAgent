import assert from 'node:assert/strict'
import {test} from 'node:test'
import {runInNewContext} from 'node:vm'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {codebuddyRecoveryInput,patchCodebuddySource} from '../patch-codebuddy-recovery.mjs'

const user=(id,text,extra={})=>({id,type:'message',role:'user',content:[{type:'input_text',text}],...extra})
const error={id:'error',type:'message',role:'assistant',status:'incomplete',providerData:{error:{code:401}},content:[{type:'output_text',text:'401 Unauthorized'}]}
const reference='Historical failed input: ',status='Runtime status: no completion'
test('CodeBuddy quotes a failed request before native error filtering, preserving current request, images and native history',()=>{
 const image={type:'input_image',image:'data:image/png;base64,AA=='}
 const first=user('old','Old output-only instruction');first.content.push(image)
 const current=user('new','Create the new file')
 const history=[first,error,current],before=structuredClone(history)
 const result=codebuddyRecoveryInput(history,reference,status)
 assert.deepEqual(history,before)
 assert.equal(result[0].content[0].text,reference+JSON.stringify('Old output-only instruction'))
 assert.equal(result[0].content[1],image)
 assert.equal(result[1].providerData.novaRuntimeRecovery,true)
 assert.equal(result.at(-1).content,current.content)
 assert.equal(result.at(-1).content[0].text,'Create the new file')
 assert.deepEqual(codebuddyRecoveryInput(result,reference,status),result)
})
test('CodeBuddy preserves pending turns, successful retries, tool progress, internal users and string content',()=>{
 const old=user('old','Original task'),next=user('next','Retry the previous request')
 const success={type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]}
 for(const history of [[old,error],[old,error,success,next],[old,{type:'function_call'},error,next],[old,error,user('internal','Reminder',{providerData:{isMeta:true}})]])assert.equal(codebuddyRecoveryInput(history,reference,status),history)
 const placeholder={type:'message',role:'assistant',content:[{type:'output_text',text:'  '}]}
 assert.notEqual(codebuddyRecoveryInput([old,placeholder,error,next],reference,status)[0],old)
 assert.equal(codebuddyRecoveryInput([old,{type:'function_call_result'},error,next],reference,status)[0],old)
 const result=codebuddyRecoveryInput([user('old','',{content:'Task'}),error,next],reference,status)
 assert.equal(result[0].content,reference+JSON.stringify('Task'))
})
test('CodeBuddy bundle projection runs only for Windows ACP and rejects changed interceptor source',()=>{
 const source='eA.input=HistoryUtils.filterApiErrorMessages(eA.input);'
 for(const platform of ['darwin','linux','win32'])for(const argv of [[],['--acp']]){
  const input=[user('old','Task'),error,user('new','New task')]
  const context={eA:{input},process:{platform,argv},HistoryUtils:{filterApiErrorMessages:input=>input}}
  runInNewContext(patchCodebuddySource(source),context)
  assert.equal(context.eA.input!==input,platform==='win32'&&argv.includes('--acp'))
 }
 assert.throws(()=>patchCodebuddySource('changed upstream'),/Unexpected/u)
})
test('macOS daily CodeBuddy bundle remains unpatched', {skip:process.platform!=='darwin'||!process.env.ACP_RECOVERY_CODEBUDDY_ROOT},async()=>{
 const source=await readFile(join(process.env.ACP_RECOVERY_CODEBUDDY_ROOT,'dist/codebuddy-headless.js'),'utf8')
 assert.equal(source.includes('function novaWindowsCodeBuddyRecovery'),false)
})
