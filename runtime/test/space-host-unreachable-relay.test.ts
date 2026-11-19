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
  let markSending!: () => void
  const firstSend = new Promise<void>(resolve => { markSending = resolve })
  let timeout: NodeJS.Timeout | undefined
  let release!: () => void
  const gate = {promise: new Promise<void>(resolve => { release = resolve }), resolve: () => release()}
  // Every send waits out a "network timeout" until the test releases it, like a stopped tailnet would.
  const transport: SpaceHostTransport = {
    start: () => Promise.resolve(() => undefined),
    send: async () => { markSending(); await gate.promise; throw new Error('relay unreachable') },
    clients: () => ['phone'],
  } as unknown as SpaceHostTransport
  const host = new PersonalAgentHost({path: join(dir, 'personal.json'), userScope: 'test', memory: () => undefined, pool: new SuggestionPool(), evidence: () => null})
  const space = new SpaceHost({path: join(dir, 'space.json'), space: 's', host, transport})
  try {
    await host.open({deferBackground: true})
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Host startup or first background delivery stalled')), 3000)
    })
    // open must finish while send is still blocked. Wait for the transport itself to signal entry
    // instead of guessing how long the preceding durable writes take on this filesystem.
    await Promise.race([space.open(), deadline])
    await Promise.race([firstSend, deadline])
    gate.resolve()
    await space.initialDelivery
  } finally { clearTimeout(timeout); gate.resolve(); await space.close(); await host.close(); await rm(dir, {recursive: true, force: true}) }
})
