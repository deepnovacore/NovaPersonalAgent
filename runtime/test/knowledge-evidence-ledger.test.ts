import {abortable} from '../src/camera-session.js'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp, writeFile, rm, realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {KnowledgeService, type KnowledgeEvidenceLedger} from '../src/knowledge/service.js'
import {KnowledgeStoreClient} from '../src/knowledge/store-client.js'

type Original = NonNullable<Awaited<ReturnType<KnowledgeEvidenceLedger['read']>>> & {sourceId: string}
test('production index refuses reads and mutations until canonical evidence binding finishes', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-ledger-required-'))
  const service = new KnowledgeService({store: new KnowledgeStoreClient({path: join(directory, 'db', 'knowledge.sqlite')}), requireEvidenceLedger: true,
    embedding: {id: 'fixture', dims: 2, embed: () => Promise.reject(new Error('must not embed'))}})
  try {
    await service.open()
    await assert.rejects(service.recall('query', 1), /knowledge_unavailable/u)
    await assert.rejects(service.getChunk('cached'), /knowledge_unavailable/u)
    for (const method of ['knowledge.ingest', 'knowledge.reindex', 'knowledge.remove']) await assert.rejects(service.handle(method, {}), /knowledge_unavailable/u)
    await assert.rejects(service.syncFile('file', directory, new AbortController().signal), /knowledge_unavailable/u)
    await service.bindEvidenceLedger(ledger().value)
    assert.deepEqual(await service.recall('query', 1), [])
  } finally {await service.close(); await rm(directory, {recursive: true, force: true})}
})
function ledger() {
  const rows = new Map<string, Original>(), deleted = new Set<string>(), consent: boolean[] = [];
  const value: KnowledgeEvidenceLedger = {
    record: input => {
      if (deleted.has(input.sourceId)) return Promise.reject(new Error('source_deleted'));
      consent.push(input.embeddingConsent);
      const id = `canonical:${createHash('sha256').update(input.sourceId + input.locator + input.text).digest('hex')}`;
      rows.set(id, {evidence_id: id, sourceId: input.sourceId, text: input.text, locator: input.locator, source_kind: 'file', observed_at: input.observedAt, trust: 'untrusted_external'});
      return Promise.resolve({evidence_id: id});
    },
    read: id => Promise.resolve(rows.get(id) ?? null),
    remove: sourceId => { deleted.add(sourceId); for (const [id, row] of rows) if (row.sourceId === sourceId) rows.delete(id); return Promise.resolve(); },
  };
  return {value, rows, deleted, consent};
}

test('existing document vectors migrate offline to canonical evidence and cannot revive deleted A originals', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-ledger-migrate-'));
  const file = join(directory, 'manual.md'), path = join(directory, 'db', 'knowledge.sqlite');
  await writeFile(file, 'Blue lamp installation guide');
  let embeds = 0;
  const embedding = {id: 'fixture-v1', dims: 2, embed: (texts: readonly string[]) => { embeds++; return Promise.resolve(texts.map(() => new Float32Array([1, 0]))); }};
  let service = new KnowledgeService({store: new KnowledgeStoreClient({path}), embedding});
  const authority = ledger();
  try {
    await service.open(); await service.handle('knowledge.ingest', {kind: 'file', locator: file, consent: true});
    const original = (await service.recall('lamp', 1))[0]!;
    const before = embeds;
    await rm(file); // Migration must use admitted cached chunks, never fetch the file again.
    await service.bindEvidenceLedger(authority.value);
    assert.equal(embeds, before); assert.deepEqual(authority.consent, [false]);
    const migrated = (await service.recall('lamp', 1))[0]!;
    assert(migrated.evidence_id?.startsWith('canonical:'));
    assert.equal(migrated.locator, original.locator);
    const row = authority.rows.get(migrated.evidence_id!)!;
    assert.equal(row.locator, `${file}#chunk=0`);
    authority.rows.set(row.evidence_id, {...row, text: 'Current A original'});
    assert.equal((await service.getChunk(migrated.locator)).text, 'Current A original');
    authority.rows.clear();
    assert.deepEqual(await service.recall('lamp', 1), []);
    assert.deepEqual(await service.getChunk(migrated.locator), {status: 'gone'});
    await service.close();
    service = new KnowledgeService({store: new KnowledgeStoreClient({path}), embedding});
    await service.open(); await service.bindEvidenceLedger(authority.value);
    assert.equal(authority.consent.length, 1); // Stored links prevent resurrection after restart.
    assert.deepEqual(await service.recall('lamp', 1), []);
  } finally { await service.close(); await rm(directory, {recursive: true, force: true}); }
});

