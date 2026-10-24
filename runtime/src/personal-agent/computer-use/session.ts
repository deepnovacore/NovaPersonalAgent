import type {DeviceAction} from '@midscene/core'
import type {GuiProgress} from '../../executors/gui-runner.js'
import {z} from 'zod'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {MacNativeReader} from '../../connectors/macos/reader.js'
import {randomUUID} from 'node:crypto'
import {mkdir} from 'node:fs/promises'
import {constrainBase64ImageToMaxSize,imageInfoOfBase64} from '@midscene/shared/img'
import {setTimeout as delay} from 'node:timers/promises'
import {loadComputerConfig,type ComputerConfig} from '../../executors/computer-config.js'
import {startComputerBackend} from '../../executors/computer-backend.js'
import {computerForeground,connectComputerDevice} from '../../executors/computer-device.js'
import {acquireDeviceLock,recordDeviceProcess,releaseDeviceLock,quarantineDeviceLock,type DeviceLock} from '../../executors/device-lock.js'
import {acquireTaskResources,quarantineTaskResources} from '../../executors/task-resources.js'
import {computerApplicationSchema,COMPUTER_IMAGE_LONG_EDGE,COMPUTER_RESOURCE,computerToolArguments,type ComputerToolName,type ToolImage,type ComputerObservation,type ComputerExecutionMode} from './contract.js'

export interface ComputerSessionOptions {
 signal:AbortSignal
 approve:(name:string,params:unknown)=>Promise<boolean>
 acting:(name:ComputerToolName,point?:{x:number;y:number})=>void
 config?:ComputerConfig
 backend?:typeof startComputerBackend
 foreground?:typeof computerForeground
 targetWindow?:{pid:number;windowId:number}
 /** The executor lifecycle retains and quarantines its own leases. */
 externalLease?:{recordProcess:(pid:number)=>Promise<void>}
 beforeWrite?:()=>void
 capture?:(image:string,steps:number)=>void
 progress?:(event:GuiProgress)=>void
 screenshotScrollDistance?:boolean
 nativeRequest?:(input:Record<string,unknown>,signal:AbortSignal)=>Promise<Record<string,unknown>>
}
export class ComputerSession {
 readonly config:ComputerConfig
 private backend:Awaited<ReturnType<typeof startComputerBackend>>|undefined
 private guarded:Awaited<ReturnType<typeof connectComputerDevice>>|undefined
 private lock:DeviceLock|undefined
 private release:(()=>void)|undefined
 private image:ToolImage|undefined
 private observation:ComputerObservation|undefined
 private selectedApplication:string|undefined
 private targetMetadata:ComputerObservation['target']=null
 private selectedTarget:string|undefined
 private pendingAction:{name:ComputerToolName;point?:{x:number;y:number}}|undefined
 private unknown=false
 private closing:Promise<void>|undefined
 constructor(private readonly options:ComputerSessionOptions){
  const {macWindow:_window,macApplication:_application,...config}=options.config??loadComputerConfig(process.env)
  this.config={...config,...(options.targetWindow?{macWindow:options.targetWindow}:{})}
  options.signal=AbortSignal.any([options.signal,AbortSignal.timeout(config.budgetMs)])
 }
 private native(input:Record<string,unknown>,signal=this.options.signal){
  const resources=this.config.resourcesPath??(process as NodeJS.Process & {resourcesPath?:string}).resourcesPath??resolve(fileURLToPath(new URL('../../../../../clients/desktop/build/',import.meta.url)))
  return this.options.nativeRequest?this.options.nativeRequest(input,signal):new MacNativeReader(resources,'macos_gui').request(input,signal)
 }

