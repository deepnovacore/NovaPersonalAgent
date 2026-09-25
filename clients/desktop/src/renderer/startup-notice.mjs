import {t} from './locale.mjs'

export function startupMessage(value) {
  if (value?.stage === 'credentials') return t('正在读取凭据，请查看系统授权弹窗。')
  if (value?.stage === 'configuration') return t('正在检查工作区和启动配置。')
  if (value?.stage === 'backend') return t('正在启动后台。')
  if (value?.stage !== 'failed') return ''
  if (value.code === 'credential_access_failed') return t('凭据访问未完成。请检查系统授权弹窗或更新凭据，再在设置中重试。')
  if (value.code === 'workspace_not_found' || value.code === 'workspace_invalid') return t('工作区不存在或不是目录。请在设置中选择有效工作区。')
  if (value.code === 'state_permissions') return t('无法写入状态目录。请检查目录权限后在设置中重试。')
  if (['state_busy', 'state_lock_failed', 'personal_store_locked'].includes(value.code)) return t('状态目录正被其他进程占用。请关闭占用它的实例后在设置中重试。')
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
