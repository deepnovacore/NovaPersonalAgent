import assert from 'node:assert/strict'
import test,{afterEach} from 'node:test'

import {HOST_REFUSALS,refusalText} from '../src/renderer/host-refusals.mjs'
import {setLanguage} from '../src/renderer/locale.mjs'

afterEach(()=>setLanguage('zh-CN'))

test('actionable host refusal codes become readable sentences in both languages',()=>{
 for(const code of Object.keys(HOST_REFUSALS)){
  const chinese=refusalText(code)
  assert.equal(chinese,refusalText(code))
  assert.match(chinese,/\p{Script=Han}/u,code)
  assert.doesNotMatch(chinese,new RegExp(`^${code}$`,'u'))
 }
 setLanguage('en')
 for(const code of Object.keys(HOST_REFUSALS)){
  const english=refusalText(code)
  assert.doesNotMatch(english,/\p{Script=Han}/u,code)
  assert.doesNotMatch(english,/^[a-z][a-z0-9_]*$/u,code)
  assert.match(english,/^[A-Z]/,code)
 }
})

test('the review-listed codes are all curated',()=>{
 for(const code of ['workspaces_unavailable','unknown_workspace','workspace_name_conflict','plan_delegation_unknown','plan_version_conflict','voice_active','generation_conflict','conversation_limit','invalid_project_directory','build_finished','conversation_busy','conversation_mode_transition','source_todo_conflict','stale_reference','reference_not_authorized','outcome_unknown','invalid_params','workspace_project_conflict'])
  assert.ok(Object.hasOwn(HOST_REFUSALS,code),`missing ${code}`)
})

test('unknown snake_case codes degrade to a generic sentence instead of the raw identifier',()=>{
 assert.match(refusalText('some_unmapped_code'),/没有完成/)
 assert.doesNotMatch(refusalText('some_unmapped_code'),/some_unmapped_code/)
 setLanguage('en')
 assert.match(refusalText('another_internal_code'),/did not complete/)
 assert.doesNotMatch(refusalText('another_internal_code'),/another_internal_code/)
})

test('serialized validation payloads never surface as JSON',()=>{
 const zod=`[\n  {\n    "origin": "string",\n    "code": "invalid_format",\n    "format": "regex",\n    "pattern": "^[\\\\p{L}]+$",\n    "message": "Invalid string"\n  }\n]`
 for(const payload of [zod,` {"origin":"string","code":"too_small"}`,new Error('x')]){
  const text=refusalText(typeof payload==='string'?payload:payload)
  assert.doesNotMatch(text,/origin|invalid_format|"pattern"|[{}[\]]/)
 }
 assert.match(refusalText(zod),/不符合要求/)
 setLanguage('en')
 assert.match(refusalText(zod),/does not meet the requirements/i)
})

test('human-readable host text and empty values stay useful',()=>{
 assert.equal(refusalText('操作超时，请刷新状态后重试'),'操作超时，请刷新状态后重试')
 assert.equal(refusalText('arbitrary disk failure'),'arbitrary disk failure')
 assert.match(refusalText(''),/没有完成/)
 assert.match(refusalText(undefined),/没有完成/)
 setLanguage('en')
 assert.match(refusalText(''),/did not complete/)
})
