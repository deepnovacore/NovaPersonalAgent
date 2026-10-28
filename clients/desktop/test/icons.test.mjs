import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ICON_ARTWORK,
  ICON_GLYPHS,
  ICON_STROKES,
  iconSymbolId,
  iconSymbolMarkup,
} from '../src/renderer/icon-artwork.mjs'
import {
  SPRITE_ATTRIBUTE,
  icon,
  iconNode,
  installIconSprite,
  withIcon,
} from '../src/renderer/icon-sprite.mjs'

// A deliberately tiny DOM double: enough of createElementNS/prepend/querySelector
// to run the real installer, but no browser and no SVG parser.
class Node {
  constructor(tag, ns) {
    this.tag = tag
    this.ns = ns
    this.attrs = {}
    this.children = []
    this.classes = new Set()
    this.parentNode = null
    this.style = {}
  }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null }
  append(...nodes) { for (const node of nodes) { if (node && typeof node === 'object') node.parentNode = this; this.children.push(node) } }
  prepend(...nodes) { for (const node of nodes) { if (node && typeof node === 'object') node.parentNode = this; this.children.unshift(node) } }
  get classList() { return { add: name => this.classes.add(name) } }
}

function descendants(node) {
  return node.children.flatMap(child => [child, ...descendants(child)])
}

function fakeDocument() {
  const document = {
    body: new Node('body'),
    createElementNS: (ns, tag) => new Node(tag, ns),
    querySelector(selector) {
      const match = /^svg\[([^\]]+)\]$/.exec(selector)
      if (!match) return null
      return descendants(document.body)
        .find(node => node.tag === 'svg' && Object.hasOwn(node.attrs, match[1])) ?? null
    },
  }
  return document
}

const LEGACY_GLYPHS = [
  'play', 'stop', 'pause', 'list', 'shield', 'alert', 'refresh',
  'search', 'monitor', 'globe', 'camera', 'code', 'book', 'plug',
]
const ADDED_GLYPHS = [
  'mail', 'calendar', 'chat', 'lock', 'folder', 'external',
  'gear', 'plus', 'x', 'check', 'chevron',
]

