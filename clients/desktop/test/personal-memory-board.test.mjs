import assert from 'node:assert/strict'
import test from 'node:test'
import {personalMemoryBoard} from '../src/renderer/personal-memory-board.mjs'

test('changing search resets the cursor and discards an older search response', async t => {
  class Element extends EventTarget {
    children = []; value = ''; hidden = false; textContent = ''
    append(...items) { this.children.push(...items) }
    replaceChildren(...items) { this.children = items }
    setAttribute() {}
  }
  const previous = globalThis.document
  globalThis.document = {createElement: () => new Element()}
  t.after(() => {if (previous === undefined) delete globalThis.document; else globalThis.document = previous})
  const root = new Element(), calls = []
  let release
  const board = personalMemoryBoard(root, options => {
    calls.push(options)
    return new Promise(resolve => {release = resolve})
  })
  const [controls, status, list, next] = root.children, search = controls.children[0]
  const snapshot = {personal: {entries: [{state: 'pending', recordedAt: '2026-09-19', original: '原话', memories: []}], next: 42}}
  let pending = board.load(); release(snapshot); await pending
  assert.match(list.children[0].children[0].textContent, /尚未形成记忆/u)
  search.value = '新关键词'; search.dispatchEvent(new Event('input'))
  assert.equal(next.hidden, true)
  pending = board.load(42)
  assert.equal(calls.at(-1).before_seq, undefined)
  search.value = '另一个关键词'; search.dispatchEvent(new Event('input'))
  release(snapshot); await pending
  assert.equal(next.hidden, true)
  assert.equal(status.textContent, '请点击搜索')
})
