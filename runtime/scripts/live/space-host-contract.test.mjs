import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp, mkdir, readFile, realpath, rm, symlink} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import test from 'node:test'
import {pathToFileURL} from 'node:url'

import {resolveSpaceLiveModelConfig} from './space-host-model.mjs'

const build=process.env.NOVA_TEST_DIST??resolve(import.meta.dirname,'../../dist')
const {OpenAIModelGateway}=await import(pathToFileURL(join(build,'src/model/model-gateway.js')).href)

const requestFor=async config=>{
 const calls=[]
 const gateway=new OpenAIModelGateway({
  baseUrl:config.baseUrl,apiKey:config.apiKey,clock:{now:()=>0},metrics:{record(){}},
  fetch:(input,init)=>{
   calls.push({url:typeof input==='string'?input:input instanceof URL?input.href:input.url,authorization:new Headers(init?.headers).get('authorization')??''})
   return Promise.resolve(Response.json({choices:[{message:{content:'{}'}}]}))
  },
 })
 await gateway.complete({model:'synthetic',system:'s',prompt:'p'})
 return calls
}

test('live model selection sends each provider its own URL and credential', async () => {
 const dashscope=resolveSpaceLiveModelConfig({
  DASHSCOPE_MODEL_BASE_URL:'https://dashscope-model.example/v1',
  DASHSCOPE_API_KEY:'dash-live-key',
 })
 assert.equal(dashscope.mode,'dashscope')
 assert.deepEqual(await requestFor(dashscope),[{
  url:'https://dashscope-model.example/v1/chat/completions',
  authorization:'Bearer dash-live-key',
 }])
 assert.throws(()=>resolveSpaceLiveModelConfig({
  DASHSCOPE_API_KEY:'dash-live-key',
  SELF_HOSTED_LLM_API_KEY:'stray-self-hosted-key',
 }),/self_hosted_model_credentials_required/u)

 const selfHosted=resolveSpaceLiveModelConfig({
  SELF_HOSTED_LLM_BASE_URL:'https://selfhost.example/v1',
  SELF_HOSTED_LLM_API_KEY:'selfhost-live-key',
  DASHSCOPE_API_KEY:'decoy-dash-key',
  DASHSCOPE_MODEL_BASE_URL:'https://decoy.example/v9',
 })
 assert.equal(selfHosted.mode,'self-hosted')
 assert.deepEqual(await requestFor(selfHosted),[{
  url:'https://selfhost.example/v1/chat/completions',
  authorization:'Bearer selfhost-live-key',
 }])

 assert.throws(()=>resolveSpaceLiveModelConfig({
  SELF_HOSTED_LLM_BASE_URL:'https://selfhost.example/v1',
  DASHSCOPE_API_KEY:'decoy-dash-key',
 }),/self_hosted_model_credentials_required/u)
 assert.throws(()=>resolveSpaceLiveModelConfig({}),/dashscope_model_credential_required/u)
})

test('Space live acceptance reaches a self-hosted mock with its dedicated credential', {timeout: 90000}, async () => {
 const root=await realpath(await mkdtemp(join(tmpdir(),'space-live-contract-')))
 const real=join(root,'real'),alias=join(root,'alias'),output=join(root,'evidence')
 await mkdir(real);await symlink(real,alias,process.platform==='win32'?'junction':'dir')
 const requests=[]
 const server=createServer((request,response)=>{
  requests.push({url:request.url,authorization:request.headers.authorization??''})
  response.writeHead(401,{'content-type':'application/json'});response.end('{"error":{"message":"synthetic rejection"}}')
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base=`http://127.0.0.1:${server.address().port}/v1`
 const run=async(name,environment)=>{
  requests.length=0
  const childOutput=join(root,name)
  const child=spawn(process.execPath,[resolve(import.meta.dirname,'space-host.mjs'),`--build-dir=${build}`,`--output=${childOutput}`],{env:{...process.env,TMPDIR:alias,TMP:alias,TEMP:alias,HTTPS_PROXY:'',https_proxy:'',HTTP_PROXY:'',http_proxy:'',ALL_PROXY:'',all_proxy:'',...environment},stdio:['ignore','pipe','pipe']})
  let log='';child.stdout.on('data',data=>{log+=data});child.stderr.on('data',data=>{log+=data})
  const timer=setTimeout(()=>child.kill('SIGKILL'),45000)
  let code
  try {code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})} finally {clearTimeout(timer)}
  let report
  try {report=JSON.parse(await readFile(join(childOutput,'progress.json'),'utf8'))} catch {report=JSON.parse(await readFile(join(childOutput,'report.json'),'utf8'))}
  return {code,requests:[...requests],report,log}
 }
 try {
  const selfHosted=await run('self-hosted',{SELF_HOSTED_LLM_BASE_URL:base,SELF_HOSTED_LLM_API_KEY:'selfhost-live-key',DASHSCOPE_API_KEY:'decoy-dash-key'})
  assert.ok(selfHosted.requests.length>0,`Host failed before reaching self-hosted mock provider: ${selfHosted.log}`)
  for(const request of selfHosted.requests){
   assert.equal(request.url,'/v1/chat/completions')
   assert.equal(request.authorization,'Bearer selfhost-live-key')
   assert.doesNotMatch(request.authorization,/decoy-dash-key/u)
  }
  assert.equal(selfHosted.report.status,'failed','the synthetic provider rejects the request')

  const missing=await run('missing-self-hosted-key',{SELF_HOSTED_LLM_BASE_URL:base,DASHSCOPE_API_KEY:'decoy-dash-key'})
  assert.notEqual(missing.code,0)
  assert.equal(missing.report.status,'failed')
  assert.equal(missing.report.failure?.message,'self_hosted_model_credentials_required')
  assert.deepEqual(missing.requests,[],'a half-configured self-hosted pair must not borrow the DashScope key')
 } finally {await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})}
})
