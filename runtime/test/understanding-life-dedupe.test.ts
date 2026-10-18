import test from 'node:test'
import assert from 'node:assert/strict'
import {applyLifeMutation,emptyLifeState,lifeEvidenceMatches} from '../src/personal-agent/life.js'

const ref={entry_id:'message',version:'1',quote:'Please review the interface draft'}
const workbench=(quote=ref.quote,version='1')=>({op:'from_workbench',kind:'todo',title:'Review interface',note:quote,due:null,success_criteria:'',automatic:false,source:{candidate_id:'daily:'+version+':'+quote,refs:[{...ref,version,quote}]},sources:[],evidence:[{id:ref.entry_id,version,text:quote,kind:'im',observed_at:'2026-10-18T01:00:00Z'}]})
const suggestion=(quote=ref.quote,version='1')=>({op:'from_suggestion',kind:'todo',suggestion_id:'unified:'+version+':'+quote,title:'Review interface',note:quote,due:null,todo_id:null,source:{candidate_id:'unified:'+version+':'+quote,refs:[{...ref,version,quote}]},sources:[],provenance_refs:[ref.entry_id]})

test('DailyWorkbench capture followed by unified adoption retains one Life object',()=>{
 const captured=applyLifeMutation(emptyLifeState(),workbench(),'daily')
 const adopted=applyLifeMutation(captured.state,suggestion(),'unified')
 assert.equal(adopted.state.todos.length,1)
 assert.deepEqual(adopted.result,captured.result)
 assert.equal(adopted.state.todos[0]!.workbench_source!.refs[0]!.quote,ref.quote)
})

test('unified adoption followed by DailyWorkbench capture retains one Life object',()=>{
 const adopted=applyLifeMutation(emptyLifeState(),suggestion(),'unified')
 const captured=applyLifeMutation(adopted.state,workbench(),'daily')
 assert.equal(captured.state.todos.length,1)
 assert.deepEqual(captured.result,adopted.result)
})

test('different quotes or evidence versions remain distinct even in the same source',()=>{
 const first=applyLifeMutation(emptyLifeState(),workbench(),'daily')
 for(const input of [suggestion('Please review the release plan'),suggestion(ref.quote,'2')]){
  const result=applyLifeMutation(first.state,input,'independent')
  assert.equal(result.state.todos.length,2)
 }
 assert.equal(lifeEvidenceMatches([{entry_id:'message',version:'1'}],[ref]),false)
})

test('explicit progress appends to its target instead of being suppressed by initial capture evidence',()=>{
 const first=applyLifeMutation(emptyLifeState(),workbench(),'daily')
 const result=applyLifeMutation(first.state,{...suggestion(),todo_id:first.result.id},'progress')
 assert.equal(result.state.todos.length,1)
 assert.equal(result.result.version,2)
})
