import test from 'node:test'
import assert from 'node:assert/strict'
import {renderDiarySection} from '../src/renderer/diary-view.mjs'
class Node{constructor(tag,text){this.tag=tag;this.text=text;this.children=[];this.style={}}append(...nodes){this.children.push(...nodes)}}
const all=node=>[node,...node.children.flatMap(all)]
test('diary renders full text as text, deletes exact version and pages by date',async()=>{
 const root=new Node('div'),calls=[]
 const el=(tag,text)=>new Node(tag,text),button=(text,action,parent)=>{const node=el('button',text);node.action=action;parent.append(node);return node}
 const entries=Array.from({length:30},(_,i)=>({id:'d'+i,version:3,day:`2026-10-${String(30-i).padStart(2,'0')}`,text:'<script>private</script>\n'+'.'.repeat(600)}))
 renderDiarySection(root,{memory:{diaries:entries,diary_before:'2026-11-01'},caps:{memory:{diaries:true}},el,button,command:async(...args)=>calls.push(args),connected:true})
 assert.equal(all(root).filter(n=>n.tag==='details').length,30)
 assert.ok(all(root).some(n=>n.text===entries[0].text),'full text, not truncated memory preview')
 await all(root).find(n=>n.text==='删除日记').action();assert.deepEqual(calls[0],['memory.forget',{id:'d0',expected_version:3}])
 await all(root).find(n=>n.text==='更早的日记').action();assert.deepEqual(calls[1],['memory.diaries',{before:'2026-10-01'}])
 await all(root).find(n=>n.text==='最新日记').action();assert.deepEqual(calls[2],['memory.diaries',{}])
})
