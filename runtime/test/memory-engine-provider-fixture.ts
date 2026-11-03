import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import type {SubstrateMemoryResource} from '../src/memory-substrate/resource.js'

export async function providerFixture(){
  let fail=false,hold=false,embeddings=0,extractions=0
  const server=createServer((req,res)=>{void(async()=>{
    let raw='';for await(const chunk of req)raw+=String(chunk)
    const body=JSON.parse(raw) as {input?:string|string[];dimensions?:number;messages?:{content:string}[]}
    if(fail){res.writeHead(503);res.end('{}');return}
    if(hold){req.on('close',()=>res.destroy());return}
    res.setHeader('Content-Type','application/json')
    if(req.url==='/v1/embeddings'){
      embeddings++;const inputs=Array.isArray(body.input)?body.input:[body.input]
      res.end(JSON.stringify({data:inputs.map((_,index)=>({index,embedding:Array.from({length:body.dimensions??2},(_,i)=>i===0?1:0)})),usage:{prompt_tokens:1,total_tokens:1}}));return
    }
    assert.equal(req.url,'/v1/chat/completions')
    extractions++
    const prompt=body.messages?.at(-1)?.content??''
    let output:unknown={memory:[],traits:[],emotion:''}
    try {
      const input=JSON.parse(prompt) as {source?:string;existing?:{id:string}[];candidates?:unknown[]}
      if(input.candidates)output={decisions:input.candidates.map((_,candidate_index)=>({candidate_index,action:'no_change',target_id:input.existing![0]!.id}))}
      else output={entries:input.source?.includes('always prefer')?[{key:'reply',text:'I prefer concise answers'+(/PURGE_SENTINEL_[A-Z0-9]+/u.exec(input.source??'')?.[0]?' '+/PURGE_SENTINEL_[A-Z0-9]+/u.exec(input.source??'')![0]:''),topic:'reply',kind:'preference',due:null,direction:null,status:null,valid_until:null}]:[]}
    }catch{
      output={memory:[],emotion:prompt.includes('upset today')?'sad':'',traits:prompt.includes('always prefer')?[{slot:'表达风格',label:'Prefers concise answers',reply_preference:true}]:[]}
    }
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}))
  })().catch(()=>{res.writeHead(500);res.end('{}')})})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();assert.ok(address&&typeof address!=='string')
  return {baseUrl:`http://127.0.0.1:${address.port}/v1`,setFail:(value:boolean)=>{fail=value},setHold:(value:boolean)=>{hold=value},counts:()=>({embeddings,extractions}),close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve())})}
}
export async function settle(memory:SubstrateMemoryResource){
  for(let n=0;n<20;n++)try{await memory.flush();return}catch(error){if(n===19)throw error;await new Promise(resolve=>setTimeout(resolve,30))}
}
