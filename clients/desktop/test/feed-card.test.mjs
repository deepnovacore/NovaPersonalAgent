import {test} from 'node:test'
import assert from 'node:assert/strict'
import {renderFeedCard,feedActionLabel,sendPresented} from '../src/renderer/feed-card.mjs'
class Node{constructor(tag,text,cls){this.tag=tag;this.children=[];this.dataset={};this.className=cls??'';if(text!==undefined)this.textContent=text}append(...c){this.children.push(...c)}}
function harness(){
 const calls=[],opened=[],parent=new Node('div');let fail=false
 const el=(tag,text,cls)=>new Node(tag,text,cls),button=(label,action,p)=>{const b=new Node('button',label);b.action=action;p.append(b);return b}
 const chips=(p,values)=>{const row=new Node('div',undefined,'chips');for(const v of values.filter(Boolean))row.append(new Node('span',v));p.append(row)}
 const command=(m,p)=>{calls.push([m,p]);return fail?Promise.reject(new Error('x')):Promise.resolve()}
 return {parent,calls,opened,el,button,chips,command,openFeed:(id,label)=>opened.push([id,label]),presented:new Set(),setFail:v=>{fail=v}}
}
const item=(o={})=>({id:'f1',kind:'suggestion',title:'T',why_now:'W',lifecycle:'active',user_state:'new',task_ref:null,delivery:{presented_at:null},...o})
const buttons=card=>card.children.flatMap(function walk(n){return n.tag==='button'?[n.textContent]:n.children.flatMap(walk)})
test('actions follow kind and lifecycle',()=>{
 const h=harness()
 assert.deepEqual(buttons(renderFeedCard(h.parent,item(),h)),['讨论这个建议','稍后','忽略'])
 assert.deepEqual(buttons(renderFeedCard(h.parent,item({kind:'question',lifecycle:'resolved'}),h)),['回复这个问题'])
 assert.equal(feedActionLabel(item({kind:'task_result',task_ref:{work_id:'w'}})),'查看任务结果');assert.equal(feedActionLabel(item({task_ref:{work_id:'w'}})),'查看任务进展');assert.equal(feedActionLabel(item({kind:'change'})),'查看变化')
 const card=h.parent.children[0];assert.equal(card.dataset.feedId,'f1');assert.equal(card.children.some(n=>n.className==='card-tags'),false)
})
test('dismissed cards keep content but expose no actions',()=>{
 const h=harness();const card=renderFeedCard(h.parent,item({user_state:'dismissed'}),h)
 assert.equal(card.dataset.dismissed,'true');assert.deepEqual(buttons(card),[]);assert.equal(card.children[0].textContent,'T')
})
test('presented receipt is sent once when visible and retried after failure',async()=>{
 const h=harness();h.setFail(true)
 renderFeedCard(h.parent,item(),{...h,visible:false});assert.equal(h.calls.length,0)
 renderFeedCard(h.parent,item(),h);await new Promise(r=>setImmediate(r));assert.equal(h.calls.length,1);assert.equal(h.presented.has('f1'),false,'failure allows retry')
 h.setFail(false);renderFeedCard(h.parent,item(),h);renderFeedCard(h.parent,item(),h);await new Promise(r=>setImmediate(r))
 assert.equal(h.calls.length,2);assert.ok(h.presented.has('f1'))
 renderFeedCard(h.parent,item({id:'f2',delivery:{presented_at:'2026-01-01T00:00:00Z'}}),h);assert.equal(h.calls.length,2,'already presented items send nothing')
})
test('primary action opens the feed conversation with its label; snooze and dismiss go through feed.action',async()=>{
 const h=harness();const card=renderFeedCard(h.parent,item(),h);const find=label=>card.children.flatMap(function walk(n){return n.tag==='button'&&n.textContent===label?[n]:n.children.flatMap(walk)})[0]
 await find('讨论这个建议').action();assert.deepEqual(h.opened,[['f1','讨论这个建议']])
 await find('忽略').action();assert.deepEqual(h.calls.at(-1),['feed.action',{id:'f1',action:'dismiss'}])
 await find('稍后').action();assert.equal(h.calls.at(-1)[1].action,'snooze');assert.ok(Date.parse(h.calls.at(-1)[1].snooze_until)>Date.now()+3500000)
})
test('prepared briefing text is kept as the card body and differs from why_now',()=>{
 const h=harness();const bodies=[];const card=renderFeedCard(h.parent,item({kind:'briefing',prepared:{text:'## 今日前瞻\n- 10:00 评审',trust:'untrusted_external',evidence_refs:[]},why_now:'每日简报'}),{...h,body:text=>{bodies.push(text);return new Node('div',text,'md')}})
 assert.deepEqual(bodies,['## 今日前瞻\n- 10:00 评审']);assert.equal(card.children[1].textContent,'每日简报');assert.equal(card.children[2].className,'md')
 const same=renderFeedCard(h.parent,item({prepared:{text:'W'}}),h);assert.equal(same.children[1].className,'feed-why','identical prepared text is not duplicated')
 const plain=renderFeedCard(h.parent,item({prepared:{text:'plain body'}}),{...h,body:undefined});assert.equal(plain.children[2].className,'feed-body')
})
test('sendPresented is independent of rendering and retries after failure',async()=>{
 const h=harness();const it=item()
 assert.equal(sendPresented(it,h),true);assert.equal(sendPresented(it,h),false);await new Promise(r=>setImmediate(r));assert.equal(h.calls.length,1)
 h.setFail(true);const other=item({id:'f9'});sendPresented(other,h);await new Promise(r=>setImmediate(r));assert.equal(h.presented.has('f9'),false)
 h.setFail(false);assert.equal(sendPresented(other,h),true)
 assert.equal(sendPresented(item({id:'done',delivery:{presented_at:'x'}}),h),false);assert.equal(sendPresented(it,{presented:undefined,command:h.command}),false)
})


