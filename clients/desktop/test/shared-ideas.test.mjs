import test from 'node:test'
import assert from 'node:assert/strict'
import {createSharedIdeas} from '../src/main/shared-ideas.mjs'
import {emptyIdeaOpening} from '../src/renderer/chat-transcript.mjs'

const topic = id => ({id, text: 'Discuss ' + id})
const catalog = (topics, language = 'en') => ({version: 1, language, topics})
const reply = data => Response.json(data)

test('the public catalog is anonymous, deduplicated and sampled once', async () => {
  const calls = []
  const ideas = createSharedIdeas(async (url, options) => {
    calls.push(url)
    assert.match(url, /^https:\/\/api\.deepnovacore\.com\/nova\/common\/v1\/ideas\/(en|zh)\.json$/)
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers, undefined)
    if (url.endsWith('/zh.json')) return reply(catalog([{id:'zh-only',text:'聊聊茶'}], 'zh'))
    return reply(catalog([topic('a'), topic('a'), ...'bcdefghi'.split('').map(topic)]))
  })
  const [first, second] = await Promise.all([ideas('en'), ideas('en')])
  assert.equal(first.length, 6)
  assert.equal(new Set(first.map(x => x.id)).size, 6)
  assert.deepEqual(first, second)
  assert.deepEqual(first, await ideas('en'))
  assert.deepEqual(await ideas('zh'), [{id:'zh-only',text:'聊聊茶'}])
  assert.deepEqual(await ideas('../other'), [])
  assert.deepEqual(calls.map(url=>url.split('/').at(-1)), ['en.json','zh.json'])
})

test('offline, invalid and oversized catalogs can be retried; small pools are valid', async () => {
  const responses = [
    () => { throw Error('offline') },
    () => reply({...catalog([topic('a')]), version: 2}),
    () => reply(catalog([topic('a'), {...topic('b'), text: ''}])),
    () => new Response('x'.repeat(65537)),
    () => reply(catalog([topic('wrong-language')], 'zh')),
    () => reply(catalog([topic('a'), topic('a'), topic('b')])),
  ]
  const ideas = createSharedIdeas(async () => responses.shift()())
  for (let i = 0; i < 5; i++) assert.deepEqual(await ideas('en'), [])
  assert.deepEqual(new Set((await ideas('en')).map(x => x.id)), new Set(['a', 'b']))
})

test('only an initial assistant message marked proactive counts as empty', () => {
  const proactive = {role: 'assistant', origin: 'proactive'}
  assert.equal(emptyIdeaOpening([]), true)
  assert.equal(emptyIdeaOpening([proactive]), true)
  assert.equal(emptyIdeaOpening([proactive, proactive]), false)
  assert.equal(emptyIdeaOpening([{role: 'assistant'}]), false)
  assert.equal(emptyIdeaOpening([{role: 'user'}]), false)
})
