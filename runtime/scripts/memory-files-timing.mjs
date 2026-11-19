// Manual benchmark: run from the worktree root after building runtime/dist.
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
const moduleAt=path=>import(pathToFileURL(resolve('runtime/dist/src/'+path)))
const {MemoryLedgerClient}=await moduleAt('memory-ledger/store-client.js')
const {SubstrateMemoryResource}=await moduleAt('memory-substrate/resource.js')
const root=await mkdtemp(join(tmpdir(),'nova-memory-files-timing-'))
const client=new MemoryLedgerClient(join(root,'ledger.sqlite'))
const memory=new SubstrateMemoryResource({client,userId:'timing',model:'fixture',gateway:{complete(){throw Error('no model')},async *stream(){}},inputConsent:true,conversationProviders:['chat']})
const deferred=process.argv[2]==='after'
let serial=0,writeMs=0
const original=client.memory.bind(client)
client.memory=async(op,input,options)=>{if(op==='explicit_write'&&!deferred)input={...input,defer_files:false};const start=performance.now();try{return await original(op,input,options)}finally{if(op==='explicit_write')writeMs=performance.now()-start}}
const stats=values=>{values.sort((a,b)=>a-b);return {mean:+(values.reduce((a,b)=>a+b,0)/values.length).toFixed(2),p50:+values[Math.floor(values.length*.5)].toFixed(2),p95:+values[Math.floor(values.length*.95)].toFixed(2)}}
const write=async()=>{const text='Synthetic benchmark fact '+(++serial),turn=await memory.beginExplicitTurn({sourceId:'turn-'+serial,text,occurredAt:new Date().toISOString()});const start=performance.now();await memory.writeExplicit(turn,'write',{action:'set',kind:'fact',text,quote:text},'chat');return performance.now()-start}
const drain=()=>deferred?original('flush_files',{}, {priority:'background'}):Promise.resolve()
try{
 await memory.open({deferBackground:true})
 for(let i=0;i<40;i++){await write();await drain()}
 const rpc=[],withRefresh=[],flush=[]
 for(let i=0;i<10;i++){withRefresh.push(await write());rpc.push(writeMs);const start=performance.now();await drain();flush.push(performance.now()-start)}
 console.log(JSON.stringify({label:process.argv[2],seed:40,samples:10,ms:{explicit_write:stats(rpc),write_and_refresh:stats(withRefresh),background_flush:deferred?stats(flush):null}}))
 if(deferred){await write();const start=performance.now(),pending=drain();await new Promise(resolve=>setTimeout(resolve,5));const lookupStart=performance.now();const lookup=memory.lookupExplicit({},'chat');await pending;const flushMs=performance.now()-start;await lookup;console.log(JSON.stringify({background_flush_ms:+flushMs.toFixed(2),interactive_lookup_issued_after_ms:+(lookupStart-start).toFixed(2),interactive_lookup_wait_ms:+(performance.now()-lookupStart).toFixed(2)}))}
}finally{await memory.close();await rm(root,{recursive:true,force:true})}
