import assert from 'node:assert/strict'
import {test} from 'node:test'
import recoveryPlugin from '../opencode-recovery.mjs'
const transform = (await recoveryPlugin())['experimental.chat.messages.transform']
const user = id => ({info:{role:'user',id},parts:[{type:'text',text:`request ${id}`},{type:'file',url:'image-reference'},{type:'text',text:'project policy',synthetic:true},{type:'text',text:'ignored text',ignored:true}]})
const response = (parentID,error) => ({info:{role:'assistant',parentID,...(error?{error:{name:'APIError'}}:{})},parts:[]})
test('OpenCode archives failed-turn text in the input view, preserving current input, attachments and native history',async()=>{
 const old=user('old'),current=user('current'),messages=[old,response('old',true),current];
 const output={messages:[...messages]};await transform({},output);
 assert(output.messages[0].parts[0].text.startsWith('Historical input from a failed turn'));
 assert.equal(old.parts[0].text,'request old');assert.equal(output.messages[0].parts[1],old.parts[1]);
 assert.equal(output.messages[0].parts[2],old.parts[2]);assert.equal(output.messages[0].parts[3],old.parts[3]);
 assert.equal(output.messages[2],current);const once=structuredClone(output);await transform({},output);assert.deepEqual(output,once);
});
test('OpenCode does not alter pending or successfully recovered requests',async()=>{
 for(const messages of [[user('old'),response('old',true)],[user('old'),response('old',true),response('old',false),user('new')],[user('old'),response('other',true),user('new')]]) {
  const original=structuredClone(messages),output={messages};await transform({},output);assert.deepEqual(output.messages,original);
 }
});

test('Installer is idempotent and refuses to overwrite a different user plugin', {skip:process.platform==='win32'}, async()=>{
 const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises')
 const {join}=await import('node:path'),{tmpdir}=await import('node:os')
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util')
 const root=await mkdtemp(join(tmpdir(),'nova-recovery-install-')),bin=join(root,'bin'),config=join(root,'config')
 try {
  await mkdir(bin);await writeFile(join(bin,'opencode'),"#!/bin/sh\nprintf '1.19.0\\n'\n",{mode:0o700})
  const run=()=>promisify(execFile)(process.execPath,[new URL('../install-opencode-recovery.mjs',import.meta.url).pathname,config],{env:{...process.env,PATH:bin+':'+process.env.PATH}})
  assert.equal(JSON.parse((await run()).stdout).changed,true);assert.equal(JSON.parse((await run()).stdout).changed,false)
  const target=join(config,'plugins/nova-acp-failure-recovery.js')
  const current=await readFile(target,'utf8'),previous=current.replace(" && !part.synthetic && !part.ignored",'')
  await writeFile(target,previous);assert.equal(JSON.parse((await run()).stdout).changed,true)
  assert.equal(await readFile(target,'utf8'),current)
  await writeFile(target,'user modification')
  await assert.rejects(run());assert.equal(await readFile(target,'utf8'),'user modification')
 } finally {await rm(root,{recursive:true,force:true})}
})
