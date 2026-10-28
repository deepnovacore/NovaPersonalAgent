import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile} from 'node:fs/promises'

const css=await readFile(new URL('../src/renderer/workbench.css',import.meta.url),'utf8')
const rule=selector=>{
 const matches=[...css.matchAll(new RegExp('\\'+selector+'\\{([^}]*)\\}','g'))]
 assert.ok(matches.length,`missing rule ${selector}`)
 return matches.map(match=>match[1]).sort((a,b)=>b.length-a.length)[0]
}

test('the workspace bar and approval dock align with the composer instead of touching the window edges',()=>{
 const bar=rule('.workspace-bar'),dock=rule('.approval-dock')
 assert.match(bar,/margin:0 8px 6px/)
 assert.match(dock,/margin:0 8px 8px/)
 assert.match(css,/\.workspace-bar\{margin:0 12px 6px\}/)
 assert.match(css,/\.approval-dock\{margin:0 12px 8px\}/)
 assert.match(css,/\.workspace-bar\{margin:0 16px 6px\}/)
 assert.match(css,/\.approval-dock\{margin:0 16px 8px\}/)
})

test('the 3px accent border stays inside the approval card itself',()=>{
 const card=rule('.approval-dock-card')
 assert.match(card,/padding:10px 12px/)
 assert.match(card,/border-left:3px solid var\(--accent\)/)
 assert.match(card,/border-radius:8px/)
})

test('the executor float is centered on the window, bounded, and carries a phase dot',()=>{
 const root=rule('.executor-float')
 assert.match(root,/position:fixed/)
 assert.match(root,/left:50vw/)
 assert.match(root,/top:50vh/)
 assert.match(root,/transform:translate\(-50%,-50%\)/)
 assert.match(root,/max-width:min\(320px,calc\(100vw - 32px\)\)/)
 assert.doesNotMatch(root,/right:12px/,'a fixed right edge let the collapsed width pick an arbitrary left edge')
 const pill=rule('.executor-float-pill')
 assert.match(pill,/border-radius:999px/)
 assert.match(pill,/display:flex/)
 assert.match(pill,/pointer-events:auto/)
 assert.match(css,/\.executor-float\[data-expanded="true"\]\{[^}]*padding:8px;[^}]*background:var\(--surface-raised\)/u)
 assert.match(css,/\.executor-float\[data-phase="working"\] \.executor-float-phase\{background:var\(--accent\)\}/u)
 assert.match(css,/\.executor-float\[data-phase="failed"\] \.executor-float-phase,[^{]*\{background:var\(--warn\)\}/u)
})
