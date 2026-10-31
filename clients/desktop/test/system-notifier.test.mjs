import test from 'node:test'
import assert from 'node:assert/strict'
import {createSystemNotifier,systemNotificationSettingsUrl} from '../src/main/system-notifier.mjs'

function setup(options={}){
 const shown=[];let supported=options.supported??true
 class FakeNotification{
  static isSupported(){return supported}
  constructor(init){this.init=init;this.handlers={};shown.push(this)}
  on(event,handler){this.handlers[event]=handler;return this}
  show(){options.onShow?.(this)}
 }
 const state={visible:false,focused:false,enabled:true,activations:0,opened:[]}
 const notifier=createSystemNotifier({Notification:FakeNotification,platform:options.platform??'darwin',
  isEnabled:()=>state.enabled,windowState:()=>({visible:state.visible,focused:state.focused}),
  activate:()=>{state.activations++},shell:{openExternal:async url=>{state.opened.push(url)}}})
 return {notifier,shown,state,setSupported:value=>{supported=value}}
}
const item=(id,title,body='')=>({id,title,body})

test('a background arrival shows one notification and a click brings the workbench forward',()=>{
 const {notifier,shown,state}=setup()
 assert.equal(notifier.notify({items:[item('feed:a','今天下午评审','材料还没发')]}),'shown')
 assert.equal(shown.length,1);assert.equal(shown[0].init.title,'今天下午评审');assert.equal(shown[0].init.body,'材料还没发')
 shown[0].handlers.click();assert.equal(state.activations,1)
})
test('arrivals together become one merged notification listing at most three titles',()=>{
 const {notifier,shown}=setup()
 notifier.notify({items:['A','B','C','D'].map(t=>item('feed:'+t,'事项'+t))})
 assert.equal(shown.length,1);assert.equal(shown[0].init.title,'Nova · 4 条新提醒');assert.equal(shown[0].init.body,'事项A · 事项B · 事项C')
})
test('nothing is shown while the workbench is visible and focused, and those messages never fire later',()=>{
 const {notifier,shown,state}=setup()
 state.visible=state.focused=true
 assert.equal(notifier.notify({items:[item('feed:a','x')]}),'foreground')
 state.focused=false
 assert.equal(notifier.notify({items:[item('feed:a','x')]}),'duplicate');assert.equal(shown.length,0)
})
test('a visible but unfocused or a hidden workbench still notifies',()=>{
 const {notifier,shown,state}=setup()
 state.visible=true;notifier.notify({items:[item('feed:a','x')]});state.visible=false;notifier.notify({items:[item('feed:b','y')]})
 assert.equal(shown.length,2)
})
test('the same message id notifies once; a mixed batch only counts the new ids',()=>{
 const {notifier,shown}=setup()
 notifier.notify({items:[item('feed:a','一')]});assert.equal(notifier.notify({items:[item('feed:a','一')]}),'duplicate')
 notifier.notify({items:[item('feed:a','一'),item('feed:b','二')]});assert.equal(shown.length,2);assert.equal(shown[1].init.title,'二')
})
test('a disabled setting or an unsupported system shows nothing',()=>{
 const off=setup();off.state.enabled=false;assert.equal(off.notifier.notify({items:[item('feed:a','x')]}),'disabled');assert.equal(off.shown.length,0)
 const none=setup({supported:false});assert.equal(none.notifier.notify({items:[item('feed:a','x')]}),'unsupported');assert.equal(none.notifier.status().state,'unsupported')
})
test('turning the setting back on does not replay what arrived while it was off',()=>{
 const {notifier,shown,state}=setup();state.enabled=false
 notifier.notify({items:[item('feed:a','x')]});state.enabled=true
 assert.equal(notifier.notify({items:[item('feed:a','x')]}),'duplicate');assert.equal(shown.length,0)
})
test('the OS reporting a failed show is surfaced as status, and a later show clears it',()=>{
 const {notifier,shown}=setup()
 assert.equal(notifier.status().state,'unverified')
 notifier.notify({items:[item('feed:a','x')]});shown[0].handlers.failed({}, 'Notifications are not allowed for this application')
 assert.equal(notifier.status().state,'failed');assert.match(notifier.status().error,/not allowed/)
 notifier.notify({items:[item('feed:b','y')]});shown[1].handlers.show()
 assert.equal(notifier.status().state,'working');assert.equal(notifier.status().error,null)
})
test('payloads from the renderer are bounded and malformed ones are rejected',()=>{
 const {notifier,shown}=setup()
 assert.throws(()=>notifier.notify({items:'nope'}),/invalid/);assert.throws(()=>notifier.notify({items:[{id:1,title:'x'}]}),/invalid/)
 assert.throws(()=>notifier.notify({items:Array.from({length:51},(_,i)=>item('m'+i,'t'))}),/invalid/)
 notifier.notify({items:[item('feed:a','t'.repeat(500),'b'.repeat(2000))]})
 assert.ok(shown[0].init.title.length<=120);assert.ok(shown[0].init.body.length<=240)
})
test('the id set stays bounded so a long session cannot grow it without limit',()=>{
 const {notifier,shown,state}=setup();state.visible=state.focused=true
 for(let i=0;i<1500;i++)notifier.notify({items:[item('m'+i,'x')]})
 state.visible=state.focused=false
 assert.equal(notifier.notify({items:[item('m0','x')]}),'shown','the oldest id was forgotten')
 assert.equal(notifier.notify({items:[item('m1499','x')]}),'duplicate','recent ids are still remembered');assert.equal(shown.length,1)
})
test('system notification settings open the right pane per platform',async()=>{
 assert.equal(systemNotificationSettingsUrl('darwin'),'x-apple.systempreferences:com.apple.Notifications-Settings.extension')
 assert.equal(systemNotificationSettingsUrl('win32'),'ms-settings:notifications');assert.equal(systemNotificationSettingsUrl('linux'),null)
 const {notifier,state}=setup({platform:'win32'});assert.equal(await notifier.openSystemSettings(),true);assert.deepEqual(state.opened,['ms-settings:notifications'])
 const linux=setup({platform:'linux'});assert.equal(await linux.notifier.openSystemSettings(),false);assert.deepEqual(linux.state.opened,[])
})

test('the merged notification title follows the interface language',()=>{
 const shown=[];class N{static isSupported(){return true}constructor(init){shown.push(init)}on(){return this}show(){}}
 const translate=(source,...values)=>source==='Nova · {0} 条新提醒'?`Nova · ${values[0]} new reminders`:source
 const notifier=createSystemNotifier({Notification:N,platform:'darwin',isEnabled:()=>true,windowState:()=>({visible:false,focused:false}),activate(){},shell:{openExternal:async()=>{}},translate})
 notifier.notify({items:[{id:'a',title:'一',body:''},{id:'b',title:'二',body:''}]});assert.equal(shown[0].title,'Nova · 2 new reminders')
})
