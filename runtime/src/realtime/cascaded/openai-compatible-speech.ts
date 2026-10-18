/* eslint-disable @typescript-eslint/require-await -- Async ports reject validation errors as promises. */
import {randomUUID} from 'node:crypto'
import {abortable} from '../../core/camera-session.js'
import {readBoundedResponse} from '../../http/bounded-response.js'
import {reportUsage, type UsageReporter} from '../usage.js'
import type {AsrFactory, TtsFactory} from './ports.js'

interface SpeechOptions {
  readonly endpoint:string
  readonly apiKey:string
  readonly model:string
  readonly voice:string
  /** OpenAI PCM is already 24kHz. Providers such as SiliconFlow require this explicit extension. */
  readonly sampleRate?:24000
  readonly fetchImpl?:typeof fetch
  readonly onUsage?:UsageReporter
}
class SpeechError extends Error {}
const failure=(code:string)=>new SpeechError(`Compatible speech ${code}`)
function checkAbort(signal?:AbortSignal):void {if(signal?.aborted)throw failure('aborted')}
function safeError(error:unknown):Error {return error instanceof SpeechError?error:failure('invalid_response')}
function discard(response:Response):void {void response.body?.cancel().catch(()=>{/* Best-effort abandoned-body cleanup. */})}
function provider(options:SpeechOptions):'openai'|'custom' {
  return options.endpoint.replace(/\/+$/u,'')==='https://api.openai.com/v1'?'openai':'custom'
}

async function request(options:SpeechOptions,path:string,body:FormData|string,signal:AbortSignal):Promise<Uint8Array> {
  const owned=AbortSignal.any([signal,AbortSignal.timeout(60_000)])
  let received:Response|undefined
  try {
    checkAbort(owned)
    const pending=(options.fetchImpl??fetch)(`${options.endpoint.replace(/\/+$/u,'')}/audio/${path}`,{
      method:'POST',headers:{authorization:`Bearer ${options.apiKey}`,...(typeof body==='string'?{'content-type':'application/json'}:{})},
      body,signal:owned,redirect:'error',
    }).then(response=>{received=response;if(owned.aborted){discard(response);throw failure('aborted')}return response})
    const response=await abortable(pending,owned)
    if(!response.ok){discard(response);throw failure(`http_${response.status}`)}
    const media=response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if(path==='speech'&&media&&!['audio/pcm','audio/raw','application/octet-stream'].includes(media)){
      discard(response);throw failure('invalid_response')
    }
    const bytes=await readBoundedResponse(response,{limit:path==='speech'?4*1024*1024:65536,signal:owned,failure})
    checkAbort(owned)
    return bytes
  }catch(error){if(received)discard(received);if(owned.aborted)throw failure('aborted');throw safeError(error)}
}

