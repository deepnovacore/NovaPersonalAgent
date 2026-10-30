import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {chmod,realpath,mkdtemp,readdir,rm,readFile,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAgentHost} from '../src/personal-agent/host.js';
import {SuggestionPool} from '../src/core/suggestions.js';
import {canonicalJson} from '../src/text/canonical-json.js';
import {SpaceHost,type SpaceHostTransport} from '../src/space-host/service.js';
import {HostSecretStore,SPACE_SECRET_NAMES,overlaySpaceSecrets,secretClearSchema,secretPutSchema} from '../src/space-host/host-admin.js';
import {environmentContract} from '../src/config/environment-contract.js';

async function fixture(options:{owner?:string;env?:NodeJS.ProcessEnv;feishu?:boolean;feishuConnector?:Parameters<PersonalAgentHost['setFeishu']>[0];memory?:unknown;feishuPollMs?:number}={}){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-admin-')),sent:Record<string,unknown>[]=[];const calls:string[]=[];
 const transport:SpaceHostTransport={start:()=>Promise.resolve(()=>{ /* Test callback intentionally has no side effects. */ }),send:(_to,body)=>{sent.push(body);return Promise.resolve()},stream:()=>Promise.resolve(),clients:()=>['phone','other']};
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>options.memory as never,pool:new SuggestionPool(),evidence:()=>null});
 if(options.feishu)host.setFeishu({snapshot:()=>({available:true,configured:true,state:'unauthorized',auth_issue:'login_required',account_id:'tenant-secret',app_setup:{state:'idle'}}),command:(method)=>{calls.push(method);return Promise.resolve({available:true,configured:true,state:'unauthorized',account_id:'tenant-secret',verification_url:method==='feishu.login'?'https://accounts.feishu.cn/device?code=x':'https://evil.example/x',chats:[]})},open:()=>Promise.resolve(),close:()=>Promise.resolve()});
 if(options.feishuConnector)host.setFeishu(options.feishuConnector);
 const secrets=new HostSecretStore(join(dir,'config.json.secrets.json')),env=options.env??{};
 const space=new SpaceHost({path:join(dir,'space.json'),space:'s',host,transport,owner:()=>options.owner,secrets,environment:env,feishuPollMs:options.feishuPollMs??10});
 await host.open({deferBackground:true});await space.open();
 const stamps=new Map<string,number>(),send=async(from:string,op_id:string,kind:string,input:Record<string,unknown>)=>{if(!stamps.has(op_id))stamps.set(op_id,Date.now());await space.receive(from,{v:1,type:'intent',op_id,kind,input,created_at:stamps.get(op_id)});return sent.filter(row=>row.type==='receipt'&&row.op_id===op_id).at(-1)!};
 return {dir,host,space,send,sent,calls,secrets,close:async()=>{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}};
}

test('admin intents are rejected for non-owner senders and when no owner exists',async()=>{
 for(const [owner,error] of [[undefined,'owner_unassigned'],['other','owner_required']] as const){const f=await fixture({...(owner?{owner}:{})});
  try{for(const [kind,input] of [['settings.patch',{method:'soul.set',params:{role:'x'}}],['secret.put',{name:'OPENAI_API_KEY',value:'sk-test-1'}],['secret.clear',{name:'OPENAI_API_KEY'}],['connector.feishu',{action:'status'}]] as const){const r=await f.send('phone','op-'+kind,kind,input);assert.deepEqual([r.status,r.error],['rejected',error])};
   assert.equal((f.space.snapshot('phone') as unknown as {owner:boolean}).owner,false);assert.equal('host_credentials' in f.space.snapshot('phone'),false)}finally{await f.close()}}
});

test('settings.patch runs allowlisted host methods only and snapshot projects them to the owner',async()=>{
 const f=await fixture({owner:'phone'});
 try{const ok=await f.send('phone','id','settings.patch',{method:'identity.configure',params:{assistant_name:'Nova2',user_name:'Ann'}});assert.equal(ok.status,'accepted',String(ok.error));assert.equal(f.host.identity().assistant_name,'Nova2');
  const d=await f.send('phone','disc','settings.patch',{method:'discovery.configure',params:{proactive_daily_cap:3}});assert.equal(d.status,'accepted');
  for(const [i,method] of ['build.start','settings.local_tool_approval','notifications.configure','space.revoke','nope'].entries())assert.equal((await f.send('phone','bad'+i,'settings.patch',{method,params:{}})).status,'rejected');
  assert.equal((await f.send('phone','badparams','settings.patch',{method:'identity.configure',params:{evil:1}})).status,'rejected');
  const snap=f.space.snapshot('phone') as unknown as {owner:boolean;host_settings:{identity:{assistant_name:string};discovery:{proactive_daily_cap:number}}};assert.equal(snap.owner,true);assert.equal(snap.host_settings.identity.assistant_name,'Nova2');assert.equal(snap.host_settings.discovery.proactive_daily_cap,3);
  const again=await f.send('phone','id','settings.patch',{method:'identity.configure',params:{assistant_name:'Nova2',user_name:'Ann'}});assert.equal(again.status,'accepted');
  // Single-field edits queued offline apply in order without reverting each other.
  assert.equal((await f.send('phone','n1','settings.patch',{method:'identity.configure',params:{assistant_name:'Nova3'}})).status,'accepted');assert.equal((await f.send('phone','n2','settings.patch',{method:'identity.configure',params:{user_name:'Bea'}})).status,'accepted');assert.deepEqual(f.host.identity(),{assistant_name:'Nova3',user_name:'Bea'});
 }finally{await f.close()}
});

