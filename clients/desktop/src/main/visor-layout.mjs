// Electron display rectangles already use DIP, including on mixed-DPI desktops.
export function visorLayout({bounds, workArea}) {
  const insetX = Math.max(0, workArea.x - bounds.x,
    bounds.x + bounds.width - workArea.x - workArea.width)
  const insetY = Math.max(0, workArea.y - bounds.y,
    bounds.y + bounds.height - workArea.y - workArea.height)
  const hud = {
    x: bounds.x + insetX, y: bounds.y + insetY,
    width: bounds.width - 2 * insetX, height: bounds.height - 2 * insetY,
  }
  const width = Math.min(420, hud.width)
  return {hud, controls: {
    x: Math.round(hud.x + (hud.width - width) / 2),
    y: hud.y + hud.height - 56, width, height: 48,
  }}
}