/** A single result settles on cancellation even if an upstream fetch ignores abort. */
class Result<T> {
  readonly controller=new AbortController()
  readonly signal:AbortSignal
  readonly done:Promise<void>
  #settle!:()=>void
  #value:T|undefined
  #error:Error|undefined
  #started=false
  #closed=false
  constructor(signal?:AbortSignal){
    this.signal=signal?AbortSignal.any([signal,this.controller.signal]):this.controller.signal
    this.done=new Promise(resolve=>{this.#settle=resolve})
    this.signal.addEventListener('abort',()=>this.#settle(),{once:true})
  }
  assertWritable(signal?:AbortSignal):void {
    checkAbort(this.signal);checkAbort(signal)
    if(this.#closed||this.#started)throw failure('session_finished')
  }
  async run(work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<void>{
    this.assertWritable(signal);this.#started=true
    const owned=signal?AbortSignal.any([this.signal,signal]):this.signal
    try{const value=await abortable(work(owned),owned);checkAbort(owned);if(!this.#closed)this.#value=value}
    catch(error){this.#error=owned.aborted?failure('aborted'):safeError(error);throw this.#error}
    finally{this.#settle()}
  }
  async value(signal?:AbortSignal):Promise<T|undefined>{
    try{if(signal)await abortable(this.done,signal);else await this.done}
    catch{throw failure('aborted')}
    if(this.#closed)return undefined
    checkAbort(this.signal);checkAbort(signal)
    if(this.#error)throw this.#error
    return this.#value
  }
  close():void {this.#closed=true;this.#value=undefined;this.controller.abort();this.#settle()}
}

export function createCompatibleAsrFactory(options:SpeechOptions):AsrFactory {
  return {openClient:()=>({open:async signal=>{
    checkAbort(signal)
    const job=new Result<string>(signal);let chunks:Uint8Array[]=[];let size=0
    return {
      append:async(pcm,signal)=>{
        job.assertWritable(signal)
        if(pcm.length%2||size+pcm.length>16000*2*64)throw failure('invalid_audio')
        chunks.push(pcm.slice());size+=pcm.length
      },
      finish:signal=>job.run(async owned=>{
        if(!size)return ''
        const form=new FormData(),audio=wav(Buffer.concat(chunks));chunks=[]
        form.set('model',options.model);form.set('response_format','json');form.set('file',new Blob([audio],{type:'audio/wav'}),'utterance.wav')
        const bytes=await request(options,'transcriptions',form,owned)
        const result:unknown=JSON.parse(Buffer.from(bytes).toString('utf8'))
        if(!result||typeof result!=='object'||!('text' in result)||typeof result.text!=='string'||result.text.length>4000)throw failure('invalid_response')
        checkAbort(owned)
        reportUsage(options.onUsage,{id:randomUUID(),provider:provider(options),service:'asr',model:options.model,status:'complete',audioDurationMs:Math.round(size/32)})
        return result.text.trim()
      },signal),
      events:async function*(signal){const text=await job.value(signal);if(text!==undefined)yield {text,final:true}},
      close:async()=>{chunks=[];job.close()},
    }
  }})}
}

export function createCompatibleTtsFactory(options:SpeechOptions):TtsFactory {
  return {openClient:()=>({open:async signal=>{
    checkAbort(signal)
    const controller=new AbortController(),owned=signal?AbortSignal.any([signal,controller.signal]):controller.signal
    const queue:Result<Uint8Array>[]=[];const jobs=new Set<Result<Uint8Array>>()
    let wake:(()=>void)|undefined,finished=false,closed=false,sending=false,characters=0
    const close=()=>{closed=true;controller.abort();for(const job of jobs)job.close();jobs.clear();queue.length=0;wake?.()}
    return {
      sendText:async(text,signal)=>{
        checkAbort(owned);checkAbort(signal)
        if(finished||sending)throw failure('session_finished')
        const points=[...text]
        if(characters+points.length>4000)throw failure('text_too_large')
        if(!text.trim())return
        characters+=points.length;sending=true
        try{
          // shortcut: buffer one host text segment; add true streaming if segment latency becomes limiting.
          for(let offset=0;offset<points.length;offset+=256){
            if(jobs.size>=8)throw failure('audio_backlog')
            const chunk=points.slice(offset,offset+256).join(''),job=new Result<Uint8Array>(owned)
            jobs.add(job);queue.push(job);wake?.()
            await job.run(async requestSignal=>{
              const bytes=await request(options,'speech',JSON.stringify({model:options.model,input:chunk,voice:options.voice,response_format:'pcm',...(options.sampleRate===undefined?{}:{sample_rate:options.sampleRate})}),requestSignal)
              if(!bytes.length||bytes.length%2||Buffer.from(bytes.subarray(0,4)).toString('ascii')==='RIFF')throw failure('invalid_audio')
              checkAbort(requestSignal)
              reportUsage(options.onUsage,{id:randomUUID(),provider:provider(options),service:'tts',model:options.model,status:'complete',characters:[...chunk].length,audioDurationMs:Math.round(bytes.length/48)})
              return bytes
            },signal)
          }
        }finally{sending=false}
      },
      finish:async signal=>{checkAbort(owned);checkAbort(signal);if(sending||finished)throw failure('session_finished');finished=true;wake?.()},
      events:async function*(signal){
        const readSignal=signal?AbortSignal.any([owned,signal]):owned
        for(;;){
          if(closed)return
          checkAbort(readSignal)
          const job=queue.shift()
          if(!job){
            if(finished)return
            try{await abortable(new Promise<void>(resolve=>{wake=resolve}),readSignal)}catch{if(!closed)throw failure('aborted')}
            continue
          }
          try{
            const pcm=await job.value(readSignal).catch(error=>{if(!closed)throw error;return undefined})
            if(pcm)for(let offset=0;offset<pcm.length;offset+=24000){if(closed)return;checkAbort(readSignal);yield {pcm:pcm.slice(offset,offset+24000)}}
          }finally{jobs.delete(job);job.close()}
        }
      },
      cancel:async()=>close(),close:async()=>close(),
    }
  }})}
}

function wav(pcm:Uint8Array):Uint8Array<ArrayBuffer> {
  const output=Buffer.alloc(44+pcm.length)
  output.write('RIFF');output.writeUInt32LE(36+pcm.length,4);output.write('WAVEfmt ',8);output.writeUInt32LE(16,16)
  output.writeUInt16LE(1,20);output.writeUInt16LE(1,22);output.writeUInt32LE(16000,24);output.writeUInt32LE(32000,28)
  output.writeUInt16LE(2,32);output.writeUInt16LE(16,34);output.write('data',36);output.writeUInt32LE(pcm.length,40);output.set(pcm,44)
  return output
}
