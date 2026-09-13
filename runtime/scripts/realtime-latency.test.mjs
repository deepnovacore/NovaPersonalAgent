import assert from 'node:assert/strict'
import {test} from 'node:test'
import {summarize} from './realtime-latency.mjs'

test('latencies correlate run/epoch/item, preserve gaps and exclude cancellations from percentiles', () => {
  const rows = []
  const add = (run_id, ts, kind, payload) => rows.push({run_id, ts, kind, payload: {session_epoch: 1, ...payload}})
  for (const run of ['a', 'b']) {
    add(run, 0, 'pipeline.configuration', {pipeline: 'cascaded', model: 'test'})
    add(run, 1, 'provider.user_speech_ended', {item_id: 'item'})
    add(run, 1.1, 'provider.user_transcript_final', {item_id: 'item'})
    add(run, 1.2, 'provider.response_started', {response_id: 'r', item_id: 'none'})
    add(run, 1.2, 'user_origin.response_binding', {response_id: 'r', item_id: 'item', status: 'bound'})
    add(run, 1.2, 'cascaded.llm.requested', {response_id: 'r'})
    add(run, 1.5, 'cascaded.llm.first_text', {response_id: 'r'})
    add(run, 1.6, 'volcengine.tts.first_text', {response_id: 'r'})
    add(run, 1.8, 'provider.first_audio_delta', {response_id: 'r'})
    add(run, 1.8, 'volcengine.tts.first_audio', {response_id: 'r'})
    add(run, run === 'a' ? 2 : 5, 'playback.started', {response_id: 'r'})
    add(run, 6, 'provider.response_terminal', {response_id: 'r', status: run === 'a' ? 'completed' : 'cancelled'})
  }
  add('a', 7, 'provider.response_started', {response_id: 'r', session_epoch: 2})
  const report = summarize(rows)
  assert.equal(report.rows.length, 3)
  assert.equal(report.rows[0].speech_to_playback_ms, 1000)
  assert.equal(report.rows[0].llm_first_text_ms, 300)
  assert.equal(report.rows[0].tts_first_audio_ms, 200)
  assert.equal(report.rows[2].speech_to_playback_ms, null)
  assert.deepEqual(report.groups[0].metrics.speech_to_playback_ms, {n: 1, p50: 1000, p95: 1000})
})
