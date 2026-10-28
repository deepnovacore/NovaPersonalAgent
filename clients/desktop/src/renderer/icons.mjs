// Compatibility facade for the renderer's icon API.
//
// The artwork lives in icon-artwork.mjs and the hidden <svg> sprite in
// icon-sprite.mjs. Existing call sites keep importing iconNode/withIcon from
// here; new code can use icon(name, { size, weight }) or installIconSprite()
// directly when a page wants the sprite present at boot.
export {
  SPRITE_ATTRIBUTE,
  icon,
  iconNode,
  installIconSprite,
  withIcon,
} from './icon-sprite.mjs'

export {
  ICON_ARTWORK,
  ICON_EDGE,
  ICON_GLYPHS,
  ICON_STROKES,
  ICON_WEIGHTS,
  iconSymbolId,
  iconSymbolMarkup,
} from './icon-artwork.mjs'
