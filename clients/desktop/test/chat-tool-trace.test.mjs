import assert from 'node:assert/strict'
import test from 'node:test'
import {setLanguage,t} from '../src/renderer/locale.mjs'
import {
 TOOL_TRACE_LABELS,TOOL_TRACE_LIMIT,TOOL_TRACE_STATE_LABELS,TOOL_TRACE_SUMMARY_LIMIT,
 aggregateToolTraceState,createToolTraceNode,normalizeToolTrace,toolTraceLabel,toolTraceStateLabel,
} from '../src/renderer/chat-tool-trace.mjs'

class Node{
 constructor(tag,text,className){this.tag=tag;this.tagName=tag.toUpperCase();this.textContent=text??'';this.className=className??'';this.children=[];this.dataset={};this.attributes={};this.open=false;this.title=''}
 append(...nodes){this.children.push(...nodes)}
 setAttribute(name,value){this.attributes[name]=value;this[name]=value}
}
const el=(tag,text,className)=>new Node(tag,text,className)
const all=node=>[node,...node.children.flatMap(all)]
const source=(name)=>TOOL_TRACE_LABELS[name]

test('provider wire names localize through a map with a generic fallback',()=>{
 setLanguage('en')
 try{
  assert.equal(toolTraceLabel('memory__recall'),'Search memory')
  assert.equal(toolTraceLabel('memory__evidence'),'Read source')
  assert.equal(toolTraceLabel('memory__remember'),'Update memory')
  assert.equal(toolTraceLabel('memory__lookup'),'View memory')
  assert.equal(toolTraceLabel('source__process'),'Process source')
  assert.equal(toolTraceLabel('app__context'),'Read app context')
  assert.equal(toolTraceLabel('search__search'),'Web search')
  assert.equal(toolTraceLabel('mcp__nova_knowledge__recall'),'Search knowledge')
  assert.equal(toolTraceLabel('mcp__nova_knowledge__get_chunk'),'Read knowledge passage')
  assert.equal(toolTraceLabel('some__future_tool'),'Tool','unknown tools still render a label')
  assert.equal(toolTraceLabel(undefined),'Tool')
  assert.equal(toolTraceStateLabel('running'),'Running')
  assert.equal(toolTraceStateLabel('ok'),'Done')
  assert.equal(toolTraceStateLabel('error'),'Failed')
  // The map is display text, so every entry must have an English translation in messages.en.mjs.
  for(const message of [...Object.values(TOOL_TRACE_LABELS),...Object.values(TOOL_TRACE_STATE_LABELS),'工具调用'])assert.doesNotMatch(t(message),/\p{Script=Han}/u,`untranslated ${message}`)
 }finally{setLanguage('zh-CN')}
 assert.equal(toolTraceLabel('memory__recall'),'检索记忆','the source language still names tools without English')
 assert.equal(toolTraceStateLabel('running'),'运行中')
 assert.equal(source('memory__recall'),'检索记忆')
})

test('normalization copies only display-safe fields and drops unknown rows',()=>{
 const rows=normalizeToolTrace([
  {name:'memory__recall',state:'running',summary:'  检索   最近记录  ',args:{query:'secret'},result:'raw result'},
  null,undefined,'frame',{},
  {name:'',state:'ok'},
  {name:'search__search',state:'weird'},
  {name:'search__search',state:'completed',summary:'找到 2 条'},
 ])
 assert.deepEqual(rows,[
  {name:'memory__recall',state:'running',summary:'检索 最近记录'},
  {name:'search__search',state:'ok',summary:'找到 2 条'},
 ])
 assert.deepEqual(Object.keys(rows[0]),['name','state','summary'])
 assert.equal(JSON.stringify(rows).includes('secret'),false,'raw arguments are never copied')
 assert.equal(JSON.stringify(rows).includes('raw result'),false,'raw results are never copied')
})

test('the summary stays one bounded quiet line and the trace stays capped',()=>{
 const long=`第一行\n第二行 ${'长'.repeat(TOOL_TRACE_SUMMARY_LIMIT)}`
 const summary=normalizeToolTrace([{name:'memory__recall',state:'ok',summary:long}])[0].summary
 assert.equal([...summary].length,TOOL_TRACE_SUMMARY_LIMIT)
 assert.ok(summary.endsWith('…'))
 assert.doesNotMatch(summary,/[\u0000-\u001f\u007f]/u)
 assert.equal(normalizeToolTrace([{name:'memory__recall',state:'ok',summary:'a\u0000b\tc'}])[0].summary,'a b c')
 const many=Array.from({length:TOOL_TRACE_LIMIT+4},(_,index)=>({name:'memory__recall',state:'ok',summary:String(index)}))
 assert.equal(normalizeToolTrace(many).length,TOOL_TRACE_LIMIT)
 assert.equal(normalizeToolTrace(many).at(-1).summary,String(TOOL_TRACE_LIMIT-1))
 assert.deepEqual(normalizeToolTrace(many,{limit:3}).map(row=>row.summary),['0','1','2'])
})

test('the aggregate state lets an error outrank running and success',()=>{
 assert.equal(aggregateToolTraceState([{state:'ok'}]),'ok')
 assert.equal(aggregateToolTraceState([{state:'ok'},{state:'running'}]),'running')
 assert.equal(aggregateToolTraceState([{state:'running'},{state:'error'},{state:'ok'}]),'error')
 assert.equal(aggregateToolTraceState([]),'ok')
})

