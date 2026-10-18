import test from 'node:test'
import assert from 'node:assert/strict'
import {createIdentityContextSync} from '../src/personal-agent/identity-context.js'

test('identity follows renames and provider epochs, deduplicating simultaneous audio/text input', async () => {
  let epoch = 1
  let identity = {assistant_name: 'nova', user_name: ''}
  const items: string[] = []
  const sync = createIdentityContextSync({identity: () => identity, epoch: () => epoch, inject: content => {items.push(content); return Promise.resolve()}})
  const signal = new AbortController().signal
  await Promise.all([sync(signal), sync(signal), sync(signal)])
  assert.equal(items.length, 1)
  await sync(signal)
  assert.equal(items.length, 1)
  identity = {assistant_name: '小星', user_name: '小林'}
  await sync(signal)
  assert.equal((JSON.parse(items[1]!) as {assistant_name: string}).assistant_name, '小星')
  epoch++
  await sync(signal)
  assert.equal(items.length, 3)
})

test('failed identity injection retries and queued renames retain order', async () => {
  let identity = {assistant_name: 'nova', user_name: ''}
  let release: (() => void) | undefined
  const items: string[] = []
  let fail = true
  const sync = createIdentityContextSync({identity: () => identity, epoch: () => 1, inject: async content => {
    if (fail) {fail = false; throw Error('disconnected')}
    items.push((JSON.parse(content) as {assistant_name: string}).assistant_name)
    if (items.length === 1) await new Promise<void>(resolve => {release = resolve})
  }})
  const signal = new AbortController().signal
  await assert.rejects(sync(signal), /disconnected/)
  const first = sync(signal)
  await new Promise(resolve => setImmediate(resolve))
  identity = {assistant_name: '小星', user_name: ''}
  const second = sync(signal)
  assert.deepEqual(items, ['nova'])
  release!()
  await Promise.all([first, second])
  assert.deepEqual(items, ['nova', '小星'])
})
