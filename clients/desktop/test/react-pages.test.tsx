import test from 'node:test'
import assert from 'node:assert/strict'
import React, {act} from 'react'
import {JSDOM} from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'https://nova.local/'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Element:dom.window.Element,Node:dom.window.Node,NodeFilter:dom.window.NodeFilter,HTMLInputElement:dom.window.HTMLInputElement,CustomEvent:dom.window.CustomEvent,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle,Event:dom.window.Event,MouseEvent:dom.window.MouseEvent,IS_REACT_ACT_ENVIRONMENT:true})
const {createRoot}=await import('react-dom/client')
const {WorkspacePage}=await import('../src/renderer/react/pages.tsx')
async function mount(page:string,snapshot:any,handler:any=async()=>{}){
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),calls:any[]=[]
 const c={connected:true,everConnected:true,snapshot,command:async(m:any,p:any)=>{calls.push([m,p]);return handler(m,p)}}
 const props:any={page,c,run:async(fn:any)=>{try{await fn()}catch{}},api:{personal:{openArticle:async()=>{}}},discuss:async(...args:any[])=>calls.push(['discuss',...args]),startConversation:async(...args:any[])=>calls.push(['start',...args]),openTask:()=>{},openSettings:()=>{}}
 await act(async()=>{root.render(<WorkspacePage {...props}/>)});
 const click=async(text:string,scope:Element=host)=>{const node=[...scope.querySelectorAll('button')].find(n=>n.textContent===text);assert.ok(node,`button ${text}`);await act(async()=>{node!.click()})}
 const input=async(label:string,value:string)=>{const node=host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;assert.ok(node,label);await act(async()=>{Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));node.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})}
 return {host,c,calls,click,input,api:props.api,props,render:async()=>act(async()=>root.render(<WorkspacePage {...props}/>)),close:async()=>{await act(async()=>root.unmount());host.remove()}}
}
const life={ideas:[{id:'i1',kind:'idea',title:'Existing',note:'Original',status:'active',version:4}],goals:[],todos:[],profile:{version:2,about:'Bio'}}
test('idea edits carry expected version and survive failed save',async()=>{
 const p=await mount('ideas',{life},async()=>{throw Error('version_conflict')});await p.click('编辑');await p.input('想法标题','My retained edit');await p.click('保存修改');assert.equal((p.host.querySelector('[aria-label="想法标题"]') as HTMLInputElement).value,'My retained edit');assert.deepEqual(p.calls[0],['life.mutate',{op:'update',kind:'idea',id:'i1',expected_version:4,title:'My retained edit',note:'Original',importance:'normal',goal_id:null}]);await p.close()
})
test('timeline mutations are versioned and planning starts a referenced conversation',async()=>{
 const p=await mount('timeline',{life:{...life,todos:[{id:'t1',title:'Ship',status:'open',version:7,due:'2026-10-29',importance:'normal'}]}});await p.click('标记完成');assert.deepEqual(p.calls[0],['life.mutate',{op:'update',kind:'todo',id:'t1',expected_version:7,status:'done'}]);await p.click('拆成行动步骤');assert.deepEqual(p.calls[1][1].references,[{kind:'todo',id:'t1',version:7}]);await p.close()
})
test('news conversion draft survives conflict and retains article content hash',async()=>{
 const p=await mount('feeds',{life,news:{enabled:true,items:[{id:'a1',title:'Article',content_hash:'hash1',source_id:'s',summary:'Summary'}],saved:[],interests:[],sources:[]}},async()=>{throw Error('version_conflict')});await p.click('转为个人事项');await p.input('个人事项标题','My idea');await p.click('保存个人事项');assert.equal((p.host.querySelector('[aria-label="个人事项标题"]') as HTMLInputElement).value,'My idea');assert.equal(p.calls[0][1].content_hash,'hash1');await p.close()
})
test('profile and soul edits retain original versions when snapshot changes',async()=>{
 const p=await mount('profile',{life,soul:{available:true,role:'Helpful',version:3,assistant_name:'Nova'},news:{enabled:false,interests:[],profile_version:1}},async()=>{throw Error('stale')});await p.click('编辑介绍');await p.input('关于我','Revised bio');await p.click('保存介绍');assert.equal((p.host.querySelector('[aria-label="关于我"]') as HTMLTextAreaElement).value,'Revised bio');assert.equal(p.calls[0][1].expected_version,2);await p.close()
})
test('pending idea mutations stay single flight and unlock after rejection',async()=>{
 let reject:any;const wait=new Promise((_,r)=>{reject=r});const p=await mount('ideas',{life},async()=>wait);await p.click('编辑');await p.click('保存修改');const save=[...p.host.querySelectorAll('button')].find(b=>b.textContent==='保存修改')!;assert.equal(save.disabled,true);await act(async()=>save.click());assert.equal(p.calls.length,1);await act(async()=>reject(Error('version_conflict')));assert.equal(save.disabled,false);await p.close()
})
test('article conversion disables saving when the referenced content changes',async()=>{
 const item={id:'a1',title:'Article',content_hash:'hash1',source_id:'s',summary:'Summary'};const p=await mount('feeds',{life,news:{enabled:true,items:[item],saved:[],interests:[],sources:[]}});await p.click('转为个人事项');await p.input('个人事项标题','Keep my title');p.c.snapshot={...p.c.snapshot,news:{...p.c.snapshot.news,items:[{...item,content_hash:'hash2'}]}};await p.render();const save=[...p.host.querySelectorAll('button')].find(b=>b.textContent==='保存个人事项')!;assert.equal(save.disabled,true);assert.equal((p.host.querySelector('[aria-label="个人事项标题"]') as HTMLInputElement).value,'Keep my title');await p.close()
})
test('memory corrections retain editing version and text after a conflict',async()=>{
 const entry={id:'m1',topic:'Note',content:'Original memory',status:'active',version:11};const p=await mount('profile',{life,memory:{entries:[entry]},capabilities:{memory:{list:true,correct:true,forgetEntry:true,purgeEntry:true}}},async()=>{throw Error('version_conflict')});await p.click('纠正');await p.input('纠正记忆内容','Corrected memory');p.c.snapshot={...p.c.snapshot,memory:{entries:[{...entry,version:12,content:'Remote update'}]}};await p.render();await p.click('保存纠正');assert.deepEqual(p.calls[0],['memory.correct',{id:'m1',expected_version:11,content:'Corrected memory'}]);assert.equal((p.host.querySelector('[aria-label="纠正记忆内容"]') as HTMLTextAreaElement).value,'Corrected memory');await p.close()
})
test('archive filter reveals retained ideas without changing their status',async()=>{
 const p=await mount('ideas',{life:{...life,ideas:[...life.ideas,{id:'old',title:'Archived idea',status:'archived',version:2}]}});assert.equal(p.host.textContent?.includes('Archived idea'),false);await p.click('显示已完成／归档');assert.equal(p.host.textContent?.includes('Archived idea'),true);assert.equal(p.calls.length,0);await p.close()
})
test('disconnected workspace leaves edits visible and prevents mutations',async()=>{
 const p=await mount('ideas',{life});await p.click('编辑');await p.input('想法标题','Unsaved idea');p.c.connected=false;await p.render();assert.equal((p.host.querySelector('[aria-label="想法标题"]') as HTMLInputElement).value,'Unsaved idea');assert.ok([...p.host.querySelectorAll('button,input,textarea,select')].every((el:any)=>el.disabled));await p.close()
})
test('brief pagination preserves date grouping and historical action restrictions',async()=>{
 const cards=Array.from({length:10},(_,i)=>({id:'b'+i,title:'Brief '+i,version:1,kind:'progress',historical:i===0,time:{anchor_date:'2026-10-28',anchor_basis:'reported'},facts:[],actions:[{kind:'discuss',label:'Discuss '+i}],sources:[]}));const p=await mount('timeline',{life,timeline:{status:'ready',generation_id:'g1',cards}});assert.equal(p.host.querySelectorAll('.timeline-attention-card').length,8);assert.equal([...p.host.querySelectorAll('button')].some(b=>b.textContent==='Discuss 0'),false);await p.click('继续查看进展（还有 2 条）');assert.equal(p.host.querySelectorAll('.timeline-attention-card').length,10);assert.equal(document.activeElement?.getAttribute('data-object-id'),'b8');assert.equal(p.host.querySelectorAll('[data-date="2026-10-28"]').length,1);await p.close()
})
test('briefing metadata stays within two lines and follows the problem priority',async()=>{
 const cards=[{id:'b0',title:'Brief',version:1,kind:'progress',time:{anchor_date:'2026-10-28',anchor_basis:'reported'},facts:[],actions:[],sources:[]}],coverage='本轮资料：1519 条消息 · 0 份文档 · 0 条个人记录；消息记录 2026-10-01—2026-10-30',base={status:'ready',generation_id:'g1',cards,input_count:3,coverage,updated_at:'2026-10-28T00:35:00Z'}
 const check=async(timeline:any,extra:any,expected:string[])=>{const p=await mount('timeline',{life,timeline,...extra});try{const lines=[...p.host.querySelectorAll('.timeline-meta-line')];assert.ok(lines.length<=2,'at most two lines');assert.equal(lines.length,expected.length);expected.forEach((text,i)=>assert.ok(lines[i].textContent!.includes(text),`${lines[i].textContent} includes ${text}`));return {p,lines}}finally{await p.close()}}
 const {lines:normal}=await check(base,{},['1519 条消息 · 0 份文档 · 0 条个人记录 · 共 1 条（已展示 1）']);assert.equal(normal[0].getAttribute('title'),'消息记录 2026-10-01—2026-10-30');assert.equal(normal[0].textContent!.includes('卡片按事项时间排列'),false)
 await check({...base,status:'failed',diagnostics:{pending_batches:1}},{sources:[{id:'s',state:'connected',processing_consent_required:true}]},['共 1 条','部分资料需要授权后才能整理 · 查看来源'])
 await check({...base,status:'failed',diagnostics:{pending_batches:1}},{},['共 1 条','本次更新未完成，已保留上次结果'])
 await check({...base,diagnostics:{failed_batches:[{batch:1}]}},{},['共 1 条','部分资料尚未整理，可刷新补充'])
 const p=await mount('timeline',{life,timeline:base,sources:[{id:'s',state:'connected',path:'/tmp/docs',processing_consent_required:true}]});try{assert.equal(p.host.querySelectorAll('.source-status').length,1);const d=p.host.querySelector('.source-status') as HTMLDetailsElement;assert.equal(d.open,false)}finally{await p.close()}
})
test('source cards expose their evidence from the keyboard context menu',async()=>{
 const p=await mount('ideas',{life:{...life,ideas:[{...life.ideas[0],sources:[{type:'file',label:'Evidence.txt',summary:'Grounded',url:'javascript:alert(1)'}]}]}});const card=p.host.querySelector('[data-life-id="i1"]')!;await act(async()=>{card.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))});assert.ok(p.host.querySelector('[role="menuitem"]'));await act(async()=>{(p.host.querySelector('[role="menuitem"]') as HTMLButtonElement).click()});assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('Evidence.txt'));assert.equal(document.querySelector('[role="dialog"] a'),null);await p.close()
})
test('saved empty lists beside suggestions explain that suggestions stay separate from saved ideas',async()=>{
 const p=await mount('ideas',{life:{...life,ideas:[]},workbench_context:{cards:[{id:'s1',tab:'ideas',title:'Suggestion',body:'Grounded suggestion'}]}});assert.equal(p.host.textContent?.includes('还没有保存想法'),false);assert.ok(p.host.textContent?.includes('不会自动加入'));await p.close()
})
test('soul conflicts retain the role draft and show the specific stale message',async()=>{
 const p=await mount('assistant',{life,soul:{available:true,role:'Helpful',version:5,assistant_name:'Nova'}},async()=>{throw Object.assign(Error('stale'),{refusal_code:'stale'})});const card=p.host.querySelector('.soul-card')!;await act(async()=>{([...card.querySelectorAll('button')].find(b=>b.textContent==='编辑') as HTMLButtonElement).click()});await p.input('角色设定','Direct and helpful');await act(async()=>{([...card.querySelectorAll('button')].find(b=>b.textContent==='保存') as HTMLButtonElement).click()});assert.deepEqual(p.calls[0],['soul.set',{role:'Direct and helpful',expected_version:5}]);assert.equal((p.host.querySelector('[aria-label="角色设定"]') as HTMLTextAreaElement).value,'Direct and helpful');assert.ok(p.host.querySelector('[role="alert"]')?.textContent?.includes('草稿还在'));await p.close()
})
test('reading articles records read state only after successful opening',async()=>{
 const article={id:'a1',title:'Article',content_hash:'hash1',source_id:'s',summary:'Summary',url:'https://example.com/news'};const p=await mount('feeds',{life,news:{enabled:true,items:[article],saved:[],interests:[],sources:[]}});await p.click('阅读原文');assert.deepEqual(p.calls[0],['news.action',{action:'read',id:'a1',value:true}]);await p.click('收藏',p.host.querySelector('.news-card')!);assert.deepEqual(p.calls[1],['news.action',{action:'save',id:'a1',value:true}]);await p.close()
})
test('goal reminder cadence and deletion use the current record version',async()=>{
 const p=await mount('goals',{life:{...life,goals:[{id:'g1',title:'Learn',status:'active',version:3,progress:{total:0,done:0}}]}});const select=p.host.querySelector('[aria-label="Learn的提醒节奏"]') as HTMLSelectElement;await act(async()=>{select.value='daily';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}))});assert.deepEqual(p.calls[0],['life.mutate',{op:'update',kind:'goal',id:'g1',expected_version:3,cadence:'daily'}]);const previous=globalThis.confirm;globalThis.confirm=()=>true;try{await p.click('删除');assert.deepEqual(p.calls[1],['life.mutate',{op:'delete',kind:'goal',id:'g1',expected_version:3}])}finally{globalThis.confirm=previous;await p.close()}
})
test('diary actions use versioned forgetting and retain pagination commands',async()=>{
 const p=await mount('profile',{life,capabilities:{memory:{diaries:true}},memory:{diaries:[{id:'d1',day:'2026-10-27',text:'Diary',version:4}],diary_before:'2026-10-27'}});await p.click('删除日记');assert.deepEqual(p.calls[0],['memory.forget',{id:'d1',expected_version:4}]);await p.click('最新日记');assert.deepEqual(p.calls[1],['memory.diaries',{}]);await p.close()
})


