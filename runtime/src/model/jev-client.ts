import {beginModelUsage} from '../usage/model-call.js'
import type {UsageReporter} from '../realtime/usage.js'
import {z} from 'zod'
export interface JevOptions {apiKey:string;onUsage?:UsageReporter;fetcher?:typeof fetch;model?:string}
export interface JevQuestion {type:'choice';instructions:string;criteria:Record<string,string>}
const answer=z.object({type:z.literal('choice'),choice:z.string(),confidence:z.number().min(0).max(1),probabilities:z.record(z.string(),z.number().min(0).max(1))})
/** Shared bounded transport for personal understanding and public-news judgments. */
export async function decide(options:JevOptions,state:unknown,questions:Record<string,JevQuestion>,signal:AbortSignal){
 if(!options.apiKey.trim())throw Error('jev_not_configured')
 signal.throwIfAborted()
 if(!Object.keys(questions).length)return {}
 const finishUsage=beginModelUsage(options.onUsage,'https://openrouter.ai/api/alpha/decisions',options.model??'typesafe/jev-1.13')
 let usage:unknown,succeeded=false
 try{
 const response=await (options.fetcher??fetch)('https://openrouter.ai/api/alpha/decisions',{method:'POST',signal:AbortSignal.any([signal,AbortSignal.timeout(30000)]),headers:{Authorization:`Bearer ${options.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:options.model??'typesafe/jev-1.13',state,questions})})
 if(!response.ok)throw Error(`jev_http_${response.status}`)
 const raw=await response.json() as {usage?:unknown}
 usage=raw?.usage
 const data=z.object({answers:z.record(z.string(),answer)}).parse(raw)
 if(Object.keys(data.answers).length!==Object.keys(questions).length)throw Error('incomplete_decisions')
 for(const [id,q] of Object.entries(questions)){
  const a=data.answers[id],labels=Object.keys(q.criteria)
  if(!a||!labels.includes(a.choice)||Object.keys(a.probabilities).length!==labels.length||labels.some(k=>a.probabilities[k]===undefined))throw Error('invalid_decision')
  if(Math.abs(Object.values(a.probabilities).reduce((sum,p)=>sum+p,0)-1)>0.06)throw Error('invalid_probabilities')
 }
 succeeded=true
 return data.answers
 }finally{finishUsage(usage,signal.aborted?'cancelled':succeeded?'success':'error')}
}
