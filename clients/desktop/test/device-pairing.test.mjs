import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {launchDevicePairing} from '../src/main/device-pairing.mjs'

test('pairing launcher sends credentials only over stdin and reports process failures', async () => {
  const config = {port: 9020, token: 'a'.repeat(32)}
  for (const fail of [false, true]) {
    let input
    const child = new EventEmitter()
    child.stdin = new EventEmitter()
    child.stdin.end = value => { input = JSON.parse(value) }
    const pending = launchDevicePairing({config, scriptPath: '/pair.swift', spawnProcess: (command, args, options) => {
      assert.equal(command, '/usr/bin/swift')
      assert.deepEqual(args, ['/pair.swift'])
      assert.ok(!JSON.stringify(options).includes(config.token))
      return child
    }})
    assert.deepEqual(input, {...config, server: ''})
    child.emit('exit', fail ? 1 : 0)
    if (fail) await assert.rejects(pending, /pairing window failed/)
    else await pending
  }
})