test('feed user feedback is distinct from task lifecycle',()=>{
 const h=harness(),tags=card=>card.children.flatMap(n=>n.className==='card-tags'?n.children.map(tag=>tag.textContent):[])
 assert.deepEqual(tags(renderFeedCard(h.parent,item({user_state:'snoozed',snooze_until:new Date(Date.now()+3600000).toISOString()}),h)),['稍后提醒'])
 assert.deepEqual(tags(renderFeedCard(h.parent,item({user_state:'dismissed'}),h)),['已忽略'])
 assert.deepEqual(tags(renderFeedCard(h.parent,item({user_state:'snoozed',snooze_until:'2000-01-01T00:00:00Z'}),h)),[])
})

test('a repeated prepared paragraph is not duplicated even with surrounding whitespace',()=>{
 const h=harness(),card=renderFeedCard(h.parent,item({why_now:'Same material',prepared:{text:'  Same material\n'}}),h)
 assert.equal(card.children.filter(node=>node.className==='feed-body').length,0)
 assert.equal(card.children.filter(node=>node.className==='feed-why').length,1)
})
test('inactive and expired suggestions explain their disabled action; task receipts still open results',()=>{
 for(const overrides of [{lifecycle:'invalidated'},{lifecycle:'resolved'},{expires_at:'2000-01-01T00:00:00Z'}]){
  const h=harness(),card=renderFeedCard(h.parent,item(overrides),h)
  assert.ok(card.children.find(node=>node.className==='feed-unavailable')?.textContent)
  assert.equal(card.children.find(node=>node.className==='feed-actions').children[0].disabled,true)
 }
 const h=harness(),card=renderFeedCard(h.parent,item({kind:'task_result',task_ref:{work_id:'w'},lifecycle:'resolved'}),h)
 assert.equal(card.children.find(node=>node.className==='feed-actions').children[0].disabled,false)
 assert.equal(card.children.some(node=>node.className==='feed-unavailable'),false)
})

