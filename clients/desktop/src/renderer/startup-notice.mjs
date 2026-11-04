import {t} from './locale.mjs'
import {publicStartupConfiguration} from './startup-configuration.mjs'

// Fixed stage labels for the bounded configuration waits. Codes carry no paths
// or credentials, so they are safe to show and to log.
const CONFIGURATION_STAGE_LABELS = Object.freeze({
  configuration_wait_settings: t('启动配置'),
  configuration_wait_workspace: t('工作区路径检查'),
  configuration_wait_directories: t('状态与工作区目录'),
  configuration_wait_codex: t('Codex 环境检查'),
  configuration_wait_maintenance: t('工作区维护服务'),
  configuration_wait_reconcile: t('外部工作区清理核对'),
  configuration_wait_capabilities: t('工作区能力检查'),
  configuration_wait_recovery: t('后台恢复检查'),
})

export function configurationStageLabel(code) {
  return CONFIGURATION_STAGE_LABELS[code] ?? t('启动配置')
}

export function startupMessage(value) {
  if (value?.stage === 'credentials') return t('正在读取凭据，请查看系统授权弹窗。')
  if (value?.stage === 'configuration' && value.code) {
    return t('正在准备{0}…', configurationStageLabel(value.code))
  }
  if (value?.stage === 'backend' && value.code) return t('后台启动尚未完成，正在自动重试。')
  if (value?.stage === 'reconnecting') return t('后台连接已断开，正在自动重连。')
  if (value?.stage !== 'failed') return ''
  const configuration = publicStartupConfiguration(value.startupConfiguration)
  if (configuration) {
    const hint = configuration.code === 'memory_provider_conflict'
      ? t('请移除旧的 MEMORY_PROVIDER，或移除 MEMORY_RECALL_ENGINE 和 MEMORY_EXTRACTORS，再重试。')
      : t('请检查这些记忆配置项的格式与连接模式，再重试。远程连接的引擎由服务端配置。')
    return `${configuration.code} · ${configuration.variables.join(', ')} — ${hint}`
  }
  if (value.code === 'startup_presentation_required') return t('请打开工作台或设置后重试，以便显示凭据授权提示。')
  if (value.code === 'credential_invalid') return t('已保存的凭据格式无效。请在设置中更新对应密钥后重试。')
  if (value.code === 'filesystem_permissions') return t('无法访问启动所需的文件或目录。请检查相关目录权限后重试。')
  if (value.code === 'credential_access_failed') return t('凭据访问未完成。请检查系统授权弹窗或更新凭据，再在设置中重试。')
  if (value.code === 'workspace_not_found' || value.code === 'workspace_invalid') return t('工作区不存在或不是目录。请在设置中选择有效工作区。')
  if (value.code === 'state_permissions') return t('无法写入状态目录。请检查目录权限后在设置中重试。')
  if (value.code === 'personal_store_capacity' || value.code === 'state_corrupt') return t('状态文件无法读取或超过大小上限。请备份后运行 novapersonal reset-state。')
  if (value.code === 'state_version_unsupported') return t('状态文件由更新版本的 Nova 写入。请升级 Nova，或备份后运行 novapersonal reset-state。')
  if (['state_busy', 'state_lock_failed', 'personal_store_locked'].includes(value.code)) return t('Nova 已在另一个窗口运行。请关闭它后重试。')
  if (value.code === 'configuration_timeout') return t('配置阶段等待超时，后台尚未启动。请点击重试；若反复出现，请检查状态与工作区目录是否可访问。')
  if (value.code === 'settings_recovery_failed') return t('设置恢复未完成。请在设置中恢复上次可用配置。')
  return t('后台启动失败，请打开设置检查配置后重试。')
}

export function createStartupNotice({render, schedule = setTimeout, cancel = clearTimeout}) {
  let phase = null, timer = null, waiting = false
  return {update(value) {
    if (phase !== value?.stage) {
      if (timer !== null) cancel(timer)
      timer = null; waiting = false; phase = value?.stage
      if (phase === 'credentials') timer = schedule(() => {
        waiting = true
        render(`${startupMessage(value)} ${t('仍在等待系统返回；可在系统弹窗中允许或取消。')}`)
      }, 10_000)
    }
    render(`${startupMessage(value)}${waiting ? ` ${t('仍在等待系统返回；可在系统弹窗中允许或取消。')}` : ''}`)
  }}
}