test('about me hides history and generation mechanics while preserving current content',async()=>{
 const p=await mount('profile',{life:{...life,profile:{version:0,about:''}},profile_preparation:{status:'failed',needs_update:true,automatic_available:false,last_attempt_at:'2026-10-18T12:00:00Z',draft:{about:{text:'Current portrait',refs:[]},work:[],interests:[]},history:[{about:'Archived portrait'}]}})
 try{
  assert.equal(p.host.querySelector('h2')?.textContent,'关于我')
  assert.equal(p.host.querySelector('.profile-about')?.textContent,'Current portrait')
  const card=p.host.querySelector('.profile-main')!
  for(const text of ['历史版本','只读','每天最多','资料需要更新','资料尚未更新','Archived portrait'])assert.equal(card.textContent!.includes(text),false,text)
  assert.equal(p.host.querySelector('.profile-history'),null)
  // The profile card no longer hides generation state: the warmup strip at the top owns it.
  const warmup=p.host.querySelector('.warmup-status')!
  assert.ok(warmup.textContent!.includes('画像暂时未能更新'))
  assert.ok(warmup.textContent!.includes('上次尝试'))
  assert.equal(p.calls.length,0)
  await p.click('更新一下');assert.deepEqual(p.calls,[['profile.refresh',{}]])
 }finally{await p.close()}
})

