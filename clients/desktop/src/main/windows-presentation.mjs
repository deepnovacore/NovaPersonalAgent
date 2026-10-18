/**
 * Transparency is fixed at window creation. Windows also disables the native
 * thick frame (and DWM shadow) on transparent windows, regardless of hasShadow.
 * Keep two native shells and move one view between them so conversations,
 * drafts, media permissions and the realtime connection keep their identity.
 */
export function createWindowsPresentationWindows({BaseWindow, WebContentsView, options, workbenchBackground, platform = process.platform}) {
  if (platform !== 'win32') return null

  const {webPreferences, ...shellOptions} = options
  shellOptions.title ??= 'Nova Personal Agent Desktop'
  const view = new WebContentsView({webPreferences})
  view.setBackgroundColor('#00000000')

  // Match the renderer access used by the other BrowserWindow surfaces. Neither
  // shell owns a second renderer, including while it is hidden in the background.
  class PresentationWindow extends BaseWindow {
    get webContents() { return view.webContents }
    loadURL(url) { return view.webContents.loadURL(url) }
  }

  const orb = new PresentationWindow(shellOptions)
  const workbench = new PresentationWindow({
    ...shellOptions,
    transparent: false,
    thickFrame: true,
    hasShadow: true,
    resizable: true,
    alwaysOnTop: false,
    backgroundColor: workbenchBackground,
  })
  const windows = [orb, workbench]
  let activeWindow = orb
  const resizeView = () => {
    const {width, height} = activeWindow.getContentBounds()
    view.setBounds({x: 0, y: 0, width, height})
  }
  for (const window of windows) {
    window.contentView.setBackgroundColor('#00000000')
    window.on('resize', () => { if (window === activeWindow) resizeView() })
    window.on('closed', () => {
      // BaseWindow does not destroy its views' WebContents automatically.
      if (windows.every(candidate => candidate.isDestroyed()) && !view.webContents.isDestroyed()) view.webContents.close()
    })
  }
  orb.contentView.addChildView(view)
  resizeView()

  return {
    orb, workbench, windows,
    get activeWindow() { return activeWindow },
    select(collapsed) {
      const next = collapsed ? orb : workbench
      if (next === activeWindow) return next
      activeWindow.hide()
      activeWindow.contentView.removeChildView(view)
      activeWindow = next
      next.contentView.addChildView(view)
      resizeView()
      return next
    },
  }
}