 private async connect(){
  if(this.closing)throw Error('cancelled')
  if(this.guarded)return
  const {options,config}=this
  options.signal.throwIfAborted()
  if(!options.externalLease){
   await mkdir(config.lockRoot,{recursive:true,mode:0o700})
   const acquired=await acquireDeviceLock(config.lockRoot,'desktop','local-input',randomUUID())
   if(!acquired.ok)throw Error('computer_resource_busy')
   this.lock=acquired.lock
  }
  try{
   if(!options.externalLease)this.release=await acquireTaskResources([COMPUTER_RESOURCE],options.signal)
   this.backend=await (options.backend??startComputerBackend)(config.displayId,options.signal,config.budgetMs,undefined,config.resourcesPath,config.clickHoldMs,config.macWindow)
   if(!this.backend.pid)throw Error('invalid_configuration')
   if(options.externalLease)await options.externalLease.recordProcess(this.backend.pid)
   else await recordDeviceProcess(this.lock!,this.backend.pid)
   if(this.selectedTarget&&(await this.backend.windowTarget()).target!==this.selectedTarget)throw Error('screen_changed')
   this.guarded=await connectComputerDevice(this.backend,config,{signal:options.signal,approve:options.approve,
    ...(options.foreground?{foreground:options.foreground}:{}),...(options.beforeWrite?{beforeConnect:options.beforeWrite}:{}),
    ...(options.capture?{capture:options.capture}:{}),...(options.screenshotScrollDistance?{screenshotScrollDistance:true}:{}),
    beforeWrite:()=>{options.beforeWrite?.();const action=this.pendingAction;if(action)options.acting(action.name,action.point)},
    progress:event=>options.progress?.({...event,...(event.phase==='action_returned'?{executionMode:this.config.macWindow?'background' as const:'activated' as const}:{})})})
  }catch(error){
   if(error instanceof Error&&error.message==='cleanup_unknown')this.unknown=true
   await this.close()
   throw error
  }
 }
 async observe(application?:string):Promise<ComputerObservation>{
  this.observation=undefined
  if(application!==undefined){
   computerToolArguments.computer_screenshot.parse({application})
   this.options.signal.throwIfAborted()
   if(this.guarded&&application!==this.selectedApplication)throw Error('screen_changed')
   const result=z.object({pid:z.number().int().positive(),windowId:z.number().int().positive(),target:z.string().min(1),title:z.string().max(400).default(''),application:computerApplicationSchema}).parse(await this.native({op:'applicationTarget',application}))
   if(this.guarded&&this.selectedTarget!==result.target)throw Error('screen_changed')
   this.config.macApplication=result.application;this.config.macWindow={pid:result.pid,windowId:result.windowId};this.selectedTarget=result.target
   this.selectedApplication=application
   this.targetMetadata={application:result.application.bundleId,pid:result.pid,window_id:result.windowId,title:result.title}
  }
  if(this.options.targetWindow&&!this.selectedTarget){
   const result=z.object({target:z.string().min(1),title:z.string().max(400).default(''),application:computerApplicationSchema}).parse(await this.native({...this.options.targetWindow,op:'target'}))
   this.selectedTarget=result.target;this.config.macApplication=result.application
   this.targetMetadata={application:result.application.bundleId,pid:this.options.targetWindow.pid,window_id:this.options.targetWindow.windowId,title:result.title}
  }
  await this.connect()
  if((this.config.settleMs??0)>0)await delay(this.config.settleMs,undefined,{signal:this.options.signal})
  const foreground=async()=>{
   try{return await (this.options.foreground??computerForeground)(this.options.signal)}catch(error){
    this.options.signal.throwIfAborted()
    if(!this.config.macWindow)throw error
    return undefined // Background capture does not depend on unrelated foreground windows/displays.
   }
  }
  const before=await foreground()
  const raw=await this.guarded!.device.screenshotBase64()
  const image=await constrainBase64ImageToMaxSize(raw,{maxSize:COMPUTER_IMAGE_LONG_EDGE})
  const info=await imageInfoOfBase64(image)
  const size=await this.guarded!.device.size()
  this.options.signal.throwIfAborted()
  this.image={media_type:image.startsWith('data:image/jpeg;')?'image/jpeg':'image/png',data_base64:image.slice(image.indexOf(',')+1),width:info.width,height:info.height,captured_at:new Date().toISOString()}
  let focus:ComputerObservation['focus']=null
  try{const identity:unknown=JSON.parse(before?.target??'null');if(Array.isArray(identity)&&typeof identity[0]==='number'&&(typeof identity[2]==='number'||typeof identity[1]==='number'))focus={pid:identity[0],window_id:typeof identity[2]==='number'?identity[2]:identity[1] as number}}catch{ /* Platform identity may be opaque. */ }
  let ax:ComputerObservation['ax']={status:'unavailable'}
  const window=this.config.macWindow??(focus?{pid:focus.pid,windowId:focus.window_id}:undefined)
  if(window&&(process.platform==='darwin'||this.options.nativeRequest)){
   const timeout=AbortSignal.timeout(2000)
   try{
    const target=this.selectedTarget??z.object({target:z.string()}).parse(await this.native({...window,op:'target'},AbortSignal.any([this.options.signal,timeout]))).target
    const editor=await this.native({...window,op:'editor',target},AbortSignal.any([this.options.signal,timeout]))
    const summary=editor.native_ui?z.object({source:z.literal('accessibility'),content:z.array(z.object({role:z.string().max(100),text:z.string().max(600),url:z.string().max(1000)})).max(80),truncated:z.boolean()}).parse(editor.native_ui):undefined
    const field=editor.available===true?z.object({role:z.string().max(100),value:z.string().max(400),source:z.literal('accessibility')}).parse(editor):undefined
    const status=z.enum(['ok','unavailable','timeout','truncated']).parse(editor.status??(summary?(summary.truncated?'truncated':'ok'):'unavailable'))
    ax={status,...(summary?{summary}:{}),...(field?{editor:field}:{})}
   }catch(error){
    this.options.signal.throwIfAborted()
    if(error instanceof Error&&error.message.includes('screen_changed'))throw Error('screen_changed')
    ax={status:timeout.aborted?'timeout':'unavailable'}
   }
  }
  const after=await foreground()
  if(!this.config.macWindow&&before?.target!==after?.target)throw Error('screen_changed')
  if(this.selectedTarget&&(await this.backend!.windowTarget()).target!==this.selectedTarget)throw Error('screen_changed')
  this.options.signal.throwIfAborted()
  const observation:ComputerObservation={id:randomUUID(),captured_at:this.image.captured_at,image:this.image,space:{logical_width:size.width,logical_height:size.height,scale:info.width/size.width},target:this.targetMetadata,focus,foreground:!this.targetMetadata||focus?.pid===this.targetMetadata.pid&&focus.window_id===this.targetMetadata.window_id,ax}
  this.guarded!.planning();this.observation=observation
  return observation
 }
 async action(name:ComputerToolName,args:unknown):Promise<{executionMode:ComputerExecutionMode}>{
  if(!this.observation)throw Error('observe_required')
  const input=computerToolArguments[name].parse(args)
  if(!('observationId' in input)||input.observationId!==this.observation.id)throw Error('observe_required')
  if(!this.observation||!this.guarded||((name==='computer_click'||name==='computer_scroll')&&!this.image))throw Error('observe_required')
  const size=await this.guarded.device.size()
  let point:{x:number;y:number}|undefined
  if('x' in input&&'y' in input&&this.image){
   if(input.x>=this.image.width||input.y>=this.image.height)throw Error('invalid_params')
   point={x:input.x*this.observation.space.logical_width/this.image.width,y:input.y*this.observation.space.logical_height/this.image.height}
  }
  const locate=point?{prompt:'screenshot coordinate',center:[point.x,point.y]}:undefined
  const actionName=name==='computer_click'?'Tap':name==='computer_type'?'Input':name==='computer_scroll'?'Scroll':name==='computer_key'?'KeyboardPress':undefined
  const action=this.guarded.device.actionSpace().find(item=>item.name===actionName)
  if(!action?.paramSchema)throw Error('invalid_params')
  const params=name==='computer_click'?{locate}:name==='computer_type'&&'text' in input?{value:input.text,mode:'mode' in input?input.mode:'append'}
   :name==='computer_key'&&'keys' in input?{keyName:input.keys}
   :name==='computer_scroll'?(()=>{const scroll=computerToolArguments.computer_scroll.parse(args);return {locate,direction:scroll.direction,scrollType:'singleAction',distance:Math.max(1,Math.min(size.width,size.height)*scroll.amount/10)}})():{}
  return this.deviceAction(input.observationId,action.name,params)
 }
 actions():Omit<DeviceAction,'call'>[]{return this.guarded?.device.actionSpace().map(({call:_call,...action})=>action)??[]}
 steps():number{return this.guarded?.steps()??0}
 failure():string|undefined{return this.guarded?.failure()}
 planning():void{this.guarded?.planning()}
 async deviceAction(observationId:string,actionName:string,params:unknown,context?:Parameters<DeviceAction['call']>[1]):Promise<{executionMode:ComputerExecutionMode}>{
  if(this.observation?.id!==observationId||!this.guarded)throw Error('observe_required')
  const action=this.guarded.device.actionSpace().find(item=>item.name===actionName)
  if(!action?.paramSchema)throw Error('invalid_params')
  action.paramSchema.parse(params)
  const name=({Tap:'computer_click',Input:'computer_type',Scroll:'computer_scroll',KeyboardPress:'computer_key'} as const)[actionName as 'Tap'|'Input'|'Scroll'|'KeyboardPress']
  if(!name)throw Error('invalid_params')
  const center=(params as {locate?:{center?:number[]}})?.locate?.center
  this.pendingAction={name,...(center?{point:{x:center[0]!,y:center[1]!}}:{})}
  try{await action.call(params,context);return {executionMode:this.config.macWindow?'background':'activated'}}catch(error){if(error instanceof Error&&error.message==='cleanup_unknown')this.unknown=true;throw error}
  finally{this.observation=undefined;this.image=undefined;this.pendingAction=undefined}
 }
 close():Promise<void>{return this.closing??=this.cleanup()}
 private async cleanup():Promise<void>{
  const backend=this.backend;this.backend=undefined;this.guarded=undefined;this.image=undefined;this.observation=undefined
  if(backend){try{if(!await backend.close())this.unknown=true}catch{this.unknown=true}}
  const lock=this.lock;this.lock=undefined
  if(this.unknown&&lock){quarantineTaskResources([COMPUTER_RESOURCE]);this.release=undefined;await quarantineDeviceLock(lock,'cleanup_unknown')}
  else{this.release?.();this.release=undefined;if(lock)await releaseDeviceLock(lock)}
  if(this.unknown)throw Error('cleanup_unknown')
 }
}
