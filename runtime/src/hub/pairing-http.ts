import type {IncomingMessage,ServerResponse} from 'node:http'
import {performance} from 'node:perf_hooks'
import type {HubStore} from './store.js'
import {readLimitedJson} from './http-body.js'

/** Each server has one global budget; proxy-supplied addresses cannot reset it. */
export function pairingHandler(store:HubStore){
 let readers=0
 const attempts:number[]=[]
 return async(req:IncomingMessage,res:ServerResponse)=>{
  const reply=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',connection:'close'});res.end(JSON.stringify(value))}
  const now=performance.now()
  while(attempts.length&&attempts[0]!<=now-60000)attempts.shift()
  if(attempts.length>=60||readers>=8){reply(429,{error:'rate_limited'});return}
  attempts.push(now);readers++
  try{
   if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){reply(415,{error:'json_required'});return}
   const body=await readLimitedJson(req)
   reply(200,store.redeemInvitation(body))
  }catch(error){
   const message=error instanceof Error?error.message:''
   const statuses:Record<string,number>={invalid_pairing:400,invalid_request:400,pairing_identity_mismatch:409,device_capacity:409,payload_too_large:413,request_timeout:408}
   reply(statuses[message]??500,{error:statuses[message]?message:'internal_error'})
  }finally{readers--}
 }
}
