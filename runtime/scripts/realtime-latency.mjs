import {readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {homedir} from 'node:os'

// Correlate exact host identities only; missing/ambiguous stages remain null.
export function summarize(records) {
  const runs = new Map(), responses = new Map(), items = new Map()
  const key = (r, id) => JSON.stringify([r.run_id, r.payload.session_epoch ?? r.payload.epoch, id])
  for (const r of records) {
    if (!r?.run_id || !Number.isFinite(r.ts) || !r.payload) continue
    const p = r.payload
    if (r.kind === 'pipeline.configuration') runs.set(r.run_id, p)
    if (p.accepted === false) continue
    if (r.kind === 'provider.user_speech_ended' || r.kind === 'provider.user_transcript_final') {
      if (!p.item_id) continue
      const id = key(r, p.item_id), item = items.get(id) ?? {}
      item[r.kind] ??= r.ts; items.set(id, item)
    }
    if (!p.response_id) continue
    const id = key(r, p.response_id)
    const response = responses.get(id) ?? {run_id: r.run_id, response_id: p.response_id, times: {}}
    response.times[r.kind] ??= r.ts
    if (p.item_id && p.item_id !== 'none' && (r.kind === 'provider.response_started' || p.status === 'bound')) response.item = key(r, p.item_id)
    if (r.kind === 'provider.response_terminal') response.status = p.status
    responses.set(id, response)
  }
  const delta = (start, end) => Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end-start)*1000) : null
  const rows = [...responses.values()].map(r => {
    const t = r.times, item = items.get(r.item) ?? {}, end = item['provider.user_speech_ended']
    return {run_id: r.run_id, response_id: r.response_id, configuration: runs.get(r.run_id) ?? {}, status: r.status ?? 'incomplete',
      speech_to_audio_ms: delta(end, t['provider.first_audio_delta']),
      speech_to_playback_ms: delta(end, t['playback.started']),
      asr_finalize_ms: delta(end, item['provider.user_transcript_final']),
      llm_first_text_ms: delta(t['cascaded.llm.requested'], t['cascaded.llm.first_text']),
      text_to_tts_ms: delta(t['cascaded.llm.first_text'], t['volcengine.tts.first_text']),
      tts_first_audio_ms: delta(t['volcengine.tts.first_text'], t['volcengine.tts.first_audio']),
      audio_to_playback_ms: delta(t['provider.first_audio_delta'], t['playback.started'])}
  })
  const groups = new Map()
  for (const row of rows) {
    const id = JSON.stringify(row.configuration)
    if (!groups.has(id)) groups.set(id, {configuration: row.configuration, responses: 0, completed: 0, metrics: {}})
    const group = groups.get(id); group.responses++
    if (row.status !== 'completed') continue
    group.completed++
    for (const [metric, value] of Object.entries(row)) if (metric.endsWith('_ms') && value !== null) (group.metrics[metric] ??= []).push(value)
  }
  for (const group of groups.values()) for (const [metric, values] of Object.entries(group.metrics)) {
    values.sort((a,b) => a-b)
    group.metrics[metric] = {n: values.length, p50: values[Math.ceil(values.length*.5)-1], p95: values[Math.ceil(values.length*.95)-1]}
  }
  return {groups: [...groups.values()], rows}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2)
  if (!paths.length) paths.push(`${homedir()}/.nova-audio-agent/realtime-telemetry.jsonl`)
  const records = []; let invalid_lines = 0, legacy_records = 0
  for (const path of paths) for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    try { const row = JSON.parse(line); if (!row?.run_id) legacy_records++; records.push(row) } catch {invalid_lines++}
  }
  console.log(JSON.stringify({invalid_lines, legacy_records, ...summarize(records)}, null, 2))
}
