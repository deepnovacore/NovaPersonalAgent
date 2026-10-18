import {normalizeUsageReport,parseUsageSnapshot} from '@nova-personal-agent/runtime/usage'
import {mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'
import {randomUUID} from 'node:crypto'

export const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'inputTextTokens', 'inputAudioTokens', 'outputTextTokens', 'outputAudioTokens', 'cachedTokens', 'reasoningTokens', 'audioDurationMs', 'characters']
export {PRICE_DATE,priceUsage} from '@nova-personal-agent/runtime/usage'
import {PRICE_DATE,priceUsage} from '@nova-personal-agent/runtime/usage'
export function publicUsageReport(value) {
  if (!value || !['qwen', 'stepfun', 'ark', 'deepseek', 'volcengine', 'openai', 'gemini', 'openrouter', 'custom', 'codex', 'acp'].includes(value.provider)
    || !['realtime', 'llm', 'asr', 'tts', 'embedding', 'agent'].includes(value.service) || !['complete', 'missing'].includes(value.status)
    || typeof value.id !== 'string' || !value.id || value.id.length > 256
    || typeof value.model !== 'string' || !value.model || value.model.length > 256) return null
  const result = {id:value.id, provider:value.provider, service:value.service, model:value.model, status:value.status,
    pricingRegion: ['cn-beijing', 'singapore'].includes(value.pricingRegion) ? value.pricingRegion : 'unknown'}
  if (['audio', 'text'].includes(value.outputModality)) result.outputModality = value.outputModality
  for (const field of USAGE_FIELDS) {
    if (value[field] === undefined) continue
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) return null
    result[field] = value[field]
  }
  return normalizeUsageReport({...value,...result})
}
// Official CNY list prices (including Singapore), checked 2026-09-08; no FX conversion.
// No credits, negotiated discounts or explicit-cache storage charges.
/** Main-process lifetime; backend restarts only change the deduplication namespace. */
function createUsageAccumulator(initial) {
  const seen = new Set(), rows = new Map((initial?.rows ?? []).map(row => [JSON.stringify([row.provider, row.service, row.model, row.pricingRegion]), {...row}]))
  // Lost lifetime usage stays incomplete after a backend restart.
  let currentGeneration = -1, truncated = initial?.truncated === true
  return {
    add(generation, input) {
      if (!Number.isSafeInteger(generation) || generation < currentGeneration) return false
      if (generation > currentGeneration) { currentGeneration = generation; seen.clear() }
      const report = publicUsageReport(input)
      if (!report) return false
      const id = `${generation}:${report.id}`
      if (seen.has(id)) return false
      // ponytail: cap one child's IDs at 100k; restart the backend to resume, preserving totals.
      if (seen.size >= 100000) { const changed = !truncated; truncated = true; return changed }
      const key = JSON.stringify([report.provider, report.service, report.model, report.pricingRegion])
      if (!rows.has(key) && rows.size >= 1000) { const changed = !truncated; truncated = true; return changed }
      const row = rows.get(key) ?? {provider:report.provider, service:report.service, model:report.model, pricingRegion:report.pricingRegion,
        requests:0, missingReports:0, unpricedReports:0, pricedReports:0, costCny:0, source:null}
      seen.add(id)
      if (USAGE_FIELDS.some(field => report[field] !== undefined && !Number.isSafeInteger((row[field] ?? 0) + report[field]))) { const changed = !truncated; truncated = true; return changed }
      row.requests++
      for (const field of USAGE_FIELDS) if (report[field] !== undefined) row[field] = (row[field] ?? 0) + report[field]
      const price = priceUsage(report)
      if (report.status === 'missing') row.missingReports++
      else if (price.costCny === null) row.unpricedReports++
      else { row.costCny += price.costCny; row.pricedReports++; row.source = price.source }
      rows.set(key,row)
      return true
    },
    snapshot() {
      const result = {truncated, costCny:0, requests:0, missingReports:0, unpricedReports:0, pricedReports:0, priceDate:PRICE_DATE, rows:[...rows.values()].map(row => ({...row}))}
      for (const row of result.rows) for (const key of ['costCny','requests','missingReports','unpricedReports','pricedReports']) result[key] += row[key]
      return result
    },
  }
}

