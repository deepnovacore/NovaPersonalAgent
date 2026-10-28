import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp, mkdir, readFile, realpath, rm, symlink} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import test from 'node:test'

test('Space live acceptance reaches the mock provider with a symlinked TMPDIR', {timeout: 45000}, async () => {
 const root=await realpath(await mkdtemp(join(tmpdir(),'space-live-contract-')))
 const real=join(root,'real'),alias=join(root,'alias'),output=join(root,'evidence')
 await mkdir(real);await symlink(real,alias,process.platform==='win32'?'junction':'dir')
 const server=createServer((_req,res)=>{res.writeHead(401,{'content-type':'application/json'});res.end('{"error":{"message":"synthetic rejection"}}')})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base=`http://127.0.0.1:${server.address().port}/v1`
 try {
  const child=spawn(process.execPath,[resolve(import.meta.dirname,'space-host.mjs'),`--build-dir=${process.env.NOVA_TEST_DIST??resolve(import.meta.dirname,'../../dist')}`,`--output=${output}`],{env:{...process.env,TMPDIR:alias,TMP:alias,TEMP:alias,NOVA_AUDIO_AGENT_MODEL_BASE_URL:base,MODEL_BASE_URL:base,MODEL_API_KEY:'synthetic-test-key',DASHSCOPE_API_KEY:'synthetic-test-key',HTTPS_PROXY:'',https_proxy:'',HTTP_PROXY:'',http_proxy:'',ALL_PROXY:'',all_proxy:''},stdio:['ignore','pipe','pipe']})
  let log='';child.stdout.on('data',data=>{log+=data});child.stderr.on('data',data=>{log+=data})
  const timer=setTimeout(()=>child.kill('SIGKILL'),35000)
  try {await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})} finally {clearTimeout(timer)}
  const report=JSON.parse(await readFile(join(output,'progress.json'),'utf8'))
  assert.ok(report.model_requests.length>0,`Host failed before reaching mock provider: ${log}`)
  assert.ok(report.model_requests.every(request=>request.http_status===401))
 } finally {await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})}
})
