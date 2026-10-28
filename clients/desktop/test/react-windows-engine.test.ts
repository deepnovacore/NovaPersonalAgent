import test from 'node:test'
import assert from 'node:assert/strict'
import {JSDOM} from 'jsdom'
import {createShellStore} from '../src/renderer/react/windows/store.ts'
import {startDesktopEngine} from '../src/renderer/react/desktop-engine.mjs'

class Socket {
 static OPEN=1;static CLOSING=2;static sockets:Socket[]=[]
 readyState=0;binaryType='';onopen:any;onclose:any;onmessage:any;onerror:any;sent:any[]=[]
 constructor(public endpoint:string){Socket.sockets.push(this)}
 send(value:any){this.sent.push(typeof value==='string'?JSON.parse(value):value)}
 close(){this.readyState=3;this.onclose?.({code:1000})}
 open(){this.readyState=1;this.onopen?.()}
}
function fixture() {
 const dom=new JSDOM('<!doctype html><html><body><div id="orb"></div><canvas></canvas></body></html>',{pretendToBeVisual:true,url:'https://nova.local'})
 const media={matches:false,addEventListener(){},removeEventListener(){}}
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,WebSocket:Socket,matchMedia:()=>media})
 Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true})
 Object.defineProperty(dom.window,'matchMedia',{value:()=>media})
 const canvas=document.querySelector('canvas')!;canvas.getContext=()=>null
 const listeners=new Map<string,any>(),counts=new Map<string,number>(),subscribe=(name:string)=>(callback:any)=>{listeners.set(name,callback);return()=>counts.set(name,(counts.get(name)??0)+1)}
 const calls:any[]=[]
 const api:any={windowLayout:{onBubbleLayout:subscribe('layout'),onConfirmationPlacement:subscribe('placement'),setConfirmationMode:(v:any)=>calls.push(['confirmation',v]),setDormant:(v:any)=>calls.push(['dormant',v]),reserveBubbleArea:async(rows:number,taskRows:number)=>({rows,taskHeightCss:taskRows*80,orbOffsetCssX:0,orbOffsetCssY:0})},camera:{onEnumerate:subscribe('camera-enumerate')},visor:{onRefresh:subscribe('visor-refresh'),report(){}},microphone:{onVoiceprintRecording:subscribe('voiceprint'),onToggle:subscribe('mute'),onRetry:subscribe('retry'),report(){}},wakeWord:{onChanged:subscribe('wake'),activity(){},report(){},sleep(){calls.push('sleep')},wake(){calls.push('wake')}},settings:{onChanged:subscribe('settings')},nativeAudio:{onEvent:subscribe('audio'),clear:async()=>{},setPlaybackMuted:async()=>{},setCaptureEnabled:async()=>({audioMode:'inactive'})},onBackendStatus:subscribe('backend-status'),onBackendExit:subscribe('backend-exit'),onBackendReady:subscribe('backend-ready'),bootstrap:async()=>({platform:'linux',cameraSource:'local',audioMode:'inactive',settings:{},startup:{stage:'ready'},wakeWord:{state:'active',epoch:0,status:'ready'},backendStatus:'connected',backend:{endpoint:'ws://127.0.0.1:12345',token:'a'.repeat(32)}}),windowDrag:{start(){calls.push('drag-start')},move(){calls.push('drag-move')},end(){calls.push('drag-end')}},orbMenu:{openSettings(){calls.push('settings')},show(){calls.push('menu')}},executorResult:{open:async()=>{}},personal:{setPresentation:async()=>{}}}
 ;(window as any).novaPersonalAgentDesktop=api
 const controller:any={presentationMode:'orb',mode:'text',connect:async()=>{},command:async()=>{},disconnect(){},desiredPresentation:'orb'},view:any={controller,refresh(){},startup(){},setOrb(){},setOrbLevel(){},identity(){},receive(){},expand(){calls.push('expand')},dispose(){calls.push('dispose-view')}}
 const ui=createShellStore(),engine=startDesktopEngine({ui,refs:{orb:document.getElementById('orb'),canvas},mountPersonalView:()=>view})
 return{dom,ui,engine,listeners,counts,calls}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve))

test('shell bridge retains transport messages, confirmation decisions, keyboard and release lifecycle',async()=>{
 const f=fixture();await settle();const socket=Socket.sockets.at(-1)!;socket.open();await settle()
 assert.deepEqual(socket.sent[0],{type:'hello',token:'a'.repeat(32)})
 await f.engine.receive({type:'caption',role:'user',text:'draft words',final:true});assert.deepEqual(f.ui.get().caption,{role:'user',text:'draft words'})
 await f.engine.receive({type:'executor.approval',executor:'codex',display_name:'Codex',pending_approval:true,pending_approval_busy:false,pending_approval_id:'approval-1',kind:'command_execution',local_detail:{kind:'command_execution',command:'npm test',cwd:'workspace'},operation_summary:'执行器请求执行命令',expires_in_seconds:60})
 assert.equal(f.ui.get().orb.confirmationActionsVisible,true);assert.equal(f.ui.get().orb.decisionEnabled,true)
 f.ui.invoke('confirm');f.ui.invoke('confirm');assert.equal(socket.sent.filter(frame=>frame.type==='codex.approval_decision'||frame.type==='executor.approval_decision').length,1);assert.equal(f.ui.get().orb.decisionEnabled,false)
 f.ui.invoke('keydown',{key:'Enter',repeat:false,preventDefault(){}});assert.ok(f.calls.includes('expand'))
 f.listeners.get('wake')({state:'sleeping',epoch:1,status:'ready'});assert.equal(f.ui.get().orb.sleeping,true);f.ui.invoke('keydown',{key:' ',repeat:false,preventDefault(){}});assert.ok(f.calls.includes('wake'))
 f.engine.dispose();f.engine.dispose();assert.equal(socket.readyState,3);await settle()
 for(const name of f.listeners.keys())assert.equal(f.counts.get(name),1,`${name} subscription released exactly once`)
 assert.equal(f.calls.filter(call=>call==='dispose-view').length,1);f.dom.window.close()
})

test('shell bridge disables decisions when delivery is unavailable and does not mutate owned DOM',async()=>{
 const f=fixture();await settle();const before=document.body.innerHTML
 await f.engine.receive({type:'caption',role:'assistant',text:'safe <b>text</b>',final:true});assert.equal(document.body.innerHTML,before)
 await f.engine.receive({type:'executor.approval',executor:'codex',display_name:'Codex',pending_approval:true,pending_approval_busy:false,pending_approval_id:'approval-2',kind:'command_execution',local_detail:{kind:'command_execution',command:'npm test',cwd:'workspace'},operation_summary:'执行器请求执行命令',expires_in_seconds:0})
 assert.equal(f.ui.get().orb.decisionEnabled,false);f.ui.invoke('confirm');assert.equal(Socket.sockets.at(-1)!.sent.length,0)
 f.engine.dispose();await settle();f.dom.window.close()
})
