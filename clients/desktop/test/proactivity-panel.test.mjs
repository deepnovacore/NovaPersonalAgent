import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createProactivityPanel, clampDailyCap, memoryEmbeddingNote, rankFallbackNote} from '../src/renderer/proactivity-panel.mjs'
import {moduleStatusNote} from '../src/renderer/capabilities-editor.mjs'
class Node{constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.dataset={};this.className='';this.textContent=''}append(...c){this.children.push(...c)}replaceChildren(...c){this.children=c}setAttribute(k,v){this[k]=v}addEventListener(k,v){this.listeners[k]=v}}
const all=n=>[n,...n.children.flatMap(all)]
function harness(settings={},{failState=false,rankFallback}={}){
 const root=new Node('div'),error=new Node('p'),calls=[]
 const document={querySelector:sel=>sel==='#proactivity-panel'?root:error,createElement:tag=>new Node(tag)}
 const state={capabilities:{discovery:true},settings:{discovery_enabled:true,discovery_interval_minutes:30,...settings}}
 const api={personalCommand:async(method,params)=>{calls.push([method,params]);if(method==='state')return failState?{error:'unavailable'}:state;return {ok:true}}}
 const panel=createProactivityPanel({document,api,moduleStatusNote,...(rankFallback?{rankFallback}:{})})
 const tick=()=>new Promise(r=>setImmediate(r))
 return {root,error,calls,panel,tick,state,
  button:label=>all(root).find(n=>n.tag==='button'&&(n.textContent===label||n['aria-label']===label)),
  cap:()=>all(root).find(n=>n.tag==='input'&&n['aria-label']==='每日主动消息上限')}
}
test('panel holds discovery, briefing, quiet hours and the daily cap',async()=>{
 const h=harness();await h.panel.load()
 const labels=all(h.root).map(n=>n['aria-label']).filter(Boolean)
 for(const label of ['主动发现间隔','早间简报','晚间简报','免打扰开始','免打扰结束','时区','周一','周日','每日主动消息上限'])assert.ok(labels.includes(label),label)
 assert.ok(h.button('保存简报设置'));assert.equal(h.cap().value,'5');assert.equal(h.cap().min,'1');assert.equal(h.cap().max,'10')
 assert.ok(all(h.root).some(n=>n.textContent==='agent 主动找你的消息每天最多几条；你自己发起的任务结果不计入。'))
})
test('changing the cap sends discovery.configure with proactive_daily_cap and only that field',async()=>{
 const h=harness({proactive_daily_cap:5});await h.panel.load();assert.equal(h.cap().value,'5')
 h.cap().value='7';h.cap().listeners.change();await h.tick()
 assert.deepEqual(h.calls[1],['discovery.configure',{proactive_daily_cap:7}])
 await h.button('增加上限').listeners.click();await h.tick();await h.tick()
 assert.deepEqual(h.calls.filter(c=>c[0]==='discovery.configure').at(-1),['discovery.configure',{proactive_daily_cap:6}])
})
test('out of range cap values are clamped and the bounds never send a command',async()=>{
 assert.equal(clampDailyCap(0),1);assert.equal(clampDailyCap(99),10);assert.equal(clampDailyCap(-4),1);assert.equal(clampDailyCap(4.6),5);assert.equal(clampDailyCap('abc'),5)
 const h=harness({proactive_daily_cap:10});await h.panel.load();const before=h.calls.length
 await h.button('增加上限').listeners.click();await h.tick();assert.equal(h.calls.length,before)
 h.cap().value='500';h.cap().listeners.change();await h.tick();assert.equal(h.calls.length,before);assert.equal(h.cap().value,'10')
 const low=harness({proactive_daily_cap:1});await low.panel.load();const n=low.calls.length
 low.cap().value='-3';low.cap().listeners.change();await low.tick();assert.equal(low.calls.length,n);assert.equal(low.cap().value,'1')
 const hi=harness({proactive_daily_cap:3});await hi.panel.load();hi.cap().value='99';hi.cap().listeners.change();await hi.tick()
 assert.deepEqual(hi.calls[1],['discovery.configure',{proactive_daily_cap:10}])
})
test('discovery interval and briefing save still use discovery.configure',async()=>{
 const h=harness();await h.panel.load()
 const select=all(h.root).find(n=>n.tag==='select');select.value='0';select.listeners.change();await h.tick()
 assert.deepEqual(h.calls[1],['discovery.configure',{enabled:false}])
 await h.button('保存简报设置').listeners.click();await h.tick()
 assert.equal(h.calls.filter(c=>c[0]==='discovery.configure').at(-1)[1].briefing_weekdays.length,5)
})
test('controls are disabled before state arrives and a failed read surfaces the error',async()=>{
 const h=harness();assert.equal(h.cap().disabled,true)
 const bad=harness({},{failState:true});await bad.panel.load();assert.equal(bad.error.textContent,'unavailable')
})
test('memory status row is hidden when the runtime does not report it and shown when it does',async()=>{
 const h=harness();await h.panel.load();h.panel.setMemory(undefined)
 assert.ok(!all(h.root).some(n=>n.dataset.memoryStatus))
 h.panel.setMemory({enabled:true,reason:null,fallback:null})
 assert.ok(all(h.root).some(n=>n.dataset.memoryStatus==='on'&&all(n).some(c=>c.textContent==='记忆嵌入可用')))
 h.panel.setMemory({enabled:false,reason:'missing_environment:DASHSCOPE_API_KEY',fallback:null})
 assert.ok(all(h.root).some(n=>n.dataset.memoryStatus==='off'&&all(n).some(c=>c.textContent==='未配置 · 需要 DASHSCOPE_API_KEY')))
 assert.equal(memoryEmbeddingNote(null,moduleStatusNote),null);assert.equal(memoryEmbeddingNote({},moduleStatusNote),null)
})
test('the settings page mounts the panel and no longer carries the removed settings',()=>{
 const html=readFileSync(new URL('../src/renderer/settings.html',import.meta.url),'utf8')
 assert.match(html,/id="proactivity-panel"/);assert.match(html,/<details id="proactivity-advanced">[\s\S]*id="heartbeat"[\s\S]*<\/details>/)
 const connections=readFileSync(new URL('../src/renderer/connections-panel.mjs',import.meta.url),'utf8')
 assert.ok(!/daily-brief-view|discovery\.configure/.test(connections))
 const notification=readFileSync(new URL('../src/renderer/notification-settings.mjs',import.meta.url),'utf8')
 assert.ok(!/legacy/.test(notification))
})
test('news fallback row shows only without an OpenRouter key and sends news_rank_fallback alone',async()=>{
 const rows=h=>all(h.root).filter(n=>n.tag==='input'&&n['aria-label']==='用对话模型判断资讯相关度')
 const keyed=harness({},{rankFallback:()=>({keyMissing:false,provider:'Qwen'})});await keyed.panel.load();assert.equal(rows(keyed).length,0)
 assert.ok(!all(keyed.root).some(n=>String(n.textContent).includes('OpenRouter')))
 const bare=harness({},{});await bare.panel.load();assert.equal(rows(bare).length,0,'no fallback info means no row')
 const h=harness({},{rankFallback:()=>({keyMissing:true,provider:'Qwen'})});await h.panel.load()
 assert.ok(all(h.root).some(n=>n.textContent==='没有 OpenRouter 密钥时，会用你的对话模型（Qwen）判断资讯相关度：你的兴趣和文章标题会发给它。'))
 const [box]=rows(h);assert.equal(box.checked,true,'on by default');assert.equal(box.disabled,false)
 box.checked=false;box.listeners.change();await h.tick()
 assert.deepEqual(h.calls[1],['discovery.configure',{news_rank_fallback:false}])
 const off=harness({news_rank_fallback:false},{rankFallback:()=>({keyMissing:true,provider:null})});await off.panel.load()
 assert.equal(rows(off)[0].checked,false);assert.equal(rankFallbackNote(null),'没有 OpenRouter 密钥时，会用你的对话模型判断资讯相关度：你的兴趣和文章标题会发给它。','unnamed provider stays generic')
})
