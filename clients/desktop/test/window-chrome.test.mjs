import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'
import {mountWindowChrome} from '../src/renderer/window-chrome.mjs'

class Node{
 constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.attrs={};this.captured=null}
 append(...c){this.children.push(...c)}
 insertBefore(node,ref){const at=this.children.indexOf(ref);this.children.splice(at<0?this.children.length:at,0,node)}
 setAttribute(k,v){this.attrs[k]=v}
 addEventListener(name,fn){this.listeners[name]=fn}
 setPointerCapture(id){this.captured=id}
}
const el=(tag,text,className)=>{const n=new Node(tag);n.className=className??'';n.text=text;return n}
const all=n=>[n,...n.children.flatMap(all)]

function mount(native=false){
 const calls=[]
 const api={
  windowControls:{minimize:()=>calls.push('minimize'),toggleMaximize:()=>calls.push('toggleMaximize'),close:()=>calls.push('close')},
  windowDrag:{native,start:()=>calls.push('drag:start'),move:(dx,dy)=>calls.push(`drag:move:${dx},${dy}`),end:()=>calls.push('drag:end')},
 }
 const root=el('main')
 const chrome=mountWindowChrome(root,{api,el})
 return {calls,chrome,root}
}

test('two buttons map to close and minimize; maximize is only the topbar double-click', () => {
 const {calls,chrome}=mount()
 const buttons=chrome.controls.children
 assert.deepEqual(buttons.map(b=>b.className),['window-control window-close','window-control window-minimize'])
 for(const b of buttons)b.listeners.click()
 assert.deepEqual(calls,['close','minimize'])
 assert.ok(buttons.every(b=>b.attrs['aria-label']))
})

test('the controls attach to the root and the drag strip maximizes on double-click', () => {
 const {calls,chrome,root}=mount()
 assert.deepEqual(root.children,[chrome.controls])
 chrome.grip.listeners.dblclick()
 assert.deepEqual(calls,['toggleMaximize'])
})

test('a press past the threshold drives the window drag and always ends it; a plain click only starts and ends', () => {
 const {calls,chrome}=mount()
 const grip=chrome.grip
 grip.listeners.pointerdown({button:0,clientX:10,clientY:10,pointerId:3})
 assert.equal(grip.captured,3)
 grip.listeners.pointermove({clientX:12,clientY:10})
 grip.listeners.pointermove({clientX:30,clientY:14})
 grip.listeners.pointerup()
 assert.deepEqual(calls,['drag:start','drag:move:20,4','drag:end'])
 calls.length=0
 grip.listeners.pointerdown({button:0,clientX:5,clientY:5,pointerId:4})
 grip.listeners.pointerup()
 assert.deepEqual(calls,['drag:start','drag:end'])
 calls.length=0
 grip.listeners.pointerdown({button:2,clientX:5,clientY:5,pointerId:5})
 grip.listeners.pointerup()
 assert.deepEqual(calls,[])
})

test('a cancelled press still releases the main-process drag', () => {
 const {calls,chrome}=mount()
 chrome.grip.listeners.pointerdown({button:0,clientX:0,clientY:0,pointerId:1})
 chrome.grip.listeners.pointercancel()
 assert.deepEqual(calls,['drag:start','drag:end'])
})

test('native window dragging sends no programmatic moves and keeps the window controls', {skip:process.platform!=='win32'}, () => {
 const {calls,chrome}=mount(true)
 chrome.grip.listeners.pointerdown?.({button:0,clientX:10,clientY:10,pointerId:1})
 for(let x=20;x<=100;x+=10)chrome.grip.listeners.pointermove?.({clientX:x,clientY:10})
 chrome.grip.listeners.pointerup?.()
 chrome.grip.listeners.dblclick?.()
 assert.deepEqual(calls,[])
 for(const button of chrome.controls.children)button.listeners.click()
 assert.deepEqual(calls,['close','minimize'])
})

for(const platform of ['darwin','linux'])test(`${platform} preload keeps pointer dragging and DOM double-click controls`, async () => {
 const source=await readFile(new URL('../src/preload/preload.cjs',import.meta.url),'utf8')
 const calls=[];let api
 runInNewContext(source,{
  process:{platform,argv:[]},
  require:name=>{
   assert.equal(name,'electron')
   return {contextBridge:{exposeInMainWorld:(_name,value)=>{api=value}},ipcRenderer:{send:(...args)=>calls.push(args)}}
  },
 })
 assert.equal(api.windowDrag.native,false)
 const chrome=mountWindowChrome(el('main'),{api,el})
 assert.doesNotMatch(chrome.grip.className,/native-window-drag/)
 const grip=chrome.grip
 grip.listeners.pointerdown({button:0,clientX:10,clientY:10,pointerId:1})
 grip.listeners.pointermove({clientX:30,clientY:14})
 grip.listeners.pointerup()
 grip.listeners.dblclick()
 assert.deepEqual(calls.map(([channel])=>channel),[
  'nova:window-drag:start','nova:window-drag:move','nova:window-drag:end','nova:window:control',
 ])
 assert.equal(calls[1][1].dx,20)
 assert.equal(calls[1][1].dy,4)
 assert.equal(calls[3][1],'toggleMaximize')
})