test('a goal proposal offers "set as goal" with its revision and "no thanks", and states the cadence',async()=>{
 const h=harness(),goal={title:'学习英语口语',success_criteria:'能用英语聊十分钟',cadence:'daily',topic_key:'k',revision:'rev1',evidence_refs:['message:chat:main:m1']}
 const card=renderFeedCard(h.parent,item({kind:'question',goal_proposal:goal}),h)
 assert.deepEqual(buttons(card),['设为目标','不用了'])
 const texts=card.children.map(n=>n.textContent);assert.ok(texts.includes('目标：学习英语口语'));assert.ok(texts.includes('建议节奏：每天陪你练一点'));assert.ok(!texts.includes('W'),'the runtime why_now line is replaced by the localized cadence')
 const find=label=>card.children.flatMap(function walk(n){return n.tag==='button'&&n.textContent===label?[n]:n.children.flatMap(walk)})[0]
 await find('设为目标').action();assert.deepEqual(h.calls.at(-1),['feed.action',{id:'f1',action:'adopt_goal',goal_revision:'rev1'}])
 await find('不用了').action();assert.deepEqual(h.calls.at(-1),['feed.action',{id:'f1',action:'decline_goal'}])
 assert.deepEqual(buttons(renderFeedCard(h.parent,item({kind:'question',lifecycle:'resolved',goal_proposal:goal}),h)),[],'an adopted proposal has no actions left')
})

test('a goal check-in shows one line per goal with "reply with progress" and "stop reminding"',async()=>{
 const h=harness(),references=[]
 const checkin={local_date:'2026-10-12',items:[{goal_id:'a',goal_version:1,text:'今天练口语了吗？',recalled:'练了三次跟读'},{goal_id:'b',goal_version:1,text:'网站进展如何？',recalled:null},{goal_id:'gone',goal_version:1,text:'已删除的目标',recalled:null}]}
 const goals=[{id:'a',version:3,cadence:'daily'},{id:'b',version:1,cadence:'off'}]
 const card=renderFeedCard(h.parent,item({kind:'question',title:'运行时标题',goal_checkin:checkin}),{...h,goals,reference:refs=>{references.push(refs)}})
 const rows=card.children.filter(n=>n.className==='feed-checkin'),texts=node=>[node.textContent,...node.children.flatMap(texts)].filter(Boolean)
 assert.equal(card.children[0].textContent,'问问你的目标','a localized title instead of the runtime string')
 assert.deepEqual(rows.map(row=>row.dataset.goalId),['a','b','gone'])
 assert.ok(texts(rows[0]).includes('上次：练了三次跟读'))
 assert.deepEqual(buttons(rows[0]),['回复进展','不再提醒']);assert.deepEqual(buttons(rows[1]),['回复进展'],'a muted goal offers no second mute');assert.ok(texts(rows[1]).includes('已不再提醒'))
 assert.deepEqual(buttons(rows[2]),[],'a deleted goal has no actions');assert.ok(texts(rows[2]).includes('这个目标已删除。'))
 const find=(row,label)=>row.children.flatMap(function walk(n){return n.tag==='button'&&n.textContent===label?[n]:n.children.flatMap(walk)})[0]
 await find(rows[0],'回复进展').action();assert.deepEqual(references,[[{kind:'goal',id:'a',version:3}]],'the reference carries the goal\'s current version')
 await find(rows[0],'不再提醒').action();assert.deepEqual(h.calls.at(-1),['feed.action',{id:'f1',action:'goal_checkin_mute',goal_id:'a'}])
 assert.deepEqual(buttons(renderFeedCard(h.parent,item({goal_checkin:checkin}),{...h,goals,reference:()=>{},connected:false})),[],'offline shows no actions')
})
