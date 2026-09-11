import {MAX_CAMERA_JPEG_BYTES} from '../../desktop-camera.js'
import type {Frame} from '../../executors/watcher.js'
import type { JsonValue } from '../../events.js'
import type { JsonObject } from '../protocol.js'

export const MAX_CASCADED_LLM_HISTORY_ITEMS = 64
export const MAX_CASCADED_LLM_HISTORY_CODEPOINTS = 131_072
/** Marks host-provided activation context; it never represents a user instruction. */
export {HOST_ACTIVATION_PREFIX, GUARD_ACTIVATION_PREFIX} from '../frontend-instructions.js'

export type CascadedLlmInput =
  | {readonly kind: 'user_text'; readonly text: string; readonly image?: Frame}
  | {readonly kind: 'host_context'; readonly content: string}
  | {readonly kind: 'packed_history'; readonly content: string}
  | {readonly kind: 'tool_result'; readonly call_id: string; readonly output: JsonValue}

export interface CascadedLlmTool {
  readonly name: string
  readonly description?: string
  readonly parameters: JsonObject
}

export type CascadedLlmEvent =
  | {readonly kind: 'response_started'; readonly response_id: string}
  | {readonly kind: 'text_delta'; readonly text: string}
  | {readonly kind: 'tool_call'; readonly item_id: string; readonly call_id: string; readonly name: string; readonly arguments: JsonObject}
  | {readonly kind: 'response_completed'; readonly response_id: string}
  | {readonly kind: 'response_failed'; readonly response_id: string; readonly code: string}

export interface CascadedLlmSession {
  stream(input: {
    readonly inputs: readonly CascadedLlmInput[]
    readonly tools: readonly CascadedLlmTool[]
    /** Replaceable provider-visible context for this request; never committed to history. */
    readonly workspaceContext?: string | null
    /** Replaceable response guidance for this request; never committed to history. */
    readonly responseAdaptation?: string | null
    readonly signal: AbortSignal
  }): AsyncIterable<CascadedLlmEvent>
  /** Discards only an unfinished response continuation, retaining completed history. */
  abandonPendingResponse(): Promise<void>
  close(): Promise<void>
}

export interface CascadedLlmFactory {
  open(): CascadedLlmSession
}


export function validateOriginalImage(image: Frame): void {
  if (!(image.payload instanceof Uint8Array) || image.payload.byteLength < 4 || image.payload.byteLength > MAX_CAMERA_JPEG_BYTES
    || image.media_type !== 'image/jpeg' || image.payload[0] !== 0xff || image.payload[1] !== 0xd8
    || image.payload.at(-2) !== 0xff || image.payload.at(-1) !== 0xd9
    || !Number.isSafeInteger(image.width) || image.width < 1 || image.width > 1920
    || !Number.isSafeInteger(image.height) || image.height < 1 || image.height > 1080) throw new Error('invalid camera image')
}

export function originalImageUrl(image: Frame): string {
  validateOriginalImage(image)
  return `data:image/jpeg;base64,${Buffer.from(image.payload).toString('base64')}`
}
