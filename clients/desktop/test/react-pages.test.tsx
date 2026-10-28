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
 const props={page,c,run:async(fn:any)=>{try{await fn()}catch{}},api:{personal:{openArticle:async()=>{}}},discuss:async(...args:any[])=>calls.push(['discuss',...args]),startConversation:async(...args:any[])=>calls.push(['start',...args]),openTask:()=>{},openSettings:()=>{}}
 await act(async()=>{root.render(<WorkspacePage {...props}/>)});
 const click=async(text:string,scope:Element=host)=>{const node=[...scope.querySelectorAll('button')].find(n=>n.textContent===text);assert.ok(node,`button ${text}`);await act(async()=>{node!.click()})}
 const input=async(label:string,value:string)=>{const node=host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;assert.ok(node,label);await act(async()=>{Object.getOwnPropertyDescriptor(node.tagName==='TEXTAREA'?dom.window.HTMLTextAreaElement.prototype:dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));node.dispatchEvent(new dom.window.Event('change',{bubbles:true}))})}
 return {host,c,calls,click,input,render:async()=>act(async()=>root.render(<WorkspacePage {...props}/>)),close:async()=>{await act(async()=>root.unmount());host.remove()}}
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
 const p=await mount('profile',{life,soul:{available:true,role:'Helpful',version:3,assistant_name:'Nova'},news:{enabled:false,interests:[],profile_version:1}},async()=>{throw Error('stale')});await p.click('编辑概览');await p.input('关于我','Revised bio');await p.click('保存介绍');assert.equal((p.host.querySelector('[aria-label="关于我"]') as HTMLTextAreaElement).value,'Revised bio');assert.equal(p.calls[0][1].expected_version,2);await p.close()
})
test('pending idea mutations stay single flight and unlock after rejection',async()=>{
 let reject:any;const wait=new Promise((_,r)=>{reject=r});const p=await mount('ideas',{life},async()=>wait);await p.click('编辑');await p.click('保存修改');const save=[...p.host.querySelectorAll('button')].find(b=>b.textContent==='保存修改')!;assert.equal(save.disabled,true);await act(async()=>save.click());assert.equal(p.calls.length,1);await act(async()=>reject(Error('version_conflict')));assert.equal(save.disabled,false);await p.close()
})
test('interest version conflicts preserve custom selection across snapshot refresh',async()=>{
 const p=await mount('profile',{life,news:{enabled:true,explore:false,interests:[{id:'i',text:'科学'}],profile_version:8}},async()=>{throw Error('version_conflict')});await p.click('调整兴趣');await p.input('自定义兴趣','音乐');await p.click('添加');p.calls.length=0;p.c.snapshot={...p.c.snapshot,news:{...p.c.snapshot.news,profile_version:9}};await p.render();await p.click('完成调整');assert.deepEqual(p.calls[0],['news.configure',{enabled:true,explore:false,interests:['科学','音乐'],expected_version:8}]);assert.ok(p.host.querySelector('[role="alert"]')?.textContent?.includes('调整已保留'));await p.close()
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
test('source cards expose their evidence from the keyboard context menu',async()=>{
 const p=await mount('ideas',{life:{...life,ideas:[{...life.ideas[0],sources:[{type:'file',label:'Evidence.txt',summary:'Grounded',url:'javascript:alert(1)'}]}]}});const card=p.host.querySelector('[data-life-id="i1"]')!;await act(async()=>{card.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))});assert.ok(p.host.querySelector('[role="menuitem"]'));await act(async()=>{(p.host.querySelector('[role="menuitem"]') as HTMLButtonElement).click()});assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes('Evidence.txt'));assert.equal(document.querySelector('[role="dialog"] a'),null);await p.close()
})
test('saved empty lists beside suggestions explain that suggestions require adoption',async()=>{
 const p=await mount('ideas',{life:{...life,ideas:[]},workbench_context:{cards:[{id:'s1',tab:'ideas',title:'Suggestion',body:'Grounded suggestion'}]}});assert.equal(p.host.textContent?.includes('还没有保存想法'),false);assert.ok(p.host.textContent?.includes('不会自动加进来'));await p.close()
})
test('soul conflicts retain the role draft and show the specific stale message',async()=>{
 const p=await mount('profile',{life,soul:{available:true,role:'Helpful',version:5,assistant_name:'Nova'}},async()=>{throw Object.assign(Error('stale'),{refusal_code:'stale'})});const card=p.host.querySelector('.soul-card')!;await act(async()=>{([...card.querySelectorAll('button')].find(b=>b.textContent==='编辑') as HTMLButtonElement).click()});await p.input('角色设定','Direct and helpful');await act(async()=>{([...card.querySelectorAll('button')].find(b=>b.textContent==='保存') as HTMLButtonElement).click()});assert.deepEqual(p.calls[0],['soul.set',{role:'Direct and helpful',expected_version:5}]);assert.equal((p.host.querySelector('[aria-label="角色设定"]') as HTMLTextAreaElement).value,'Direct and helpful');assert.ok(p.host.querySelector('[role="alert"]')?.textContent?.includes('草稿还在'));await p.close()
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
