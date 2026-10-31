import test from 'node:test'
import assert from 'node:assert/strict'
import {systemNotificationsView} from '../src/renderer/system-notifications-view.mjs'

test('an unsupported system explains itself and offers nothing to click',()=>{
 const view=systemNotificationsView({supported:false,enabled:true,state:'unsupported',error:null},'linux')
 assert.equal(view.tone,'muted');assert.equal(view.canOpenSettings,false);assert.match(view.hint,/不支持/)
})
test('a user who turned it off is told nothing will pop up, with no scary tone',()=>{
 const view=systemNotificationsView({supported:true,enabled:false,state:'unverified',error:null},'darwin')
 assert.equal(view.tone,'muted');assert.match(view.hint,/不会弹出/)
})
test('before the first notification the state is honestly unknown and the settings pane is one click away',()=>{
 const view=systemNotificationsView({supported:true,enabled:true,state:'unverified',error:null},'darwin')
 assert.equal(view.tone,'neutral');assert.equal(view.canOpenSettings,true);assert.match(view.hint,/尚未确认|还没有/)
})
test('a failure is surfaced with the platform-specific place to fix it',()=>{
 const mac=systemNotificationsView({supported:true,enabled:true,state:'failed',error:'not allowed'},'darwin')
 assert.equal(mac.tone,'warning');assert.equal(mac.canOpenSettings,true);assert.match(mac.hint,/系统设置/);assert.match(mac.hint,/通知/)
 const win=systemNotificationsView({supported:true,enabled:true,state:'failed',error:'x'},'win32')
 assert.match(win.hint,/专注助手|勿扰|通知/)
})
test('a working state is plain and quiet',()=>{
 const view=systemNotificationsView({supported:true,enabled:true,state:'working',error:null},'darwin')
 assert.equal(view.tone,'ok');assert.equal(view.canOpenSettings,true)
})
test('a missing status is treated as loading, never as an error',()=>{
 const view=systemNotificationsView(null,'darwin');assert.equal(view.tone,'muted');assert.equal(view.canOpenSettings,false)
})
