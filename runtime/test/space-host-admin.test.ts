import {test} from 'node:test';
import assert from 'node:assert/strict';
import {realpath,mkdtemp,rm,readFile,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonalAgentHost} from '../src/personal-agent/host.js';
import {SuggestionPool} from '../src/core/suggestions.js';
import {SpaceHost,type SpaceHostTransport} from '../src/space-host/service.js';
import {HostSecretStore,SPACE_SECRET_NAMES,overlaySpaceSecrets} from '../src/space-host/host-admin.js';

async function fixture(options:{owner?:string;env?:NodeJS.ProcessEnv;feishu?:boolean;feishuConnector?:Parameters<PersonalAgentHost['setFeishu']>[0];memory?:unknown}={}){
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-admin-')),sent:Record<string,unknown>[]=[];const calls:string[]=[];
 const transport:SpaceHostTransport={start:()=>Promise.resolve(()=>{ /* Test callback intentionally has no side effects. */ }),send:(_to,body)=>{sent.push(body);return Promise.resolve()},stream:()=>Promise.resolve(),clients:()=>['phone','other']};
 const host=new PersonalAgentHost({path:join(dir,'personal.json'),userScope:'test',memory:()=>options.memory as never,pool:new SuggestionPool(),evidence:()=>null});
 if(options.feishu)host.setFeishu({snapshot:()=>({available:true,configured:true,state:'unauthorized',auth_issue:'login_required',account_id:'tenant-secret',app_setup:{state:'idle'}}),command:(method)=>{calls.push(method);return Promise.resolve({available:true,configured:true,state:'unauthorized',account_id:'tenant-secret',verification_url:method==='feishu.login'?'https://accounts.feishu.cn/device?code=x':'https://evil.example/x',chats:[]})},open:()=>Promise.resolve(),close:()=>Promise.resolve()});
 if(options.feishuConnector)host.setFeishu(options.feishuConnector);
 const secrets=new HostSecretStore(join(dir,'config.json.secrets.json')),env=options.env??{};
 const space=new SpaceHost({path:join(dir,'space.json'),space:'s',host,transport,owner:()=>options.owner,secrets,environment:env,feishuPollMs:10});
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

test('secrets: allowlist, 0600 store, env wins, snapshot has fingerprints only, journal has no secret bytes',async()=>{
 assert.ok(SPACE_SECRET_NAMES.includes('OPENAI_API_KEY'));for(const n of ['DESKTOP_TOKEN','NOVA_HUB_TOKEN','SERVER_TOKEN_FILE','MEMORY_TOKEN','NATIVE_REALTIME_API_KEY'])assert.equal(SPACE_SECRET_NAMES.includes(n),false);
 const f=await fixture({owner:'phone',env:{GEMINI_API_KEY:'operator-gem'}});const secret='sk-super-secret-value-123';
 try{const r=await f.send('phone','put','secret.put',{name:'OPENAI_API_KEY',value:secret});assert.deepEqual([r.status,r.applies,r.shadowed_by_environment],['accepted','restart',false]);
  const g=await f.send('phone','put2','secret.put',{name:'GEMINI_API_KEY',value:'phone-gem'});assert.equal(g.shadowed_by_environment,true);
  assert.equal((await f.send('phone','bad','secret.put',{name:'DESKTOP_TOKEN',value:'x'})).status,'rejected');
  const path=join(f.dir,'config.json.secrets.json');assert.equal((await stat(path)).mode&0o777,0o600);
  const snap=JSON.stringify(f.space.snapshot('phone')),creds=(f.space.snapshot('phone') as unknown as {host_credentials:{name:string;source:string;fingerprint:string}[]}).host_credentials;
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

test('a damaged secrets file stops startup with an error naming the file',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-secrets-'));
 try{for(const text of ['{','{"v":2,"secrets":{}}','\n']){await writeFile(join(dir,'config.json.secrets.json'),text,{mode:0o600});
   assert.throws(()=>overlaySpaceSecrets({},join(dir,'config.json')),/space_secrets_invalid: .*config\.json\.secrets\.json/)}
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('Feishu app setup link generated after app.start reaches the owner snapshot',async()=>{
 let polls=0;const url='https://open.feishu.cn/page/cli?code=late';
 const view=(withUrl:boolean)=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting',...(withUrl?{verification_url:url}:{})}});
 const f=await fixture({owner:'phone',feishuConnector:{snapshot:()=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting'}}),command:method=>Promise.resolve(method==='feishu.app.status'?view(++polls>=2):view(false)),open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{const start=await f.send('phone','setup','connector.feishu',{action:'app.start'});assert.equal(start.status,'accepted');assert.equal(((start.result as Record<string,unknown>).app_setup as Record<string,unknown>).verification_url,undefined);
  for(let i=0;i<100&&!f.sent.some(row=>row.type==='snapshot'&&JSON.stringify(row).includes('code=late'));i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(polls>=2);const snap=f.sent.filter(row=>row.type==='snapshot').at(-1) as {snapshot:{host_feishu:{app_setup:{verification_url:string}}}};assert.equal(snap.snapshot.host_feishu.app_setup.verification_url,url);
 }finally{await f.close()}
});

test('a Feishu setup link that appears long after app.start still reaches the owner',async()=>{
 let polls=0;const url='https://open.feishu.cn/page/cli?code=very-late';
 const view=(withUrl:boolean)=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting',...(withUrl?{verification_url:url}:{})}});
 // The connector's config process can run for 300s, so a link after many empty polls is still delivered.
 const f=await fixture({owner:'phone',feishuConnector:{snapshot:()=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting'}}),command:method=>Promise.resolve(method==='feishu.app.status'?view(++polls>40):view(false)),open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{assert.equal((await f.send('phone','setup','connector.feishu',{action:'app.start'})).status,'accepted');
  for(let i=0;i<500&&!f.sent.some(row=>row.type==='snapshot'&&JSON.stringify(row).includes('code=very-late'));i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(polls>40);const snap=f.sent.filter(row=>row.type==='snapshot').at(-1) as {snapshot:{host_feishu:{app_setup:{verification_url:string}}}};assert.equal(snap.snapshot.host_feishu.app_setup.verification_url,url);
 }finally{await f.close()}
});

test('a transient Feishu app status failure does not drop the setup link',async()=>{
 let polls=0;const url='https://open.feishu.cn/page/cli?code=after-failure';
 const view=(withUrl:boolean)=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting',...(withUrl?{verification_url:url}:{})}});
 const f=await fixture({owner:'phone',feishuConnector:{snapshot:()=>({available:true,configured:false,state:'unauthorized',app_setup:{state:'waiting'}}),command:method=>{if(method!=='feishu.app.status')return Promise.resolve(view(false));
   // Two unavailable status calls are retried rather than ending the poll.
   if(++polls<=2)return Promise.reject(Error('unavailable'));return Promise.resolve(view(true))},open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{assert.equal((await f.send('phone','setup','connector.feishu',{action:'app.start'})).status,'accepted');assert.equal(f.sent.some(row=>JSON.stringify(row).includes('code=after-failure')),false);
  for(let i=0;i<200&&!f.sent.some(row=>row.type==='snapshot'&&JSON.stringify(row).includes('code=after-failure'));i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(polls>=3);const snap=f.sent.filter(row=>row.type==='snapshot').at(-1) as {snapshot:{host_feishu:{app_setup:{verification_url:string}}}};assert.equal(snap.snapshot.host_feishu.app_setup.verification_url,url);
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

test('after logout a failed re-login keeps the phone signed out though the account id is retained',async()=>{
 let signed=true;const view=()=>({available:true,configured:true,state:signed?'ready':'paused',signed_in:signed,account_id:'acct'});
 const f=await fixture({owner:'phone',feishuConnector:{snapshot:view,command:method=>{if(method==='feishu.disconnect'){signed=false;return Promise.resolve(view())}if(method==='feishu.login')return Promise.reject(Error('lark_cli_failed'));return Promise.resolve(view())},open:()=>Promise.resolve(),close:()=>Promise.resolve()}});
 try{assert.equal((f.space.snapshot('phone') as unknown as {host_feishu:{connected:boolean}}).host_feishu.connected,true);
  assert.equal((await f.send('phone','out','connector.feishu',{action:'logout'})).status,'accepted');
  assert.equal((await f.send('phone','in','connector.feishu',{action:'login'})).status,'rejected');
  assert.equal((f.space.snapshot('phone') as unknown as {host_feishu:{connected:boolean}}).host_feishu.connected,false);
 }finally{await f.close()}
});
