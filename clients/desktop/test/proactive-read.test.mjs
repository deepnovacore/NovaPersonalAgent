import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
test('proactive read requires expanded focused visible final rendered message and is idempotent', async () => {
 const source=await readFile(new URL('../src/renderer/personal-view.mjs',import.meta.url),'utf8')
 const calls=[];const c={connected:true,collapsed:false,selectedId:'p',snapshot:{conversations:{items:[{id:'p',kind:'proactive',unread_count:2}],messages:[{id:'m',conversation_id:'p'}]}},command:(...args)=>{calls.push(args);return Promise.resolve()}}
 const document={visibilityState:'visible',hasFocus:()=>true};const history={scrollHeight:200,scrollTop:100,clientHeight:100}
 const context=vm.createContext({c,document,history,readMessages:new Set()})
 vm.runInContext(source.slice(source.indexOf(' function markVisibleRead(){'),source.indexOf(" history.addEventListener('scroll'")),context)
 c.collapsed=true;context.markVisibleRead();c.collapsed=false
 document.visibilityState='hidden';context.markVisibleRead();document.visibilityState='visible'
 history.scrollTop=0;context.markVisibleRead();history.scrollTop=100
 document.hasFocus=()=>false;context.markVisibleRead();document.hasFocus=()=>true
 assert.equal(calls.length,0)
 context.markVisibleRead();context.markVisibleRead()
 assert.equal(calls.length,1);assert.equal(calls[0][0],'conversations.read');assert.equal(calls[0][1].through_message_id,'m')
})