const savedPortrait={generated_at:'2026-10-15T11:24:55Z',read_only:true,unavailable_sources:1,draft:{about:{text:'Saved full portrait '.repeat(30),refs:[]},work:[{title:'Earlier project',text:'Complete saved work description',refs:[]}],interests:[]},sources:[]}
test('saved full profile remains readable without a current recipe draft and never seeds editing',async()=>{
 const p=await mount('profile',{life:{...life,profile:{version:0,about:''}},profile_preparation:{status:'failed',needs_update:true,draft:null,last_success:savedPortrait}})
 try{
  const saved=p.host.querySelector('.profile-main');assert.ok(saved,'profile section')
  assert.ok(saved.textContent!.includes(savedPortrait.draft.about.text),'complete saved about')
  assert.ok(saved.textContent!.includes('Complete saved work description'),'complete work body')
  assert.equal(saved.textContent!.includes('只读'),false)
  assert.equal(saved.textContent!.includes('资料'),false)
  assert.equal(saved.querySelector('input,textarea,select'),null)
  await p.click('补充介绍');assert.equal((p.host.querySelector('[aria-label="关于我"]') as HTMLTextAreaElement).value,'')
  assert.equal(p.calls.length,0)
 }finally{await p.close()}
})
test('current and manually cleared profiles do not fall back to archived prose',async()=>{
 for(const profile of [{version:0,about:''},{version:2,about:''},{version:3,about:'Manual biography'}]){
  const p=await mount('profile',{life:{...life,profile},profile_preparation:{status:'ready',draft:profile.version===0?{about:{text:'Current portrait',refs:[]},work:[],interests:[]}:null,last_success:savedPortrait}})
  try{assert.equal(p.host.querySelector('.profile-about')?.textContent??'',profile.version===0?'Current portrait':profile.about);assert.equal(p.host.textContent!.includes(savedPortrait.draft.about.text),false)}finally{await p.close()}
 }
})
test('manual daily suggestions refresh forces another run for unchanged inputs on ideas and goals',async()=>{
 for(const page of ['ideas','goals']){
  const p=await mount(page,{life,workbench_context:{daily:true,status:'ready',cards:[]}})
  try{await p.click('重新整理');assert.deepEqual(p.calls,[['context.refresh',{force:true}]])}finally{await p.close()}
 }
})

