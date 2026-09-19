import {spawn} from 'node:child_process'
import {realpathSync} from 'node:fs'
import {resolve,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {snapshotRegularFile} from '../../storage/native-resource-snapshot.js'
import {canonicalJson} from '../../text/canonical-json.js'
import {ComposioFailure,type GoogleScope} from '../composio/client.js'
import type {GoogleObject,GooglePage} from '../composio/google.js'
const record=z.record(z.string(),z.unknown())
const requestSchema=z.discriminatedUnion('command',[
 z.object({command:z.enum(['status','request_access','list_calendars'])}).strict(),
 z.object({command:z.literal('snapshot'),calendars:z.array(z.string().min(1).max(1024)).min(1).max(20),start:z.iso.datetime(),end:z.iso.datetime()}).strict(),
])
const eventSchema=z.object({calendarId:z.string().min(1).max(1024),id:z.string().min(1).max(4096),occurrence:z.iso.datetime(),title:z.string().max(10000),notes:z.string().max(2*1024*1024),location:z.string().max(10000),start:z.iso.datetime(),end:z.iso.datetime(),allDay:z.boolean(),timeZone:z.string().max(100),cancelled:z.boolean()}).strict()
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
export function normalizeMacCalendarEvent(value:unknown):GoogleObject {
 const e=eventSchema.parse(value),key=hash(canonicalJson([e.calendarId,e.id,e.occurrence])),text=[e.title,e.notes,e.location,e.start,e.end,e.allDay?'全天':'',e.timeZone].join('\n')
 return {key,semanticHash:hash(canonicalJson(e)),metadata:{calendar_id:e.calendarId,remote_id:e.id,occurrence:e.occurrence,all_day:e.allDay,time_zone:e.timeZone,start:e.start,end:e.end,truncated:text.length>99000},text:text.length>99000?text.slice(0,99000)+'\n[正文已截断]':text,locator:'ical://',observedAt:e.start,retentionUntil:new Date(Date.parse(e.end)+30*86400000).toISOString(),kind:'calendar',status:e.cancelled?'provider_deleted':'current'}
}
/** Only a desktop-owned resources root is accepted; requests cannot choose an executable. */
export class MacCalendarClient {
 constructor(readonly resourcesRoot:string){}
 #executable():string {
  if(process.platform!=='darwin'||!isAbsolute(this.resourcesRoot)||realpathSync(this.resourcesRoot)!==this.resourcesRoot)throw new ComposioFailure('native_unavailable')
  const manifest=z.object({schema_version:z.literal(1),target:z.literal('darwin-'+process.arch),resources:z.array(record).max(256)}).parse(JSON.parse(snapshotRegularFile(resolve(this.resourcesRoot,'native-resources-v1.json'),1024*1024).bytes.toString('utf8')))
  const rows=manifest.resources.filter(r=>r.logical_id==='macos_calendar')
  const r=z.object({relative_path:z.literal('native/macos_calendar'),kind:z.literal('executable'),platform:z.literal('darwin'),architecture:z.literal(process.arch),byte_size:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/u),build_contract_version:z.literal(1)}).parse(rows.length===1?rows[0]:null)
  const path=resolve(this.resourcesRoot,r.relative_path);if(realpathSync(path)!==path)throw new ComposioFailure('native_unavailable')
  const file=snapshotRegularFile(path,16*1024*1024)
  if(file.size!==r.byte_size||file.sha256!==r.sha256)throw new ComposioFailure('native_unavailable')
  return path
 }
 request(input:unknown,signal=AbortSignal.timeout(30000)):Promise<Record<string,unknown>> {
  const body=JSON.stringify(requestSchema.parse(input));if(Buffer.byteLength(body)>65536)throw new ComposioFailure('request_too_large')
  const executable=this.#executable()
  return new Promise((resolve,reject)=>{
   const child=spawn(executable,[],{shell:false,stdio:['pipe','pipe','ignore'],signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])})
   let bytes=0;const chunks:Buffer[]=[]
   child.on('error',()=>reject(new ComposioFailure('native_unavailable')))
   child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2*1024*1024){child.kill();reject(new ComposioFailure('response_too_large'))}else chunks.push(chunk)})
   child.on('close',code=>{try{if(code!==0)throw new ComposioFailure('native_unavailable');const result=record.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));if(result.error)throw new ComposioFailure(z.enum(['native_unavailable','permission_denied','calendar_unavailable','response_too_large','timeout','scope_denied','invalid_request']).catch('native_unavailable').parse(result.error));resolve(result)}catch(error){reject(error instanceof ComposioFailure?error:new ComposioFailure('invalid_contract'))}})
   child.stdin.on('error',()=>{ /* child failure is reported on close/error */ });child.stdin.end(body)
  })
 }
 async page(scope:GoogleScope,signal:AbortSignal):Promise<GooglePage>{
  if(scope.kind!=='calendar')throw new ComposioFailure('scope_denied')
  const now=Date.now(),result=await this.request({command:'snapshot',calendars:scope.calendars,start:new Date(now-scope.pastDays*86400000).toISOString(),end:new Date(now+scope.futureDays*86400000).toISOString()},signal)
  if(result.complete!==true||result.status!=='granted')throw new ComposioFailure('snapshot_incomplete')
  const events=z.array(eventSchema).max(200).parse(result.events)
  if(events.some(e=>!scope.calendars.includes(e.calendarId)||Date.parse(e.end)<=now-scope.pastDays*86400000||Date.parse(e.start)>=now+scope.futureDays*86400000))throw new ComposioFailure('scope_denied')
  return {objects:events.map(normalizeMacCalendarEvent),continuation:null,checkpoint:null,complete:true,snapshot:true}
 }
}
