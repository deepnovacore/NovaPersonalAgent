import assert from 'node:assert/strict'
import {mkdtemp, mkdir, writeFile, rm, realpath, symlink, rename, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {LocalDirectorySources} from '../src/personal-agent/sources.js'
import {KnowledgeService} from '../src/knowledge/service.js'
import {KnowledgeStoreClient} from '../src/knowledge/store-client.js'

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-directory-'))
  const folder = join(root, 'allowed'); await mkdir(folder)
  let failEmbedding = false, failInvalidation = false
  let embeddingHook: () => Promise<void> = () => Promise.resolve()
  const knowledge = new KnowledgeService({store: new KnowledgeStoreClient({path: join(root, 'db', 'knowledge.sqlite')}),
    embedding: {id: 'test', dims: 2, embed: texts => failEmbedding ? Promise.reject(new Error('offline')) : embeddingHook().then(() => texts.map(() => new Float32Array([1, 0])))}})
  await knowledge.open()
  const invalidated: string[] = []
  const options = {path: join(root, 'db', 'sources.json'), knowledge, pollMs: 0,
    onInvalidate: (ref: string) => { if (failInvalidation) throw new Error('interrupted'); invalidated.push(ref) }}
  let sources = new LocalDirectorySources(options)
  await sources.open()
  return {root, folder, knowledge, invalidated, setEmbeddingHook(hook: () => Promise<void>) {embeddingHook = hook}, setFail(value: boolean) {failEmbedding = value}, setFailInvalidation(value: boolean) {failInvalidation = value}, get sources() {return sources},
    reopen: async () => {await sources.close(); sources = new LocalDirectorySources(options); await sources.open()},
    close: async () => {await sources.close(); await knowledge.close(); await rm(root, {recursive: true, force: true})}}
}

test('local sources use explicit grants, exclude private trees and reconcile durable scoped knowledge', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.folder, 'readme.md'), 'The blue lamp is ready.')
    for (const name of ['.git', 'node_modules', 'Browser']) {await mkdir(join(f.folder, name)); await writeFile(join(f.folder, name, 'private.md'), 'Never read this')}
    await writeFile(join(f.folder, '.env'), 'secret')
    await writeFile(join(f.root, 'outside.md'), 'Outside grant')
    await symlink(join(f.root, 'outside.md'), join(f.folder, 'escape.md'))
    await assert.rejects(f.sources.command('sources.add', {path: f.folder}), /invalid_request/)
    await assert.rejects(f.sources.command('sources.add', {path: join(f.folder, 'Browser'), consent: true}), /path_denied/)
    assert.equal((await f.knowledge.listSources()).length, 0)
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const source = f.sources.list()[0]!
    assert.equal(source.read, 1)
    assert.ok(source.excludes.includes('Browser'))
    assert.ok(source.skipped >= 5)
    assert.equal((await f.knowledge.listSources()).length, 1)
    const ref = f.sources.evidenceSnapshot()[0]!.ref
    assert.ok(f.sources.evidence(ref))
    await f.reopen()
    assert.equal(f.sources.list()[0]!.id, source.id)
    await f.sources.command('sources.pause', {id: source.id})
    await writeFile(join(f.folder, 'new.md'), 'Another file')
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal((await f.knowledge.listSources()).length, 1)
    await f.sources.command('sources.resume', {id: source.id})
    assert.equal((await f.knowledge.listSources()).length, 2)
    await rm(join(f.folder, 'readme.md'))
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal((await f.knowledge.listSources()).length, 1)
    assert.ok(f.invalidated.includes(ref))
    assert.equal(f.sources.evidence(ref), null)
    await f.sources.command('sources.disconnect', {id: source.id})
    for (const method of ['sources.pause', 'sources.resume', 'sources.sync']) await assert.rejects(f.sources.command(method, {id: source.id}), /source_disconnected/)
    assert.equal(f.sources.list()[0]!.state, 'disconnected')
    await f.sources.command('sources.delete', {id: source.id})
    assert.deepEqual(await f.knowledge.listSources(), [])
    assert.deepEqual(f.sources.list(), [])
  } finally {await f.close()}
})

