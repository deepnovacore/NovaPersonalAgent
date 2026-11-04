import assert from 'node:assert/strict'
import test from 'node:test'
import {summarize} from './prerecall-latency.mjs'

test('summarize uses nearest-rank percentiles and reports starts and injection/reuse ratios', () => {
  const completed = Array.from({length: 20}, (_, i) => ({kind: 'memory.prerecall.completed', payload: {duration_ms: (i + 1) * 10}}))
  const injected = [{kind: 'memory.prerecall.injected', payload: {injected: true, reused: true}}, {kind: 'memory.prerecall.injected', payload: {injected: false, reused: false}}]
  assert.deepEqual(summarize([...completed, ...injected]), {starts: 20, p50_ms: 100, p95_ms: 190, injected_ratio: .5, reused_ratio: .5})
})
test('summarize exposes the throttle cap through settled starts, not ASR partial count', () => {
  const events = Array.from({length: 10}, () => ({kind: 'cascaded.asr.partial', payload: {}}))
  for (let i = 0; i < 3; i++) events.push({kind: 'memory.prerecall.completed', payload: {duration_ms: 100}})
  assert.equal(summarize(events).starts, 3)
  assert.deepEqual(summarize([]), {starts: 0, p50_ms: null, p95_ms: null, injected_ratio: 0, reused_ratio: 0})
})
