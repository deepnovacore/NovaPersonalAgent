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
  assert.equal(result.length,3);assert.equal(result[0].id,old.id);assert.equal(result[2],current)
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
 assert.equal(shared.length,4);assert.equal(a.length,5);assert.equal(a[1].id,b[1].id);assert.deepEqual(a[0],b[0]);
 assert.equal(run('aborted',[old,current]).length,3);
 assert.equal(dshContext({seq:1,eventAt:()=>({type:'turn/end'}),deriveMessages:()=>shared}).length,4);
})

const bundleFixture=`function transform(transformed){const result=[];for(let i=0;i<transformed.length;i++){const assistantMsg=transformed[i];if(assistantMsg.stopReason==="error"||assistantMsg.stopReason==="aborted")continue;result.push(assistantMsg)}return result}`;
test('Pi production bundle inserts the same boundary and preserves successful retry history',()=>{
 const transform=new Function(`${patchRecoverySource('@earendil-works/pi-coding-agent',bundleFixture)};return transform`)();
 const failed={role:'assistant',stopReason:'error',content:[]},next={role:'user',content:[]};
 assert.equal(transform([failed,next])[0].content[0].text,RECOVERY_STATUS);
 assert.deepEqual(transform([failed]),[]);
 const success={role:'assistant',stopReason:'stop',content:[]};
 assert.deepEqual(transform([failed,success,next]),[success,next]);
});

test('Failed Pi request becomes historical reference only, while current request and original log stay intact',()=>{
 const old={role:'user',content:[{type:'text',text:'old per-turn instruction'}]};
 const error={role:'assistant',stopReason:'error',content:[]},current={role:'user',content:[{type:'text',text:'new task'}]};
 const transform=new Function(`${patchRecoverySource('@earendil-works/pi-coding-agent',bundleFixture)};return transform`)();
 const result=transform([old,error,current]);
 assert(result[0].content[0].text.startsWith('Historical input from a failed turn'));
 assert(result[0].content[0].text.includes('old per-turn instruction'));
 assert.equal(old.content[0].text,'old per-turn instruction');
 assert.deepEqual(result.at(-1),current);
});

test('Actual installed Pi CLI bundle archives failed input and retains images and successful context', {skip:!process.env.ACP_RECOVERY_PI_ROOT},async()=>{
 const {pathToFileURL}=await import('node:url'),{join}=await import('node:path')
 const {transformMessages}=await import(pathToFileURL(join(process.env.ACP_RECOVERY_PI_ROOT,'dist/bundle/chunks/chunk-Y4NYF362.js')).href)
 const model={input:['text','image'],provider:'deepseek',api:'openai-completions',id:'deepseek-v4-pro'}
 const image={type:'image',data:'aGVsbG8=',mimeType:'image/png'}
 const old={role:'user',content:[{type:'text',text:'earlier instruction'},image]}
 const error={role:'assistant',content:[],stopReason:'error',provider:model.provider,api:model.api,model:model.id}
 const current={role:'user',content:[{type:'text',text:'retry previous request'}]}
 const result=transformMessages([old,error,current],model)
 assert(result[0].content[0].text.startsWith('Historical input from a failed turn'))
 assert.deepEqual(result[0].content[1],image);assert.deepEqual(result.at(-1),current)
 assert.equal(old.content[0].text,'earlier instruction')
 const stringInput={role:'user',content:'earlier string instruction'}
 assert(transformMessages([stringInput,error,current],model)[0].content[0].text.includes('earlier string instruction'))
 assert.equal(stringInput.content,'earlier string instruction')
 assert.deepEqual(transformMessages([old,error],model),[old])
 const success={...error,stopReason:'stop',content:[{type:'text',text:'done'}]}
 assert.equal(transformMessages([old,error,success,current],model)[0].content[0].text,'earlier instruction')
})

test('DeepSeek failure boundaries cross native instruction and runtime-context user messages',()=>{
 const old=user('old'),current=user('new');
 const instructions={role:'user',id:'policy',source:{kind:'agent-instructions'},content:[{type:'text',text:'keep project constraints'}]};
 const runtime={role:'user',id:'runtime',source:{kind:'runtime-context'},content:[{type:'text',text:'policy snapshot'}]};
 const result=run('error',[old,instructions,runtime,current]);
 assert.equal(result.length,5);assert(result[0].content[0].text.startsWith('Historical input from a failed turn'));
 assert.equal(result[1],instructions);assert.equal(result[2],runtime);assert.equal(result[3].source.kind,'runtime-recovery-status');assert.equal(result[4],current);
})
