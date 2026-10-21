import assert from 'node:assert/strict'
import {mkdtemp,readFile,readdir,stat,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {test} from 'node:test'
import {WorkbenchStore,emptyWorkbenchCheckpoint} from '../src/personal-agent/workbench-store.js'
import type {ToolImage} from '../src/personal-agent/computer-use/contract.js'

const image:ToolImage={media_type:'image/png',data_base64:'aGVsbG8=',width:100,height:80,captured_at:'2026-10-21T00:00:00Z'}
test('screenshots are private scoped files and checkpoint journals contain refs only', {timeout:5000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'workbench-images-'))
 try {
  const store=new WorkbenchStore(root),ref=await store.saveImage('build',0,image)
  assert.deepEqual(await store.loadImage('build',0,ref),image)
  await assert.rejects(store.loadImage('other',0,ref))
  await assert.rejects(store.loadImage('build',0,'../../outside'))
  const state=emptyWorkbenchCheckpoint('build',0)
  state.inputs=[{kind:'tool_result',call_id:'screen',output:{ok:true},images:[image]}]
  state.model={protocol:'chat-completions',history:[[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}}]}]],pending:null}
  await store.saveCheckpoint(state)
  const imageDir=(await readdir(root)).find(name=>name.startsWith('images-'))!
  assert.equal((await readFile(join(root,imageDir,ref))).toString(),'hello')
  if(process.platform!=='win32'){
   assert.equal((await stat(join(root,imageDir,ref))).mode&0o777,0o600)
   assert.equal((await stat(join(root,imageDir))).mode&0o777,0o700)
  }
  const file=(await readdir(root)).find(name=>name.startsWith('build-'))!
  const journal=await readFile(join(root,file),'utf8')
  assert.doesNotMatch(journal,/aGVsbG8=/u)
  assert.match(journal,/image_ref/u)
  assert.deepEqual((await store.checkpoint('build',0)).inputs,state.inputs)
  assert.deepEqual((await store.checkpoint('build',0)).model,state.model)
  assert.doesNotMatch((await store.detail('build',0)).text,/aGVsbG8=/u)
  if(process.platform!=='win32')assert.equal((await stat(join(root,file))).mode&0o777,0o600)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('concurrent checkpoint saves preserve invocation order while externalizing images', {timeout:5000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'workbench-images-order-'))
 try{
  const store=new WorkbenchStore(root),first=emptyWorkbenchCheckpoint('build',0),last=emptyWorkbenchCheckpoint('build',0)
  first.inputs=[{kind:'tool_result',call_id:'screen',output:{ok:true},images:[image]}]
  last.assistant='latest'
  await Promise.all([store.saveCheckpoint(first),store.saveCheckpoint(last)])
  assert.equal((await store.checkpoint('build',0)).assistant,'latest')
 }finally{await rm(root,{recursive:true,force:true})}
})
test('checkpoint and detail readers cannot overtake screenshot persistence', {timeout:5000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'workbench-images-read-'))
 try{
  const writer=new WorkbenchStore(root),reader=new WorkbenchStore(root),state=emptyWorkbenchCheckpoint('build',0)
  await writer.saveCheckpoint(state)
  state.run_version=1
  state.inputs=[{kind:'tool_result',call_id:'screen',output:{ok:true},images:[image]}]
  const save=writer.saveCheckpoint(state)
  const checkpoint=reader.checkpoint('build',0),detail=reader.detail('build',0)
  assert.equal((await checkpoint).run_version,1)
  assert.equal((JSON.parse((await detail).text) as {run_version:number}).run_version,1)
  await save
 }finally{await rm(root,{recursive:true,force:true})}
})

test('call paging exposes screenshot refs without opening screenshot files', {timeout:5000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'workbench-images-page-'))
 try{
  const store=new WorkbenchStore(root),state=emptyWorkbenchCheckpoint('build',0)
  state.calls=[{id:'screen',name:'computer_screenshot',arguments:{},state:'completed',result:{nested:{frame:{...image}}}}]
  await store.saveCheckpoint(state)
  const dir=(await readdir(root)).find(name=>name.startsWith('images-'))!
  await rm(join(root,dir),{recursive:true})
  const page=await store.calls('build',0)
  assert.match(page.items[0]!.image_ref??'',/^[a-f0-9]{64}\.png$/u)
  assert.doesNotMatch(JSON.stringify(page),/aGVsbG8=/u)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('UI thumbnail is JPEG at most 480 pixels and 200 KB including base64', {timeout:10000},async()=>{
 const {default:sharp}=await import('sharp')
 const {randomBytes}=await import('node:crypto')
 const root=await mkdtemp(join(tmpdir(),'workbench-thumbnail-'))
 try{
  const store=new WorkbenchStore(root),png=await sharp(randomBytes(1280*720*3),{raw:{width:1280,height:720,channels:3}}).png().toBuffer()
  const source={...image,width:1280,height:720,data_base64:png.toString('base64')}
  const ref=await store.saveImage('build',0,source),thumbnail=await store.thumbnail('build',0,ref)
  assert.equal(thumbnail.media_type,'image/jpeg');assert.equal(thumbnail.captured_at,image.captured_at)
  assert.ok(Math.max(thumbnail.width,thumbnail.height)<=480)
  assert.ok(Buffer.byteLength(JSON.stringify(thumbnail))<=200_000)
  const metadata=await sharp(Buffer.from(thumbnail.data_base64,'base64')).metadata()
  assert.equal(metadata.format,'jpeg');assert.equal(metadata.width,thumbnail.width);assert.equal(metadata.height,thumbnail.height)
 }finally{await rm(root,{recursive:true,force:true})}
})
