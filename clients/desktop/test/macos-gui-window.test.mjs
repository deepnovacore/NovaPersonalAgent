import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

test('window discovery tolerates missing AX focus while ownership stays process/window bound', {skip:process.platform!=='darwin'}, t => {
  const root=mkdtempSync(join(tmpdir(),'nova-gui-window-test-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const harness=join(root,'main.swift'),binary=join(root,'test')
  writeFileSync(harness,`
func check(_ condition: Bool, _ message: String) {
    if !condition { print(message); exit(1) }
}
import Darwin
check(selectedGUIWindow(focused: nil, main: 8, visible: [8]) == 8, "missing focus must use valid main window")
check(selectedGUIWindow(focused: 99, main: 8, visible: [8,9]) == 8, "stale focus must use valid main")
check(selectedGUIWindow(focused: 9, main: 8, visible: [8,9]) == 9, "valid focus wins")
check(selectedGUIWindow(focused: nil, main: nil, visible: [8,8]) == 8, "one distinct visible window")
check(selectedGUIWindow(focused: nil, main: nil, visible: [8,9]) == nil, "ambiguous windows fail closed")
check(selectedGUIWindow(focused: 8, main: 8, visible: []) == nil, "offscreen window refused")
let pids = [1: Int32(7), 2: 7, 3: 7, 4: 9, 5: 7, 6: 7]
let windows: [Int: UInt32] = [1: 8, 4: 9]
func owner(_ node: Int, links: [Int:Int] = [:], parents: [Int:Int] = [:]) -> UInt32? {
    owningGUIWindow(node, pid: 7, process: {pids[$0]}, windowID: {windows[$0]}, window: {links[$0]}, parent: {parents[$0]})
}
check(owner(1) == 8, "AXWindow itself owns the window")
check(owner(2, links: [2:1]) == 8, "explicit AXWindow link")
check(owner(3, parents: [3:2,2:1]) == 8, "parent-only element")
check(owner(3, parents: [3:4,4:1]) == nil, "cross-process parent refused")
check(owner(4, links: [4:1]) == nil, "cross-process starting element refused")
check(owner(3, links: [3:4], parents: [3:1]) == nil, "foreign explicit owner must not fall back")
check(owner(5, parents: [5:6,6:5]) == nil, "parent cycle refused")
let deep = Dictionary(uniqueKeysWithValues: (10...50).map {($0, $0+1)})
check(owningGUIWindow(10, pid: 7, process: {_ in 7}, windowID: {$0 == 51 ? 8 : nil}, window: {_ in nil}, parent: {deep[$0]}) == nil, "bounded parent walk")
var reads=0,pauses=0
check(confirmedGUIReadback({reads+=1;return reads==3},pause:{pauses+=1}), "asynchronous AX readback must settle without another write")
check(reads==3 && pauses==2, "only pending reads wait")
reads=0;pauses=0
check(!confirmedGUIReadback({reads+=1;return false},pause:{pauses+=1}), "nonmatching readback stays unconfirmed")
check(reads==50 && pauses==49, "readback wait is bounded")
enum Changed: Error {case target}
reads=0;pauses=0
var refused=false
do {_ = try confirmedGUIReadback({reads+=1;throw Changed.target},pause:{pauses+=1})}catch {refused=true}
check(refused && reads==1 && pauses==0, "target or editor change aborts immediately")
print("19 window/readback policy checks passed")
`)
  const build=spawnSync('/usr/bin/swiftc',['-module-cache-path',join(root,'cache'),fileURLToPath(new URL('../native/macos_gui_window.swift',import.meta.url)),harness,'-o',binary],{encoding:'utf8',timeout:180000})
  assert.equal(build.status,0,build.error?.message??build.stderr)
  const result=spawnSync(binary,[],{encoding:'utf8',timeout:10000})
  assert.equal(result.status,0,result.stdout+result.stderr)
})