test('personal profile contains neither assistant personality nor news preferences',async()=>{
 const p=await mount('profile',{life,soul:{available:true,role:'Helpful',assistant_name:'Nova'},news:{enabled:true,interests:[{text:'科学'}]}});
 assert.equal(p.host.querySelector('.soul-card'),null);assert.equal(p.host.querySelector('[aria-label="资讯兴趣"]'),null);assert.ok(p.host.querySelector('.profile-main'));await p.close()
})

test('assistant rename uses the existing local identity store and preserves a failed draft',async()=>{
 const p=await mount('assistant',{life,soul:{available:true,role:'Helpful',assistant_name:'Nova'}});const writes:any[]=[];let fail=true;
 (p.api as any).welcome={save:async(value:any)=>{writes.push(value);if(fail)throw Error('write_failed');return {profile:{assistantName:value.assistantName}}}};await p.render();
 await p.click('改名字');await p.input('助手名字','小星');await p.click('保存名字');assert.equal((p.host.querySelector('[aria-label="助手名字"]') as HTMLInputElement).value,'小星');fail=false;await p.click('保存名字');assert.equal(p.host.querySelector('[aria-label="助手名字"]'),null);assert.deepEqual(writes,[{assistantName:'小星'},{assistantName:'小星'}]);assert.equal(p.calls.length,0);await p.close()
})

