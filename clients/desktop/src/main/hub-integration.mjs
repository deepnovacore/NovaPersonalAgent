export function installHubIpc({ipcMain, getSender, action, enabled}) {
  ipcMain.handle('nova:hub:action', (event, name, deviceId) => {
    const sender = getSender()
    if (!sender || event.sender !== sender) return {state:'unavailable'}
    if (!enabled()) return {state:'unsupported'}
    return action(name,deviceId)
  })
}
