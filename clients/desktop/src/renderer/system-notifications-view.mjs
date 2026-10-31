/**
 * What the settings panel says about OS notifications. Electron cannot read the permission, so this reports only what
 * the platform has actually told the main process (`unverified` until the first notification is shown or refused).
 */
export function systemNotificationsView(status,platform){
 if(!status)return {tone:'muted',hint:'',canOpenSettings:false}
 if(!status.supported||status.state==='unsupported')return {tone:'muted',hint:'当前系统不支持桌面通知，提醒仍会出现在主对话里。',canOpenSettings:false}
 const canOpenSettings=platform==='darwin'||platform==='win32'
 if(!status.enabled)return {tone:'muted',hint:'已关闭：提醒只出现在主对话里，不会弹出系统通知。',canOpenSettings}
 if(status.state==='failed'){
  const where=platform==='darwin'?'请在「系统设置 → 通知」里允许 Nova 发送通知。':platform==='win32'?'请检查「设置 → 系统 → 通知」，并确认没有开启专注助手或勿扰。':'请检查桌面环境的通知设置。'
  return {tone:'warning',hint:'上一次系统通知没能显示。'+where,canOpenSettings}
 }
 if(status.state==='working')return {tone:'ok',hint:'系统通知正常。你正在使用工作台时不会重复弹出。',canOpenSettings}
 return {tone:'neutral',hint:'尚未确认系统是否允许通知；第一条提醒到达时会自动检测。你正在使用工作台时不会弹出。',canOpenSettings}
}