test('the writable secret list is an explicit allowlist of contract secrets',()=>{
 const secretNames=environmentContract.filter(row=>row.secret).map(row=>row.name);
 for(const name of SPACE_SECRET_NAMES){assert.ok(secretNames.includes(name),`${name} is not a contract secret`);assert.equal(secretPutSchema.safeParse({name,value:'x'}).success,true,name)}
 // A secret added to the contract later stays Host-only until someone reviews and lists it.
 for(const name of secretNames.filter(name=>!SPACE_SECRET_NAMES.includes(name)))assert.equal(secretClearSchema.safeParse({name}).success,false,name);
 for(const name of ['COMPOSIO_API_KEY','EXECUTOR_API_KEY','TAVILY_API_KEY','DESKTOP_TOKEN','MEMORY_TOKEN','SERVER_TOKEN_FILE','NATIVE_REALTIME_API_KEY'])assert.equal(SPACE_SECRET_NAMES.includes(name),false,name);
});

test('secrets: allowlist, 0600 store, env wins, snapshot has fingerprints only, journal has no secret bytes',async()=>{
 assert.ok(SPACE_SECRET_NAMES.includes('OPENAI_API_KEY'));for(const n of ['DESKTOP_TOKEN','NOVA_HUB_TOKEN','SERVER_TOKEN_FILE','MEMORY_TOKEN','NATIVE_REALTIME_API_KEY'])assert.equal(SPACE_SECRET_NAMES.includes(n),false);
 const f=await fixture({owner:'phone',env:{GEMINI_API_KEY:'operator-gem'}});const secret='sk-super-secret-value-123';
 try{const r=await f.send('phone','put','secret.put',{name:'OPENAI_API_KEY',value:secret});assert.deepEqual([r.status,r.applies,r.shadowed_by_environment],['accepted','restart',false]);
  const g=await f.send('phone','put2','secret.put',{name:'GEMINI_API_KEY',value:'phone-gem'});assert.equal(g.shadowed_by_environment,true);
  assert.equal((await f.send('phone','bad','secret.put',{name:'DESKTOP_TOKEN',value:'x'})).status,'rejected');
  const path=join(f.dir,'config.json.secrets.json');assert.equal((await stat(path)).mode&0o777,0o600);
  const snap=JSON.stringify(f.space.snapshot('phone')),creds=(f.space.snapshot('phone') as unknown as {host_credentials:{credentials:{name:string;source:string;fingerprint:string}[]}}).host_credentials.credentials;
  assert.equal(snap.includes(secret),false);assert.equal(snap.includes('phone-gem'),false);assert.equal(creds.find(c=>c.name==='OPENAI_API_KEY')!.source,'space');assert.equal(creds.find(c=>c.name==='GEMINI_API_KEY')!.source,'environment');assert.match(creds.find(c=>c.name==='OPENAI_API_KEY')!.fingerprint,/^[0-9a-f]{8}$/);
  await f.send('phone','reg','push.register',{handle:'h',credential:'push-credential-xyz'}).catch(()=>undefined);
  assert.equal(JSON.stringify(f.sent).includes(secret),false);
  await f.space.close();const journal=await readFile(join(f.dir,'space.json'),'utf8');assert.equal(journal.includes(secret),false);assert.equal(journal.includes('phone-gem'),false);assert.equal(journal.includes('push-credential-xyz'),false);
  const env=overlaySpaceSecrets({GEMINI_API_KEY:'operator-gem'},join(f.dir,'config.json'));assert.equal(env.OPENAI_API_KEY,secret);assert.equal(env.GEMINI_API_KEY,'operator-gem');
  await f.space.open();assert.equal((await f.send('phone','clr','secret.clear',{name:'OPENAI_API_KEY'})).status,'accepted');assert.equal(overlaySpaceSecrets({},join(f.dir,'config.json')).OPENAI_API_KEY,undefined);
  await writeFile(join(f.dir,'x'),'');assert.equal(overlaySpaceSecrets({A:'1'},join(f.dir,'missing.json')).A,'1');
 }finally{await f.close()}
});