// Saved aggregates keep the original per-request estimates, including tiered prices.
function readHistory(file) {
  const value = JSON.parse(readFileSync(file, 'utf8'))
  if (value.version !== 1 || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))
    || typeof value.truncated !== 'boolean' || !Array.isArray(value.rows) || value.rows.length > 1000) throw Error('invalid usage history')
  const identities = new Set()
  const rows = value.rows.map(row => {
    const report = publicUsageReport({...row, id: 'stored', status: 'complete'})
    const counters = ['requests', 'missingReports', 'unpricedReports', 'pricedReports']
    if (!report || counters.some(key => !Number.isSafeInteger(row[key]) || row[key] < 0)
      || row.requests !== row.missingReports + row.unpricedReports + row.pricedReports
      || !Number.isFinite(row.costCny) || row.costCny < 0) throw Error('invalid usage row')
    const {id, status, ...safe} = report
    const key = JSON.stringify([safe.provider, safe.service, safe.model, safe.pricingRegion])
    if (identities.has(key)) throw Error('duplicate usage row')
    identities.add(key)
    return {...safe, ...Object.fromEntries(counters.map(key => [key, row[key]])), costCny: row.costCny, source: null}
  })
  return {startedAt: value.startedAt, truncated: value.truncated, rows}
}

export function createFrontendUsage({file, now = () => new Date().toISOString()} = {}) {
  const startedAt = now()
  let runtimeSnapshot
  let initial, persistenceError = null, unreadable = false
  if (file) {
    try { initial = readHistory(file) }
    catch (error) {
      if (error.code !== 'ENOENT') { unreadable = true; persistenceError = 'read_failed' }
    }
  }
  const session = createUsageAccumulator()
  const history = createUsageAccumulator(initial)
  const historyStartedAt = initial?.startedAt ?? startedAt
  function persist() {
    if (!file || unreadable) return
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(file), {recursive: true, mode: 0o700})
      // ponytail: sync atomic write of at most 1000 aggregate rows; queue writes if measured UI latency warrants it.
      writeFileSync(temporary, JSON.stringify({version: 1, startedAt: historyStartedAt, ...history.snapshot()}), {mode: 0o600})
      renameSync(temporary, file)
      persistenceError = null
    } catch { persistenceError = 'write_failed' }
    finally { try { unlinkSync(temporary) } catch {} }
  }
  return {
    setRuntimeSnapshot(value) {const parsed=parseUsageSnapshot(value);if(!parsed)return false;runtimeSnapshot=parsed;return true},
    add(generation, report) {
      const changed = session.add(generation, report)
      if (!changed) return false
      history.add(generation, report)
      persist()
      return true
    },
    snapshot() {
      if(runtimeSnapshot)return {...runtimeSnapshot,persistenceError:runtimeSnapshot.persistenceError??persistenceError,history:mergeRuntimeHistory(runtimeSnapshot.history,{...history.snapshot(),startedAt:historyStartedAt,unavailable:unreadable})}
      return {...session.snapshot(), startedAt, persistenceError,
        history: {...history.snapshot(), startedAt: historyStartedAt, unavailable: unreadable}}
    },
  }
}

/** Frozen pre-ledger history is included once, never fed back into the runtime ledger. */
function mergeRuntimeHistory(current,legacy) {
 const result={...current,rows:current.rows.map(r=>({...r})),features:current.features.map(r=>({...r})),unavailable:legacy.unavailable}
 if(!legacy.requests)return result
 const totals=['requests','missingReports','unpricedReports','pricedReports','costCny']
 for(const key of totals)result[key]=(current[key]??0)+(legacy[key]??0)
 result.estimatedCostReports=(current.estimatedCostReports??0)+legacy.pricedReports
 result.startedAt=legacy.startedAt<current.startedAt?legacy.startedAt:current.startedAt
 result.truncated=current.truncated||legacy.truncated
 const rows=new Map(result.rows.map(row=>[JSON.stringify([row.provider,row.service,row.model,row.pricingRegion]),row]))
 const legacyRow={provider:'custom',service:'llm',model:'*',pricingRegion:'unknown',feature:'legacy',source:null,costUsd:0,failedRequests:0,cancelledRequests:0,reportedCostReports:0,estimatedCostReports:legacy.pricedReports,...Object.fromEntries(totals.map(key=>[key,legacy[key]??0]))}
 for(const row of legacy.rows){
  const key=JSON.stringify([row.provider,row.service,row.model,row.pricingRegion]),target=rows.get(key)
  if(target){for(const field of [...totals,...USAGE_FIELDS])if(row[field]!==undefined)target[field]=(target[field]??0)+row[field];target.estimatedCostReports=(target.estimatedCostReports??0)+row.pricedReports}
  else rows.set(key,{...row,feature:'legacy'})
  for(const field of USAGE_FIELDS)if(row[field]!==undefined){legacyRow[field]=(legacyRow[field]??0)+row[field];result[field]=(result[field]??0)+row[field]}
 }
 result.rows=[...rows.values()];result.features.push(legacyRow)
 return result
}
