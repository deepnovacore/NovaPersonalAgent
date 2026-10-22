import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import {setLanguage,t} from '../src/renderer/locale.mjs'
import {computerOverlayDetail,computerOverlayFrame,computerOverlayMark} from '../src/renderer/computer-overlay-view.mjs'
import {createComputerUseIndicator} from '../src/renderer/computer-use-indicator.mjs'
import {mountComputerUseControl} from '../src/renderer/computer-use-control.mjs'
import {computerCallTarget} from '../src/renderer/build-call-log.mjs'

class Element{
 constructor(name,text){this.name=name;this.textContent=text??'';this.children=[];this.listeners={};this.hidden=false;this.disabled=false;this.attributes={}}
 append(...children){this.children.push(...children)}
 replaceChildren(...children){this.children=[...children]}
 setAttribute(name,value){this.attributes[name]=value}
 addEventListener(name,callback){this.listeners[name]=callback}
}
const el=(name,text)=>new Element(name,text)
const flush=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setTimeout(resolve,0))}
const texts=node=>[node.textContent,...node.children.flatMap(texts)].filter(Boolean)

test('overlay frames are sanitised before they can move a window',()=>{
 assert.equal(computerOverlayFrame({type:'caption'}),null)
 assert.equal(computerOverlayFrame({type:'computer_use',conversation_id:'b',state:'grabbing'}),null)
 assert.equal(computerOverlayFrame({type:'computer_use',conversation_id:'',state:'active'}),null)
 assert.deepEqual(computerOverlayFrame({type:'computer_use',conversation_id:'b',state:'acting',action:'computer_click',point:{x:10.6,y:20.2},summary:'x'.repeat(300),extra:1}),
  {type:'computer_use',conversation_id:'b',state:'acting',action:'computer_click',point:{x:11,y:20},summary:'x'.repeat(120)})
 assert.deepEqual(computerOverlayFrame({type:'computer_use',conversation_id:'b',state:'active',action:'rm_rf',point:{x:Infinity,y:1}}),{type:'computer_use',conversation_id:'b',state:'active'})
})

test('bar detail puts pending approval first and shows click coordinates',()=>{
 assert.equal(computerOverlayDetail({state:'acting',action:'computer_click',point:{x:4,y:5},awaiting_approval:true}),'等待你在工作台批准下一步')
 assert.equal(computerOverlayDetail({state:'acting',action:'computer_click',point:{x:4,y:5}}),'点击 · 4, 5')
 assert.equal(computerOverlayDetail({state:'acting',action:'computer_type'}),'输入文字')
 assert.equal(computerOverlayDetail({state:'delegated'}),'已交给电脑助手执行')
 assert.equal(computerOverlayDetail({state:'active'}),'观察屏幕中')
 assert.equal(computerOverlayDetail(null),'')
})

test('input marks are drawn relative to the display and never for screenshots',()=>{
 assert.deepEqual(computerOverlayMark({state:'acting',action:'computer_click',point:{x:110,y:60},origin:{x:100,y:25}}),{x:10,y:35,kind:'click',label:'点击'})
 assert.equal(computerOverlayMark({state:'acting',action:'computer_screenshot',point:{x:1,y:1},origin:{x:0,y:0}}),null)
 assert.equal(computerOverlayMark({state:'active',action:'computer_click',point:{x:1,y:1},origin:{x:0,y:0}}),null)
})

test('computer calls read as actions in the Build log',()=>{
 assert.equal(computerCallTarget({name:'computer_click',input:'{"x":12,"y":34}'}),'点击 · 12, 34')
 assert.equal(computerCallTarget({name:'computer_scroll',input:'{"x":1,"y":2,"direction":"down"}'}),'滚动 · 向下')
 assert.equal(computerCallTarget({name:'computer_type',input:JSON.stringify({text:'a'.repeat(50)})}),'输入 · “'+'a'.repeat(40)+'…”')
 assert.equal(computerCallTarget({name:'computer_run',input:'{"instr'}),'电脑助手')
 assert.equal(computerCallTarget({name:'shell_execute',input:'{}'}),null)
})

function indicatorFixture(build){
 const sent=[],commands=[]
 let stop
 const c={connected:true,snapshot:{conversations:{items:[{id:'b',kind:'build',build}]}},command:async(method,params)=>{commands.push([method,params])}}
 const api={computerUse:{overlay:frame=>sent.push(frame),clear:()=>sent.push('clear'),onStop:callback=>{stop=callback}}}
 return {c,sent,commands,indicator:createComputerUseIndicator({c,api}),stop:id=>stop(id)}
}

test('indicator follows frames, marks approval and drops back to idle when the Build stops',()=>{
 const build={status:'running',computer_use:{enabled:true,direct:true}},{c,sent,indicator}=indicatorFixture(build)
 indicator.receive({type:'computer_use',conversation_id:'b',state:'acting',action:'computer_click',point:{x:1,y:2}})
 assert.deepEqual(sent.at(-1),{type:'computer_use',conversation_id:'b',state:'acting',action:'computer_click',point:{x:1,y:2}})
 build.status='awaiting_approval';indicator.update()
 assert.equal(sent.at(-1).awaiting_approval,true)
 indicator.update();assert.equal(sent.length,2,'unchanged projections are not re-sent')
 build.status='paused';indicator.update()
 assert.deepEqual(sent.at(-1),{type:'computer_use',conversation_id:'b',state:'idle'})
 indicator.receive({type:'computer_use',conversation_id:'b',state:'active'})
 assert.equal(sent.at(-1).state,'idle','a paused Build never shows as controlling the screen')
 build.status='running';indicator.receive({type:'computer_use',conversation_id:'b',state:'active'})
 c.connected=false;indicator.update();assert.equal(sent.at(-1),'clear')
})

