import {writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
export async function waitForNativeWorkbench(window){
 for(let attempt=0;attempt<60;attempt++){
  if(window&&!window.isDestroyed()&&await window.webContents.executeJavaScript("Boolean(document.querySelector('.rail-pages [data-page=\"todos\"]'))").catch(()=>false))return
  await new Promise(resolve=>setTimeout(resolve,250))
 }
 throw Error('acceptance_workbench_not_ready')
}
export async function captureNativeWorkbench(window,outputDirectory,tag='final'){
 if(!window||window.isDestroyed())throw Error('acceptance_native_window_missing')
 const js=source=>window.webContents.executeJavaScript(source)
 const shots=[],cards={todos:0,ideas:0}
 for(const page of ['todos','ideas','goals','feeds','tasks','profile']){
  const found=await js(`(()=>{const tab=document.querySelector('.rail-pages [data-page="${page}"]');if(!tab)return false;tab.click();return true})()`)
  if(!found)throw Error('acceptance_production_tab_missing')
  await new Promise(resolve=>setTimeout(resolve,250))
  if(page==='todos'||page==='ideas')cards[page]=await js("document.querySelectorAll('.workbench-suggestions > article.card').length")
  const path=resolve(outputDirectory,`${tag}-${page}.png`)
  writeFileSync(path,(await window.webContents.capturePage()).toPNG(),{mode:0o600});shots.push(path)
 }
 const expanded=await js("(()=>{const section=document.querySelector('details.memory-section');if(!section)return false;section.open=true;return true})()")
 if(!expanded)throw Error('acceptance_memory_detail_missing')
 await new Promise(resolve=>setTimeout(resolve,250))
 const path=resolve(outputDirectory,`${tag}-profile-memory.png`)
 writeFileSync(path,(await window.webContents.capturePage()).toPNG(),{mode:0o600});shots.push(path)
 return {screenshots:shots,dom_cards:cards}
}
