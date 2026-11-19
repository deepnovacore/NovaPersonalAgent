import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {loadRelayFixture} from './helpers/relay-fixture.js';
import {attachExistingHostSpace,initializeHostSpace,hostSpaceConfigSchema,readHostSpaceConfig,SpaceHostController,type HostSpaceConfig,type SpaceHostModules} from '../src/space-host/config.js';
import {PersonalAgentHost} from '../src/personal-agent/host.js';
import {SuggestionPool} from '../src/core/suggestions.js';

// Legacy readers strip unknown fields but still require the literal version 1.
const legacyReader=z.object({...hostSpaceConfigSchema.shape,v:z.literal(1)}).omit({data_mode:true});

test('v2 existing mode fails closed in old readers and never defaults to isolated in new readers',()=>{
 const config={v:1,mode:'host',space:'fixture',personal_path:'/fixture/personal.json',relay_url:'https://fixture.invalid',epoch:1,identity:{device:'host',signingPublicKey:{},signingPrivateKey:{},encryptionPublicKey:{},encryptionPrivateKey:{}},content_key:'x'.repeat(43),members:[],data_mode:'existing'};
 assert.equal(legacyReader.safeParse(config).success,true);
 assert.equal('data_mode' in legacyReader.parse(config),false,'v1 readers would silently discard the new mode');
 assert.equal(hostSpaceConfigSchema.safeParse({...config,v:2}).success,true);
 assert.equal(legacyReader.safeParse({...config,v:2}).success,false);
 assert.equal(hostSpaceConfigSchema.safeParse({...config,v:2,data_mode:undefined}).success,false);
 assert.equal(hostSpaceConfigSchema.safeParse({...config,v:2,data_mode:'isolated'}).success,false);
});

test('existing-data attachment writes v2 while isolated creation stays compatible v1',async t=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-config-version-'));
 const {RelayServer}=await loadRelayFixture(),bootstrapToken='private-fixture-bootstrap-0123456789';
 const relay=new RelayServer({securityPath:':memory:',mailboxPath:':memory:',bootstrapToken});
 t.after(async()=>{await relay.close();await rm(dir,{recursive:true,force:true})});
 const relayUrl=await relay.listen(),personalPath=join(dir,'original.personal.json'),configPath=join(dir,'existing.json');
 await writeFile(personalPath,'original fixture bytes',{mode:0o600});
 await attachExistingHostSpace({configPath,personalPath,relayUrl,bootstrapToken});
 const existing=readHostSpaceConfig(configPath);
 assert.equal(existing.v,2);assert.equal(existing.data_mode,'existing');assert.equal(existing.personal_path,personalPath);
 assert.equal(await readFile(personalPath,'utf8'),'original fixture bytes');
 assert.equal(legacyReader.safeParse(existing).success,false);
 assert.equal(hostSpaceConfigSchema.safeParse({...existing,data_mode:undefined}).success,false,'v2 cannot fall back to isolated mode');
 const isolatedPath=join(dir,'isolated.json');
 await initializeHostSpace({configPath:isolatedPath,personalPath:join(dir,'new.personal.json'),relayUrl,bootstrapToken});
 const isolated=readHostSpaceConfig(isolatedPath);
 assert.equal(isolated.v,1);assert.equal(isolated.data_mode,'isolated');assert.equal(legacyReader.safeParse(isolated).success,true);
});

test('legacy existing config upgrades atomically under Host ownership before relay starts, preserving identity and membership',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'space-config-upgrade-')),configPath=join(dir,'config.json');
 const host=new PersonalAgentHost({path:join(dir,'original.personal.json'),userScope:'original-owner',memory:()=>undefined,pool:new SuggestionPool(),evidence:()=>null});
 const member={selected_version:1 as const,device:'owner-phone',signingPublicKey:{x:'phone-sign'},encryptionPublicKey:{x:'phone-encrypt'}};
 const legacy:HostSpaceConfig={v:1,mode:'host',data_mode:'existing',space:'fixture-space',personal_path:host.path,relay_url:'https://fixture.invalid',epoch:4,identity:{device:'host',signingPublicKey:{x:'host-sign'},signingPrivateKey:{d:'host-private'},encryptionPublicKey:{x:'host-encrypt'},encryptionPrivateKey:{d:'host-private-encrypt'}},content_key:'x'.repeat(43),members:[member],owner_device:member.device,revoked_members:[{...member,device:'previous-phone'}]};
 let starts=0;
 const sdk={crypto:{},RelayClient:class {start(){starts++;assert.deepEqual(readHostSpaceConfig(configPath),{...legacy,v:2});throw Error('upgrade_observed')}}} as unknown as SpaceHostModules;
 const controller=new SpaceHostController(configPath,legacy,host,sdk);host.setSpaceHost(controller);
 try{
  await writeFile(configPath,JSON.stringify(legacy),{mode:0o600});
  assert.equal(readHostSpaceConfig(configPath).v,1,'construction must not mutate an unowned configuration');
  await assert.rejects(host.open({deferBackground:true}),/upgrade_observed/);
  const upgraded=readHostSpaceConfig(configPath);
  assert.equal(starts,1);assert.deepEqual(upgraded,{...legacy,v:2});assert.equal(controller.config.v,2);
  assert.equal(legacyReader.safeParse(upgraded).success,false);
 }finally{await host.close();await rm(dir,{recursive:true,force:true})}
});
