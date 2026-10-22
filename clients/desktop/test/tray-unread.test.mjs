import test from 'node:test'
import assert from 'node:assert/strict'
import {resetTrayUnreadForBackend,trayClickAction,updateTrayUnread} from '../src/main/tray-unread.mjs'
test('tray clears stale unread on disconnect and connection replacement only',()=>{
 const calls=[];const tray={setTitle:value=>calls.push(['title',value]),setToolTip:value=>calls.push(['tip',value])};const connection={}
 updateTrayUnread(tray,3,'darwin');assert.equal(calls[0][1],'3');calls.length=0
 resetTrayUnreadForBackend(tray,{connection},{state:'connected',connection},'darwin');assert.equal(calls.length,0)
 for(const next of [{state:'reconnecting',connection:null},{state:'starting',connection:null},{state:'connected',connection:{}}]){resetTrayUnreadForBackend(tray,{connection},next,'darwin');assert.deepEqual(calls.splice(0),[['title',''],['tip','Nova Personal Agent Desktop']])}
 updateTrayUnread(tray,2,'linux');assert.deepEqual(calls,[['tip','Nova · 2 条未读提醒']])
})
test('tray click leads to pending items and only toggles when nothing is pending',()=>{
 assert.equal(trayClickAction(1,true),'attention');assert.equal(trayClickAction(2,false),'attention')
 assert.equal(trayClickAction(0,true),'hide');assert.equal(trayClickAction(0,false),'workbench')
})
