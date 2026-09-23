#!/usr/bin/env node
// Offline rollback for the v1 directory-ledger extension. Keep the input as the recovery copy.
import {readFile,writeFile,rename} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'

const [input,output]=process.argv.slice(2)
if(!input||!output||input===output)throw Error('usage: rollback-source-walk INPUT OUTPUT (distinct paths)')
const disk=JSON.parse(await readFile(input,'utf8'))
if(disk.version!==1||!Array.isArray(disk.sources))throw Error('unsupported_source_state')
for(const source of disk.sources){
 const walk=source.walk
 if(!walk)continue
 const queued=new Map((walk.queue??[]).map(item=>[item.path,{path:item.path,offset:0,...(item.unit?{unit:item.unit}:{})}]))
 for(const item of walk.ledger??[])if(item.status!=='done'&&!queued.has(item.path))queued.set(item.path,{path:item.path,offset:0,...(item.unit?{unit:item.unit}:{})})
 source.walk={queue:[...queued.values()],pending:walk.pending??[],deferred:walk.deferred??[],...(walk.workspace_seeded?{workspace_seeded:walk.workspace_seeded}:{})}
}
const temp=`${output}.${randomUUID()}.tmp`
await writeFile(temp,JSON.stringify(disk),{flag:'wx',mode:0o600})
await rename(temp,output)
