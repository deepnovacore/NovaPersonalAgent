import { Buffer } from 'node:buffer'
import type { Channel, Memory, MemoryItem } from '../core/memory.js'
import type {RealtimeDiagnosticsSnapshot} from './telemetry.js'

export const MAX_BOARD_MESSAGE_BYTES = 256 * 1024
export const MAX_BOARD_ITEMS_PER_CHANNEL = 50
export const MAX_BOARD_CONTENT_CHARS = 2048
export const MAX_BOARD_SUMMARY_CHARS = 4096
export const MAX_BOARD_REFRESH_MESSAGE_BYTES = 64 * 1024
export const MAX_BOARD_REFRESH_ITEMS_PER_CHANNEL = 12
export const MAX_BOARD_REFRESH_CONTENT_CHARS = 768
export const MAX_BOARD_REFRESH_SUMMARY_CHARS = 1024
export const MAX_BOARD_REFRESH_DIAGNOSTICS = 32

export type MemoryBoardDetail = 'compact' | 'full'

export interface MemoryBoardMessageOptions {
  readonly detail?: MemoryBoardDetail
  readonly channel?: string
  readonly before_seq?: number
  readonly conversationEpoch?: number
}

interface BoardItem {
  readonly seq: number
  readonly ts: number
  readonly trust: MemoryItem['trust']
  readonly priority: number
  readonly outcome: MemoryItem['outcome']
  readonly refs: readonly string[]
  readonly content: string
  readonly truncated?: true
  readonly historical?: true
  readonly recorded_at_ms?: number
}

interface BoardChannel {
  readonly name: string
  readonly historical_through_seq?: number
  summary: string | null
  readonly uncompressed: number
  readonly item_count: number
  readonly retention_revision: number
  items: BoardItem[]
  next_before_seq: number | null
  has_more: boolean
}

export function memoryBoardMessage(
  requestId: string,
  memory: Memory,
  diagnosticSnapshot: RealtimeDiagnosticsSnapshot = {version: 1, records: []},
  options: MemoryBoardMessageOptions = {},
): string {
  const detail = options.channel === undefined ? options.detail ?? 'full' : 'full'
  const profile = detail === 'compact'
    ? {
        messageBytes: MAX_BOARD_REFRESH_MESSAGE_BYTES,
        itemsPerChannel: MAX_BOARD_REFRESH_ITEMS_PER_CHANNEL,
        contentChars: MAX_BOARD_REFRESH_CONTENT_CHARS,
        summaryChars: MAX_BOARD_REFRESH_SUMMARY_CHARS,
        diagnostics: MAX_BOARD_REFRESH_DIAGNOSTICS,
      }
    : {
        messageBytes: MAX_BOARD_MESSAGE_BYTES,
        itemsPerChannel: MAX_BOARD_ITEMS_PER_CHANNEL,
        contentChars: MAX_BOARD_CONTENT_CHARS,
        summaryChars: MAX_BOARD_SUMMARY_CHARS,
        diagnostics: diagnosticSnapshot.records.length,
      }
  const selected = [...memory.channels.values()].filter(channel => options.channel === undefined || channel.name === options.channel)
  const channels = selected.map(channel => channelView(channel, profile, options.before_seq))
  const diagnostics = {
    version: 1 as const,
    records: diagnosticSnapshot.records.slice(-profile.diagnostics),
  }
  let summariesDropped = false
  while (true) {
    for (const channel of channels) {
      const first = channel.items[0]?.seq
      channel.has_more = first !== undefined && memory.channels.get(channel.name)!.items.some(item => item.seq < first)
      channel.next_before_seq = channel.has_more ? first! : null
    }
    const message = JSON.stringify({
      type: 'memory.board', request_id: requestId, conversation_epoch: options.conversationEpoch ?? 0, diagnostics, channels,
    })
    if (Buffer.byteLength(message, 'utf8') <= profile.messageBytes) return message
    if (diagnostics.records.length > 0) {
      diagnostics.records = diagnostics.records.slice(1)
      continue
    }
    const populated = channels.filter(channel => channel.items.length > 0)
    if (populated.length > 0) {
      const largest = populated.reduce((current, candidate) => (
        candidate.items.length > current.items.length ? candidate : current
      ))
      largest.items = largest.items.slice(1)
      continue
    }
    if (!summariesDropped) {
      summariesDropped = true
      for (const channel of channels) channel.summary = null
      continue
    }
    return message
  }
}

interface BoardProfile {
  readonly itemsPerChannel: number
  readonly contentChars: number
  readonly summaryChars: number
}

function channelView(channel: Channel, profile: BoardProfile, before?: number): BoardChannel {
  return {
    name: channel.name,
    next_before_seq: null,
    has_more: false,
    ...(channel.restoredThroughSequence === 0 ? {} : {historical_through_seq: channel.restoredThroughSequence}),
    summary: channel.summary === null
      ? null
      : sliceCodePoints(channel.summary, profile.summaryChars),
    uncompressed: channel.uncompressed,
    item_count: channel.items.length,
    retention_revision: channel.retentionRevision,
    items: channel.items
      .filter(item => before === undefined || item.seq < before)
      .slice(-profile.itemsPerChannel)
      .map(item => ({...itemView(item, profile.contentChars),
        ...(item.seq <= channel.restoredThroughSequence ? {
          historical: true as const,
          recorded_at_ms: channel.restoredRecord(item.seq)!.recordedAtMs,
        } : {}),
      })),
  }
}

function itemView(item: MemoryItem, contentChars: number): BoardItem {
  const content = JSON.stringify(item.content)
  const truncated = [...content].length > contentChars
  return {
    seq: item.seq,
    ts: item.ts,
    trust: item.trust,
    priority: item.priority,
    outcome: item.outcome,
    refs: [...item.refs],
    content: sliceCodePoints(content, contentChars),
    ...(truncated ? {truncated: true as const} : {}),
  }
}

function sliceCodePoints(value: string, limit: number): string {
  return [...value].slice(0, limit).join('')
}
