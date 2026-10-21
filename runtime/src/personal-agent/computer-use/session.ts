import {randomUUID} from 'node:crypto'
import {mkdir} from 'node:fs/promises'
import {constrainBase64ImageToMaxSize,imageInfoOfBase64} from '@midscene/shared/img'
import {setTimeout as delay} from 'node:timers/promises'
import {loadComputerConfig,type ComputerConfig} from '../../executors/computer-config.js'
import {startComputerBackend} from '../../executors/computer-backend.js'
import {computerForeground,guardComputerDevice,guiApproval,type ComputerTarget} from '../../executors/computer-device.js'
import {acquireDeviceLock,recordDeviceProcess,releaseDeviceLock,quarantineDeviceLock,type DeviceLock} from '../../executors/device-lock.js'
import {acquireTaskResources,quarantineTaskResources} from '../../executors/task-resources.js'
import {COMPUTER_IMAGE_LONG_EDGE,COMPUTER_RESOURCE,computerToolArguments,type ComputerToolName,type ToolImage} from './contract.js'

export interface ComputerSessionOptions {
 signal:AbortSignal
 approve:(name:string,params:unknown)=>Promise<boolean>
 acting:(name:ComputerToolName,point?:{x:number;y:number})=>void
 config?:ComputerConfig
 backend?:typeof startComputerBackend
 foreground?:typeof computerForeground
}
export class ComputerSession {
 readonly config:ComputerConfig
 private backend:Awaited<ReturnType<typeof startComputerBackend>>|undefined
 private guarded:Awaited<ReturnType<typeof guardComputerDevice>>|undefined
 private lock:DeviceLock|undefined
 private release:(()=>void)|undefined
 private image:ToolImage|undefined
 private observed=false
 private pendingAction:{name:ComputerToolName;point?:{x:number;y:number}}|undefined
 private unknown=false
 private closing:Promise<void>|undefined
 constructor(private readonly options:ComputerSessionOptions){this.config=options.config??loadComputerConfig(process.env)}
 private async connect(){
  if(this.closing)throw Error('cancelled')
  if(this.guarded)return
  const {options,config}=this
  options.signal.throwIfAborted()
  await mkdir(config.lockRoot,{recursive:true,mode:0o700})
  const acquired=await acquireDeviceLock(config.lockRoot,'desktop','local-input',randomUUID())
  if(!acquired.ok)throw Error('computer_resource_busy')
  this.lock=acquired.lock
  try{
   this.release=await acquireTaskResources([COMPUTER_RESOURCE],options.signal)
   this.backend=await (options.backend??startComputerBackend)(config.displayId,options.signal,config.budgetMs,undefined,config.resourcesPath,config.clickHoldMs,config.macWindow)
   if(!this.backend.pid)throw Error('invalid_configuration')
   await recordDeviceProcess(this.lock,this.backend.pid)
   const target=async():Promise<ComputerTarget>=>{
    options.signal.throwIfAborted()
    if(config.macWindow)return {displayId:config.displayId,...await this.backend!.windowTarget()}
    const displays=await this.backend!.listDisplays()
    if(displays.length!==1||displays[0]?.id!==config.displayId)throw Error('screen_changed')
    return {displayId:config.displayId,...await (options.foreground??computerForeground)(options.signal)}
   }
   const baseline=await target()
   if(!await guiApproval(options.approve('Connect',config.macWindow?{window:config.macWindow,app:'Safari',mode:'background',healthCheck:'window identity only',pointerInput:'brief AppKit keyboard-focus lease per Tap, restored before receipt'}:{displayId:config.displayId,healthCheck:'moves and restores pointer'}),options.signal))throw Error('declined')
   if(JSON.stringify(await target())!==JSON.stringify(baseline))throw Error('screen_changed')
   options.signal.throwIfAborted()
   await this.backend.connect()
   const size=await this.backend.device.size()
   if(size.width!==baseline.width||size.height!==baseline.height)throw Error('screen_changed')
   this.guarded=await guardComputerDevice(this.backend.device,target,{displayId:config.displayId,signal:options.signal,maxSteps:config.maxSteps,budgetMs:config.budgetMs,approve:options.approve,beforeWrite:()=>{const action=this.pendingAction;if(action)options.acting(action.name,action.point)},progress:()=>{ /* Build emits tool-scoped activity. */ }})
  }catch(error){
   if(error instanceof Error&&error.message==='cleanup_unknown')this.unknown=true
   await this.close()
   throw error
  }
 }
 async screenshot():Promise<ToolImage>{
  await this.connect()
  if((this.config.settleMs??0)>0)await delay(this.config.settleMs,undefined,{signal:this.options.signal})
  const raw=await this.guarded!.device.screenshotBase64()
  const image=await constrainBase64ImageToMaxSize(raw,{maxSize:COMPUTER_IMAGE_LONG_EDGE})
  const info=await imageInfoOfBase64(image)
  this.options.signal.throwIfAborted()
  this.image={media_type:image.startsWith('data:image/jpeg;')?'image/jpeg':'image/png',data_base64:image.slice(image.indexOf(',')+1),width:info.width,height:info.height,captured_at:new Date().toISOString()}
  this.guarded!.planning();this.observed=true
  return this.image
 }
 async action(name:ComputerToolName,args:unknown):Promise<void>{
  const input=computerToolArguments[name].parse(args)
  if(!this.observed||!this.guarded||((name==='computer_click'||name==='computer_scroll')&&!this.image))throw Error('observe_required')
  const size=await this.guarded.device.size()
  let point:{x:number;y:number}|undefined
  if('x' in input&&'y' in input&&this.image){
   if(input.x>=this.image.width||input.y>=this.image.height)throw Error('invalid_params')
   point={x:input.x*size.width/this.image.width,y:input.y*size.height/this.image.height}
  }
  const locate=point?{prompt:'screenshot coordinate',center:[point.x,point.y]}:undefined
  const actionName=name==='computer_click'?'Tap':name==='computer_type'?'Input':name==='computer_scroll'?'Scroll':name==='computer_key'?'KeyboardPress':undefined
  const action=this.guarded.device.actionSpace().find(item=>item.name===actionName)
  if(!action?.paramSchema)throw Error('invalid_params')
  const params=name==='computer_click'?{locate}:name==='computer_type'&&'text' in input?{value:input.text}
   :name==='computer_key'&&'keys' in input?{keyName:input.keys}
   :name==='computer_scroll'&&'amount' in input?{locate,direction:input.direction,scrollType:'singleAction',distance:Math.max(1,Math.min(size.width,size.height)*input.amount/10)}:{}
  action.paramSchema.parse(params)
  this.pendingAction={name,...(point?{point}:{})}
  try{await action.call(params);this.guarded.planning()}catch(error){this.observed=false;if(error instanceof Error&&error.message==='cleanup_unknown')this.unknown=true;throw error}
  finally{this.image=undefined;this.pendingAction=undefined}
 }
 close():Promise<void>{return this.closing??=this.cleanup()}
 private async cleanup():Promise<void>{
  const backend=this.backend;this.backend=undefined;this.guarded=undefined;this.image=undefined;this.observed=false
  if(backend){try{if(!await backend.close())this.unknown=true}catch{this.unknown=true}}
  const lock=this.lock;this.lock=undefined
  if(this.unknown&&lock){quarantineTaskResources([COMPUTER_RESOURCE]);this.release=undefined;await quarantineDeviceLock(lock,'cleanup_unknown')}
  else{this.release?.();this.release=undefined;if(lock)await releaseDeviceLock(lock)}
  if(this.unknown)throw Error('cleanup_unknown')
 }
}
