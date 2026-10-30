import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,createConnection} from 'node:net';
import {mkdtemp,rm,stat,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startSpaceAdminSocket,spaceAdminRequest,adminSocketPath,SPACE_ADMIN_REQUEST_LIMIT,type SpaceAdminTarget} from '../src/space-host/admin-socket.js';

const target=(calls:unknown[][]):SpaceAdminTarget=>({status:()=>({mode:'host',clients:[]}),invitation:()=>Promise.resolve({id:'inv'}),pairings:()=>Promise.resolve([{id:'p1'}]),
 confirmPairing:(id,fingerprint)=>{calls.push(['confirm',id,fingerprint]);return id==='bad'?Promise.reject(Error('pairing_fingerprint_mismatch')):Promise.resolve({device:'phone'})},
 revoke:device=>{calls.push(['revoke',device]);return Promise.resolve({revoked:device})}});
const tempDir=async(t:{after(fn:()=>Promise<void>):void})=>{const dir=await mkdtemp(join(await realpath(tmpdir()),'adm-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir};
const raw=(path:string,payload:string)=>new Promise<string>(resolve=>{const socket=createConnection(path);let out='';socket.setEncoding('utf8');socket.on('data',(c:string)=>{out+=c});socket.on('close',()=>resolve(out));socket.on('error',()=>resolve(out));socket.on('connect',()=>socket.write(payload))});

test('admin socket round trip, 0600 mode and removal on close',{skip:process.platform==='win32'},async t=>{
 const dir=await tempDir(t),path=adminSocketPath(join(dir,'config.json')),calls:unknown[][]=[];
 const admin=await startSpaceAdminSocket(target(calls),path);assert.ok(admin);
 assert.equal((await stat(path)).mode&0o777,0o600);
 assert.deepEqual(await spaceAdminRequest(path,'status'),{mode:'host',clients:[]});
 assert.deepEqual(await spaceAdminRequest(path,'invitation'),{id:'inv'});
 assert.deepEqual(await spaceAdminRequest(path,'pairings'),[{id:'p1'}]);
 assert.deepEqual(await spaceAdminRequest(path,'confirm_pairing',{id:'p1',fingerprint:'fp'}),{device:'phone'});
 assert.deepEqual(await spaceAdminRequest(path,'revoke',{device:'d1'}),{revoked:'d1'});
 await assert.rejects(spaceAdminRequest(path,'confirm_pairing',{id:'bad',fingerprint:'fp'}),/pairing_fingerprint_mismatch/);
 assert.deepEqual(calls,[['confirm','p1','fp'],['revoke','d1'],['confirm','bad','fp']]);
 await admin.close();
 await assert.rejects(stat(path),{code:'ENOENT'});
 await assert.rejects(spaceAdminRequest(path,'status'),/space_host_not_running/);
});

test('admin socket rejects malformed, unknown and oversized requests and closes the connection',{skip:process.platform==='win32'},async t=>{
 const dir=await tempDir(t),path=adminSocketPath(join(dir,'config.json')),calls:unknown[][]=[];
 const admin=await startSpaceAdminSocket(target(calls),path);assert.ok(admin);t.after(()=>admin.close());
 for(const payload of ['not json\n','{"id":1,"method":"nope"}\n','{"id":1,"method":"revoke"}\n','{"id":1,"method":"revoke","params":{"device":"d","extra":1}}\n','{"id":1,"method":"status","extra":true}\n'])
  assert.match(await raw(path,payload),/"ok":false,"error":"malformed_request"/);
 assert.match(await raw(path,'{"id":1,"method":"status","params":{},"pad":"'+'a'.repeat(SPACE_ADMIN_REQUEST_LIMIT)+'"}\n'),/request_too_large/);
 assert.match(await raw(path,'a'.repeat(SPACE_ADMIN_REQUEST_LIMIT+1)),/request_too_large/);
 assert.deepEqual(calls,[]);
 assert.deepEqual(await spaceAdminRequest(path,'status'),{mode:'host',clients:[]});
});

test('stale socket files are replaced; live sockets and regular files are left alone',{skip:process.platform==='win32'},async t=>{
 const dir=await tempDir(t),path=adminSocketPath(join(dir,'config.json')),diagnostics:string[]=[];
 const stale=createServer();await new Promise<void>(resolve=>stale.listen(path,resolve));
 const live=await startSpaceAdminSocket(target([]),path,code=>diagnostics.push(code));
 assert.equal(live,undefined);assert.deepEqual(diagnostics,['space_admin_socket_unavailable']);
 await new Promise<void>(resolve=>stale.close(()=>resolve()));
 // A closed Node server unlinks its path; recreate a dead socket file by leaving the listener without closing it cleanly.
 const dead=createServer();await new Promise<void>(resolve=>dead.listen(path,resolve));(dead as unknown as {_handle:{close():void}})._handle.close();
 const admin=await startSpaceAdminSocket(target([]),path,code=>diagnostics.push(code));assert.ok(admin);t.after(()=>admin.close());
 assert.deepEqual(await spaceAdminRequest(path,'status'),{mode:'host',clients:[]});
 const file=join(dir,'plain.json.admin.sock');await writeFile(file,'x');
 assert.equal(await startSpaceAdminSocket(target([]),file,code=>diagnostics.push(code)),undefined);assert.equal(diagnostics.length,2);
});

test('over-long socket paths emit a diagnostic instead of failing startup',{skip:process.platform==='win32'},async()=>{
 const diagnostics:string[]=[];
 assert.equal(await startSpaceAdminSocket(target([]),'/tmp/'+'a'.repeat(120)+'.admin.sock',code=>diagnostics.push(code)),undefined);
 assert.deepEqual(diagnostics,['space_admin_socket_unavailable']);
});
