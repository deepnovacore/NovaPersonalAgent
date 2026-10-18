import {hostContextItemSchema} from '../src/realtime/protocol.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {maySendPreparedMemory,preparedReferenceParts} from '../src/personal-agent/conversation-runtime.js'
import type {PersonalMemoryResource} from '../src/memory/personal-memory.js'

test('prepared topic requires every evidence grant for the actual recipient and fails closed without provenance',async()=>{
 const checked:string[]=[]
 const memory:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:()=>Promise.reject(Error('unused')),canReadConversationEvidence:(id,consumer)=>{checked.push(id+':'+consumer);return Promise.resolve(id==='allowed'&&consumer==='text-model')}}
 assert.equal(await maySendPreparedMemory(memory,'text-model',['allowed']),true)
 assert.equal(await maySendPreparedMemory(memory,'voice-model',['allowed']),false)
 assert.equal(await maySendPreparedMemory(memory,'text-model',['allowed','purged']),false)
 assert.equal(await maySendPreparedMemory(memory,'text-model',[]),false)
 assert.equal(await maySendPreparedMemory(memory,undefined,['allowed']),false)
 assert.equal(await maySendPreparedMemory(undefined,'text-model',['allowed']),false)
 assert.ok(checked.includes('purged:text-model'))
})

test('selected reference fragments preserve quotes, Unicode and every provenance id within the protocol limit',()=>{
 const material={trust:'untrusted_external' as const,text:'原文\n\t\"🪴\\'.repeat(900),evidence_refs:Array.from({length:16},(_,i)=>String(i)+':'+ 'x'.repeat(500))}
 const parts=preparedReferenceParts(material).map(part=>{hostContextItemSchema.parse({kind:'dialogue_context',host_item_id:'part',event_id:'part',content:part,call_id:null});const parsed=JSON.parse(part) as {trust:string;fragment:string};assert.equal(parsed.trust,'untrusted_external');return parsed.fragment})
 assert.ok(parts.length>1)
 assert.deepEqual(JSON.parse(parts.join('')),{text:material.text,evidence_refs:material.evidence_refs})
})
