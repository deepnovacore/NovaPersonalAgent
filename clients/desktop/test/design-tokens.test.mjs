import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'

const read = name => readFile(new URL(`../src/renderer/${name}`, import.meta.url), 'utf8')
const [tokens, indexHtml, indexCss, workbenchCss, settingsCss, welcomeCss, controlsCss] = await Promise.all([
  'design-tokens.css', 'index.html', 'index.css', 'workbench.css', 'settings.css', 'welcome.css', 'controls.css',
].map(read))

const pxRadii = css => [...css.matchAll(/border-radius:\s*([^;}\n]+)/gu)]
  .flatMap(([, value]) => [...value.matchAll(/(?<![\d.])(\d+)px/gu)].map(([, px]) => Number(px)))

test('one token file owns spacing, radius, elevation, type, control and focus geometry', () => {
  assert.match(tokens, /--space-1:\s*4px;/)
  assert.match(tokens, /--space-6:\s*24px;/)
  for (const [name, value] of [
    ['--radius-xs', '4px'], ['--radius-sm', '6px'], ['--radius-md', '8px'],
    ['--radius-lg', '10px'], ['--radius-xl', '12px'], ['--radius-pill', '999px'],
  ]) assert.match(tokens, new RegExp(`${name}:\\s*${value};`), name)
  assert.match(tokens, /--shadow-1:/)
  assert.match(tokens, /--shadow-3:/)
  assert.match(tokens, /--font-sans:/)
  assert.match(tokens, /--font-mono:/)
  assert.match(tokens, /--text-md:\s*13px;/)
  assert.match(tokens, /--leading-normal:\s*1\.6;/)
  assert.match(tokens, /--control-height-lg:\s*36px;/)
  assert.match(tokens, /--focus-ring-width:\s*2px;/)
  assert.match(tokens, /--focus-ring-offset:\s*2px;/)
  // The contrast path stays: a stronger ring is a system preference, not a page choice.
  assert.match(tokens, /@media \(prefers-contrast: more\) \{[\s\S]*?--focus-ring-width:\s*3px/)
})

test('both settings and workbench load the token file instead of re-declaring geometry', () => {
  const tokenLink = indexHtml.indexOf('<link rel="stylesheet" href="./design-tokens.css">')
  const ownLink = indexHtml.indexOf('<link rel="stylesheet" href="./index.css">')
  assert.ok(tokenLink >= 0, 'index.html links design-tokens.css')
  assert.ok(ownLink > tokenLink, 'tokens load before the orb stylesheet')
  assert.match(indexHtml, /href="\.\/controls\.css">\s*<link rel="stylesheet" href="\.\/design-tokens\.css">/)
  // settings.html is owned by the icon work, so the settings page pulls the
  // tokens through its own stylesheet instead of a new <link>.
  assert.match(settingsCss, /^@import "\.\/design-tokens\.css";\n/)
  assert.match(workbenchCss, /--radius:var\(--radius-md\);--radius-sm:var\(--radius-xs\);--radius-window:var\(--radius-xl\)/)
  assert.match(workbenchCss, /--font:var\(--font-sans\);\n --mono:var\(--font-mono\)/)
  // The spacing scale is consumed, not just declared.
  assert.match(workbenchCss, /padding:var\(--space-6\) var\(--space-6\) var\(--space-8\)/)
  assert.match(settingsCss, /margin: 0 0 var\(--space-3\);\n  padding: var\(--space-4\)/)
})

test('content surfaces are flat: no content gradients, no white inset highlights, no hover elevation', () => {
  assert.doesNotMatch(workbenchCss, /linear-gradient/, 'workbench content carries no gradient')
  assert.doesNotMatch(indexCss, /radial-gradient/, 'the orb page draws its depth in canvas, not CSS')
  assert.doesNotMatch(settingsCss, /gradient/, 'settings surfaces are flat')
  assert.doesNotMatch(welcomeCss, /gradient/, 'welcome hero and permission rows are flat')
  for (const css of [workbenchCss, settingsCss]) {
    assert.doesNotMatch(css, /inset[^;{}]*rgba\(\s*255,\s*255,\s*255/, 'no inset white bevel remains')
  }
  assert.doesNotMatch(workbenchCss, /:hover[^{};]*\{[^}]*box-shadow/, 'hover changes the border, never the elevation')
  assert.match(workbenchCss, /\.workbench \.card:hover,[^{]*\{border-color:var\(--line-strong\)\}/)
  assert.match(workbenchCss, /\.timeline-card:hover\{border-color:[^};]*\}/)
  assert.match(workbenchCss, /\.nova-column\{[^}]*background:var\(--surface\)/)
  assert.match(workbenchCss, /\.workbench-plan-actions button\[data-primary="true"\]\{[^}]*background:var\(--accent\)/)
  assert.doesNotMatch(workbenchCss, /\.workbench-plan-actions button\[data-primary="true"\]\{[^}]*gradient/)
})

test('card and panel radii stay at or below 12px in both settings and workbench', () => {
  assert.deepEqual(pxRadii(workbenchCss).filter(px => px > 12 && px < 100), [])
  assert.deepEqual(pxRadii(settingsCss).filter(px => px > 12 && px < 100), [])
  // The two intentional exceptions are not cards: the opaque orb window plate
  // and the identity portrait tile keep their brand rounding.
  assert.ok(pxRadii(indexCss).includes(24), 'the opaque window plate keeps its 24px corner')
  assert.ok(pxRadii(welcomeCss).includes(26), 'the identity portrait keeps its 26px tile')
})

test('the settings rail marks the current category with an accent wash and a 3px bar', () => {
  assert.match(settingsCss, /--nav-active:\s*var\(--accent-wash\)/)
  assert.match(settingsCss, /\.settings-nav \.nav-item\[aria-current="true"\] \{[^}]*background:\s*var\(--nav-active\)/)
  assert.match(settingsCss, /\.settings-nav \.nav-item\[aria-current="true"\]::after \{[^}]*width:\s*3px;[^}]*background:\s*var\(--accent\)/s)
  assert.match(settingsCss, /\.settings-nav \.nav-item\[aria-current="true"\] \{[^}]*color:\s*var\(--accent-strong\)/)
})

test('inputs, buttons and selects land on one control height per page and share one focus ring', () => {
  // settings: the controls.css 36px select height, matched by inputs and buttons.
  assert.match(controlsCss, /--control-height:\s*36px/)
  assert.match(settingsCss, /min-height:\s*var\(--control-height-lg\)/)
  assert.match(settingsCss, /button \{ min-height: var\(--control-height-lg\);/)
  // workbench: a dense 32px row, with the select following the same token.
  assert.match(workbenchCss, /--control-height:var\(--control-height-md\);--control-radius:var\(--radius-xs\)/)
  assert.match(workbenchCss, /\.workbench button\{[^}]*line-height:20px\}/)
  assert.match(workbenchCss, /\.workbench textarea,\.workbench input:not\(\[type=checkbox\]\):not\(\[type=radio\]\)\{[^}]*line-height:18px/)
  for (const css of [workbenchCss, settingsCss]) {
    assert.match(css, /outline: ?var\(--focus-ring-width\) solid var\(--accent\)/)
    assert.doesNotMatch(css, /outline: ?2px solid var\(--accent\)/, 'focus ring width comes from the token')
  }
})

test('the restrained pass keeps dark, forced-colors and reduced-motion paths intact', () => {
  assert.match(workbenchCss, /@media\(prefers-reduced-motion:reduce\)\{\.workbench \*/)
  assert.match(workbenchCss, /@media\(forced-colors:active\)\{\.workbench \.message-avatar/)
  assert.match(settingsCss, /@media \(forced-colors: active\)/)
  assert.match(settingsCss, /@media \(prefers-contrast: more\)/)
  assert.match(indexCss, /@media \(prefers-contrast: more\)/)
  assert.match(welcomeCss, /@media\(prefers-reduced-motion:reduce\)\{\.welcome-spinner/)
  // Brand orb geometry stays the orb page's own.
  assert.match(indexCss, /#orb \{[\s\S]*?width:\s*98px/)
  assert.match(indexCss, /#codex-label\[data-mode='confirmation'\] \{[\s\S]*?border-radius:\s*999px;/)
})

test('the chat tool trace contract is styled flat with semantic state dots', () => {
  assert.match(workbenchCss, /\.chat-tool-trace\{[^}]*border-radius:var\(--radius-lg\)/)
  assert.match(workbenchCss, /\.chat-tool-trace-dot\[data-state="running"\],[^{]*\{background:var\(--warn\)\}/)
  assert.match(workbenchCss, /\[data-state="ok"\][^{]*\{background:var\(--ok\)\}/)
  assert.match(workbenchCss, /\[data-state="error"\][^{]*\{background:var\(--warn\)\}/)
  assert.match(workbenchCss, /\.chat-tool-trace-summary\{[^}]*font:500 11px\/1\.5 var\(--mono\)/)
  assert.match(workbenchCss, /@media\(prefers-reduced-motion:no-preference\)\{\.chat-tool-trace\[data-live="true"\]/)
})
