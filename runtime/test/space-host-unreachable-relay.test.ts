import {test} from 'node:test'
import assert from 'node:assert/strict'
import {realpath, mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PersonalAgentHost} from '../src/personal-agent/host.js'
import {SuggestionPool} from '../src/core/suggestions.js'
import {SpaceHost, type SpaceHostTransport} from '../src/space-host/service.js'

test('an unreachable relay never holds Host startup, and queued messages are retried in the background', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'space-unreachable-'))
  let attempts = 0
  let release!: () => void
  const gate = {promise: new Promise<void>(resolve => { release = resolve }), resolve: () => release()}
  // Every send waits out a "network timeout" until the test releases it, like a stopped tailnet would.
  const transport: SpaceHostTransport = {
    start: () => Promise.resolve(() => undefined),
    send: async () => { attempts += 1; await gate.promise; throw new Error('relay unreachable') },
    clients: () => ['phone'],
  } as unknown as SpaceHostTransport
  const host = new PersonalAgentHost({path: join(dir, 'personal.json'), userScope: 'test', memory: () => undefined, pool: new SuggestionPool(), evidence: () => null})
  const space = new SpaceHost({path: join(dir, 'space.json'), space: 's', host, transport})
  try {
    await host.open({deferBackground: true})
    const started = Date.now()
    await Promise.race([space.open(), new Promise((_, reject) => setTimeout(() => reject(new Error('open() waited for the relay')), 3000))])
    assert.ok(Date.now() - started < 3000)
    // The first delivery is still in flight in the background; it is not part of startup.
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(attempts >= 1, 'the background pass started delivering')
    gate.resolve()
    await space.initialDelivery
  } finally { gate.resolve(); await space.close(); await host.close(); await rm(dir, {recursive: true, force: true}) }
})
