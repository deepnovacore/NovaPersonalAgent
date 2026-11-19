// Icon artwork for the desktop renderer.
//
// Every glyph is ordinary data on one 16×16 grid: a list of SVG child elements
// (tag + attributes) plus the drawn edge. The sprite installer turns this data
// into <symbol> nodes, so no markup is parsed, no <style> is injected, and the
// geometry can be swapped later without touching call sites.
//
// Rules:
// - Geometry only ever paints with `currentColor`; literal colours would break
//   the light/dark themes.
// - The library owns stroke geometry: `regular` is 1px, `medium` is 1.3px.
// - All glyphs are decorative and carry no title, desc or label.
export const ICON_STROKES = Object.freeze({ regular: 1, medium: 1.3 })

export const ICON_WEIGHTS = Object.freeze(Object.keys(ICON_STROKES))

export const ICON_EDGE = 16

const path = d => ['path', { d }]

const circle = (cx, cy, r, extra = {}) => ['circle', { cx, cy, r, ...extra }]

const rect = (x, y, width, height, extra = {}) => ['rect', { x, y, width, height, ...extra }]

// A filled dot reads better than a zero-length stroked segment.
const dot = (cx, cy, r = 0.7) => circle(cx, cy, r, { fill: 'currentColor', stroke: 'none' })

const glyph = (...parts) => Object.freeze({ size: ICON_EDGE, parts: Object.freeze(parts) })

export const ICON_ARTWORK = Object.freeze({
  // --- migrated from the old 24×24 renderer set ---------------------------
  play: glyph(path('M5.4 3.1 12.9 8l-7.5 4.9z')),
  stop: glyph(rect(4.3, 4.3, 7.4, 7.4, { rx: 1.2 })),
  pause: glyph(path('M6 4.1v7.8M10 4.1v7.8')),
  list: glyph(
    path('M6.4 4.4h6.2M6.4 8h6.2M6.4 11.6h6.2'),
    dot(2.9, 4.4),
    dot(2.9, 8),
    dot(2.9, 11.6),
  ),
  shield: glyph(
    path('M8 1.9 13.3 3.8v4.1c0 3-2.3 5.2-5.3 6.2-3-1-5.3-3.2-5.3-6.2V3.8z'),
    path('m5.5 7.7 1.7 1.7 3.2-3.4'),
  ),
  alert: glyph(
    path('M8 2.3 14 13.1H2z'),
    path('M8 6.2v3.3M8 11.6v.1'),
  ),
  refresh: glyph(
    path('M13.4 3.2v3.5h-3.5'),
    path('M13.1 6.3A5.4 5.4 0 1 0 13.5 8.9'),
  ),
  search: glyph(
    circle(6.8, 6.8, 4.2),
    path('M9.9 9.9 13.8 13.8'),
  ),
  monitor: glyph(
    rect(1.9, 3.2, 12.2, 8.2, { rx: 1.4 }),
    path('M8 11.4v2.6M5.9 14h4.2'),
  ),
  globe: glyph(
    circle(8, 8, 5.9),
    path('M2.1 8h11.8'),
    path('M8 2.1c1.9 1.9 2.9 3.9 2.9 5.9S9.9 12.1 8 13.9C6.1 12.1 5.1 10.1 5.1 8S6.1 3.9 8 2.1z'),
  ),
  camera: glyph(
    path('M2.2 5.5h2.6l1.2-2h4l1.2 2h2.6v7.7H2.2z'),
    circle(8, 9.2, 2.5),
  ),
  code: glyph(path('M5.5 5.1 2.2 8l3.3 2.9M10.5 5.1 13.8 8l-3.3 2.9M9.2 3.3 6.8 12.7')),
  book: glyph(
    path('M3.3 3h7a2 2 0 0 1 2 2v8H5.3a2 2 0 0 1-2-2z'),
    path('M3.3 11a2 2 0 0 1 2-2h7'),
  ),
  plug: glyph(path('M6 2.3v3.4M10 2.3v3.4M4.3 5.7h7.4v2.3a3.7 3.7 0 0 1-7.4 0zM8 11.7v2')),

  // --- additions for settings navigation and shared chrome -----------------
  mail: glyph(
    rect(1.8, 3.3, 12.4, 9.4, { rx: 1.5 }),
    path('m2.4 4.5 5.6 4 5.6-4'),
  ),
  calendar: glyph(
    rect(2, 3.4, 12, 10.2, { rx: 1.7 }),
    path('M2 6.9h12M5.4 1.9v2.8M10.6 1.9v2.8'),
  ),
  chat: glyph(path('M2.2 4.4a2.2 2.2 0 0 1 2.2-2.2h7.2a2.2 2.2 0 0 1 2.2 2.2v5a2.2 2.2 0 0 1-2.2 2.2H6.6L3.4 14v-3.1a2.2 2.2 0 0 1-1.2-2z')),
  lock: glyph(
    rect(3.3, 7.3, 9.4, 6.6, { rx: 1.6 }),
    path('M5.5 7.3V5.6a2.5 2.5 0 0 1 5 0v1.7'),
    path('M8 10.2v1.7'),
  ),
  folder: glyph(path('M2.1 4.7a1.6 1.6 0 0 1 1.6-1.6h2.8l1.5 1.9h4.3a1.6 1.6 0 0 1 1.6 1.6v5.8a1.6 1.6 0 0 1-1.6 1.6H3.7a1.6 1.6 0 0 1-1.6-1.6z')),
  external: glyph(path('M6.4 9.6 13.4 2.6M9.9 2.6h3.5v3.5M12.8 9.4v2.4a1.6 1.6 0 0 1-1.6 1.6H3.8a1.6 1.6 0 0 1-1.6-1.6V4.4a1.6 1.6 0 0 1 1.6-1.6h2.4')),
  gear: glyph(
    path('M14.96 6.9 14.96 9.1 13.14 9.47 12.94 10.05 12.68 10.59 13.7 12.14 12.14 13.7 10.59 12.68 10.05 12.94 9.47 13.14 9.1 14.96 6.9 14.96 6.53 13.14 5.95 12.94 5.41 12.68 3.86 13.7 2.3 12.14 3.32 10.59 3.06 10.05 2.86 9.47 1.04 9.1 1.04 6.9 2.86 6.53 3.06 5.95 3.32 5.41 2.3 3.86 3.86 2.3 5.41 3.32 5.95 3.06 6.53 2.86 6.9 1.04 9.1 1.04 9.47 2.86 10.05 3.06 10.59 3.32 12.14 2.3 13.7 3.86 12.68 5.41 12.94 5.95 13.14 6.53Z'),
    circle(8, 8, 2.5),
  ),
  plus: glyph(path('M8 3.2v9.6M3.2 8h9.6')),
  x: glyph(path('M4.1 4.1 11.9 11.9M11.9 4.1 4.1 11.9')),
  check: glyph(path('M3.2 8.4 6.4 11.6 12.8 4.8')),
  chevron: glyph(path('M6.2 3.8 10.4 8l-4.2 4.2')),

  // --- settings categories without a reusable legacy glyph -----------------
  theme: glyph(
    path('M8 1.9 9.4 6.1 13.6 7.5 9.4 8.9 8 13.1 6.6 8.9 2.4 7.5 6.6 6.1z'),
    path('M12.3 11.1v2.6M11 12.4h2.6'),
  ),
  chart: glyph(path('M4.1 12.6V8.4M8 12.6V3.6M11.9 12.6V6.5')),
  cube: glyph(
    path('M8 1.9 13.6 5.2v5.9L8 14.4 2.4 11.1V5.2z'),
    path('M8 8.1 13.6 5.2M8 8.1v6.3M8 8.1 2.4 5.2'),
  ),
  key: glyph(
    circle(5.4, 10.6, 2.7),
    path('M7.3 8.7 13.4 2.6M10.6 5.4l2 2M12.1 3.9l2 2'),
  ),
  phone: glyph(
    rect(4.7, 1.9, 6.6, 12.2, { rx: 1.8 }),
    path('M7.2 12.3h1.6'),
  ),

  // --- permission-card glyphs (welcome + settings) -------------------------
  microphone: glyph(
    rect(6.2, 1.9, 3.6, 6.4, { rx: 1.8 }),
    path('M4.2 7.5a3.8 3.8 0 0 0 7.6 0M8 11.3v2.8'),
  ),
  cursor: glyph(path('M4 2.7 12 7 8.5 8.1 7.4 11.6z')),
})

