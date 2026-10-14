import test,{beforeEach,afterEach} from 'node:test'
import assert from 'node:assert/strict'
import {attachFeedEvidence} from '../src/renderer/feed-evidence.mjs'
import {disposeSources} from '../src/renderer/source-popover.mjs'
class Node{
 constructor(tag,text,cls=''){this.tag=tag;this.textContent=text??'';this.className=cls;this.children=[];this.dataset={};this.listeners={};this.style={}}
 append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node)}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes)}
 setAttribute(k,v){this[k]=v}addEventListener(k,v){this.listeners[k]=v}
 focus(){document.activeElement=this}contains(node){return this===node||this.children.some(child=>child.contains(node))}
}
const all=node=>[node,...node.children.flatMap(all)]
const old=globalThis.document
beforeEach(()=>{globalThis.document={createElement:tag=>new Node(tag),addEventListener(){},removeEventListener(){}}})
afterEach(()=>{disposeSources();globalThis.document=old})
const base=()=>({id:'feed',updated_at:'2026-10-12T00:00:00Z',lifecycle:'active',evidence_refs:['raw-1'],prepared:{evidence_refs:['raw-1','raw-2']},memory_refs:[{entry_id:'m',version:2}]})
function render(item=base(),options={}){
 const card=new Node('article'),calls=[],el=(...args)=>new Node(...args)
 const button=(text,action,parent)=>{const node=el('button',text);node.action=action;parent.append(node);return node}
 attachFeedEvidence(card,item,{el,button,command:async(method,params)=>{calls.push([method,params]);return {state:'ok',evidence:{evidence_id:params.evidence_id,text:'<script>原文是数据</script>'}}},memory:[{id:'m',version:2,status:'active',content:'用户记录',evidence_refs:['raw-2','raw-3']}],...options})
 return {card,calls,reads:all(card).filter(node=>node.className==='feed-evidence-read')}
}
test('evidence requests deduplicate raw references and use only the cited current memory revision',async()=>{
 const {card,calls,reads}=render()
 assert.equal(reads.length,3)
 assert.ok(all(card).some(node=>node.textContent==='用户记录'))
 await reads[0].action()
 assert.deepEqual(calls,[['memory.evidence',{evidence_id:'raw-1'}]])
 const excerpt=all(card).find(node=>node.textContent==='<script>原文是数据</script>');assert.ok(excerpt)
 assert.equal(excerpt.role,undefined,'long excerpts are read normally, not announced as status')
 const stale=render(base(),{memory:[{id:'m',version:3,status:'active',content:'Changed private content',evidence_refs:['other']}]})
 assert.equal(stale.reads.length,2)
 assert.equal(all(stale.card).some(node=>node.textContent==='Changed private content'),false)
})
test('unavailable, removed and mismatched evidence never displays a returned excerpt',async()=>{
 for(const result of [{state:'gone',evidence:{evidence_id:'raw-1',text:'Do not show'}},{state:'unavailable',evidence:null},{state:'ok',evidence:{evidence_id:'wrong',text:'Do not show'}}]){
  const {card,reads}=render(base(),{command:async()=>result})
  await reads[0].action()
  assert.equal(all(card).some(node=>node.textContent==='Do not show'),false)
  assert.ok(all(card).some(node=>node.className==='hint'&&node.textContent))
 }
 const {card,reads}=render(base(),{command:async()=>{throw Error('internal_failure')}})
 await reads[0].action()
 assert.equal(all(card).some(node=>node.textContent==='internal_failure'),false)
 assert.ok(all(card).some(node=>node.className==='hint'&&node.textContent))
})
test('a receipt from a replaced feed cannot populate its previous evidence popover',async()=>{
 let current=base(),resolve
 const {card,reads}=render(current,{currentItem:()=>current,command:()=>new Promise(done=>{resolve=done})})
 const pending=reads[0].action();current={...current,updated_at:'2026-10-12T01:00:00Z'}
 resolve({state:'ok',evidence:{evidence_id:'raw-1',text:'Old result'}});await pending
 assert.equal(all(card).some(node=>node.textContent==='Old result'),false)
})
test('offline evidence keeps an info entry but disables reads, and invalidated feeds never read sources',async()=>{
 const offline=render(base(),{connected:false})
 assert.ok(all(offline.card).some(node=>node.className==='source-info'))
 assert.ok(offline.reads.every(node=>node.disabled))
 assert.ok(all(offline.card).some(node=>node.textContent==='连接后可读取原文。'))
 await offline.reads[0].action();assert.equal(offline.calls.length,0)
 const invalidated=render({...base(),lifecycle:'invalidated'})
 assert.equal(invalidated.reads.length,0)
 assert.equal(all(invalidated.card).some(node=>node.textContent==='用户记录'),false)
 assert.ok(all(invalidated.card).some(node=>node.className==='source-info'))
 const empty=render({id:'none',evidence_refs:[],memory_refs:[]})
 assert.equal(all(empty.card).some(node=>node.className==='source-info'),false)
})
