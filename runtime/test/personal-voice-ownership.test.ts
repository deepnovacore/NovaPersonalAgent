import assert from 'node:assert/strict'
import {mkdtemp, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {SuggestionPool} from '../src/core/suggestions.js'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import type {ConversationRuntime} from '../src/personal-agent/conversations.js'

const supported = ['darwin', 'win32'].includes(process.platform)

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'nova-voice-owner-'))
  const host = new PersonalAgentHost({path: join(root, 'personal.json'), userScope: 'local-test', memory: () => undefined, pool: new SuggestionPool(), evidence: () => null})
  const runtime: ConversationRuntime = {runTurn: () => Promise.resolve({assistant: 'ok'}), close: () => Promise.resolve()}
  host.setConversationRuntime(() => Promise.resolve(runtime), () => { /* frames are not asserted here */ })
  let request = 0
  const command = (method: string, params: Record<string, unknown> = {}) =>
    host.command({type: 'personal.command', request_id: 'r' + request++, method, params}, {client_id: 'desktop:local'}) as Promise<{ok: boolean; error?: string; data?: unknown}>
  await host.open()
  assert.equal((await command('presentation.set', {mode: 'workbench'})).ok, true)
  assert.equal((await command('conversations.voice', {id: 'chat:main', enabled: true})).ok, true)
  return {root, host, command, close: async () => {await host.close(); await rm(root, {recursive: true, force: true})}}
}

test('starting a local Build ends voice ownership instead of leaving a ghost owner', {skip: !supported}, async () => {
  const f = await fixture()
  try {
    assert.equal(f.host.conversationSnapshot().voice_id, 'chat:main')
    const result = await f.command('build.begin', {text: 'implement the change', project: f.root})
    assert.equal(result.ok, true, result.error)
    assert.equal(f.host.conversationSnapshot().voice_id, null)
    await assert.rejects(f.host.sendConversationAudio('chat:main', new Uint8Array([1, 2])), /voice_not_owned/u)
    const buildId = f.host.conversationSnapshot().selected_id
    // Voice on the active Build would clear its runtime; it must be refused rather than abort the run.
    assert.equal((await f.command('conversations.voice', {id: buildId, enabled: true})).error, 'conversation_busy')
    // Another conversation keeps voice available while the Build runs.
    assert.equal((await f.command('conversations.voice', {id: 'chat:main', enabled: true})).ok, true)
    // The emergency Stop must still work from the floating orb, where the overlay is visible.
    assert.equal((await f.command('presentation.set', {mode: 'orb'})).ok, true)
    assert.equal((await f.command('build.stop', {id: buildId})).ok, true)
  } finally {
    await f.close()
  }
})
