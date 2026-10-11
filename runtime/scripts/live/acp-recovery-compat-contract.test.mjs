import assert from 'node:assert/strict'
import {test} from 'node:test'
import {patchRecoverySource,RECOVERY_STATUS} from '../patch-acp-recovery.mjs'

const piSource=`function transform(messages) {const result=[],transformed=messages;for(let i=0;i<transformed.length;i++){const assistantMsg=transformed[i];
            if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
                continue;
            }
 result.push(assistantMsg)}return result}`
const piTransform=new Function(`${patchRecoverySource('@earendil-works/pi-ai',piSource)};return transform`)()
test('Pi keeps an explicit runtime failure boundary without replaying partial content or credentials',()=>{
  const original={role:'assistant',content:[{type:'thinking',thinking:'partial-secret'}],stopReason:'error',errorMessage:'private-token'}
  const result=piTransform([original,{role:'user',content:[]}])[0]
  assert.deepEqual(result.content,[{type:'text',text:RECOVERY_STATUS}])
  assert.equal(JSON.stringify(result).includes('private-token'),false)
  assert.equal(JSON.stringify(result).includes('partial-secret'),false)
  assert.equal(original.stopReason,'error')
  assert.deepEqual(piTransform([original,{role:'assistant',stopReason:'stop',content:[]},{role:'user',content:[]}]).map(x=>x.role),['assistant','user'])
  assert.equal(piTransform([original,original,{role:'user',content:[]}]).length,2)
  assert.deepEqual(piTransform([original]),[]) // Automatic retry must retain the original last-valid state.
  assert.equal(piTransform([{role:'assistant',stopReason:'stop',content:[]}])[0].stopReason,'stop')
})
const dshSource=`function context(session){
\t\tconst boundaryMessages = session.deriveMessages();
 return boundaryMessages}`
const dshContext=new Function('randomUUID',`${patchRecoverySource('@deepseek-ai/dsh-agent-loop',dshSource)};return context`)(()=> 'runtime-boundary')
const user=text=>({id:text,role:'user',source:{kind:'user'},content:[{type:'text',text}]})
const run=(kind,messages)=>dshContext({seq:2,eventAt:seq=>seq===0?{type:'user/message',data:messages[0]}:{type:'turn/end',data:{reason:{kind}}},deriveMessages:()=>[...messages]})
test('DeepSeek separates a failed no-reply request from the current user message, preserving history',()=>{
  const old=user('old'),current=user('new'),messages=[old,current]
  const result=run('error',messages)
  assert.equal(result.length,3);assert.equal(result[0],old);assert.equal(result[2],current)
  assert.equal(result[1].source.kind,'runtime-recovery-status')
  assert.equal(messages.length,2)
  assert.equal(run('completed',messages).length,2)
  assert.equal(run('error',[old,{role:'assistant',content:[]},current]).length,3)
})

test('DeepSeek retains the historical boundary after later success, uses stable ids and supports interruption',()=>{
 const old=user('old'),current=user('new'),later=user('later'),answer={role:'assistant',content:[]};
 const events=[{type:'user/message',data:old},{type:'turn/end',data:{reason:{kind:'error'}}},{type:'user/message',data:current},{type:'turn/end',data:{reason:{kind:'completed'}}}];
 const shared=[old,current,answer,later];
 const session={seq:events.length,eventAt:i=>events[i],deriveMessages:()=>shared};
 const a=dshContext(session),b=dshContext(session);
 assert.equal(shared.length,4);assert.equal(a.length,5);assert.equal(a[1].id,b[1].id);
 assert.equal(run('aborted',[old,current]).length,3);
 assert.equal(dshContext({seq:1,eventAt:()=>({type:'turn/end'}),deriveMessages:()=>shared}).length,4);
})
