import assert from 'node:assert/strict'
import {test} from 'node:test'
import {StreamingSpeech} from '../src/realtime/streaming-speech.js'

const clean = (parts: string[]) => {const speech = new StreamingSpeech(); return parts.map(p => speech.push(p)).join('') + speech.finish()}
test('ordinary speech is released before completion, preserving numbers and comparisons', () => {
  const speech = new StreamingSpeech()
  assert.equal(speech.push('先别重置。'), '先别重置。')
  assert.equal(speech.push('偏差 ≤30 秒，版本 0.8.4。'), '偏差 ≤30 秒，版本 0.8.4。')
  assert.equal(speech.finish(), '')
})
test('formatting cannot leak regardless of model split positions', () => {
  for (const [input, expected] of [
    ['## 结论\n**尚未完成**。\n1. 需要 `48 小时`，见[原文](https://example.com/a)。', '结论 尚未完成。 需要 48 小时，见原文。'],
    ['先看这里。```js\nsecret()\n```再继续。', '先看这里。（代码示例略）再继续。'],
    ['查 https://example.com/a 后继续。', '查 （链接略） 后继续。'],
    ['> 不重置\n- 保留记录\n版本 0.8.4，偏差 ≤30。', '不重置 保留记录 版本 0.8.4，偏差 ≤30。'],
    ['![示意图](file:///tmp/private.png)\n| 项目 | 状态 |\n| --- | --- |\n| 观察 | 未完成 |', '示意图 项目 状态 观察 未完成'],
    ['> ## 结论\n---\n完成。', '结论 完成。'],
    ['~~~js\nsecret()\n~~~\n继续。', '（代码示例略） 继续。'],
  ]) {
    const normalized = (s: string) => s.replace(/\s+/gu, ' ').trim()
    for (let i = 0; i <= input!.length; i++) assert.equal(normalized(clean([input!.slice(0, i), input!.slice(i)])), expected)
    assert.equal(normalized(clean([...input!])), expected)
  }
})
test('unclosed markup does not expose destinations or code; instances do not share cancelled buffers', () => {
  assert.equal(clean(['看[原文](https://private']), '看原文')
  assert.equal(clean(['```js\nsecret()']), '（代码示例略）')
  const cancelled = new StreamingSpeech(); cancelled.push('[旧内容](')
  assert.equal(clean(['新回答。']), '新回答。')
})
