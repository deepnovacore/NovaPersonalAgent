import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'

const dist=resolve(process.env.NOVA_TEST_RUNTIME_DIST??new URL('../dist',import.meta.url).pathname)
const {dailyWorkbenchStateSchema}=await import(pathToFileURL(join(dist,'src/personal-agent/daily-workbench.js')).href)
test('offline recovery validates the merged state, is idempotent, and rejects malformed evidence without touching the target',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-idea-import-')),target=join(dir,'daily.json'),source=join(dir,'snapshot.json')
 const state={version:1,automatic_day:'',key:'',updated_at:null,cache:[],cards:[],dismissed:[],recorded:[],diagnostics:{inputs:0,cache_hits:0,extraction_calls:0,composition_calls:0,received:0,rejected:0,recorded:0},legacy_imported:true}
 const card={scope:'original-account',id:'saved-idea',tab:'ideas',title:'Synthetic idea',body:'Synthetic content',why:null,next:null,refs:[{entry_id:'test-source',version:'1',quote:'Original'}],sources:[]}
 const script=new URL('./import-recovered-ideas.mjs',import.meta.url)
 const run=(...flags)=>spawnSync(process.execPath,[script.pathname,'--from',source,'--target',target,'--runtime-dist',dist,...flags],{encoding:'utf8'})
 try{
  const original=JSON.stringify(state);await writeFile(target,original,{mode:0o600});await writeFile(source,JSON.stringify({updated_at:'2026-10-18T11:07:45.359Z',cards:[card,card]}),{mode:0o600})
  let result=run('--dry-run');assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/to import: 1/u);assert.equal(await readFile(target,'utf8'),original)
  result=run();assert.equal(result.status,0,result.stderr)
  const imported=dailyWorkbenchStateSchema.parse(JSON.parse(await readFile(target,'utf8')))
  assert.equal(imported.history.length,1);assert.equal(imported.history[0].imported,true);assert.equal(imported.history[0].scope,'original-account','import never strips the original account binding')
  const before=await readFile(target,'utf8');result=run();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/to import: 0/u);assert.equal(await readFile(target,'utf8'),before)
  await writeFile(source,JSON.stringify({updated_at:'2026-10-18T11:07:45.359Z',cards:[{...card,id:'bad',title:'Bad record',refs:[{entry_id:'test-source',version:'1'}]}]}))
  result=run();assert.notEqual(result.status,0);assert.equal(await readFile(target,'utf8'),before,'invalid history must not destroy the readable cache')
  result=spawnSync(process.execPath,[script.pathname],{encoding:'utf8'});assert.notEqual(result.status,0)
 }finally{await rm(dir,{recursive:true,force:true})}
})