test('new indexing admits A before embedding; deletion fences in-flight reindex and clears both stores', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-ledger-write-'));
  const file = join(directory, 'manual.md'); await writeFile(file, 'Initial document');
  const authority = ledger(); let blocking = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;}), started = new Promise<void>(resolve => {entered = resolve;});
  const store = new KnowledgeStoreClient({path: join(directory, 'db', 'knowledge.sqlite')});
  const service = new KnowledgeService({store, embedding: {id: 'fixture-v1', dims: 2, embed: async (texts) => {
    assert(authority.rows.size > 0, 'source must be durable in A before external embedding');
    if (blocking) { entered(); await gate; }
    return texts.map(() => new Float32Array([1, 0]));
  }}});
  try {
    await service.open(); await service.bindEvidenceLedger(authority.value);
    await service.handle('knowledge.ingest', {kind: 'file', locator: file, consent: true});
    assert.deepEqual(authority.consent, [true]);
    const source = (await service.listSources())[0]!;
    const chunks = await store.listChunks(source.id); assert.equal(chunks.length, 1); assert(chunks[0]!.evidence_id);
    await writeFile(file, 'Replacement document'); blocking = true;
    const reindex = service.handle('knowledge.reindex', {id: source.id, consent: true}); await abortable(started, AbortSignal.timeout(3000));
    await service.handle('knowledge.remove', {id: source.id}); release(); await reindex;
    assert(authority.deleted.has(`knowledge:${source.id}`)); assert.equal(authority.rows.size, 0);
    assert.deepEqual(await store.listChunks(source.id), []); assert.deepEqual(await service.listSources(), []);
  } finally { release?.(); await service.close(); await rm(directory, {recursive: true, force: true}); }
});

test('A deletion failure preserves the index for retry, and changed chunk digests reject stale migration links', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'knowledge-ledger-retry-'));
  const file = join(directory, 'manual.md'); await writeFile(file, 'First content');
  const authority = ledger(); let failRemove = true;
  const store = new KnowledgeStoreClient({path: join(directory, 'db', 'knowledge.sqlite')});
  const service = new KnowledgeService({store, embedding: {id: 'fixture-v1', dims: 2, embed: texts => Promise.resolve(texts.map(() => new Float32Array([1, 0])))}});
  try {
    await service.open(); await service.bindEvidenceLedger({...authority.value, remove: sourceId => failRemove ? Promise.reject(new Error('fixture failure')) : authority.value.remove(sourceId)});
    await service.handle('knowledge.ingest', {kind: 'file', locator: file, consent: true});
    const source = (await service.listSources())[0]!, old = (await store.listChunks(source.id))[0]!;
    await writeFile(file, 'Changed content'); await service.handle('knowledge.reindex', {id: source.id, consent: true});
    await assert.rejects(store.linkEvidence([{chunk_id: old.chunk_id, content_digest: old.content_digest, evidence_id: old.evidence_id!}]));
    await assert.rejects(service.handle('knowledge.remove', {id: source.id}));
    assert.equal((await service.listSources()).length, 1);
    failRemove = false; await service.handle('knowledge.remove', {id: source.id});
    assert.equal((await service.listSources()).length, 0);
  } finally { await service.close(); await rm(directory, {recursive: true, force: true}); }
});
