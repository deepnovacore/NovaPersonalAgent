import assert from 'node:assert/strict'
import test from 'node:test'

import {configureWorkbenchNativeDrag} from '../src/main/workbench-drag.mjs'
import {createWorkbenchFrame} from '../src/main/workbench-frame.mjs'

function setup() {
  const initial = {x:100, y:80, width:800, height:600}
  const area = {x:0, y:0, width:1440, height:900}
  const state = {bounds:{...initial}, collapsed:false}
  const hooks = new Map(), events = new Map()
  const frame = createWorkbenchFrame({
    getBounds: () => ({...state.bounds}),
    setBounds: bounds => { state.bounds = {...bounds} },
    getWorkArea: () => area,
  })
  configureWorkbenchNativeDrag({
    window: {
      hookWindowMessage: (message, listener) => hooks.set(message, listener),
      on: (event, listener) => events.set(event, listener),
    },
    platform: 'win32',
    isCollapsed: () => state.collapsed,
    frame,
  })
  return {
    initial, area, state, frame,
    doubleClick(hitTest=2) {
      const value = Buffer.alloc(8)
      value.writeUInt32LE(hitTest)
      hooks.get(0x00a3)(value)
    },
    movePrevented() {
      let prevented = false
      events.get('will-move')({preventDefault: () => { prevented = true }})
      return prevented
    },
  }
}

test('native titlebar double-click maximizes and restores the workbench', {skip:process.platform!=='win32'}, () => {
  const {state, frame, area, initial, doubleClick} = setup()
  doubleClick()
  assert.deepEqual(state.bounds, area)
  assert.equal(frame.maximized, true)
  doubleClick()
  assert.deepEqual(state.bounds, initial)
  assert.equal(frame.maximized, false)
})

test('native double-clicks on controls and the collapsed orb leave bounds alone', {skip:process.platform!=='win32'}, () => {
  const {state, initial, doubleClick} = setup()
  for (const hitTest of [1, 10, 12, 20]) doubleClick(hitTest)
  assert.deepEqual(state.bounds, initial)
  state.collapsed = true
  doubleClick()
  assert.deepEqual(state.bounds, initial)
})

test('native moves stay enabled except while the workbench fills the work area', {skip:process.platform!=='win32'}, () => {
  const {state, initial, doubleClick, movePrevented} = setup()
  assert.equal(movePrevented(), false)
  doubleClick()
  assert.equal(movePrevented(), true)
  state.collapsed = true
  assert.equal(movePrevented(), false)
  state.collapsed = false
  doubleClick()
  assert.equal(movePrevented(), false)
  state.bounds = {...initial, width:900}
  doubleClick()
  state.bounds = {...initial, width:1000}
  assert.equal(movePrevented(), false)
})

test('macOS and Linux keep their existing window drag handling', () => {
  for (const platform of ['darwin', 'linux']) {
    configureWorkbenchNativeDrag({
      platform,
      window: new Proxy({}, {get() { assert.fail('native hooks must be Windows-only') }}),
    })
  }
})
