import assert from 'node:assert/strict'
import test from 'node:test'
import {selectContextCandidates,type ContextInput} from '../src/personal-agent/context-candidates.js'

const file=(id:string,rel_path:string,content:string,priority=0,mtime_ms=1):ContextInput=>({kind:'file',id:`source:${id}`,version:'v1',content,source_id:'computer',file_id:id,root:id==='note'?'/notes':'/projects',rel_path,role:'document',mtime_ms,priority})

test('candidate selection excludes tool files and keeps diverse readable work',()=>{
 const inputs:ContextInput[]=[
  file('note','project-notes.md','Next step: compare two recording flows.\nAn idea for simpler onboarding.',2,1),
  file('readme','README.md','A library for measuring input quality.',0,9),
  file('agent','AGENTS.md','Always run these agent instructions.',0,10),
  file('config','config.yaml','provider: example',0,11),
  file('vendor','node_modules/dependency/README.md','Dependency overview',0,12),
 ]
 const selected=selectContextCandidates(inputs)
 assert.ok(selected.some(item=>item.tab==='todos'&&item.primaryFileId==='note'))
 assert.ok(selected.some(item=>item.tab==='ideas'&&item.primaryFileId==='readme'))
 assert.ok(selected.every(item=>!['agent','config','vendor'].includes(item.primaryFileId??'')))
 assert.ok(selected.every(item=>item.tab==='todos'||item.tab==='ideas'))
})

test('activity never turns a cloned repository into a personal Todo or Goal',()=>{
 const selected=selectContextCandidates([file('clone','README.md','Next step: publish a release.',0,Date.now())])
 assert.ok(selected.every(item=>item.tab==='ideas'))
 assert.deepEqual(selectContextCandidates([file('config','config.yaml','key: value')]),[])
})
