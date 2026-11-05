import {t} from './locale.mjs'
// The panel's page-level navigation, kept DOM-free so the category table and
// its keyboard mapping stay unit-testable. Category membership lives here and
// never as markup attributes: the section tags themselves carry contract-pinned
// text that additive attributes would disturb.
export const SETTINGS_CATEGORIES = Object.freeze([
  Object.freeze({id: 'general', label: t("通用"), sections: Object.freeze([
    'language-section', 'startup-view-section', 'wake-word-section', 'notifications-section',
    'intent-section', 'proactivity-section', 'display-section',
  ])}),
  Object.freeze({id: 'diary', label: t('简报'), sections: Object.freeze(['diary-section'])}),
  Object.freeze({id: 'themes', label: t("主题"), sections: Object.freeze(['visor-section','orb-skin-section'])}),
  Object.freeze({id: 'usage', label: t("用量"), sections: Object.freeze(['frontend-usage-section'])}),
  Object.freeze({id: 'secrets', label: t("API 密钥"), sections: Object.freeze(['chatgpt-settings','secrets'])}),
  Object.freeze({id: 'models', label: t("模型"), sections: Object.freeze(['models-section','pipeline'])}),
  Object.freeze({id: 'skills', label: t('技能'), sections: Object.freeze(['skills-section'])}),
  // 执行器 owns the vision and coding sub-tabs; the coding page keeps the executor
  // configuration and workspace cards, so both sections belong to this category.
  Object.freeze({id: 'capabilities', label: t("执行器"), sections: Object.freeze(['capabilities-section','codex-projects'])}),
  Object.freeze({id: 'mcp', label: t("MCP"), sections: Object.freeze(['mcp-section'])}),
  Object.freeze({id: 'connectors', label: t("连接器"), sections: Object.freeze(['im-section','connections-section'])}),
  Object.freeze({id: 'space', label: t("设备"), sections: Object.freeze([])}),
  Object.freeze({id: 'permissions', label: t("权限"), sections: Object.freeze(['desktop-permissions-section','codex-approval-section'])}),
  Object.freeze({id: 'privacy', label: t("隐私与数据"), sections: Object.freeze(['privacy-section'])}),
  Object.freeze({id: 'knowledge', label: t("知识库"), sections: Object.freeze(['knowledge-section'])}),
])

/** Old deep links keep working after the settings categories were split. */
const CATEGORY_ALIASES = Object.freeze({
  im: 'connectors',
  hub: 'space',
  phone: 'space',
  connections: 'connectors',
  pipeline: 'models',
  codex: 'capabilities',
})

export function categoryIds() {
  return SETTINGS_CATEGORIES.map(category => category.id)
}

export function resolveCategory(id) {
  return CATEGORY_ALIASES[id] ?? id
}

export function isValidCategory(id) {
  return categoryIds().includes(resolveCategory(id))
}

/** Every section owned by any category, so a caller can hide the panel in one pass. */
export function categorySectionIds() {
  return SETTINGS_CATEGORIES.flatMap(category => category.sections)
}

/**
 * Roving-focus mapping for the vertical sidebar. Deliberately separate from
 * the removed channel-tabs board, which was horizontal and fixed at
 * two tabs; null means the key is not a navigation key and must pass through.
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
