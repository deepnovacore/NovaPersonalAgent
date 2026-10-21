/**
 * Build-mode Computer Use contract (issue #32). Shared by the runtime tool group, the workbench loop,
 * the model wire, the host IPC and the desktop overlay. Change names here first; implementations follow.
 */
import {z} from 'zod'

/** Screenshot coordinates: the model sees images scaled so the long edge is at most this; x/y refer to that image. */
export const COMPUTER_IMAGE_LONG_EDGE = 1280
/** The model history keeps only the newest images; older ones become a text placeholder. */
export const COMPUTER_HISTORY_IMAGES = 2
/** Same in-process and device-lock key used by the existing ComputerExecutor, so leases exclude each other. */
export const COMPUTER_RESOURCE = 'desktop:local-input'

export const computerToolArguments = {
 computer_screenshot: z.object({}).strict(),
 computer_click: z.object({x:z.number().int().min(0),y:z.number().int().min(0)}).strict(),
 computer_type: z.object({text:z.string().min(1).max(4000)}).strict(),
 computer_scroll: z.object({x:z.number().int().min(0),y:z.number().int().min(0),direction:z.enum(['up','down','left','right']),amount:z.number().int().min(1).max(10).default(3)}).strict(),
 computer_key: z.object({keys:z.string().min(1).max(100)}).strict(),
 computer_run: z.object({instruction:z.string().trim().min(1).max(4000)}).strict(),
} as const
export type ComputerToolName = keyof typeof computerToolArguments
/** Inputs that change the screen. Approval for these follows `local_tool_approval`; they are journaled like shell_execute. */
export const COMPUTER_WRITE_TOOLS:readonly ComputerToolName[] = ['computer_click','computer_type','computer_scroll','computer_key']
/** Tools that need a vision-capable Build model. Without one, only computer_run is offered. */
export const COMPUTER_VISION_TOOLS:readonly ComputerToolName[] = ['computer_screenshot',...COMPUTER_WRITE_TOOLS]
export function isComputerTool(name:string):name is ComputerToolName{return Object.hasOwn(computerToolArguments,name)}

/** Image attached to a tool result. The wire sends it as a host observation right after the tool message. */
export interface ToolImage {readonly media_type:'image/png'|'image/jpeg';readonly data_base64:string;readonly width:number;readonly height:number;readonly captured_at:string}

/** Result codes returned in tool results (JSON `code`). */
export const COMPUTER_CODES = ['computer_use_disabled','vision_model_required','observe_required','verification_required',
 'computer_resource_busy','screen_changed','declined','cancelled','action_failed','cleanup_unknown','invalid_params'] as const
export type ComputerCode = typeof COMPUTER_CODES[number]

/** Per-conversation switch, stored on `conversation.build.computer_use`. */
export const computerUseStateSchema = z.object({enabled:z.boolean(),enabled_at:z.string().optional(),
 /** False when the Build model lacks vision; only computer_run is offered. */
 direct:z.boolean().default(false)}).strict()
export type ComputerUseState = z.infer<typeof computerUseStateSchema>

/** IPC `build.computer_use` params. Desktop attaches its permission readout (desktop-permissions.mjs). */
export const computerUseCommandSchema = z.object({conversation_id:z.string().min(1),enabled:z.boolean(),
 permissions:z.object({screen:z.string(),accessibility:z.string()}).strict().optional()}).strict()
/** Preflight items. Any of platform/configuration/permissions blocks enabling; vision_model only limits it to computer_run. */
export const COMPUTER_PREFLIGHT_ITEMS = ['platform','configuration','screen_permission','accessibility_permission','vision_model'] as const
export type ComputerPreflightItem = typeof COMPUTER_PREFLIGHT_ITEMS[number]
export interface ComputerUseCommandResult {readonly ok:boolean;readonly state:ComputerUseState;readonly missing:readonly ComputerPreflightItem[]}

/** Emitted through the Build `emit` callback; desktop main drives the overlay from it. */
export interface ComputerUseFrame {
 readonly type:'computer_use'
 readonly conversation_id:string
 /** active: lease held; acting: an input is being sent; delegated: computer_run in progress; idle: lease released. */
 readonly state:'active'|'acting'|'delegated'|'idle'
 readonly action?:ComputerToolName
 /** Logical screen point of a click/scroll, for the ripple. */
 readonly point?:{readonly x:number;readonly y:number}
 readonly summary?:string
}
