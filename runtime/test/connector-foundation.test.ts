import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {connectorSourceId,initializeSourceState,assertSourceStateSchema} from '../src/memory-substrate/source-state.js'
import {WorkspaceGraphStoreClient} from '../src/workspace-graph/store-client.js'

test('source identity separates accounts and deletion generations within reference budget',()=>{
 const a=connectorSourceId('account',0,'x'.repeat(4096))
 assert.ok(('personal:'+ 'a'.repeat(64)+':'+a).length<=256)
 assert.equal(a,connectorSourceId('account',0,'x'.repeat(4096)))
 assert.notEqual(a,connectorSourceId('other',0,'x'.repeat(4096)))
 assert.notEqual(a,connectorSourceId('account',1,'x'.repeat(4096)))
 assert.throws(()=>connectorSourceId('account',-1,'x'))
 assert.throws(()=>connectorSourceId('account',Number.MAX_SAFE_INTEGER+1,'x'))
})

test('v3 migration preserves evidence and suppression and does not reset source clock',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nova-source-migration-'));const path=join(root,'memory.sqlite')
 let client=new WorkspaceGraphStoreClient(path)
 try{
  await client.open();await client.close()
  const old=new DatabaseSync(path)
  for(const table of ['source_connections','source_objects','source_pages','source_grants','source_extractions','source_clock'])old.exec(`DROP TABLE IF EXISTS ${table}`)
  old.exec('DELETE FROM schema_migrations WHERE version>3; INSERT OR IGNORE INTO schema_migrations VALUES(3,0)')
  old.prepare('INSERT INTO memory_suppressed VALUES(?)').run('forgotten')
  old.prepare('INSERT INTO memory_evidence VALUES(?,?,?,?)').run('e','s','h','{"preserve":true}')
  old.close()
  client=new WorkspaceGraphStoreClient(path);await client.open();await client.close()
  const upgraded=new DatabaseSync(path)
  assert.equal(upgraded.prepare('SELECT MAX(version) n FROM schema_migrations').get()!.n,4)
  assert.equal(upgraded.prepare('SELECT COUNT(*) n FROM memory_suppressed').get()!.n,1)
  assert.equal(upgraded.prepare('SELECT payload_json FROM memory_evidence WHERE id=?').get('e')!.payload_json,'{"preserve":true}')
  upgraded.exec('UPDATE source_clock SET revision=7');upgraded.close()
  client=new WorkspaceGraphStoreClient(path);await client.open();await client.close()
  const again=new DatabaseSync(path);assert.equal(again.prepare('SELECT revision FROM source_clock').get()!.revision,7)
  again.exec('INSERT INTO schema_migrations VALUES(999,0)');again.close()
  client=new WorkspaceGraphStoreClient(path);await assert.rejects(client.open(),{code:'STORE_SCHEMA_UNSUPPORTED'})
 }finally{await client.close();await rm(root,{recursive:true,force:true})}
})

test('source schema rejects missing uniqueness rather than silently accepting damaged tables',()=>{
 const db=new DatabaseSync(':memory:')
 try{
  initializeSourceState(db);assertSourceStateSchema(db)
  db.exec('DROP TABLE source_grants; CREATE TABLE source_grants(source_id TEXT,payload_json TEXT NOT NULL) STRICT')
  assert.throws(()=>assertSourceStateSchema(db),/SCHEMA/)
 }finally{db.close()}
})
