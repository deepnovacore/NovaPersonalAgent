import {createOrbVisualSafe} from './orb-visual.mjs'

// Small, reusable still of the particle orb for list avatars. The animated orb
// stays on the companion and voice stage; a transcript can hold dozens of
// message avatars, so they share one cached first frame instead of one loop
// each. A canvas that cannot be acquired simply yields no image.
let cached
export function orbAvatarImage(size = 64) {
  if (cached !== undefined) return cached
  cached = ''
  try {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const visual = createOrbVisualSafe(canvas, {size, palette: 'ember', reducedMotion: true})
    visual.setState('idle')
    cached = canvas.toDataURL('image/png')
    visual.destroy()
  } catch { /* A canvas-less renderer keeps the text-only transcript. */ }
  return cached
}