test('one tool builds a collapsed details card with a dot, label, note, and status',()=>{
 const card=createToolTraceNode([{name:'memory__recall',state:'ok',summary:'找到 2 条'}],{el})
 assert.equal(card.tag,'details')
 assert.equal(card.className,'chat-tool-trace')
 assert.equal(card.open,false,'a trace is collapsed until the reader opens it')
 assert.equal(card.dataset.state,'ok')
 assert.equal(card.dataset.live,'false')
 const summary=card.children[0]
 assert.equal(summary.tag,'summary')
 assert.equal(summary.className,'chat-tool-trace-summary')
 const dot=summary.children[0]
 assert.equal(dot.className,'chat-tool-trace-dot')
 assert.equal(dot.dataset.state,'ok')
 assert.equal(dot.attributes['aria-hidden'],'true')
 assert.equal(summary.children[1].className,'chat-tool-trace-label')
 assert.equal(summary.children[1].textContent,'检索记忆')
 assert.equal(summary.children[2].className,'visually-hidden')
 assert.equal(summary.children[2].textContent,'完成')
 assert.equal(summary.title,'检索记忆 · 完成')
 assert.equal(summary.children[3].textContent,'找到 2 条','the collapsed line also shows the short note')
 const list=card.children[1]
 assert.equal(list.tag,'ol')
 assert.equal(list.className,'chat-tool-trace-items')
 const row=list.children[0]
 assert.equal(row.tag,'li')
 assert.equal(row.className,'chat-tool-trace-item')
 assert.equal(row.dataset.state,'ok')
 assert.equal(row.children[0].dataset.state,'ok')
 assert.equal(row.children[1].textContent,'检索记忆')
 assert.equal(row.children[2].className,'chat-tool-trace-note')
 assert.equal(row.children[2].textContent,'找到 2 条')
 assert.equal(row.children[3].textContent,'完成')
})

test('a lone tool without a summary is a static accessible row in every state',()=>{
 for(const state of ['running','ok','error']){
  const card=createToolTraceNode([{name:'memory__remember',state,args:{text:'private value'},result:'private result'}],{el,open:true,live:true})
  assert.equal(card.tag,'div')
  assert.equal(card.className,'chat-tool-trace chat-tool-trace-static')
  assert.equal(card.dataset.state,state)
  assert.equal(card.dataset.live,'true')
  assert.ok(all(card).every(node=>!['details','summary'].includes(node.tag)))
  assert.equal(card.children[0].attributes['aria-hidden'],'true')
  assert.equal(card.children[1].textContent,'更新记忆')
  assert.equal(card.children[2].className,'visually-hidden')
  assert.equal(card.children[2].textContent,toolTraceStateLabel(state))
  assert.equal(all(card).filter(node=>node.textContent==='更新记忆').length,1)
  assert.doesNotMatch(all(card).map(node=>node.textContent).join(' '),/private value|private result/)
 }
})

test('fixed receipt summaries localize while dynamic notes fall back unchanged',()=>{
 setLanguage('en')
 try{
  for(const [summary,expected] of [
   ['已保存','Saved'],['已忘记','Forgotten'],['未保存','Not saved'],
   ['已保存 · 称呼','Saved · preferred name'],['已忘记 · 称呼','Forgotten · preferred name'],
   ['已保存 · 回答风格','Saved · reply style'],['已忘记 · 回答风格','Forgotten · reply style'],
   ['3 条','3 条'],['custom error {0}','custom error {0}'],
  ]){
   const card=createToolTraceNode([{name:'memory__remember',state:'ok',summary}],{el})
   assert.equal(card.tag,'details')
   assert.equal(card.children[0].children.at(-1).textContent,expected)
   assert.equal(card.children[1].children[0].children[2].textContent,expected)
  }
 }finally{setLanguage('zh-CN')}
})

test('several tools stay compact, the worst state wins, and an empty trace renders nothing',()=>{
 const card=createToolTraceNode([
  {name:'memory__recall',state:'running'},
  {name:'search__search',state:'error',summary:'offline'},
 ],{el,live:true})
 assert.equal(card.dataset.state,'error')
 assert.equal(card.dataset.live,'true')
 assert.equal(card.children[0].children[1].textContent,'工具调用 · 2')
 assert.equal(card.children[1].children.length,2)
 assert.equal(card.children[1].children[0].children[1].textContent,'检索记忆')
 assert.equal(card.children[1].children[1].children[1].textContent,'搜索网络')
 assert.equal(card.children[1].children[0].children.length,3,'running without a summary renders no empty note')
 assert.equal(card.children[1].children[0].children[2].className,'visually-hidden')
 assert.equal(createToolTraceNode([],{el}),null)
 assert.equal(createToolTraceNode(undefined,{el}),null)
 assert.equal(createToolTraceNode([{name:'memory__recall',state:'ok'}],{}),null,'a missing DOM factory is tolerated')
})

test('raw arguments and results never reach the card',()=>{
 const card=createToolTraceNode([
  {name:'memory__recall',state:'ok',summary:'找到 2 条',args:{query:'secret query'},result:'raw tool result'},
 ],{el})
 const text=all(card).map(node=>node.textContent??'').join('\n')
 assert.doesNotMatch(text,/secret query|raw tool result/)
 assert.equal(card.children[1].children[0].children.length,4,'only dot, label, note, and the hidden state are rendered')
})
