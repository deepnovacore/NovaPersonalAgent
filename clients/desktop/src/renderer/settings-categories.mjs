// The panel's page-level navigation, kept DOM-free so the category table and
// its keyboard mapping stay unit-testable. Category membership lives here and
// never as markup attributes: the section tags themselves carry contract-pinned
// text that additive attributes would disturb.
export const SETTINGS_CATEGORIES = Object.freeze([
  Object.freeze({id: 'general', label: '通用', sections: Object.freeze([
    'wake-word-section', 'appearance-section', 'notifications-section',
    'intent-section', 'proactivity-section', 'frontend-usage-section',
  ])}),
  Object.freeze({id: 'pipeline', label: '语音管线', sections: Object.freeze(['pipeline'])}),
  Object.freeze({id: 'capabilities', label: '能力与 MCP', sections: Object.freeze(['capabilities-section'])}),
  Object.freeze({id: 'knowledge', label: '知识库', sections: Object.freeze(['knowledge-section'])}),
  Object.freeze({id: 'secrets', label: 'API 密钥', sections: Object.freeze(['secrets'])}),
  Object.freeze({id: 'phone', label: '连接 iPhone', sections: Object.freeze(['phone-connection-section'])}),
  Object.freeze({id: 'codex', label: 'Coding 执行器与工作区', sections: Object.freeze([
    'codex-approval-section', 'codex-projects',
  ])}),
])

export function categoryIds() {
  return SETTINGS_CATEGORIES.map(category => category.id)
}

export function isValidCategory(id) {
  return categoryIds().includes(id)
}

/** Every section owned by any category, so a caller can hide the panel in one pass. */
export function categorySectionIds() {
  return SETTINGS_CATEGORIES.flatMap(category => category.sections)
}

/**
 * Roving-focus mapping for the vertical sidebar. Deliberately separate from
 * workspace-graph-board.mjs's boardTabForKey, which is horizontal and fixed at
 * three tabs; null means the key is not a navigation key and must pass through.
 */
export function categoryTabForKey(activeCategory, key) {
  const ids = categoryIds()
  if (key === 'Home') return ids[0]
  if (key === 'End') return ids[ids.length - 1]
  const current = ids.indexOf(activeCategory)
  if (current === -1) return null
  if (key === 'ArrowUp' || key === 'ArrowLeft') return ids[(current + ids.length - 1) % ids.length]
  if (key === 'ArrowDown' || key === 'ArrowRight') return ids[(current + 1) % ids.length]
  return null
}