test('indicator hides when Computer Use is switched off and Stop from the bar stops that Build',async()=>{
 const build={status:'running',computer_use:{enabled:true,direct:true}},{sent,commands,indicator,stop}=indicatorFixture(build)
 indicator.receive({type:'computer_use',conversation_id:'b',state:'active'})
 build.computer_use.enabled=false;indicator.update()
 assert.equal(sent.at(-1).state,'idle')
 stop('b');await flush()
 assert.deepEqual(commands,[['build.stop',{id:'b'}]])
})

function controlFixture(item,{response,permissions={screen:'granted',accessibility:'denied'}}={}){
 const commands=[],opened=[]
 const c={connected:true,selectedId:item.id,selectedConversation:item,command:async(method,params)=>{commands.push([method,params]);return response}}
 const api={welcome:{get:async()=>({permissions}),permission:async kind=>opened.push(kind)},orbMenu:{openSettings:category=>opened.push('settings:'+category)}}
 const bar=el('div'),root=el('section'),control=mountComputerUseControl(bar,root,{c,el,run:callback=>callback(),api})
 return {c,commands,opened,bar,root,control,toggle:bar.children[0],panel:root.children[0]}
}

test('Computer Use switch appears only in Build sessions and reflects the stored state',()=>{
 const chat=controlFixture({id:'chat:main',kind:'chat'});chat.control.update();assert.equal(chat.toggle.hidden,true)
 const finished=controlFixture({id:'b',kind:'build',build:{status:'finished'}});finished.control.update();assert.equal(finished.toggle.hidden,true)
 const on=controlFixture({id:'b',kind:'build',build:{status:'paused',computer_use:{enabled:true,direct:false}}});on.control.update()
 assert.equal(on.toggle.hidden,false);assert.equal(on.toggle.attributes['aria-checked'],'true')
 assert.equal(on.toggle.children[2].textContent,'仅委派');assert.equal(on.toggle.children[2].hidden,false)
 on.c.connected=false;on.control.update();assert.equal(on.toggle.disabled,true)
})

test('turning Computer Use on sends the permission readout and lists each missing item with a fix',async()=>{
 const item={id:'b',kind:'build',build:{status:'paused'}}
 const {commands,opened,toggle,panel,control}=controlFixture(item,{response:{ok:false,state:{enabled:false,direct:false},missing:['accessibility_permission','configuration']}})
 control.update();toggle.listeners.click();await flush()
 assert.deepEqual(commands,[['build.computer_use',{conversation_id:'b',enabled:true,permissions:{screen:'granted',accessibility:'denied'}}]])
 assert.equal(panel.hidden,false);assert.equal(panel.attributes['data-tone'],'blocked')
 const rows=panel.children[1].children
 assert.deepEqual(rows.map(row=>row.attributes['data-item']),['accessibility_permission','configuration'])
 rows[0].children[1].listeners.click();rows[1].children[1].listeners.click();await flush()
 assert.deepEqual(opened,['accessibility','settings:connections'])
 assert.ok(texts(panel).includes('还不能打开 Computer Use'))
})

test('turning Computer Use off sends no permissions and a vision-less model is explained, not blocked',async()=>{
 const item={id:'b',kind:'build',build:{status:'paused',computer_use:{enabled:true,direct:true}}}
 const off=controlFixture(item,{response:{ok:true,state:{enabled:false,direct:false},missing:[]}})
 off.control.update();off.toggle.listeners.click();await flush()
 assert.deepEqual(off.commands,[['build.computer_use',{conversation_id:'b',enabled:false}]]);assert.equal(off.panel.hidden,true)
 const limited=controlFixture({id:'b',kind:'build',build:{status:'paused'}},{response:{ok:true,state:{enabled:true,direct:false},missing:['vision_model']}})
 limited.control.update();limited.toggle.listeners.click();await flush()
 assert.equal(limited.panel.attributes['data-tone'],'limited');assert.ok(texts(limited.panel).includes('Computer Use 已打开（仅委派）'))
})

test('overlay pages and new workbench strings are translated',async context=>{
 setLanguage('en');context.after(()=>setLanguage('zh-CN'))
 for(const file of ['computer-edge.html','computer-bar.html']){
  const html=await readFile(new URL(`../src/renderer/${file}`,import.meta.url),'utf8')
  const sources=[...html.matchAll(/>([^<>]+)</g)].map(m=>m[1].trim()).concat([...html.matchAll(/(?:title|aria-label)="([^"]+)"/g)].map(m=>m[1]))
  for(const source of sources.filter(s=>/\p{Script=Han}/u.test(s)))assert.doesNotMatch(t(source),/\p{Script=Han}/u,source)
 }
 for(const source of ['等待你在工作台批准下一步','正在停止…','停止失败，请在工作台点击停止','还不能打开 Computer Use','Computer Use 已打开（仅委派）','仅委派','操作后的屏幕','截图暂不可用。','尚未配置电脑操作模型和目标显示器。'])
  assert.doesNotMatch(t(source),/\p{Script=Han}/u,source)
})
