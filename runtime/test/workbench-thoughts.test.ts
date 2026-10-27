import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash} from 'node:crypto'
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
  MAX_WORKBENCH_THOUGHT_BYTES,
  MAX_WORKBENCH_THOUGHT_CODEPOINTS,
  MAX_WORKBENCH_THOUGHTS,
  WorkbenchStore,
  emptyWorkbenchCheckpoint,
  type WorkbenchCall,
  type WorkbenchCheckpoint,
  type WorkbenchThought,
} from '../src/personal-agent/workbench-store.js'

async function fixture(){const root=await mkdtemp(join(await realpath(tmpdir()),'nova-thoughts-')),store=new WorkbenchStore(root);return {root,store,close:()=>rm(root,{recursive:true,force:true})}}
const checkpointFile=(root:string,id:string,generation:number)=>join(root,'build-'+createHash('sha256').update(id+':'+generation).digest('hex')+'.json')
const thought=(id:string,text:string,created_at:string):WorkbenchThought=>({id,text,created_at})
const call=(id:string,name:string,created_at:string,result?:unknown):WorkbenchCall=>({id,name,arguments:{path:id+'.txt'},state:'completed',created_at,...(result===undefined?{}:{result:result as never})})

test('an old checkpoint without thoughts still loads and defaults the array',async()=>{
 const f=await fixture()
 try{
  const legacy={version:1,conversation_id:'chat:main',generation:0,run_version:0,status:'idle',reason:null,model:null,inputs:[],pending_calls:[],calls:[],last_user:'',assistant:'',updated_at:'2026-01-01T00:00:00.000Z'}
  await writeFile(checkpointFile(f.root,'chat:main',0),JSON.stringify(legacy))
  const loaded=await f.store.checkpoint('chat:main',0)
  assert.deepEqual(loaded.thoughts,[])
  assert.equal(loaded.conversation_id,'chat:main')
  assert.deepEqual((await f.store.checkpoint('chat:main',7)).thoughts,[])
 }finally{await f.close()}
})

test('checkpoints bound thoughts to the newest 64, 8000 codepoints each and 256 KiB total',async()=>{
 const f=await fixture()
 try{
  const thoughts:WorkbenchThought[]=[]
  for(let index=0;index<70;index++)thoughts.push(thought('t-'+index,index===69?'🙂'.repeat(9000):'x'.repeat(8000),new Date(Date.UTC(2026,0,1,0,0,index)).toISOString()))
  const base=emptyWorkbenchCheckpoint('chat:main',0)
  await f.store.saveCheckpoint({...base,thoughts})
  const loaded=await f.store.checkpoint('chat:main',0),kept=loaded.thoughts!
  assert.ok(kept.length>0&&kept.length<=MAX_WORKBENCH_THOUGHTS)
  assert.ok(Buffer.byteLength(JSON.stringify(kept))<=MAX_WORKBENCH_THOUGHT_BYTES)
  assert.equal(kept.at(-1)!.id,'t-69')
  assert.ok(!kept.some(item=>item.id==='t-0'),'the oldest entries are trimmed first')
  for(const item of kept)assert.ok([...item.text].length<=MAX_WORKBENCH_THOUGHT_CODEPOINTS)
  assert.equal([...kept.at(-1)!.text].length,MAX_WORKBENCH_THOUGHT_CODEPOINTS)
  const persisted=JSON.parse(await readFile(checkpointFile(f.root,'chat:main',0),'utf8')) as {thoughts:WorkbenchThought[]}
  assert.ok(Buffer.byteLength(JSON.stringify(persisted.thoughts))<=MAX_WORKBENCH_THOUGHT_BYTES)
 }finally{await f.close()}
})

test('steps merge thoughts and tool previews chronologically and page within limits',async()=>{
 const f=await fixture()
 try{
  const base=emptyWorkbenchCheckpoint('chat:main',0)
  await f.store.saveCheckpoint({
   ...base,
   thoughts:[
    thought('think-1','第二段思考','2026-01-01T00:00:02.000Z'),
    thought('think-0','第一段思考','2026-01-01T00:00:00.000Z'),
   ],
   calls:[
    call('call-1','file_read','2026-01-01T00:00:03.000Z',{status:'completed'}),
    call('call-0','file_write','2026-01-01T00:00:01.000Z',{status:'completed'}),
   ],
  })
  const page=await f.store.steps('chat:main',0)
  assert.equal(page.total,4);assert.equal(page.next_offset,null);assert.equal(page.generation,0)
  assert.deepEqual(page.items.map(item=>item.kind),['thinking','tool','thinking','tool'])
  assert.deepEqual(page.items.map(item=>item.created_at),[
   '2026-01-01T00:00:00.000Z','2026-01-01T00:00:01.000Z','2026-01-01T00:00:02.000Z','2026-01-01T00:00:03.000Z',
  ])
  const first=page.items[0]
  assert.equal(first?.kind==='thinking'?first.text:null,'第一段思考')
  assert.equal(first?.kind==='thinking'?first.message_id:null,null)
  const tool=page.items[1]
  assert.equal(tool?.kind==='tool'?tool.name:null,'file_write')
  assert.equal(tool?.kind==='tool'?tool.sequence:null,1)

  const many:WorkbenchCheckpoint={
   ...base,
   thoughts:Array.from({length:15},(_,index)=>thought('t-'+index,'思考'+index,new Date(Date.UTC(2026,0,1,0,0,index)).toISOString())),
   calls:Array.from({length:10},(_,index)=>call('c-'+index,'file_read',new Date(Date.UTC(2026,0,1,0,0,15+index)).toISOString(),{status:'completed'})),
  }
  await f.store.saveCheckpoint(many)
  const firstPage=await f.store.steps('chat:main',0)
  assert.equal(firstPage.total,25);assert.equal(firstPage.items.length,20);assert.equal(firstPage.next_offset,20)
  assert.ok(Buffer.byteLength(JSON.stringify(firstPage.items))<=12_000)
  const secondPage=await f.store.steps('chat:main',0,firstPage.next_offset??0)
  assert.equal(secondPage.items.length,5);assert.equal(secondPage.next_offset,null)
  assert.equal(new Set([...firstPage.items,...secondPage.items].map(item=>item.kind+':'+item.id)).size,25)
 }finally{await f.close()}
})

test('checkpoint reset removes thoughts with the rest of the round',async()=>{
 const f=await fixture()
 try{
  const base=emptyWorkbenchCheckpoint('chat:main',0)
  await f.store.saveCheckpoint({...base,thoughts:[thought('t-0','旧思考','2026-01-01T00:00:00.000Z')]})
  assert.equal((await f.store.checkpoint('chat:main',0)).thoughts!.length,1)
  await f.store.resetCheckpoint('chat:main',0)
  assert.deepEqual((await f.store.checkpoint('chat:main',0)).thoughts,[])
 }finally{await f.close()}
})
