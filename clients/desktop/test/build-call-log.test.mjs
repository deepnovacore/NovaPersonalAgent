import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createBuildCallLog} from '../src/renderer/build-call-log.mjs'

class Element{
 constructor(tag,text){this.tag=tag;this.textContent=text;this.children=[];this.dataset={};this.listeners={};this.hidden=false;this.open=false}
 append(...nodes){this.children.push(...nodes)}
 replaceChildren(...nodes){this.children=nodes}
 addEventListener(event,callback){this.listeners[event]=callback}
}
const el=(tag,text)=>new Element(tag,text),tick=()=>new Promise(resolve=>setImmediate(resolve))
const call=(sequence,status='completed')=>({sequence,id:'call-'+sequence,message_id:'user',name:'file_read',state:status==='completed'?'completed':status,status,target:'src/中文.txt',input:'{"path":"src/中文.txt"}',output:status==='completed'?'actual contents':'',exit_code:null,input_truncated:false,output_truncated:false,started_at:new Date().toISOString(),finished_at:status==='completed'?new Date().toISOString():null})

test('Build log refreshes the active tail and preserves native expansion and completed row identity',async()=>{
 let records=[call(0),call(1,'running')],changes=0
 const requests=[],conversation={id:'build',kind:'build',generation:0,build:{log_revision:1,status:'running'}}
 const c={selectedId:'build',selectedConversation:conversation,connected:true,command:async(method,params)=>{requests.push([method,params]);return {generation:0,items:records.slice(params.offset),total:records.length,next_offset:null}}}
 const log=createBuildCallLog({c,el,changed:()=>{changes++}})
 log.update();await tick()
 const [group]=log.forMessage('user'),rows=group.children[0].children[1],[first,active]=rows.children;first.children[0].open=true
 assert.equal(active.dataset.toolStatus,'running');assert.ok(changes>0)
 records=[records[0],{...call(1),status:'failed',exit_code:7,output:'stderr: 检查失败',output_truncated:true}]
 conversation.build={log_revision:2,status:'completed'};log.update();await tick()
 const [same]=log.forMessage('user'),[sameFirst,finished]=rows.children
 assert.equal(same,group);assert.equal(same.children[0].open,true);assert.equal(sameFirst,first);assert.equal(sameFirst.children[0].open,true);assert.equal(finished,active)
 assert.equal(finished.dataset.toolStatus,'failed');assert.match(finished.children[0].children[0].children[3].textContent,/退出码 7/)
 assert.equal(finished.children[0].children[1].children.at(-1).hidden,false)
 assert.deepEqual(requests.map(([,params])=>params.offset),[0,1])
 assert.equal(log.forMessage('other').length,0);assert.equal(log.remaining(new Set(['user'])).length,0)
})

test('Build log recovers persisted pages and discards replies from a previously selected conversation',async()=>{
 let release
 const c={selectedId:'old',selectedConversation:{id:'old',kind:'build',generation:0,build:{log_revision:3,status:'paused'}},connected:true,command:()=>new Promise(resolve=>{release=resolve})}
 const log=createBuildCallLog({c,el,changed:()=>{}});log.update()
 c.selectedId='chat';c.selectedConversation={id:'chat',kind:'chat'};log.update()
 release({generation:0,items:[call(0)],total:1,next_offset:null});await tick()
 assert.equal(log.forMessage('user').length,0)
 const offsets=[]
 c.command=async(_method,params)=>{offsets.push(params.offset);return {generation:0,items:[call(params.offset)],total:2,next_offset:params.offset===0?1:null}}
 c.selectedId='new';c.selectedConversation={id:'new',kind:'build',generation:0,build:{log_revision:4,status:'paused'}};log.update();await tick()
 assert.equal(log.forMessage('user').length,1);assert.equal(log.forMessage('user')[0].children[0].children[1].children.length,2);assert.deepEqual(offsets,[0,1])
})

test('Build log offers retry on read failure without turning the build into a failed response',async()=>{
 let attempts=0
 const c={selectedId:'build',selectedConversation:{id:'build',kind:'build',generation:0,build:{log_revision:1,status:'paused'}},connected:true,command:async()=>{attempts++;if(attempts===1)throw Error('disconnected');return {generation:0,items:[call(0)],total:1,next_offset:null}}}
 const log=createBuildCallLog({c,el,changed:()=>{}});log.update();await tick();log.update();await tick()
 assert.equal(attempts,1)
 const notice=log.remaining(new Set())[0];assert.match(notice.children[0].textContent,/日志暂不可用/)
 notice.children[1].listeners.click();await tick()
 assert.equal(attempts,2);assert.equal(log.forMessage('user').length,1)
 assert.equal(c.selectedConversation.build.status,'paused')
})

test('retry after a later page fails starts at the first missing call',async()=>{
 let fail=true
 const offsets=[],c={selectedId:'build',selectedConversation:{id:'build',kind:'build',generation:0,build:{log_revision:1,status:'paused'}},connected:true,command:async(_method,params)=>{
  offsets.push(params.offset)
  if(params.offset===1&&fail){fail=false;throw Error('read interrupted')}
  return {generation:0,items:[call(params.offset)],total:2,next_offset:params.offset===0?1:null}
 }}
 const log=createBuildCallLog({c,el,changed:()=>{}});log.update();await tick()
 assert.equal(log.forMessage('user').length,1)
 const notice=log.remaining(new Set(['user']))[0];notice.children[1].listeners.click();await tick()
 assert.deepEqual(offsets,[0,1,1]);assert.equal(log.forMessage('user').length,1);assert.equal(log.forMessage('user')[0].children[0].children[1].children.length,2)
})