export const ICON_GLYPHS = Object.freeze(Object.keys(ICON_ARTWORK))

/** `nova-icon-<glyph>-<weight>`; null for unknown glyphs or weights. */
export function iconSymbolId(glyph, weight = 'regular') {
  if (!Object.hasOwn(ICON_ARTWORK, glyph)) return null
  if (!Object.hasOwn(ICON_STROKES, weight)) return null
  return `nova-icon-${glyph}-${weight}`
}

const quote = value => `"${String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"`

/** The exact `<symbol>` markup the installer builds, exported for tests/tools. */
export function iconSymbolMarkup(glyph, weight = 'regular') {
  const artwork = ICON_ARTWORK[glyph]
  const stroke = ICON_STROKES[weight]
  if (!artwork || stroke === undefined) return null
  const attributes = [
    `id=${quote(iconSymbolId(glyph, weight))}`,
    `viewBox=${quote(`0 0 ${artwork.size} ${artwork.size}`)}`,
    'fill="none"',
    'stroke="currentColor"',
    `stroke-width=${quote(stroke)}`,
    'stroke-linecap="round"',
    'stroke-linejoin="round"',
  ].join(' ')
  const children = artwork.parts.map(([tag, attrs]) => {
    const serialized = Object.entries(attrs).map(([name, value]) => ` ${name}=${quote(value)}`).join('')
    return `<${tag}${serialized}></${tag}>`
  }).join('')
  return `<symbol ${attributes}>${children}</symbol>`
}
