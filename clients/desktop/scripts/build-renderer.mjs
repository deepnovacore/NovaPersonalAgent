import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {cp, mkdir, readFile, readdir, writeFile} from 'node:fs/promises'
import {resolve, relative, sep} from 'node:path'
import {pathToFileURL} from 'node:url'

const desktopRoot=resolve(import.meta.dirname,'..')
const sourceRoot=resolve(desktopRoot,'src/renderer')
export const rendererEntries=Object.freeze({
 index:'main.tsx',settings:'entries/settings.tsx',setup:'entries/setup.tsx',
 visor:'entries/visor.tsx','visor-controls':'entries/visor-controls.tsx',
 'computer-bar':'entries/computer-bar.tsx','computer-edge':'entries/computer-edge.tsx',
 'memory-board':'entries/memory-board.tsx','release-camera':'entries/release-camera.tsx',
})
const titles={index:'Nova Personal Agent Desktop',settings:'设置 · Nova',setup:'开始使用 · Nova','memory-board':'记忆 · Nova',visor:'Nova Visor'}
const css={index:['controls.css','index.css','task-banner.css','workbench.css','welcome.css'],settings:['controls.css','settings.css','skills.css'],setup:['controls.css','setup.css'],visor:['visor.css'],'visor-controls':['controls.css','visor-controls.css'],'computer-bar':['computer-overlay.css'],'computer-edge':['computer-overlay.css'],'memory-board':['controls.css','memory-board.css'],'release-camera':[]}
export async function buildRenderer({outputRoot=process.env.NOVA_DESKTOP_RENDERER_OUTPUT_ROOT, sourcemap=false}={}){
 assert.ok(outputRoot,'Set NOVA_DESKTOP_RENDERER_OUTPUT_ROOT or pass --outdir to an isolated external build directory')
 const out=resolve(outputRoot),path=relative(sourceRoot,out)
 assert.ok(path.startsWith('..'+sep)||path==='..','Renderer output must be outside the source directory')
 await mkdir(out,{recursive:true})
 // Retain local static files at their original URLs, including worklets and idle media.
 for(const file of await readdir(sourceRoot,{withFileTypes:true})){
  if(file.name==='assets'||file.name.endsWith('.css'))await cp(resolve(sourceRoot,file.name),resolve(out,file.name),{recursive:true})
 }
 const result=await build({
  absWorkingDir:desktopRoot,
  entryPoints:Object.fromEntries(Object.entries(rendererEntries).map(([key,file])=>[key,resolve(sourceRoot,'react',file)])),
  outdir:out,entryNames:'react/[name]',chunkNames:'chunks/[name]-[hash]',assetNames:'assets/[name]-[hash]',
  bundle:true,splitting:true,format:'esm',platform:'browser',target:'chrome140',jsx:'automatic',
  outExtension:{'.js':'.mjs'},loader:{'.mp4':'file','.png':'file','.woff2':'file'},
  define:{'process.env.NODE_ENV':'"production"'},sourcemap,metafile:true,logLevel:'warning',
 })
 // AudioWorklet has its own global scope and URL; bundle it separately without React/shared chunks.
 const worklet=await build({entryPoints:[resolve(sourceRoot,'capture-worklet.mjs')],outfile:resolve(out,'capture-worklet.mjs'),bundle:true,format:'esm',platform:'browser',target:'chrome140',metafile:true,logLevel:'warning'})
 Object.assign(result.metafile.inputs,worklet.metafile.inputs);Object.assign(result.metafile.outputs,worklet.metafile.outputs)
 for(const [name] of Object.entries(rendererEntries)){
  const styleLinks=[`react/${name}.css`,...(css[name]??[])].map(file=>`<link rel="stylesheet" href="./${file}">`).join('\n')+(name==='index'?'\n<link rel="prefetch" href="./assets/nova-idle.mp4">':'')
  const policy="default-src 'self'; script-src 'self'; style-src 'self'; connect-src ws://127.0.0.1:*; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'"
  const html=`<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>${titles[name]??'Nova'}</title>${styleLinks}\n<link rel="stylesheet" href="./theme.css"></head><body class="nova-window-${name}${name==='computer-bar'?' computer-bar-page':name==='computer-edge'?' computer-edge-page':''}"><div id="root"></div><script type="module" src="./react/${name}.mjs"></script></body></html>\n`
  await writeFile(resolve(out,`${name}.html`),html)
 }
 await cp(resolve(sourceRoot,'react/theme.css'),resolve(out,'theme.css'))
 await writeFile(resolve(out,'renderer-manifest.json'),JSON.stringify({version:1,entries:Object.keys(rendererEntries),outputs:Object.keys(result.metafile.outputs)},null,2)+'\n')
 return {outputRoot:out,metafile:result.metafile}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const index=process.argv.indexOf('--outdir'),outputRoot=index===-1?process.env.NOVA_DESKTOP_RENDERER_OUTPUT_ROOT:process.argv[index+1]
 const result=await buildRenderer({outputRoot,sourcemap:process.argv.includes('--sourcemap')})
 console.log(`React renderer built: ${result.outputRoot}`)
}