test('assistant display follows the real saved identity envelope while runtime soul metadata lags',async()=>{
 const p=await mount('assistant',{life,soul:{available:true,role:'Helpful',assistant_name:'Old name'}});p.props.identity={profile:{assistantName:'小星'}};await p.render();assert.ok(p.host.querySelector('.soul-intro')?.textContent?.includes('我叫小星。'),'intro uses saved local identity');assert.equal(p.host.querySelector('.soul-row p')?.textContent,'小星');await p.close()
})


test('timeline no longer hosts suggestions awaiting confirmation',async()=>{
 const suggestions=[{id:'s1',kind:'idea',title:'Side project',body:'A grounded idea',project_id:null,todo_id:null,due:null,refs:[]},{id:'s2',kind:'goal',title:'Read weekly',body:'A grounded direction',project_id:null,todo_id:null,due:null,refs:[]}]
 const p=await mount('timeline',{life,timeline:{status:'ready',generation_id:'g1',cards:[]},derived_understanding:{projects:[],suggestions,sources:[]}})
 try{
  assert.equal(p.host.querySelector('.timeline-suggestions'),null)
  assert.equal(p.host.textContent!.includes('待确认建议'),false)
  for(const text of ['Side project','Read weekly','加入想法','加入目标'])assert.equal(p.host.textContent!.includes(text),false,text)
  assert.ok(p.host.textContent!.includes('这里展示已记录的事项，不代表完整日程。'))
  assert.ok(p.host.textContent!.includes('近期简报'))
 }finally{await p.close()}
})

