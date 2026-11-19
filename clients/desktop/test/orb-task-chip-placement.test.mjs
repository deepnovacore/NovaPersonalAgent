import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'

const css = await readFile(new URL('../src/renderer/index.css', import.meta.url), 'utf8')
const bannerCss = await readFile(new URL('../src/renderer/task-banner.css', import.meta.url), 'utf8')
const workbenchCss = await readFile(new URL('../src/renderer/workbench.css', import.meta.url), 'utf8')
const BASE = `body[data-presentation-mode='orb'] #personal-orb-host .personal-orb-extras`
const BUBBLES = `body[data-presentation-mode='orb'] #shell[data-bubbles='true'] #personal-orb-host .personal-orb-extras`
const STATE_LABEL = `#shell[data-bubbles='true'] #state-label`

const rule = selector => {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `missing rule: ${selector}`)
  return css.slice(start, css.indexOf('}', start))
}
const offsetOf = text => {
  const match = text.match(/top:\s*calc\(var\(--bubble-orb-y\)\s*\+\s*(\d+)px\)/)
  assert.ok(match, `expected a top offset relative to --bubble-orb-y in: ${text}`)
  return Number(match[1])
}

// Rendered heights in CSS px: chip is 10px/1.3 text + 3px padding x2 + 1px border x2; the status label is 11px/1.35 + 3px x2 + 1px x2.
const CHIP_HEIGHT = Math.ceil(10 * 1.3) + 6 + 2
const NOTICE_HEIGHT = Math.ceil(10 * 1.3)
const STATE_LABEL_HEIGHT = Math.ceil(11 * 1.35) + 6 + 2

test('in bubble mode the orb task chip is anchored to the orb, not to the window top edge where the bubble stack starts', () => {
  const bubbleRule = rule(BUBBLES)
  assert.doesNotMatch(bubbleRule, /top:\s*6px/, 'top:6px is inside the first bubble row when bubbles sit above the orb')
  const stackGap = Number(css.match(/#bubble-stack\[data-placement='above'\] \{ inset: auto 0 calc\(100% - var\(--bubble-orb-y\) \+ (\d+)px\)/)?.[1])
  assert.ok(Number.isFinite(stackGap), 'the above-placed stack bottom is orbY - gap')
  const chipTop = offsetOf(bubbleRule)
  assert.ok(chipTop > -stackGap, `chip top (orbY+${chipTop}) must be below the stack bottom (orbY-${stackGap})`)
  assert.match(css.slice(css.indexOf(BASE)), /top:\s*6px/, 'the collapsed orb without bubbles keeps the top-edge slot')
  assert.ok(css.indexOf(BUBBLES) > css.indexOf(BASE), 'the bubble rule must follow the base rule in the cascade')
})

test('the bubble-mode chip slot clears the orb status label and the task banner', () => {
  const chipTop = offsetOf(rule(BUBBLES))
  const labelTop = offsetOf(rule(STATE_LABEL))
  const bannerTop = Number(bannerCss.match(/top:\s*calc\(var\(--bubble-orb-y, 80px\)\s*\+\s*(\d+)px\)/)?.[1])
  assert.ok(Number.isFinite(bannerTop), 'task banner offset is derived from task-banner.css')
  assert.ok(chipTop >= labelTop + STATE_LABEL_HEIGHT, `chip (orbY+${chipTop}) must start below the status label (ends orbY+${labelTop + STATE_LABEL_HEIGHT})`)
  assert.ok(chipTop + CHIP_HEIGHT + NOTICE_HEIGHT <= bannerTop, `chip plus one notice line (ends orbY+${chipTop + CHIP_HEIGHT + NOTICE_HEIGHT}) must end above the task banner (orbY+${bannerTop})`)
})

test('the bubble-mode chip follows the orb horizontally so left, center and right alignment all stay inside the window', () => {
  const bubbleRule = rule(BUBBLES)
  assert.match(bubbleRule, /left:\s*var\(--bubble-orb-x\)/)
  assert.match(bubbleRule, /right:\s*auto/)
  assert.match(bubbleRule, /transform:\s*translateX\(-50%\)/)
  const maxWidth = Number(bubbleRule.match(/max-width:\s*(\d+)px/)?.[1])
  assert.ok(maxWidth <= 160, 'main keeps the orb 80 CSS px from either window side, so half the chip width must not exceed 80')
})

test('placement below only happens during a confirmation, and the chip is already hidden then', () => {
  assert.ok(workbenchCss.includes('#shell:has(#codex-label[data-mode="confirmation"]) .personal-orb-task{display:none}'))
})
