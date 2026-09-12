import {fixture, context} from './fixtures/codex/project-adapter-fixture.js'
import {hostHomeValue} from '../src/host-paths.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {sharedHomeOverrides} from '../src/executors/codex/shared-home.js'
import {readLocalCodexSessions} from '../src/executors/codex/local-sessions.js'

test('local catalog reads named top-level sessions and excludes archived, agents and missing workspaces', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'nova-local-catalog-')))
  try {
    const db = new DatabaseSync(join(home, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER)')
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)')
    insert.run('original', '修复登录', 'long original request', home, 'vscode', 0, 100)
    insert.run('archived', '隐藏', 'x', home, 'vscode', 1, 200)
    insert.run('agent', '隐藏', 'x', home, '{"subagent":{}}', 0, 300)
    insert.run('missing', '隐藏', 'x', join(home, 'missing'), 'cli', 0, 400)
    db.close()
    assert.deepEqual(await readLocalCodexSessions(home), [{threadId: 'original', title: '修复登录', cwd: home, updatedAt: 100}])
  } finally { await rm(home, {recursive: true, force: true}) }
})


test('a discovered title resolves to and resumes the original thread/home, not the newest session', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'nova-shared-session-')))
  const value = await fixture({localCodexHome: home})
  try {
    const db = new DatabaseSync(join(home, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at INTEGER)')
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)')
    insert.run('original-older-thread', '修复登录', 'original', home, 'vscode', 0, 100)
    insert.run('newest-thread', '修改首页', 'newest', home, 'vscode', 0, 200)
    db.close()
    await value.adapter.initialize()
    const row = value.adapter.roster().find(row => row.sessions?.includes('修复登录'))
    assert.ok(row)
    const target = await value.adapter.resolveIntakeTarget({kind: 'work', project: row.name, session: 'latest', session_title: '修复登录'})
    assert.equal((await value.store.resolveWorkspace(null)).display_name, 'alpha', 'discovery does not activate a workspace')
    const request = {work_order: '继续修复', project: row.name, session: 'latest', session_id: target.session_id!}
    assert.equal((await value.adapter.dispatch('run', request, context('run', request, value.clock))).outcome, 'ok')
    assert.equal(value.factory.bindings[0]?.resumeThreadId, 'original-older-thread')
    assert.equal(value.factory.bindings[0]?.preserveHome, true)
    assert.equal(hostHomeValue(value.factory.bindings[0].codexHome).path, home)
    assert.equal((await value.store.listSessions(target.workspace_id!)).length, 2)
    const before = (await value.store.listSessions(target.workspace_id!)).find(row => row.session_id === target.session_id)!
    const updated = await value.store.importSession(target.workspace_id!, {home, threadId: 'original-older-thread', title: '登录校验修复', updatedAt: 300})
    assert.equal(updated.session_id, before.session_id)
    assert.equal(updated.codex_thread_id, before.codex_thread_id)
  } finally {
    await value.adapter.close()
    await rm(value.root, {recursive: true, force: true})
    await rm(home, {recursive: true, force: true})
  }
})


test('shared config overrides disable inherited tools without replacing the home configuration', () => {
  const args = sharedHomeOverrides({config: {
    features: {js_repl: true}, mcp_servers: {external: {enabled: true}, managed: {}},
    shell_environment_policy: {set: {EXTERNAL_VALUE: 'private'}},
  }}, ['managed'])
  assert.ok(args.includes('features.js_repl=false'))
  assert.ok(args.includes('mcp_servers.external.enabled=false'))
  assert.ok(args.includes('shell_environment_policy.set.EXTERNAL_VALUE=""'))
  assert.equal(args.includes('mcp_servers={}'), false)
  assert.equal(args.some(arg => arg.includes('managed')), false)
  assert.throws(() => sharedHomeOverrides({config: {mcp_servers: {'ambiguous.key': {}}}}, []))
})