test('connector.feishu routes to host commands and exposes only validated, secret-free state',async()=>{
 const f=await fixture({owner:'phone',feishu:true});
 try{const login=await f.send('phone','login','connector.feishu',{action:'login'});assert.equal(login.status,'accepted');const view=login.result as Record<string,unknown>;assert.equal(view.verification_url,'https://accounts.feishu.cn/device?code=x');assert.equal(JSON.stringify(view).includes('tenant-secret'),false);
  const out=await f.send('phone','out','connector.feishu',{action:'logout'});assert.equal(out.status,'accepted');assert.deepEqual(f.calls,['feishu.login','feishu.disconnect']);
  const bad=await f.send('phone','st','connector.feishu',{action:'status'});assert.equal((bad.result as Record<string,unknown>).verification_url,undefined);
  assert.equal((await f.send('phone','x','connector.feishu',{action:'bind'})).status,'rejected');
  const snap=f.space.snapshot('phone') as unknown as {host_feishu:Record<string,unknown>};assert.equal(snap.host_feishu.auth_issue,'login_required');assert.equal(JSON.stringify(snap).includes('tenant-secret'),false);
 }finally{await f.close()}
});

test('a stale role edit returns a conflict receipt so the phone can retry it',async()=>{
 const f=await fixture({owner:'phone',memory:{setSoul:()=>Promise.reject(Error('stale'))}});
 try{const r=await f.send('phone','soul','settings.patch',{method:'soul.set',params:{role:'x',expected_version:0}});assert.deepEqual([r.status,r.error],['conflict','version_conflict']);assert.ok(r.snapshot)}finally{await f.close()}
});

test('an untouched secrets file does not block the next Host start',async()=>{
 const f=await fixture({owner:'phone'});
 try{const path=join(f.dir,'config.json.secrets.json');assert.equal((await stat(path)).size,0);assert.deepEqual(overlaySpaceSecrets({A:'1'},join(f.dir,'config.json')),{A:'1'});
  await f.space.close();await f.space.open();assert.equal((await f.send('phone','put','secret.put',{name:'OPENAI_API_KEY',value:'sk-after-restart'})).status,'accepted');
 }finally{await f.close()}
});

