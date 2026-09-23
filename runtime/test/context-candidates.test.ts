import assert from 'node:assert/strict'
import test from 'node:test'
import {selectContextCandidates,type ContextInput} from '../src/personal-agent/context-candidates.js'

const file=(id:string,rel_path:string,content:string,priority=0,mtime_ms=1):ContextInput=>({kind:'file',id:`source:${id}`,version:'v1',content,source_id:'computer',file_id:id,root:id==='note'?'/notes':'/projects',rel_path,role:'document',mtime_ms,priority})

test('candidate selection excludes generic project overviews and keeps explicit proposals',()=>{
 const inputs:ContextInput[]=[
  file('note','project-notes.md','Next step: compare two recording flows.\nAn idea for simpler onboarding.',2,1),
  file('readme','README.md','A library for measuring input quality.',0,9),
  file('agent','AGENTS.md','Always run these agent instructions.',0,10),
  file('config','config.yaml','provider: example',0,11),
  file('vendor','node_modules/dependency/README.md','Dependency overview',0,12),
 ]
 const selected=selectContextCandidates(inputs)
 assert.ok(selected.some(item=>item.tab==='todos'&&item.primaryFileId==='note'))
 assert.ok(selected.some(item=>item.tab==='ideas'&&item.primaryFileId==='note'))
 assert.ok(selected.every(item=>item.primaryFileId!=='readme'))
 assert.ok(selected.every(item=>!['agent','config','vendor'].includes(item.primaryFileId??'')))
 assert.ok(selected.every(item=>item.tab==='todos'||item.tab==='ideas'))
})

test('README content alone never turns a cloned repository into a personal suggestion',()=>{
 const selected=selectContextCandidates([file('clone','README.md','Next step: publish a release.',0,Date.now())])
 assert.deepEqual(selected,[])
 assert.deepEqual(selectContextCandidates([file('workspace','README.md','Next step: publish a release.',1,Date.now())]),[])
 assert.deepEqual(selectContextCandidates([file('overview','README.md','An idea for setup.',3,Date.now())]),[])
 assert.deepEqual(selectContextCandidates([file('vendor','vendor/tool/README.md','An idea for setup.',3,Date.now())]),[])
 assert.deepEqual(selectContextCandidates([file('config','config.yaml','key: value')]),[])
})
test('an explicit proposal in a project note remains a candidate',()=>{
 const selected=selectContextCandidates([file('proposal','notes.md','摘要：建议用会话替代一次性派发。',0)])
 assert.equal(selected.length,1)
 assert.equal(selected[0]!.tab,'ideas')
})
test('an explicitly selected hidden notes folder may contribute its documents only',()=>{
 const selected={...file('hidden','.notes/idea.md','An idea for a simpler workflow.',3),hidden_prefix_depth:1} as Extract<ContextInput,{kind:'file'}>
 assert.equal(selectContextCandidates([selected]).length,1)
 assert.deepEqual(selectContextCandidates([{...selected,rel_path:'.notes/.nested/idea.md'}]),[])
})
