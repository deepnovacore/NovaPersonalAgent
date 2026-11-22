// Ctrl+M (microphone) and Ctrl+L (sleep) act only while a Nova window has focus.
// Registering them globally would swallow Ctrl+L in browsers and terminals.
export function windowShortcut(input) {
  if (input?.type !== 'keyDown' || input.isAutoRepeat || !input.control || input.meta || input.alt || input.shift) return null
  const key = String(input.key).toLowerCase()
  return key === 'm' ? 'microphone' : key === 'l' ? 'sleep' : null
}

export function bindWindowShortcuts(window, {toggleMicrophone, sleep}) {
  window.webContents.on('before-input-event', (event, input) => {
    const action = windowShortcut(input)
    if (!action) return
    event.preventDefault()
    if (action === 'microphone') toggleMicrophone()
    else sleep()
  })
}
