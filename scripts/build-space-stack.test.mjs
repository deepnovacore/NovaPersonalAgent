import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {test} from 'node:test'
import {pathToFileURL} from 'node:url'

test('build-space-stack: private SDK staging, same-run replacement, notices and real fixture module load',{timeout:300_000},async()=>{
 const repo=realpathSync(resolve(import.meta.dirname,'..'));
 const root=mkdtempSync(join(realpathSync(tmpdir()),'space-sdk-packaging-'));
 const runId=`sdk-packaging-${process.pid}`;
 const out=join(root,'nova-space-'+createHash('sha256').update(repo).digest('hex').slice(0,16),runId);
 const runtime=join(out,'node_modules/@nova-personal-agent/runtime');
 const sdk=join(runtime,'dist/src/memory/voicemem-sdk');
 const build=()=>{
  const result=spawnSync(process.execPath,[join(repo,'scripts/build-space-stack.mjs'),'--output-root',root,'--run-id',runId],{cwd:repo,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/Space stack built at/u);
 };
 try{
  build();
  assert.ok(existsSync(join(sdk,'index.js')),'direct tsc Space output must include the required SDK');
  const original=readFileSync(join(sdk,'grounded-reply-preferences.js'),'utf8');
  writeFileSync(join(sdk,'grounded-reply-preferences.js'),'stale invalid JavaScript');
  writeFileSync(join(sdk,'obsolete-sdk-file.js'),'stale file must not survive');
  build();
  assert.equal(readFileSync(join(sdk,'grounded-reply-preferences.js'),'utf8'),original,'incremental build freshly stages verified SDK bytes');
  assert.equal(existsSync(join(sdk,'obsolete-sdk-file.js')),false);
  assert.ok(!readdirSync(out).some(name=>name.startsWith('.voicemem-sdk-')),'only current staging directory is cleaned');
  for(const name of ['LICENSE','NOTICE.md','PATCH-NOTICE.md'])assert.ok(readFileSync(join(sdk,name)).length);
  const {loadGroundedVoiceMem}=await import(pathToFileURL(join(runtime,'dist/src/memory/grounded-voicemem.js')).href);
  const {VoiceMem,OpenAITextModel,OpenAIEmbeddingModel}=await loadGroundedVoiceMem();
  const {providerFixture}=await import(pathToFileURL(join(runtime,'dist/test/memory-engine-provider-fixture.js')).href);
  const provider=await providerFixture();
  const memory=new VoiceMem({path:join(root,'fixture.sqlite'),userId:'fixture',mode:'text',rbMinScore:0,
   model:new OpenAITextModel({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture'}),
   embeddings:new OpenAIEmbeddingModel({baseUrl:provider.baseUrl,apiKey:'fixture',model:'fixture',dimensions:2})});
  try{
   await memory.ingest('I am upset today',{sourceId:'fixture',scope:'styles',role:'user'});
   const result=await memory.search('feelings',{scope:'styles',recordUsage:false});
   assert.ok(result.rbHits.some(hit=>hit.kind==='heartnote'),'actual Space-packaged SDK opens, ingests and searches over HTTP fixtures');
   assert.ok(provider.counts().embeddings>0&&provider.counts().extractions>0);
  }finally{await memory.close();await provider.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});
