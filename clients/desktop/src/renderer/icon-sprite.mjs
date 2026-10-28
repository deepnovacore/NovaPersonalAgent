// Runtime installer and rendering facade for the shared icon sprite.
//
// The document owns one hidden <svg> holding a <symbol> per glyph and weight;
// every icon is a tiny <svg><use href="#…"> box that inherits `currentColor`
// from its use site. That keeps colours in CSS (themes keep working) while the
// geometry lives only once, in icon-artwork.mjs.
//
// There are no external .svg files: the page CSPs allow inline SVG only, and an
// <img>/url() icon could not follow `currentColor` anyway.
import { ICON_ARTWORK, ICON_STROKES, ICON_EDGE, iconSymbolId } from './icon-artwork.mjs'

export const SPRITE_ATTRIBUTE = 'data-nova-icon-sprite'

const SVG_NS = 'http://www.w3.org/2000/svg'
const SPRITE_SELECTOR = `svg[${SPRITE_ATTRIBUTE}]`

// Each Document keeps its own sprite. The WeakMap fallback handles test doubles
// whose querySelector cannot see attribute selectors; real documents hit the
// querySelector path and survive a sprite removed by a page teardown.
const installed = new WeakMap()

function canHoldSprite(document) {
  return Boolean(
    document &&
    typeof document.createElementNS === 'function' &&
    document.body &&
    typeof document.body.prepend === 'function',
  )
}

function findSprite(document) {
  const found = typeof document.querySelector === 'function' ? document.querySelector(SPRITE_SELECTOR) : null
  if (found) return found
  const remembered = installed.get(document)
  return remembered && remembered.parentNode === document.body ? remembered : null
}

function createSymbol(document, glyph, weight) {
  const artwork = ICON_ARTWORK[glyph]
  const symbol = document.createElementNS(SVG_NS, 'symbol')
  symbol.setAttribute('id', iconSymbolId(glyph, weight))
  symbol.setAttribute('viewBox', `0 0 ${artwork.size} ${artwork.size}`)
  symbol.setAttribute('fill', 'none')
  symbol.setAttribute('stroke', 'currentColor')
  symbol.setAttribute('stroke-width', String(ICON_STROKES[weight]))
  symbol.setAttribute('stroke-linecap', 'round')
  symbol.setAttribute('stroke-linejoin', 'round')
  for (const [tag, attributes] of artwork.parts) {
    const node = document.createElementNS(SVG_NS, tag)
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
    symbol.append(node)
  }
  return symbol
}

/**
 * Prepends the hidden sprite to `document.body` once and returns it. Calling it
 * again on the same document is a no-op; without a usable DOM it returns null
 * so stub renderers (unit tests) keep working.
 */
export function installIconSprite(document = globalThis.document) {
  if (!canHoldSprite(document)) return null
  const existing = findSprite(document)
  if (existing) {
    installed.set(document, existing)
    return existing
  }
  const sprite = document.createElementNS(SVG_NS, 'svg')
  sprite.setAttribute('aria-hidden', 'true')
  sprite.setAttribute(SPRITE_ATTRIBUTE, '')
  sprite.setAttribute('data-icon-sprite', 'nova')
  sprite.setAttribute('width', '0')
  sprite.setAttribute('height', '0')
  sprite.setAttribute('focusable', 'false')
  if (sprite.style) sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
  for (const glyph of Object.keys(ICON_ARTWORK)) {
    for (const weight of Object.keys(ICON_STROKES)) sprite.append(createSymbol(document, glyph, weight))
  }
  document.body.prepend(sprite)
  installed.set(document, sprite)
  return sprite
}

/**
 * A decorative <svg><use href="#nova-icon-…"> box. Size is the rendered edge;
 * weight picks the regular (1px) or medium (1.3px) artwork. Unknown names and
 * document-less environments yield null so callers can skip the node.
 */
export function icon(name, { size = 0, weight = 'regular', document = globalThis.document, className = 'ui-icon' } = {}) {
  const artwork = ICON_ARTWORK[name]
  const symbolId = iconSymbolId(name, weight)
  if (!artwork || !symbolId || typeof document?.createElementNS !== 'function') return null
  installIconSprite(document)
  const edge = Number.isFinite(size) && size > 0 ? size : artwork.size
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('width', String(edge))
  svg.setAttribute('height', String(edge || ICON_EDGE))
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('data-icon', symbolId)
  const use = document.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', `#${symbolId}`)
  svg.append(use)
  return svg
}

/** Backwards-compatible entry point for existing renderer call sites. */
export function iconNode(name, document = globalThis.document) {
  return icon(name, { document })
}

/** Puts an icon in front of a button's existing label and marks the button. */
export function withIcon(button, name, document = globalThis.document) {
  const node = iconNode(name, document)
  if (node) {
    button.prepend(node)
    button.classList?.add('has-icon')
  }
  return button
}