test('metadata coverage counts 10000 files while body budget is enforced and failed roots retain index', async () => {
  const f = await fixture()
  try {
    for (let start = 0; start < 10000; start += 100) {
      await Promise.all(Array.from({length: 100}, (_, index) => writeFile(join(f.folder, `note-${start + index}.md`), 'A short note.')))
    }
    await f.sources.command('sources.add', {path: f.folder, consent: true, max_files: 2, max_bytes: 100})
    const source = f.sources.list()[0]!
    assert.equal(source.scanned, 10000)
    assert.equal(source.read, 2)
    assert.equal(source.reasons.body_budget, 9998)
    await rename(f.folder, `${f.folder}-offline`)
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal(f.sources.list()[0]!.state, 'error')
    assert.equal((await f.knowledge.listSources()).length, 2)
    assert.equal(f.invalidated.length, 0)
    await rename(`${f.folder}-offline`, f.folder)
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal(f.sources.list()[0]!.state, 'connected')
    assert.equal(f.sources.list()[0]!.read, 2)
    assert.ok((await readFile(join(f.root, 'db', 'sources.json'), 'utf8')).includes(source.id))
  } finally {await f.close()}
})

test('scoped ingestion rejects a replaced directory resolving outside the grant', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, 'other'))
    await writeFile(join(f.root, 'other', 'readme.md'), 'Must not upload outside grant')
    await symlink(join(f.root, 'other'), join(f.folder, 'link'))
    await assert.rejects(f.knowledge.syncFile(join(f.folder, 'link', 'readme.md'), f.folder, new AbortController().signal), /path_denied|ingest_failed/)
    assert.equal((await f.knowledge.listSources()).length, 0)
  } finally {await f.close()}
})


test('failed refresh retries the changed file rather than blessing stale index metadata', async () => {
  const f = await fixture()
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Original manually imported source')
    await f.knowledge.handle('knowledge.ingest', {kind: 'file', locator: path, consent: true})
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const source = f.sources.list()[0]!, before = (await f.knowledge.listSources())[0]!
    await writeFile(path, 'Updated source after an interrupted synchronization')
    f.setFail(true)
    await f.sources.command('sources.sync', {id: source.id})
    f.setFail(false)
    await f.sources.command('sources.sync', {id: source.id})
    assert.notEqual((await f.knowledge.listSources())[0]!.fingerprint, before.fingerprint)
    assert.equal((await f.knowledge.recall('Updated', 1))[0]!.text, 'Updated source after an interrupted synchronization')
  } finally {await f.close()}
})

test('body-budget deferred changes cannot keep stale source evidence or owned searchable chunks', async () => {
  const f = await fixture()
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Original')
    await f.sources.command('sources.add', {path: f.folder, consent: true, max_bytes: 10})
    const source = f.sources.list()[0]!, ref = f.sources.evidenceSnapshot()[0]!.ref
    await writeFile(path, 'Changed content now larger than the authorized scan budget')
    await f.sources.command('sources.sync', {id: source.id})
    assert.equal(f.sources.evidence(ref), null)
    assert.deepEqual(await f.knowledge.listSources(), [])
    assert.ok(f.invalidated.includes(ref))
  } finally {await f.close()}
})


test('restart retries source invalidation interrupted after durable stale marking', async () => {
  const f = await fixture()
  try {
    const path = join(f.folder, 'notes.md')
    await writeFile(path, 'Original version')
    await f.sources.command('sources.add', {path: f.folder, consent: true})
    const id = f.sources.list()[0]!.id, ref = f.sources.evidenceSnapshot()[0]!.ref
    f.setFailInvalidation(true)
    await writeFile(path, 'Changed version with distinct size')
    await f.sources.command('sources.sync', {id})
    assert.equal(f.sources.evidence(ref), null)
    assert.equal(f.invalidated.length, 0)
    f.setFailInvalidation(false)
    await f.reopen()
    assert.ok(f.invalidated.includes(ref))
    assert.equal(f.sources.evidenceSnapshot().length, 1)
    assert.notEqual(f.sources.evidenceSnapshot()[0]!.ref, ref)
  } finally {await f.close()}
})


test('pause fences an in-flight body import before it can commit', async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => {release = resolve})
  const started = new Promise<void>(resolve => {entered = resolve})
  try {
    await writeFile(join(f.folder, 'notes.md'), 'An import being paused')
    f.setEmbeddingHook(() => {entered(); return gate})
    const adding = f.sources.command('sources.add', {path: f.folder, consent: true})
    await started
    const id = f.sources.list()[0]!.id
    const pausing = f.sources.command('sources.pause', {id})
    release()
    await Promise.all([adding, pausing])
    assert.equal(f.sources.list()[0]!.state, 'paused')
    assert.deepEqual(await f.knowledge.listSources(), [])
    assert.deepEqual(f.sources.evidenceSnapshot(), [])
  } finally {release(); await f.close()}
})
