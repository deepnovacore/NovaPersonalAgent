import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, readFile, mkdir, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {buildRenderer, rendererEntries} from '../scripts/build-renderer.mjs'

test('renderer entry manifest covers every desktop window with stable URLs',()=>{
 assert.deepEqual(Object.keys(rendererEntries).sort(), ['computer-bar','computer-edge','index','memory-board','release-camera','settings','setup','visor','visor-controls'].sort())
})
test('renderer builder refuses the source tree and preserves unrelated output files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'nova-react-build-test-'))
 try {
  await writeFile(join(directory,'unrelated.txt'),'keep')
  await assert.rejects(buildRenderer({outputRoot:new URL('../src/renderer',import.meta.url).pathname}), /source|output/i)
  // Missing dependencies or component entry points must fail rather than serve a blank legacy fallback.
  assert.equal(await readFile(join(directory,'unrelated.txt'),'utf8'),'keep')
 } finally {await rm(directory,{recursive:true,force:true})}
})

test('complete built renderer graph includes the bundled capture worklet and only approved local media',async()=>{
 const {buildRendererAssetGraph}=await import('../src/main/app-protocol.mjs')
 const directory=await mkdtemp(join(tmpdir(),'nova-renderer-graph-'))
 try{
  await writeFile(join(directory,'unrelated.txt'),'keep')
  await buildRenderer({outputRoot:directory})
  const graph=await buildRendererAssetGraph(directory)
  assert.ok(graph.includes('/capture-worklet.mjs'))
  assert.ok(graph.includes('/react/index.mjs'))
  assert.ok(graph.includes('/react/settings.mjs'))
  assert.ok(graph.includes('/assets/nova-idle.mp4'))
  assert.ok(!graph.includes('/index.mjs'),'old DOM entry must not be reachable')
  assert.ok(!graph.includes('/personal-view.mjs'),'old DOM workbench must not be reachable')
  const capture=await readFile(join(directory,'capture-worklet.mjs'),'utf8')
  assert.ok(!/from ['"]\.\/audio\.mjs/.test(capture),'audio worklet must be self contained')
  const html=await readFile(join(directory,'index.html'),'utf8')
  assert.match(html,/script-src 'self'/);assert.doesNotMatch(html,/unsafe-eval|unsafe-inline|https:\/\//)
  assert.match(await readFile(join(directory,'settings.html'),'utf8'),/nova-window-settings/)
  assert.match(await readFile(join(directory,'computer-bar.html'),'utf8'),/computer-bar-page/)
  assert.equal(await readFile(join(directory,'unrelated.txt'),'utf8'),'keep')
 }finally{await rm(directory,{recursive:true,force:true})}
})

test('release camera graph is isolated to its bundled page dependencies',async()=>{
 const {buildRendererAssetGraph}=await import('../src/main/app-protocol.mjs')
 const files=new Map([['/release-camera.html','<script src="./react/release-camera.mjs"></script><link href="./react/release-camera.css">'],['/react/release-camera.mjs','import "../chunks/camera.mjs"'],['/react/release-camera.css',''],['/chunks/camera.mjs','export const camera=true']])
 const graph=await buildRendererAssetGraph('/fixture',path=>{const route=path.slice('/fixture'.length);assert.ok(files.has(route),`unrelated entry read: ${route}`);return files.get(route)},['/release-camera.html'])
 assert.deepEqual(graph,[...files.keys()].sort())
})
test('packaged desktop includes compiled renderer files at the path loaded by main',async()=>{
 const config=await readFile(new URL('../electron-builder.yml',import.meta.url),'utf8')
 assert.match(config,/^  - build\/renderer\/\*\*\/\*/m)
})
