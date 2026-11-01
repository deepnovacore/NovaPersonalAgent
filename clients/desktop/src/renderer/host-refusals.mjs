import {t} from './locale.mjs'

/**
 * Host refusal codes that a user can act on, mapped to source-language sentences.
 *
 * The host raises snake_case codes (see `runtime/src/personal-agent/host.ts`); the renderer never
 * shows a raw identifier or a serialized Zod issue to the user. `invalid_params` is the single
 * normalized code for every parameter-validation failure, so payload shapes cannot leak here.
 */
export const HOST_REFUSALS=Object.freeze({
 build_stop_required:'请先停止正在进行的 Build，再进行这个操作。',
 voice_context_unavailable:'当前语音模型无法带入这段对话的上下文，请先在文字模式继续。',
 project_busy:'这个工作区正被另一项任务占用，请稍后再试或换一个工作区。',
 conversation_busy:'这段对话正在处理上一件事，请稍后再试。',
 local_build_unavailable:'当前平台暂不支持本地 Build。',
 project_directory_required:'请先选择工作区。',
 executor_unavailable:'这个执行器当前不可用。',
 unknown_project:'这个工作区不在执行器已登记的列表里，请从列表中选择。',
 workspaces_unavailable:'工作区列表暂时不可用，请稍后重试。',
 unknown_workspace:'这个工作区已不存在，请重新选择。',
 workspace_name_conflict:'已有同名的工作区，请换一个名称。',
 workspace_project_conflict:'工作区和文件夹只能选择一个，请取消其中一个。',
 plan_delegation_unknown:'上一次委托的结果还不确定，请先刷新计划状态再操作。',
 plan_version_conflict:'计划已在其他操作中更新，请核对最新版本后重试。',
 generation_conflict:'这段对话已在其他操作中更新，请刷新后再试。',
 conversation_limit:'会话数量已经达到上限，请先清理部分会话。',
 invalid_project_directory:'这个文件夹已不可用，请重新选择工作区。',
 invalid_params:'提交的内容不符合要求，请检查后重试。',
 build_finished:'这个 Build 已经结束，不能再发送消息。',
 voice_active:'另一段对话正在使用语音，请先结束语音。',
 source_todo_conflict:'关联的待办已经变化，请重新选择后再发送。',
 stale_reference:'引用事项已变化或不可用，请移除引用后重新选择。',
 reference_not_authorized:'引用来源当前不允许用于对话，请核对来源权限。',
 outcome_unknown:'主机已重启，上一条消息是否执行无法确认。草稿已保留，请先检查对话与任务再决定是否重发。',
 version_conflict:'内容已在其他操作中更新，请核对最新状态后重试。',
 brief_in_quiet_hours:'简报时间在免打扰时段内，不会发送。请调整简报时间或免打扰时段。',
 // Realtime voice connect failures (runtime RealtimeConnectError); the host never forwards provider text.
 realtime_auth_rejected:'实时语音鉴权失败，请在设置中检查语音服务的 API Key 与地域（千问为 DashScope 北京或新加坡站）。',
 realtime_endpoint_not_found:'找不到实时语音服务地址或模型，请检查语音服务的地域、地址与模型名称。',
 realtime_rate_limited:'实时语音服务请求过于频繁或额度不足，请稍后重试或检查账户额度。',
 realtime_handshake_rejected:'实时语音服务拒绝了连接，请稍后重试；若持续失败，请检查语音服务设置。',
 realtime_unreachable:'无法连接实时语音服务，请检查网络或代理后重试。',
 realtime_timeout:'连接实时语音服务超时，请检查网络后重试。',
 realtime_tls_failed:'与实时语音服务的加密连接失败，请检查系统时间、代理或网络证书设置后重试。',
 realtime_session_rejected:'实时语音服务拒绝了会话，可能是模型权限或账户余额问题，请检查语音服务的模型与账户状态。',
 realtime_connect_failed:'实时语音连接失败，请稍后重试；若持续失败，请检查语音服务设置。',
 realtime_protocol_error:'实时语音服务的响应不符合预期，请确认所选模型支持实时语音后重试。',
})

const GENERIC_REFUSAL='操作没有完成，请检查当前状态后再试。'
const INVALID_INPUT='提交的内容不符合要求，请检查后重试。'
const CODE=/^[a-z][a-z0-9_]*$/u

/** A readable sentence for a host refusal code; human-readable host text passes through unchanged. */
export function refusalText(code){
 if(typeof code!=='string')return t(GENERIC_REFUSAL)
 const value=code.trim()
 if(!value)return t(GENERIC_REFUSAL)
 if(Object.hasOwn(HOST_REFUSALS,value))return t(HOST_REFUSALS[value])
 // Serialized validation errors (Zod issues) must never reach a user: either shape is JSON or a code.
 if(/^[\[{]/.test(value)||(value.includes('\n')&&/["{}[\]]/.test(value)))return t(INVALID_INPUT)
 if(CODE.test(value))return t(GENERIC_REFUSAL)
 return value
}
