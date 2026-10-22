export function updateTrayUnread(tray, count, platform = process.platform) {
  if (platform === 'darwin') tray?.setTitle(count ? String(count) : '')
  tray?.setToolTip(count ? `Nova · ${count} 条未读提醒` : 'Nova Personal Agent Desktop')
}
// A badge on the tray means something wants the user, so the click must lead
// there; only an empty tray keeps the show/hide toggle.
export function trayClickAction(unread, visible) {
  return unread > 0 ? 'attention' : visible ? 'hide' : 'workbench'
}
export function resetTrayUnreadForBackend(tray, previous, next, platform = process.platform) {
  if (next.state !== 'connected' || next.connection !== previous.connection) updateTrayUnread(tray, 0, platform)
}
