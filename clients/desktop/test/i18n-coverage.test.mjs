import assert from 'node:assert/strict'
import test from 'node:test'
import {readdir,readFile} from 'node:fs/promises'

import {ENGLISH_MESSAGES} from '../src/renderer/messages.en.mjs'
import {setLanguage,t} from '../src/renderer/locale.mjs'
import {HOST_REFUSALS} from '../src/renderer/host-refusals.mjs'
import {COMPOSER_APPROVAL_CAPTIONS} from '../src/renderer/composer-approval.mjs'
import {COMPOSER_MODE_CAPTIONS} from '../src/renderer/composer-mode.mjs'
import {TASK_PHASE_LABEL,WAITING_LABEL} from '../src/renderer/tasks-page.mjs'
import {BUILD_REASONS,BUILD_STATUS_LABELS} from '../src/renderer/workbench-agent.mjs'
import {TIMELINE_LABELS,TIMELINE_STATUS_LABELS} from '../src/renderer/timeline-view.mjs'

const RENDERER=new URL('../src/renderer/',import.meta.url)
const HAN=/\p{Script=Han}/u
// `t('中文原文')` / `t("中文原文")` with escaped quotes unescaped, as the sources store them.
const CALL=/\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*(?:[,)])/g
const unescape=value=>value.replace(/\\(['"\\])/g,'$1')

async function rendererMessages(){
 const files=(await readdir(RENDERER)).filter(file=>file.endsWith('.mjs'))
 const found=new Map()
 for(const file of files){
  const source=(await readFile(new URL(file,RENDERER),'utf8')).replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'')
  for(const match of source.matchAll(CALL)){
   const raw=match[1]??match[2]
   if(raw===undefined)continue
   const message=unescape(raw)
   if(!HAN.test(message))continue
   if(!found.has(message))found.set(message,[])
   found.get(message).push(file)
  }
 }
 return found
}

/** Dynamic indexes are only reachable through `t(TABLE[code])`, so the scan cannot see them. */
const dynamicTables={
 HOST_REFUSALS,COMPOSER_APPROVAL_CAPTIONS,COMPOSER_MODE_CAPTIONS,TASK_PHASE_LABEL,WAITING_LABEL,
 BUILD_REASONS,BUILD_STATUS_LABELS,TIMELINE_LABELS,TIMELINE_STATUS_LABELS,
}

test('every source-language key used by t() in renderer modules has an English translation',async context=>{
 setLanguage('en');context.after(()=>setLanguage('zh-CN'))
 const messages=await rendererMessages()
 assert.ok(messages.size>1000,`scan found only ${messages.size} CJK t() keys; the extractor is probably broken`)
 const missing=[...messages].filter(([source])=>!Object.hasOwn(ENGLISH_MESSAGES,source)).map(([source,files])=>`${JSON.stringify(source)} (${[...new Set(files)].join(', ')})`)
 assert.deepEqual(missing,[],`missing ENGLISH_MESSAGES keys:\n${missing.join('\n')}`)
 // The wake phrase is user-facing product speech and stays untranslated on purpose.
 const WAKE_PHRASE=/\p{Script=Han}[^\n]*Hi Nova|Hi Nova[^\n]*\p{Script=Han}/u
 for(const [source] of messages){
  const translated=t(source)
  if(!HAN.test(translated))continue
  assert.match(translated,WAKE_PHRASE,`untranslated: ${JSON.stringify(source)} => ${JSON.stringify(translated)}`)
 }
})

test('dynamic message tables used through t() are fully translated',async context=>{
 setLanguage('en');context.after(()=>setLanguage('zh-CN'))
 for(const [name,table] of Object.entries(dynamicTables)){
  assert.ok(table&&typeof table==='object',`${name} must stay an exported table`)
  assert.ok(Object.keys(table).length>0,`${name} is empty`)
  for(const [code,source] of Object.entries(table)){
   assert.equal(typeof source,'string',`${name}.${code}`)
   assert.ok(Object.hasOwn(ENGLISH_MESSAGES,source),`${name}.${code} has no English key: ${JSON.stringify(source)}`)
   assert.doesNotMatch(t(source),HAN,`${name}.${code} is untranslated: ${JSON.stringify(source)}`)
  }
 }
})

test('refusal codes and parameter errors are covered by the curated table',()=>{
 for(const code of ['build_finished','conversation_busy','voice_active','conversation_mode_transition','source_todo_conflict','stale_reference','reference_not_authorized','outcome_unknown','invalid_params','workspaces_unavailable','unknown_workspace','workspace_name_conflict','workspace_project_conflict','plan_delegation_unknown','plan_version_conflict','generation_conflict','conversation_limit','invalid_project_directory'])
  assert.ok(Object.hasOwn(HOST_REFUSALS,code),`missing curated refusal: ${code}`)
})