test('every glyph is 16×16 data painted only with currentColor', () => {
  assert.ok(ICON_GLYPHS.length > 0)
  assert.deepEqual(ICON_STROKES, { regular: 1, medium: 1.3 })
  for (const name of ICON_GLYPHS) {
    assert.match(name, /^[a-z][a-z0-9-]*$/, `${name} is kebab-case`)
    const artwork = ICON_ARTWORK[name]
    assert.equal(artwork.size, 16, `${name} is drawn on the 16px grid`)
    assert.ok(artwork.parts.length > 0, `${name} has at least one shape`)
    for (const [tag, attrs] of artwork.parts) {
      assert.match(tag, /^(path|circle|rect)$/, `${name} uses simple SVG shapes`)
      assert.ok(Object.keys(attrs).length > 0)
    }
    for (const weight of ['regular', 'medium']) {
      const markup = iconSymbolMarkup(name, weight)
      assert.ok(markup?.startsWith('<symbol '), `${name} renders a symbol`)
      assert.match(markup, /viewBox="0 0 16 16"/)
      assert.match(markup, /stroke="currentColor"/)
      assert.match(markup, new RegExp(`stroke-width="${ICON_STROKES[weight]}"`))
      assert.doesNotMatch(markup, /<style|<script|url\(|<image/, `${name} stays self-contained`)
      assert.doesNotMatch(markup, /#[0-9a-f]{3,8}\b|\b(?:black|white|rgb|hsl)\(/i, `${name} hard-codes no colour`)
    }
  }
})

test('the legacy renderer set survives and the shared additions exist', () => {
  for (const name of [...LEGACY_GLYPHS, ...ADDED_GLYPHS]) {
    assert.ok(Object.hasOwn(ICON_ARTWORK, name), `${name} is part of the sprite`)
  }
  assert.equal(iconSymbolId('play'), 'nova-icon-play-regular')
  assert.equal(iconSymbolId('play', 'medium'), 'nova-icon-play-medium')
  assert.equal(iconSymbolId('nope'), null)
  assert.equal(iconSymbolId('play', 'heavy'), null)
  assert.equal(iconSymbolMarkup('nope'), null)
})

test('the sprite is one hidden prepended svg per document, one symbol per glyph and weight', () => {
  const document = fakeDocument()
  const sprite = installIconSprite(document)
  assert.ok(sprite)
  assert.equal(document.body.children[0], sprite, 'the sprite is prepended before the app markup')
  assert.equal(sprite.tag, 'svg')
  assert.equal(sprite.ns, 'http://www.w3.org/2000/svg')
  assert.equal(sprite.getAttribute('aria-hidden'), 'true')
  assert.equal(sprite.getAttribute(SPRITE_ATTRIBUTE), '')
  assert.equal(sprite.getAttribute('width'), '0')
  assert.equal(sprite.getAttribute('height'), '0')
  assert.equal(sprite.style.cssText, 'position:absolute;width:0;height:0;overflow:hidden')

  const symbols = sprite.children.filter(node => node.tag === 'symbol')
  assert.equal(symbols.length, ICON_GLYPHS.length * 2)
  assert.equal(new Set(symbols.map(node => node.getAttribute('id'))).size, symbols.length)
  for (const symbol of symbols) {
    assert.match(symbol.getAttribute('id'), /^nova-icon-[a-z0-9-]+-(?:regular|medium)$/)
    assert.equal(symbol.getAttribute('viewBox'), '0 0 16 16')
    assert.equal(symbol.getAttribute('fill'), 'none')
    assert.equal(symbol.getAttribute('stroke'), 'currentColor')
    assert.ok(['1', '1.3'].includes(symbol.getAttribute('stroke-width')))
    assert.equal(symbol.getAttribute('width'), null, 'symbols never pin a size')
    assert.equal(symbol.getAttribute('height'), null)
    assert.ok(symbol.children.length > 0)
  }

  assert.equal(installIconSprite(document), sprite, 'installing twice is a no-op')
  assert.equal(document.body.children.filter(node => node.tag === 'svg').length, 1)
})

test('an icon is a decorative <svg><use> box that inherits colour at the use site', () => {
  const document = fakeDocument()
  const svg = icon('search', { document, size: 20 })
  assert.equal(svg.tag, 'svg')
  assert.equal(svg.getAttribute('class'), 'ui-icon')
  assert.equal(svg.getAttribute('width'), '20')
  assert.equal(svg.getAttribute('height'), '20')
  assert.equal(svg.getAttribute('aria-hidden'), 'true')
  assert.equal(svg.getAttribute('data-icon'), 'nova-icon-search-regular')
  assert.equal(svg.children.length, 1)
  assert.equal(svg.children[0].tag, 'use')
  assert.equal(svg.children[0].getAttribute('href'), '#nova-icon-search-regular')
  assert.ok(installIconSprite(document), 'rendering lazily installs the sprite')

  const medium = icon('search', { document, weight: 'medium' })
  assert.equal(medium.children[0].getAttribute('href'), '#nova-icon-search-medium')
  assert.equal(medium.getAttribute('width'), '16', 'size defaults to the artwork edge')
})

test('without a DOM the icon helpers stay inert for stub renderers', () => {
  assert.equal(icon('play', { document: null }), null)
  assert.equal(icon('nope', { document: fakeDocument() }), null)
  assert.equal(iconNode('play', null), null)
  assert.equal(installIconSprite(null), null)
  assert.equal(installIconSprite({}), null)
  const button = new Node('button')
  assert.equal(withIcon(button, 'play', null), button)
  assert.equal(button.children.length, 0)
})

test('withIcon keeps the icon before the existing label and marks the button', () => {
  const document = fakeDocument()
  const button = new Node('button')
  button.append('label')
  withIcon(button, 'list', document)
  assert.equal(button.children[0].tag, 'svg')
  assert.equal(button.children[1], 'label')
  assert.ok(button.classes.has('has-icon'))
})
