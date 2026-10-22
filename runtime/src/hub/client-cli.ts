import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import type {HubSnapshot} from './store.js'
import type {HubRouting} from './routing.js'

type Task=ReturnType<HubRouting['tasks']>[number]

/** Remote commands never open the local database or execute a task. */
export async function runHubClient(args:string[]):Promise<number>{
 const command=args.shift(),subcommand=['todo','authority','schedules'].includes(command??'')?args.shift():undefined
 const options=new Map<string,string>()
 const allowed:Record<string,string[]>={
  devices:[],tasks:[],watch:['task','timeout-seconds'],
  send:['to','goal','acceptance','capability','target','ttl-seconds','command-id','task-id','expires-at'],
  cancel:['task','to','ttl-seconds','command-id','expires-at'],
  'todo add':['title','note','op-id'],'todo list':[],
  'authority show':[],'authority initialize':[],'authority members':[],
  'authority prepare':['to','epoch','transition'],
  'authority ack':['transition'],'authority commit':['transition'],'authority cancel':['transition'],
  'schedules list':[],'schedules pause':['id','revision'],'schedules resume':['id','revision'],
  'schedules prepare':['id','revision','transition','to'],'schedules ack':['id','revision','transition'],'schedules commit':['id','revision','transition'],'schedules cancel':['id','revision','transition'],
 }
 const flags=allowed[['todo','authority','schedules'].includes(command??'')?`${command} ${subcommand}`:command??'']
 if(!flags)throw Error('Usage: hub devices | send --to ID --goal TEXT --acceptance TEXT [--target PACKAGE] | cancel --task ID --to ID | tasks | watch --task ID | todo add --title TEXT | todo list; --url URL --token TOKEN (or NOVA_HUB_URL/NOVA_HUB_TOKEN)')
 for(let i=0;i<args.length;i+=2){
  const key=args[i]?.replace(/^--/,''),value=args[i+1]
  if(!args[i]?.startsWith('--')||!key||!['url','token',...flags].includes(key)||value===undefined||value.startsWith('--')||options.has(key))throw Error(`Invalid option: ${args[i]}`)
  options.set(key,value)
 }
 const required=(key:string)=>{const value=options.get(key);if(!value?.trim())throw Error(`--${key} required`);return value}
 const positive=(key:string,fallback:number)=>{const value=Number(options.get(key)??fallback);if(!Number.isFinite(value)||value<=0)throw Error(`Invalid --${key}`);return value}
 const url=new URL(options.get('url')??process.env.NOVA_HUB_URL??'')
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw Error('Hub URL must be an HTTPS origin (HTTP only for loopback)')
 const token=options.get('token')??process.env.NOVA_HUB_TOKEN
 if(!token)throw Error('--token or NOVA_HUB_TOKEN required')
 const request=async(path:string,body?:unknown,signal=AbortSignal.timeout(15000)):Promise<unknown>=>{
  const response=await fetch(new URL(`/hub/v1/${path}`,url),{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal})
  const value:unknown=await response.json()
  if(!response.ok){const error=value as {error?:string};throw Error(`HTTP ${response.status}: ${error.error??'hub_request_failed'}`)}
  return value
 }
 const print=(value:unknown)=>console.log(JSON.stringify(value))
 if(command==='schedules'){
  if(subcommand==='list')print(await request('schedule-owners'))
  else if(subcommand==='pause'||subcommand==='resume')print(await request('schedule-owners/control',{id:required('id'),owner_revision:positive('revision',0),enabled:subcommand==='resume'}))
  else print(await request('schedule-owners/handoff',{id:required('id'),owner_revision:positive('revision',0),transition_id:required('transition'),action:subcommand,...(subcommand==='prepare'?{target:required('to')}:{})}))
  return 0
 }
 if(command==='authority'){
  if(subcommand==='show'||subcommand==='members')print(await request(subcommand==='show'?'authority':'authority/members'))
  else if(subcommand==='initialize')print(await request('authority/initialize',{}))
  else if(subcommand==='prepare')print(await request('authority/prepare',{transition_id:required('transition'),target_device_id:required('to'),expected_epoch:positive('epoch',0)}))
  else print(await request(`authority/${subcommand}`,{transition_id:required('transition')}))
  return 0
 }
 if(command==='devices'||command==='tasks'){print(await request(command));return 0}
 if(command==='todo'){
  if(subcommand==='list')print((await request('state') as HubSnapshot).state.todos)
  else{
   const op_id=options.get('op-id')??randomUUID()
   print({op_id,...await request('mutations',{op_id,input:{op:'create',kind:'todo',title:required('title'),note:options.get('note')??''}}) as object})
  }
  return 0
 }
 if(command==='watch'){
  const task=required('task'),deadline=Date.now()+positive('timeout-seconds',300)*1000
  let previous=''
  while(Date.now()<deadline){
   const remaining=deadline-Date.now(),signal=AbortSignal.timeout(Math.max(1,Math.ceil(Math.min(15000,remaining))))
   let tasks:Task[]
   try{tasks=await request('tasks',undefined,signal) as Task[]}
   catch(error){
    // A watch deadline can expire while reading either headers or the JSON body.
    // Keep HTTP/network failures and the independent 15-second request cap intact.
    if(remaining<=15000&&signal.aborted&&error instanceof Error&&['TimeoutError','AbortError'].includes(error.name))throw Error('watch_timeout')
    throw error
   }
   const current=tasks.find(value=>value.task_id===task)
   if(current){
    const encoded=JSON.stringify(current)
    if(encoded!==previous){print(current);previous=encoded}
    if(['completed','cancelled','interrupted'].includes(current.phase))return current.phase==='completed'?0:1
    if(['rejected','expired','sender_revoked'].includes(current.delivery))return 1
   }
   await delay(Math.max(0,Math.min(500,deadline-Date.now())))
  }
  throw Error('watch_timeout')
 }
 const ttl=positive('ttl-seconds',300)
 if(ttl>900)throw Error('--ttl-seconds must be at most 900')
 if(options.has('expires-at')&&options.has('ttl-seconds'))throw Error('Use --expires-at or --ttl-seconds, not both')
 const expires_at=options.has('expires-at')?Number(required('expires-at')):Date.now()+Math.round(ttl*1000)
 if(!Number.isSafeInteger(expires_at))throw Error('Invalid --expires-at')
 // Replays must reuse the returned deadline as well as both IDs; never retry uncertain writes automatically.
 const payload={command_id:options.get('command-id')??randomUUID(),task_id:command==='send'?options.get('task-id')??randomUUID():required('task'),target_device_id:required('to'),kind:command==='send'?'start':'cancel',expires_at,
  ...(command==='send'?{goal:required('goal'),acceptance:required('acceptance'),capability:options.get('capability')??'android_native',target:options.get('target')??'com.nova.nova_mobile'}:{})}
 print({...await request('commands',payload) as object,expires_at})
 return 0
}
