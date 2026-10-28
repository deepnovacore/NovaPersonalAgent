import React,{createRef} from 'react'
import {createRoot} from 'react-dom/client'
import {flushSync} from 'react-dom'
import {PersonalController} from '../personal-controller.mjs'
import {DesktopTheme,ErrorBoundary} from './theme'
import {Workbench} from './workbench'

export type DesktopBridge=Record<string,any>
export type WorkbenchOptions={send:(frame:any)=>any;start:(options?:any)=>any;stop:()=>any;tasks:()=>any;taskAction?:(...args:any[])=>any;results:()=>any;api:DesktopBridge;applyPresentation?:(...args:any[])=>any;speakingLevel?:()=>number;onUnreadChange?:(count:number)=>void}
export class WorkbenchRuntime{
 controller:any
 revision=0
 listeners=new Set<()=>void>()
 chat=createRef<any>()
 detail=createRef<any>()
 executorFloat=createRef<any>()
 startupValue:any=null
 executorFrame:any=null
 confirmation:{resolve:(answer:boolean)=>void}|null=null
 disposed=false
 constructor(public options:WorkbenchOptions){
  this.controller=new PersonalController({...options,applyPresentation:options.applyPresentation,changed:()=>this.refresh(),confirmBuildSwitch:()=>new Promise<boolean>(resolve=>{this.confirmation={resolve};this.refresh()})})
 }
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 snapshot=()=>this.revision
 refresh=()=>{if(this.disposed)return;this.revision++;for(const listener of this.listeners)listener()}
 confirm=(answer:boolean)=>{const pending=this.confirmation;this.confirmation=null;pending?.resolve(answer);this.refresh()}
 run=async(action:()=>any)=>{
  const c=this.controller
  try{c.error='';return await action()}
  catch(error:any){
   c.error=error.message==='version_conflict'?'内容已在其他操作中更新，请核对最新状态后重试。':error.message
   if(c.presentationMode==='background')void this.options.api.personal?.showPresentationError?.(c.error)
   if((error.refusal_code==='version_conflict'||error.refusal_code?.endsWith('_conflict')||/conflict|version/i.test(error.message))&&c.connected)void c.command('state').catch(()=>{})
   return undefined
  }finally{this.refresh()}
 }
 receive=(frame:any)=>{
  this.chat.current?.receive(frame)
  if(frame.type==='client.ready'){this.executorFrame=null;this.executorFloat.current?.reset()}
  if(frame.type==='executor.tasks')this.executorFrame=frame
  this.controller.receive(frame)
  if(frame.type==='computer_use')document.getElementById('personal-root')?.dispatchEvent(new CustomEvent('nova-computer-frame',{detail:frame}))
  this.detail.current?.receive(frame)
  this.refresh()
 }
}

/** The existing device engine sees the same lifecycle; React owns every workbench node. */
export function mountPersonalView(options:WorkbenchOptions){
 const host=document.getElementById('personal-root')
 if(!host)throw new Error('React personal-root host is missing')
 const runtime=new WorkbenchRuntime(options),root=createRoot(host)
 flushSync(()=>root.render(<DesktopTheme transparent><ErrorBoundary><Workbench runtime={runtime}/></ErrorBoundary></DesktopTheme>))
 const invoke=(type:string,value?:any)=>host.dispatchEvent(new CustomEvent(`nova-workbench-${type}`,{detail:value}))
 return {
  controller:runtime.controller,receive:runtime.receive,refresh:runtime.refresh,
  identity:(value:any)=>runtime.chat.current?.identity(value),
  setOrb:(value:any)=>runtime.chat.current?.setOrb(value),
  setOrbLevel:(value:number)=>runtime.chat.current?.setOrbLevel(value),
  expand:()=>runtime.run(async()=>{await runtime.controller.setPresentation('workbench');if(runtime.controller.snapshot?.conversations?.items?.some((item:any)=>item.id==='chat:main'))await runtime.controller.home();runtime.chat.current?.reveal()}),
  openTask:(id:string)=>invoke('open-task',id),
  startup:(value:any)=>{runtime.startupValue=value;runtime.refresh()},
  dispose:()=>{runtime.disposed=true;runtime.confirm(false);root.unmount();runtime.controller.disconnect();runtime.listeners.clear()},
 }
}
