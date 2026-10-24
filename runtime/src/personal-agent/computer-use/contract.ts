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
 computer_screenshot: z.object({application:z.string().trim().min(1).max(200).optional()}).strict(),
 computer_click: z.object({observationId:z.string().min(1),x:z.number().int().min(0),y:z.number().int().min(0)}).strict(),
 computer_type: z.object({observationId:z.string().min(1),mode:z.enum(['append','replace']).default('append'),text:z.string().min(1).max(4000)}).strict(),
 computer_scroll: z.object({observationId:z.string().min(1),x:z.number().int().min(0),y:z.number().int().min(0),direction:z.enum(['up','down','left','right']),amount:z.number().int().min(1).max(10).default(3)}).strict(),
 computer_key: z.object({observationId:z.string().min(1),keys:z.string().min(1).max(100)}).strict(),
 computer_run: z.object({instruction:z.string().trim().min(1).max(4000)}).strict(),
} as const
export type ComputerToolName = keyof typeof computerToolArguments
/** Inputs that change the screen. Approval for these follows `local_tool_approval`; they are journaled like shell_execute. */
export const COMPUTER_WRITE_TOOLS:readonly ComputerToolName[] = ['computer_click','computer_type','computer_scroll','computer_key']
/** Tools that need a vision-capable Build model. Without one, only computer_run is offered. */
export const COMPUTER_VISION_TOOLS:readonly ComputerToolName[] = ['computer_screenshot',...COMPUTER_WRITE_TOOLS]
export function isComputerTool(name:string):name is ComputerToolName{return Object.hasOwn(computerToolArguments,name)}

/** Image attached to a tool result. The wire sends it as a host observation right after the tool message. */
export interface ToolImage {readonly media_type:'image/png'|'image/jpeg';readonly data_base64:string;readonly width:number;readonly height:number;readonly captured_at:string;readonly native_ui?:{source:'accessibility';content:{role:string;text:string;url:string}[];truncated:boolean};readonly native_editor?:{role:string;value:string;source:'accessibility'}}

/** Result codes returned in tool results (JSON `code`). */
export const COMPUTER_CODES = ['computer_use_disabled','vision_model_required','observe_required','verification_required',
 'computer_resource_busy','screen_changed','declined','cancelled','action_failed','cleanup_unknown','invalid_params'] as const

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

export const computerApplicationSchema=z.object({name:z.string().min(1).max(200),bundleId:z.string().min(1).max(300),path:z.string().min(1).max(4096)}).strict()

/** Unified window observation (issue #3). One shape for Build and for the voice-dispatched ComputerExecutor. */
export const COMPUTER_AX_STATUSES = ['ok','unavailable','timeout','truncated'] as const
export type ComputerAxStatus = typeof COMPUTER_AX_STATUSES[number]
/** How an action reached the target. `activated` is foreground/global input (including an already-active window), not permission to activate another window. */
export type ComputerExecutionMode = 'background'|'activated'
export interface ComputerObservation {
 /** Opaque; every action must cite the newest one, and the session rejects it when the target or geometry changed. */
 readonly id:string
 readonly captured_at:string
 readonly image:ToolImage
 /** `scale` = screenshot px per logical px. Click/scroll coordinates are in screenshot space and are mapped with it. */
 readonly space:{readonly logical_width:number;readonly logical_height:number;readonly scale:number}
 /** Null target = whole screen. */
 readonly target:null|{readonly application:string;readonly pid:number;readonly window_id:number;readonly title:string}
 readonly focus:{readonly pid:number;readonly window_id:number}|null
 readonly foreground:boolean
 /** AX text is untrusted application data: bounded, never includes secure text fields. */
 readonly ax:{readonly status:ComputerAxStatus;readonly summary?:NonNullable<ToolImage['native_ui']>;readonly editor?:NonNullable<ToolImage['native_editor']>}
}
/** Replace overwrites the focused field; append adds at the caret. Drivers must agree. */
export const COMPUTER_TYPE_MODES = ['append','replace'] as const
export type ComputerTypeMode = typeof COMPUTER_TYPE_MODES[number]