test('ideas tab shows Nova suggestions as plain ideas with only ignore',async()=>{
 const suggestions=[{id:'s1',kind:'idea',title:'整理灵感',body:'把零散的想法收在一起',project_id:null,todo_id:null,due:null,refs:[]},{id:'s2',kind:'goal',title:'每周读一本书',body:'长期坚持的方向',project_id:null,todo_id:null,due:null,refs:[]}]
 const p=await mount('ideas',{life,derived_understanding:{projects:[],suggestions,sources:[]}})
 try{
  const section=p.host.querySelector('.nova-suggestions')!
  assert.ok(section,'Nova suggestion section')
  assert.equal(section.querySelector('h2')?.textContent,'Nova 的建议')
  const cards=[...section.querySelectorAll('.nova-suggestion')]
  assert.equal(cards.length,2)
  assert.equal(cards[0].getAttribute('data-suggestion-kind'),'idea')
  assert.ok(cards[0].textContent!.includes('整理灵感'))
  assert.ok(cards[0].textContent!.includes('把零散的想法收在一起'))
  for(const card of cards){
   assert.deepEqual([...card.querySelectorAll('button')].map(node=>node.getAttribute('aria-label')),['忽略'],'one corner close control, no text button')
   assert.equal(card.querySelector('.card-actions'),null)
   assert.equal(card.textContent!.includes('设为目标'),false)
   assert.equal(card.textContent!.includes('目标建议'),false)
   assert.equal(card.querySelector('.card-tag'),null)
  }
  assert.ok(section.textContent!.includes('根据你的资料整理的想法，不需要额外保存；不适用的直接忽略。'))
  for(const text of ['加入想法','加入目标'])assert.equal(section.textContent!.includes(text),false,text)
 }finally{await p.close()}
})

test('Nova suggestions dismiss through understanding command then hide',async()=>{
 const suggestions=[{id:'s1',kind:'idea',title:'Idea A',body:'Body A',project_id:null,todo_id:null,due:null,refs:[]},{id:'s2',kind:'goal',title:'Goal B',body:'Body B',project_id:null,todo_id:null,due:null,refs:[]}]
 const p=await mount('ideas',{life,derived_understanding:{projects:[],suggestions,sources:[]}})
 try{
  await act(async()=>{(p.host.querySelector('[data-suggestion-id="s1"] .card-close') as HTMLElement).click()})
  assert.deepEqual(p.calls[0],['understanding.dismiss',{id:'s1'}])
  assert.equal(p.host.querySelector('[data-suggestion-id="s1"]'),null)
  assert.ok(p.host.querySelector('[data-suggestion-id="s2"]'))
 }finally{await p.close()}
})

test('profile shows warmup status, icon work cards and read-only interest tags',async()=>{
 const p=await mount('profile',{life:{...life,profile:{version:0,about:''}},profile_preparation:{status:'working',draft:{about:{text:'Portrait',refs:[]},work:[{title:'Earlier project',text:'Complete saved work description',refs:[]},{title:'Second project',text:'Another description',refs:[]}],interests:[{text:'摄影'},{text:'城市漫步'}]},sources:[]}})
 try{
  const warmup=p.host.querySelector('.warmup-status')!
  assert.ok(warmup.textContent!.includes('正在后台更新画像'))
  const work=p.host.querySelectorAll('.profile-work-item')
  assert.equal(work.length,2)
  assert.equal(p.host.querySelectorAll('.profile-work-icon').length,2)
  assert.equal(p.host.querySelector('.profile-work-icon svg')?.getAttribute('aria-hidden'),'true')
  assert.equal(p.host.querySelector('.profile-interests h4')?.textContent,'关注')
  assert.deepEqual([...p.host.querySelectorAll('.profile-interests .interest-tag')].map(node=>node.textContent),['摄影','城市漫步'])
  assert.equal(p.host.querySelector('.profile-interests input, .profile-interests textarea, .profile-interests button'),null)
  assert.equal(p.host.querySelector('.soul-card'),null)
  assert.equal(p.host.querySelector('[aria-label="资讯兴趣"]'),null)
 }finally{await p.close()}
})
