import assert from 'node:assert/strict'
import test from 'node:test'
import {createTaskAreaReservation} from '../src/renderer/task-banner-layout.mjs'
import {bubbleWindowLayout} from '../src/main/window-position.mjs'

test('cards reserve below the orb independently of chat bubbles', async () => {
  const reservations = []
  const area = createTaskAreaReservation({reserve: async (rows, taskRows) => {reservations.push([rows, taskRows]); return {rows, taskHeightCss: taskRows * 72 + 30}}, onLayout() {}})
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

test('one, two and five compact rows reserve exactly their content and fit display edges', () => {
  for (const taskRows of [1, 2, 5]) for (const zoomFactor of [.8, 1, 1.5, 2]) for (const scaleFactor of [1, 2]) {
    for (const x of [-1920, -160]) for (const y of [24, 1700]) {
      const layout = bubbleWindowLayout({normalBounds: {x, y, width: 160, height: 160}, rows: 0,
        taskRows, zoomFactor, scaleFactor, workArea: {x: -1920, y: 24, width: 1920, height: 1800}})
      assert.equal(layout.taskHeightCss, 30 + 72 * taskRows)
      assert.equal(layout.bounds.width, Math.ceil(332 * zoomFactor))
      assert.ok(Math.abs(layout.bounds.height / zoomFactor - (180 + 30 + 72 * taskRows)) <= 2)
      assert.ok(layout.bounds.x >= -1920 && layout.bounds.x + layout.bounds.width <= 0)
      assert.ok(layout.bounds.y >= 24 && layout.bounds.y + layout.bounds.height <= 1824)
    }
  }
})
