import {MAX_CAMERA_JPEG_BYTES} from '../../desktop/desktop-camera.js'
import type {Frame} from '../../executors/watcher.js'
import type { JsonValue } from '../../core/events.js'
import type { JsonObject } from '../protocol.js'

export const MAX_CASCADED_LLM_HISTORY_ITEMS = 64
export const MAX_CASCADED_LLM_HISTORY_CODEPOINTS = 131_072
/** Marks host-provided activation context; it never represents a user instruction. */
export {HOST_ACTIVATION_PREFIX, GUARD_ACTIVATION_PREFIX} from '../frontend-instructions.js'

/** Shared by the actual adapter and live probes; tool availability never requires a call. */
export function cascadedResponseGuidance(allowTools: boolean): string {
  return allowTools
    ? '本轮可自然对话、回答或澄清；工具可用不代表必须调用。编程需求存在会改变交付的必要歧义时，只问最关键的一个问题，等用户回答，不列问题清单；此时不调用 dispatch。需要执行且需求明确时直接通过结构化 tool_calls 调用工具，不把调用写成 JSON 文本，同轮不混合正文与调用。确认必须基于本轮用户决定；调用后等待宿主结果，不声称已执行。工具参数错误时依据返回的具体原因修正调用；无法继续时如实说明当前失败，不猜测原因，不口头承诺尚未发起的重试。'
    : '本轮是宿主事实播报，没有用户授权，也没有可调用工具。只转述最新事实或给定问题，不模拟工具调用，不输出调用 JSON，不代用户确认；已接纳不等于已启动。失败事实没有提供待用户决定的问题时，只说明当前结果，不沿用历史追问，不要求再次确认；失败原因未知时不猜测，不承诺自动重试。'
}

export type CascadedLlmInput =
  | {readonly kind: 'user_text'; readonly text: string; readonly image?: Frame}
  | {readonly kind: 'host_context'; readonly content: string}
  | {readonly kind: 'packed_history'; readonly content: string}
  /** Provider turn trigger, explicitly marked as a host fact; never user-action authority. */
  | {readonly kind: 'host_activation'; readonly content: string}
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
