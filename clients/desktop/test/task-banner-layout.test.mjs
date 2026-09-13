import assert from 'node:assert/strict'
import test from 'node:test'
import {createTaskAreaReservation} from '../src/renderer/task-banner-layout.mjs'
import {bubbleWindowLayout} from '../src/main/window-position.mjs'

test('cards reserve below the orb independently of chat bubbles', async () => {
  const reservations = []
  const area = createTaskAreaReservation({reserve: async (rows, taskRows) => {reservations.push([rows, taskRows]); return {rows, taskHeightCss: taskRows * 96 + 64}}, onLayout() {}})
  await area.reserveBanner(3)
  await area.reserveProgress(2)
  await area.reserveBanner(5)
  await area.reserveProgress(0)
  assert.deepEqual(reservations, [[0,3],[2,3],[2,5],[0,5]])
})

test('task cards remain below status and workspace at screen edges and zoom', () => {
  for (const zoomFactor of [1, 1.5]) for (const rows of [0, 3]) for (const y of [0, 700]) {
    const layout = bubbleWindowLayout({normalBounds: {x: 900, y, width: 160, height: 160}, rows, taskRows: 3, zoomFactor, scaleFactor: 2, workArea: {x: 0,y: 0,width: 1200,height: 900}})
    assert.equal(layout.suppressed, false)
    assert.ok(layout.taskHeightCss >= 128)
    assert.ok(layout.bounds.y >= 0 && layout.bounds.y + layout.bounds.height <= 900)
    assert.ok(layout.orbOffsetCssY + 125 + layout.taskHeightCss <= layout.bounds.height / zoomFactor + 1)
  }
})
