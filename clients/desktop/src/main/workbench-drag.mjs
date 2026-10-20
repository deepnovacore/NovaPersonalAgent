const WM_NCLBUTTONDBLCLK = 0x00a3
const HTCAPTION = 2

/** Keep Windows moves in the OS: setPosition round-trips the size through DIPs. */
export function configureWorkbenchNativeDrag({window, platform, isCollapsed, frame}) {
  if (platform !== 'win32') return

  // A native drag region consumes DOM double-clicks. Keep the workbench's
  // existing bounds toggle on shells created with maximizable: false.
  window.hookWindowMessage(WM_NCLBUTTONDBLCLK, hitTest => {
    if (!isCollapsed() && hitTest.readUInt32LE(0) === HTCAPTION) frame.toggleMaximize()
  })
  window.on('will-move', event => {
    if (!isCollapsed() && frame.maximized) event.preventDefault()
  })
}