test('a damaged secrets file is dropped with a diagnostic instead of stopping startup',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-secrets-'));
 try{for(const text of ['{','{"v":2,"secrets":{}}','\n']){const path=join(dir,'config.json.secrets.json');await writeFile(path,text,{mode:0o600});
   const diagnostics:string[]=[];
   assert.deepEqual(overlaySpaceSecrets({A:'1'},join(dir,'config.json'),code=>diagnostics.push(code)),{A:'1'});
   assert.deepEqual(diagnostics,['space_secrets_invalid_dropped']);
   // The damaged bytes stay for the operator; nothing silently deletes them.
   assert.equal(await readFile(path,'utf8'),text)}
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('a damaged secrets file marks the owner projection and a re-entered key clears it',async()=>{
 const f=await fixture({owner:'phone'});
 try{await f.space.close();await writeFile(join(f.dir,'config.json.secrets.json'),'{',{mode:0o600});await f.space.open();
  const view=()=>(f.space.snapshot('phone') as unknown as {host_credentials:{damaged:boolean;credentials:{name:string;configured:boolean}[]}}).host_credentials;
  assert.equal(view().damaged,true);assert.equal(view().credentials.every(row=>!row.configured),true);
  assert.equal((await f.send('phone','put','secret.put',{name:'OPENAI_API_KEY',value:'sk-after-damage'})).status,'accepted');
  assert.equal(view().damaged,false);assert.equal(view().credentials.find(row=>row.name==='OPENAI_API_KEY')!.configured,true);
 }finally{await f.close()}
});

test('the journal hashes the redacted intent, so a stored hash never confirms a secret value',async()=>{
 const f=await fixture({owner:'phone'});const secret='sk-journal-oracle-value';
 try{const intent={v:1,type:'intent',op_id:'oracle',kind:'secret.put',created_at:Date.now(),input:{name:'OPENAI_API_KEY',value:secret}};
  await f.space.receive('phone',intent);assert.equal(f.sent.filter(row=>row.type==='receipt').at(-1)!.status,'accepted');
  // A replay of the same operation stays idempotent; the same op id with another value conflicts.
  await f.space.receive('phone',intent);assert.equal(f.sent.filter(row=>row.type==='receipt').at(-1)!.error,undefined);
  await f.space.receive('phone',{...intent,input:{name:'OPENAI_API_KEY',value:'sk-a-different-value'}});
  assert.equal(f.sent.filter(row=>row.type==='receipt').at(-1)!.error,'op_id_conflict');
  await f.space.close();
  const journal=await readFile(join(f.dir,'space.json'),'utf8'),rawHash=createHash('sha256').update(canonicalJson(intent)).digest('hex');
  assert.equal(journal.includes(secret),false);assert.equal(journal.includes(rawHash),false);
  assert.equal(journal.includes(createHash('sha256').update(secret).digest('hex')),false);
  const saved=JSON.parse(journal) as {ops:Record<string,{hash:string}>};
  assert.equal(Object.values(saved.ops)[0]!.hash,createHash('sha256').update(canonicalJson({...intent,input:{name:'OPENAI_API_KEY'}})).digest('hex'));
 }finally{await f.close()}
});

test('a secret replayed with another value conflicts after a SpaceHost restart',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-secret-restart-')),sent:Record<string,unknown>[]=[];
 const transport:SpaceHostTransport={start:()=>Promise.resolve(()=>{ /* Test callback intentionally has no side effects. */ }),send:(_to,body)=>{sent.push(body);return Promise.resolve()},stream:()=>Promise.resolve(),clients:()=>['phone']};
 const make=()=>new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
 const makeSpace=(host:PersonalAgentHost)=>new SpaceHost({path:join(dir,'space.json'),space:'s',host,transport,owner:()=>'phone',secrets:new HostSecretStore(join(dir,'config.json.secrets.json')),environment:{}});
 const stamp=Date.now(),intent=(value:string)=>({v:1,type:'intent',op_id:'restart-secret',kind:'secret.put',created_at:stamp,input:{name:'OPENAI_API_KEY',value}});
 const receipt=()=>sent.filter(row=>row.type==='receipt'&&row.op_id==='restart-secret').at(-1)!;
 let host=make(),space=makeSpace(host);
 try{
  await host.open({deferBackground:true});await space.open();await space.receive('phone',intent('sk-first-value'));assert.equal(receipt().status,'accepted');
  await space.close();await host.close();
  // A fresh instance has no in-memory raw fingerprints; the persisted salted tag must still catch a changed value.
  host=make();space=makeSpace(host);await host.open({deferBackground:true});await space.open();
  await space.receive('phone',intent('sk-first-value'));assert.equal(receipt().status,'accepted');assert.equal(receipt().error,undefined);
  await space.receive('phone',intent('sk-second-value'));assert.equal(receipt().error,'op_id_conflict');
  assert.equal((space.snapshot('phone') as unknown as {host_credentials:{credentials:{name:string;fingerprint:string}[]}}).host_credentials.credentials.find(row=>row.name==='OPENAI_API_KEY')!.fingerprint,'e802e85a');
  await space.close();
  const journal=await readFile(join(dir,'space.json'),'utf8'),rawHash=createHash('sha256').update(canonicalJson(intent('sk-first-value'))).digest('hex');
  assert.equal(journal.includes('sk-first-value'),false);assert.equal(journal.includes('sk-second-value'),false);
  assert.equal(journal.includes(rawHash),false);assert.equal(journal.includes(createHash('sha256').update('sk-first-value').digest('hex')),false);
  const key=await readFile(join(dir,'space.json.key'),'utf8');
  assert.equal((await stat(join(dir,'space.json.key'))).mode&0o777,0o600);assert.match(key,/^[a-f0-9]{64}$/);assert.equal(key.includes('sk-first-value'),false);
  assert.equal(journal.includes(key.trim()),false);
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('a secret op recorded while a dependency is pending keeps its tag, so the retry stays idempotent',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-secret-pending-')),sent:Record<string,unknown>[]=[];
 const transport:SpaceHostTransport={start:()=>Promise.resolve(()=>{ /* Test callback intentionally has no side effects. */ }),send:(_to,body)=>{sent.push(body);return Promise.resolve()},stream:()=>Promise.resolve(),clients:()=>['phone']};
 const make=()=>new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
 const makeSpace=(host:PersonalAgentHost)=>new SpaceHost({path:join(dir,'space.json'),space:'s',host,transport,owner:()=>'phone',secrets:new HostSecretStore(join(dir,'config.json.secrets.json')),environment:{}});
 const stamp=Date.now(),put=(value:string)=>({v:1,type:'intent',op_id:'pending-secret',kind:'secret.put',created_at:stamp,depends_on:['dep'],input:{name:'OPENAI_API_KEY',value}});
 const receipt=(id:string)=>sent.filter(row=>row.type==='receipt'&&row.op_id===id).at(-1)!;
 let host=make(),space=makeSpace(host);
 try{
  await host.open({deferBackground:true});await space.open();
  await space.receive('phone',put('sk-pending-value'));assert.deepEqual([receipt('pending-secret').status,receipt('pending-secret').error],['pending','dependency_pending']);
  // The early pending record carries the salted tag, not just the redacted hash.
  const ops=(JSON.parse(await readFile(join(dir,'space.json'),'utf8')) as {ops:Record<string,{tag?:string}>}).ops;
  assert.match(Object.values(ops)[0]!.tag??'',/^[a-f0-9]{64}$/);
  await space.close();await host.close();
  // A fresh instance has no in-memory fingerprint, so only the stored tag can prove the retry is the same operation.
  host=make();space=makeSpace(host);await host.open({deferBackground:true});await space.open();
  await space.receive('phone',{v:1,type:'intent',op_id:'dep',kind:'snapshot.request',created_at:stamp,input:{}});assert.equal(receipt('dep').status,'accepted');
  await space.receive('phone',put('sk-pending-value'));assert.equal(receipt('pending-secret').status,'accepted',String(receipt('pending-secret').error));assert.equal(receipt('pending-secret').error,undefined);
  await space.receive('phone',put('sk-other-value'));assert.equal(receipt('pending-secret').error,'op_id_conflict');
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

test('a secret op journalled before tags existed replays without a cross-algorithm conflict',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-secret-legacy-')),sent:Record<string,unknown>[]=[];
 const transport:SpaceHostTransport={start:()=>Promise.resolve(()=>{ /* Test callback intentionally has no side effects. */ }),send:(_to,body)=>{sent.push(body);return Promise.resolve()},stream:()=>Promise.resolve(),clients:()=>['phone']};
 const make=()=>new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
 const makeSpace=(host:PersonalAgentHost)=>new SpaceHost({path:join(dir,'space.json'),space:'s',host,transport,owner:()=>'phone',secrets:new HostSecretStore(join(dir,'config.json.secrets.json')),environment:{}});
 const stamp=Date.now(),intent={v:1,type:'intent',op_id:'legacy-secret',kind:'secret.put',created_at:stamp,input:{name:'OPENAI_API_KEY',value:'sk-legacy-value'}};
 const receipt=()=>sent.filter(row=>row.type==='receipt'&&row.op_id==='legacy-secret').at(-1)!;
 let host=make(),space=makeSpace(host);
 try{
  await host.open({deferBackground:true});await space.open();await space.receive('phone',intent);assert.equal(receipt().status,'accepted');
  await space.close();await host.close();
  // An older build stored the redacted hash without a tag; rewriting the journal back to that shape must stay replayable.
  const file=join(dir,'space.json'),journal=JSON.parse(await readFile(file,'utf8')) as {ops:Record<string,{tag?:string}>};
  for(const op of Object.values(journal.ops))delete op.tag;
  await writeFile(file,JSON.stringify(journal));
  host=make();space=makeSpace(host);await host.open({deferBackground:true});await space.open();
  await space.receive('phone',intent);assert.equal(receipt().status,'accepted');assert.equal(receipt().error,undefined);
  const ops=(JSON.parse(await readFile(file,'utf8')) as {ops:Record<string,unknown>}).ops;
  assert.equal(Object.keys(ops).length,1,'a legacy replay is the same operation, not a second one');
 }finally{await space.close();await host.close();await rm(dir,{recursive:true,force:true})}
});

/** Starters share one journal and key file, so they race on the same `.key` while each keeps its own personal store. */
function recordingTransport(sent:Record<string,unknown>[]):SpaceHostTransport{
 return {start:()=>Promise.resolve(()=>{ /* Test callback intentionally has no side effects. */ }),send:(_to,body)=>{sent.push(body);return Promise.resolve()},stream:()=>Promise.resolve(),clients:()=>['phone']};
}
async function concurrentStarters(dir:string,sent:Record<string,unknown>[],count:number){
 const transport=recordingTransport(sent),make=async()=>{const host=new PersonalAgentHost({path:join(dir,'personal-'+randomUUID()+'.json'),userScope:'test',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});await host.open({deferBackground:true});return {host,space:new SpaceHost({path:join(dir,'space.json'),space:'s',host,transport,owner:()=>'phone',secrets:new HostSecretStore(join(dir,'config-'+randomUUID()+'.secrets.json')),environment:{}})}};
 const rows=await Promise.all(Array.from({length:count},make));
 return {rows,close:async()=>{await Promise.all(rows.map(async row=>{await row.space.close();await row.host.close()}))}};
}
function secretRaceIntent(value:string){return {v:1,type:'intent',op_id:'raced-secret',kind:'secret.put',created_at:Date.now(),input:{name:'OPENAI_API_KEY',value}}}

test('concurrent starters publish one complete key file and every starter reads the same key',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-secret-race-')),sent:Record<string,unknown>[]=[],receipt=()=>sent.filter(row=>row.type==='receipt'&&row.op_id==='raced-secret').at(-1)!;
 const started=await concurrentStarters(dir,sent,8);
 try{
  // No starter may observe a half-written key: the name only appears once its contents are complete.
  await Promise.all(started.rows.map(row=>row.space.open()));
  const keyFile=join(dir,'space.json.key'),key=await readFile(keyFile,'utf8');
  assert.match(key,/^[a-f0-9]{64}$/u);assert.equal((await stat(keyFile)).mode&0o777,0o600);
  assert.deepEqual((await readdir(dir)).filter(name=>name.endsWith('.tmp')),[],'publishing must not leave a temp file behind');
  await started.rows[0]!.space.receive('phone',secretRaceIntent('sk-raced-value'));assert.equal(receipt().status,'accepted');
  // A starter that lost the race tags the same operation identically only if it read the winner's key.
  for(const row of started.rows.slice(1)){await row.space.receive('phone',secretRaceIntent('sk-raced-value'));assert.equal(receipt().error,undefined)}
  await started.rows[1]!.space.receive('phone',secretRaceIntent('sk-raced-changed'));assert.equal(receipt().error,'op_id_conflict');
 }finally{await started.close();await rm(dir,{recursive:true,force:true})}
});

test('a zero-length key left by an interrupted publish is replaced instead of blocking startup',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-secret-empty-')),sent:Record<string,unknown>[]=[],receipt=()=>sent.filter(row=>row.type==='receipt'&&row.op_id==='raced-secret').at(-1)!,keyFile=join(dir,'space.json.key');
 // The old writer created the key file and then wrote it, so a crash in between left exactly this.
 await writeFile(keyFile,'',{mode:0o600});
 const started=await concurrentStarters(dir,sent,3);
 try{
  await Promise.all(started.rows.map(row=>row.space.open()));
  const key=await readFile(keyFile,'utf8');assert.match(key,/^[a-f0-9]{64}$/u);assert.equal((await stat(keyFile)).mode&0o777,0o600);
  await started.rows[0]!.space.receive('phone',secretRaceIntent('sk-repaired-value'));assert.equal(receipt().status,'accepted');
  for(const row of started.rows.slice(1)){await row.space.receive('phone',secretRaceIntent('sk-repaired-value'));assert.equal(receipt().error,undefined)}
  await started.rows[1]!.space.receive('phone',secretRaceIntent('sk-repaired-changed'));assert.equal(receipt().error,'op_id_conflict');
 }finally{await started.close();await rm(dir,{recursive:true,force:true})}
});

test('a symlinked key file is refused instead of supplying the tag key',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-secret-link-')),sent:Record<string,unknown>[]=[],key=randomUUID().replaceAll('-','')+'a'.repeat(32),keyFile=join(dir,'space.json.key');
 try{
  // A 0600 file elsewhere in the directory tree is still not the key this journal expects.
  await writeFile(join(dir,'elsewhere.key'),key,{mode:0o600});await symlink(join(dir,'elsewhere.key'),keyFile);
  const linked=await concurrentStarters(dir,sent,1);
  try{await assert.rejects(linked.rows[0]!.space.open(),(error:NodeJS.ErrnoException)=>error.code==='space_secret_key_symlink')}finally{await linked.close()}
  await rm(keyFile);await writeFile(keyFile,key,{mode:0o600});
  const direct=await concurrentStarters(dir,sent,1);
  try{await direct.rows[0]!.space.open();assert.equal((await stat(keyFile)).mode&0o777,0o600)}finally{await direct.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('a key file readable by other accounts or of the wrong length is refused',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-secret-mode-')),sent:Record<string,unknown>[]=[],keyFile=join(dir,'space.json.key'),key='b'.repeat(64);
 try{
  await writeFile(keyFile,key,{mode:0o644});
  const wide=await concurrentStarters(dir,sent,1);
  try{await assert.rejects(wide.rows[0]!.space.open(),(error:NodeJS.ErrnoException)=>error.code==='space_secret_key_permissions')}finally{await wide.close()}
  await chmod(keyFile,0o600);const narrow=await concurrentStarters(dir,sent,1);
  try{await narrow.rows[0]!.space.open()}finally{await narrow.close()}
  await writeFile(keyFile,key.slice(0,63),{mode:0o600});const short=await concurrentStarters(dir,sent,1);
  try{await assert.rejects(short.rows[0]!.space.open(),(error:NodeJS.ErrnoException)=>error.code==='space_secret_key_invalid')}finally{await short.close()}
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('Feishu app setup link generated after app.start reaches the owner snapshot',async()=>{
 let polls=0;const url='https://open.feishu.cn/page/cli?code=late';
 const view=(withUrl:boolean)=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting',...(withUrl?{verification_url:url}:{})}});
 const f=await fixture({owner:'phone',feishuConnector:{snapshot:()=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting'}}),command:method=>Promise.resolve(method==='feishu.app.status'?view(++polls>=2):view(false)),open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{const start=await f.send('phone','setup','connector.feishu',{action:'app.start'});assert.equal(start.status,'accepted');assert.equal(((start.result as Record<string,unknown>).app_setup as Record<string,unknown>).verification_url,undefined);
  for(let i=0;i<1500&&!f.sent.some(row=>row.type==='snapshot'&&JSON.stringify(row).includes('code=late'));i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(polls>=2);const withLink=f.sent.filter(row=>row.type==='snapshot'&&JSON.stringify(row).includes(url)) as {snapshot:{host_feishu?:{app_setup:{verification_url:string}}}}[];assert.ok(withLink.length>0);for(const row of withLink)assert.equal(row.snapshot.host_feishu?.app_setup.verification_url,url);
 }finally{await f.close()}
});

test('repeated app.start keeps exactly one setup poll chain per owner',async()=>{
 let polls=0;const view=()=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting'}});
 // Status keeps answering "waiting", so every chain stays alive and the call rate reveals how many exist.
 const f=await fixture({owner:'phone',feishuPollMs:20,feishuConnector:{snapshot:view,command:method=>method==='feishu.app.status'?(polls++,Promise.resolve(view())):Promise.resolve(view()),open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{
  for(const op of ['setup-a','setup-b','setup-c'])assert.equal((await f.send('phone',op,'connector.feishu',{action:'app.start'})).status,'accepted');
  const start=polls;await new Promise(resolve=>setTimeout(resolve,250));const calls=polls-start;
  assert.ok(calls<15,`three app.start intents must share one poll chain (${calls} status calls)`);
 }finally{await f.close()}
});

test('close cancels an in-flight setup poll and does not publish its late snapshot',async()=>{
 let polls=0,commandFinished=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
 const url='https://open.feishu.cn/page/cli?code=after-close';
 const view=(withUrl:boolean)=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting',...(withUrl?{verification_url:url}:{})}});
 const f=await fixture({owner:'phone',feishuConnector:{snapshot:()=>view(false),command:method=>method==='feishu.app.status'?(polls++,gate.then(()=>{commandFinished=true;return view(true)})):Promise.resolve(view(false)),open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{
  assert.equal((await f.send('phone','setup','connector.feishu',{action:'app.start'})).status,'accepted');
  for(let i=0;i<200&&polls===0;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(polls,1);
  let published=0;const publish=f.space.publishSnapshot.bind(f.space);f.space.publishSnapshot=(async(...args:Parameters<typeof publish>)=>{published++;return publish(...args)});
  const closing=f.space.close();release();await closing;
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(commandFinished,true,'close must wait for the in-flight status call');
  assert.equal(published,0,'a status call returning during close must not publish a snapshot');
 }finally{release();await f.close()}
});

test('close clears a snapshot timer queued before it while an in-flight setup poll is still pending',async()=>{
 let polls=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
 const url='https://open.feishu.cn/page/cli?code=queued-before-close';
 const view=(withUrl:boolean)=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting',...(withUrl?{verification_url:url}:{})}});
 const f=await fixture({owner:'phone',feishuConnector:{snapshot:()=>view(false),command:method=>method==='feishu.app.status'?(polls++,gate.then(()=>view(true))):Promise.resolve(view(false)),open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{
  // app.start runs through the Host, whose change notification queues the 100ms snapshot timer before close.
  const notifications:string[]=[];f.host.subscribe(()=>notifications.push('changed'));
  assert.equal((await f.send('phone','setup','connector.feishu',{action:'app.start'})).status,'accepted');
  assert.ok(notifications.length>0,'app.start must notify the Host so a snapshot timer is queued');
  for(let i=0;i<200&&polls===0;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(polls,1);
  let published=0;const publish=f.space.publishSnapshot.bind(f.space);f.space.publishSnapshot=(async(...args:Parameters<typeof publish>)=>{published++;return publish(...args)});
  // close now waits longer than the timer delay for the in-flight status call, so a timer left armed would fire inside close.
  const closing=f.space.close();await new Promise(resolve=>setTimeout(resolve,150));release();await closing;
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(published,0,'a snapshot timer queued before close must not publish while close awaits the setup poll');
 }finally{release();await f.close()}
});

test('a Feishu setup link that appears long after app.start still reaches the owner',async()=>{
 let polls=0;const url='https://open.feishu.cn/page/cli?code=very-late';
 const view=(withUrl:boolean)=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting',...(withUrl?{verification_url:url}:{})}});
 // The connector's config process can run for 300s, so a link after many empty polls is still delivered.
 const f=await fixture({owner:'phone',feishuConnector:{snapshot:()=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting'}}),command:method=>Promise.resolve(method==='feishu.app.status'?view(++polls>40):view(false)),open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{assert.equal((await f.send('phone','setup','connector.feishu',{action:'app.start'})).status,'accepted');
  for(let i=0;i<1500&&!f.sent.some(row=>row.type==='snapshot'&&JSON.stringify(row).includes('code=very-late'));i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(polls>40);const withLink=f.sent.filter(row=>row.type==='snapshot'&&JSON.stringify(row).includes(url)) as {snapshot:{host_feishu?:{app_setup:{verification_url:string}}}}[];assert.ok(withLink.length>0);for(const row of withLink)assert.equal(row.snapshot.host_feishu?.app_setup.verification_url,url);
 }finally{await f.close()}
});

test('a transient Feishu app status failure does not drop the setup link',async()=>{
 let polls=0;const url='https://open.feishu.cn/page/cli?code=after-failure';
 const view=(withUrl:boolean)=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting',...(withUrl?{verification_url:url}:{})}});
 const f=await fixture({owner:'phone',feishuConnector:{snapshot:()=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting'}}),command:method=>{if(method!=='feishu.app.status')return Promise.resolve(view(false));
   // Two unavailable status calls are retried rather than ending the poll.
   if(++polls<=2)return Promise.reject(Error('unavailable'));return Promise.resolve(view(true))},open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{const start=await f.send('phone','setup','connector.feishu',{action:'app.start'});assert.equal(start.status,'accepted');assert.equal(JSON.stringify(start.result).includes('code=after-failure'),false);
  for(let i=0;i<1500&&!f.sent.some(row=>row.type==='snapshot'&&JSON.stringify(row).includes('code=after-failure'));i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(polls>=3);const withLink=f.sent.filter(row=>row.type==='snapshot'&&JSON.stringify(row).includes(url)) as {snapshot:{host_feishu?:{app_setup:{verification_url:string}}}}[];assert.ok(withLink.length>0);for(const row of withLink)assert.equal(row.snapshot.host_feishu?.app_setup.verification_url,url);
 }finally{await f.close()}
});

test('a pending Feishu login is never projected as connected, even though beginLogin pauses the connector',async()=>{
 const f=await fixture({owner:'phone',feishuConnector:{snapshot:()=>({available:true,configured:true,state:'paused',verification_url:'https://accounts.feishu.cn/device?code=p'}),command:()=>Promise.resolve({available:true,configured:true,state:'paused',verification_url:'https://accounts.feishu.cn/device?code=p'}),open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{const r=await f.send('phone','login','connector.feishu',{action:'login'});const view=r.result as Record<string,unknown>;assert.deepEqual([view.connected,view.login_pending,view.verification_url],[false,true,'https://accounts.feishu.cn/device?code=p']);
  const snap=f.space.snapshot('phone') as unknown as {host_feishu:Record<string,unknown>};assert.equal(snap.host_feishu.connected,false);
 }finally{await f.close()}
});

test('a Feishu login whose link request fails leaves the phone signed out, not connected',async()=>{
 const f=await fixture({owner:'phone',feishuConnector:{snapshot:()=>({available:true,configured:true,state:'paused',auth_issue:'login_required'}),command:()=>Promise.reject(Error('lark_cli_failed')),open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{assert.equal((await f.send('phone','login','connector.feishu',{action:'login'})).status,'rejected');
  const snap=f.space.snapshot('phone') as unknown as {host_feishu:Record<string,unknown>};assert.equal(snap.host_feishu.connected,false);
 }finally{await f.close()}
 const ok=await fixture({owner:'phone',feishuConnector:{snapshot:()=>({available:true,configured:true,state:'ready',signed_in:true,account_id:'acct'}),command:()=>Promise.resolve({available:true,configured:true,state:'ready',signed_in:true,account_id:'acct'}),open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{const r=await ok.send('phone','done','connector.feishu',{action:'complete'});assert.equal((r.result as Record<string,unknown>).connected,true);assert.equal(JSON.stringify(r.result).includes('acct'),false)}finally{await ok.close()}
});

test('a login that is temporarily unverifiable is not shown as connected and carries its reason',async()=>{
  const f=await fixture({owner:'phone',feishuConnector:{snapshot:()=>({available:true,configured:true,state:'ready',signed_in:true,unverified:true,error:'飞书暂时无法验证登录，网络恢复后会自动继续'}),command:()=>Promise.resolve({}),open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
  try{const view=(f.space.snapshot('phone') as unknown as {host_feishu:Record<string,unknown>}).host_feishu;
   assert.equal(view.connected,false);assert.equal(view.unverified,true);assert.match(String(view.error),/无法验证登录/u);
  }finally{await f.close()}
});

test('after logout a failed re-login keeps the phone signed out though the account id is retained',async()=>{
 let signed=true;const view=()=>({available:true,configured:true,state:signed?'ready':'paused',signed_in:signed,account_id:'acct'});
 const f=await fixture({owner:'phone',feishuConnector:{snapshot:view,command:method=>{if(method==='feishu.disconnect'){signed=false;return Promise.resolve(view())}if(method==='feishu.login')return Promise.reject(Error('lark_cli_failed'));return Promise.resolve(view())},open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{assert.equal((f.space.snapshot('phone') as unknown as {host_feishu:{connected:boolean}}).host_feishu.connected,true);
  assert.equal((await f.send('phone','out','connector.feishu',{action:'logout'})).status,'accepted');
  assert.equal((await f.send('phone','in','connector.feishu',{action:'login'})).status,'rejected');
  assert.equal((f.space.snapshot('phone') as unknown as {host_feishu:{connected:boolean}}).host_feishu.connected,false);
 }finally{await f.close()}
});
