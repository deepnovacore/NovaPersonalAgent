import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,realpath,rm,writeFile,chmod,stat,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {secureSidecar,PrivateDatabaseError} from '../src/storage/private-database.js'

const moduleUrl=new URL('../src/storage/private-database.js',import.meta.url).href

test('sidecar validation rejects unsafe files without changing their permissions',{skip:process.platform==='win32'},async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-sidecar-permissions-')),database=join(dir,'memory.sqlite'),sidecar=database+'-shm'
 try{
  assert.doesNotThrow(()=>secureSidecar(database,'-shm'))
  await writeFile(sidecar,'',{mode:0o600});assert.doesNotThrow(()=>secureSidecar(database,'-shm'))
  await chmod(sidecar,0o644)
  assert.throws(()=>secureSidecar(database,'-shm'),(error:unknown)=>error instanceof PrivateDatabaseError&&error.code==='STORE_WRITE_FAILED')
  assert.equal((await stat(sidecar)).mode&0o777,0o644)
  await rm(sidecar);const target=join(dir,'target');await writeFile(target,'',{mode:0o600});await symlink(target,sidecar)
  assert.throws(()=>secureSidecar(database,'-shm'),PrivateDatabaseError)
  assert.equal((await stat(target)).mode&0o777,0o600)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('sidecar validation preserves live SQLite SHM locks across independent readers',{skip:process.platform==='win32',timeout:15000},async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-sidecar-locks-')),database=join(dir,'memory.sqlite')
 try{
  // Keep the mapped reader in a child: a regression SIGBUS must fail this test,
  // rather than taking down the test runner and losing the other test results.
  const reader=`import{DatabaseSync}from'node:sqlite';for(let i=0;i<1000;i++){const db=new DatabaseSync(process.argv[1]);db.prepare('SELECT count(*) FROM sample').get();db.close();await new Promise(resolve=>setTimeout(resolve,1))}`
  const holder=`import assert from'node:assert/strict';import{DatabaseSync}from'node:sqlite';import{writeFileSync,statSync}from'node:fs';import{spawn}from'node:child_process';import{secureSidecar}from ${JSON.stringify(moduleUrl)};process.umask(0o022);const p=process.argv[1];writeFileSync(p,'',{mode:0o600});const db=new DatabaseSync(p);db.exec('PRAGMA journal_mode=WAL;CREATE TABLE sample(id INTEGER PRIMARY KEY,n INTEGER);INSERT INTO sample VALUES(1,7)');const query=db.prepare('SELECT n FROM sample WHERE id=1');assert.equal(query.get().n,7);assert.equal(statSync(p+'-wal').mode&0o777,0o600);assert.equal(statSync(p+'-shm').mode&0o777,0o600);secureSidecar(p,'-wal');secureSidecar(p,'-shm');const child=spawn(process.execPath,['--input-type=module','--eval',${JSON.stringify(reader)},p]);let error='';child.stderr.on('data',data=>error+=data);const timer=setInterval(()=>assert.equal(query.get().n,7),1);const result=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));clearInterval(timer);assert.equal(result.code,0,error);assert.equal(result.signal,null);assert.equal(query.get().n,7);db.close()`
  const result=spawnSync(process.execPath,['--input-type=module','--eval',holder,database],{encoding:'utf8',timeout:12000})
  assert.equal(result.error,undefined)
  assert.equal(result.signal,null,`SQLite holder crashed: ${result.signal}`)
  assert.equal(result.status,0,result.stderr)
 }finally{await rm(dir,{recursive:true,force:true})}
})
