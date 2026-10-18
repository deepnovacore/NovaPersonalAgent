import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {generateKeyPair,exportJWK,SignJWT} from 'jose'
import {ChatGptAccounts,verifyChatGptIdentity} from '../src/main/chatgpt-auth.mjs'
import {chatGptRequest,createChatGptBroker,applyChatGptEnvironment} from '../src/main/chatgpt-broker.mjs'
const codec={available:()=>true,encrypt:s=>Buffer.from(s),decrypt:b=>b.toString()}
const {publicKey,privateKey}=await generateKeyPair('RS256');const keys={keys:[{...await exportJWK(publicKey),kid:'test'}]}
const sign=(nonce,client='oaiapp_test',issuer='https://auth.openai.com')=>new SignJWT({nonce}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(issuer).setAudience(client).setSubject('user').setIssuedAt().setExpirationTime('1h').sign(privateKey)

test('identity rejects mismatched nonce, audience, issuer and returning subject',async()=>{
 const token=await sign('nonce');const valid={clientId:'oaiapp_test',nonce:'nonce',keys}
 assert.equal((await verifyChatGptIdentity(token,valid)).sub,'user')
 for(const patch of [{nonce:'wrong'},{clientId:'wrong'},{subject:'wrong'}])await assert.rejects(verifyChatGptIdentity(token,{...valid,...patch}))
 await assert.rejects(verifyChatGptIdentity(await sign('nonce','oaiapp_test','https://evil.test'),valid))
 await assert.rejects(verifyChatGptIdentity(token.slice(0,-4)+'abcd',valid))
})

test('official callback, per-account storage, refresh single-flight and logout',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-chatgpt-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 let authorization,grants=0,refreshes=0
 const accounts=new ChatGptAccounts({file:join(dir,'accounts.enc'),codec,openBrowser:async url=>{authorization=new URL(url)},fetcher:async(url,init)=>{
  if(String(url).endsWith('jwks.json'))return Response.json(keys)
  if(String(url).endsWith('openid-configuration'))return Response.json({revocation_endpoint:'https://auth.openai.com/revoke'})
  if(String(url).endsWith('/revoke'))return new Response(null,{status:200})
  const fields=new URLSearchParams(init.body);grants++
  if(fields.get('grant_type')==='refresh_token'){refreshes++;return Response.json({access_token:'renewed',refresh_token:'rotated',token_type:'Bearer',expires_in:3600})}
  assert.equal(fields.get('client_id'),'oaiapp_test');assert.equal(fields.get('redirect_uri'),authorization.searchParams.get('redirect_uri'))
  return Response.json({access_token:'initial',refresh_token:'refresh',id_token:await sign(authorization.searchParams.get('nonce')),token_type:'Bearer',expires_in:1,scope:'openid chatgpt.tokens.use.direct'})
 }})
 t.after(()=>accounts.cancel());await accounts.login()
 assert.equal(authorization.searchParams.get('client_id'),'dynamic_agent_client')
 assert.match(authorization.searchParams.get('ext_agent_host_id'),/^urn:uuid:/)
 const callback=new URL(authorization.searchParams.get('redirect_uri'))
 callback.search=new URLSearchParams({code:'code',client_id:'oaiapp_test',state:'wrong'})
 assert.equal((await fetch(callback)).status,400);assert.equal(grants,0)
 callback.searchParams.set('state',authorization.searchParams.get('state'))
 assert.equal((await fetch(callback)).status,200)
 assert.equal(accounts.view().active,'oaiapp_test');assert.ok(!JSON.stringify(accounts.view()).includes('refreshToken'))
 assert.deepEqual(await Promise.all([accounts.accessToken(),accounts.accessToken()]),['renewed','renewed']);assert.equal(refreshes,1)
 const host=authorization.searchParams.get('ext_agent_host_id');await accounts.login('oaiapp_test')
 assert.equal(authorization.searchParams.get('client_id'),'oaiapp_test');assert.equal(authorization.searchParams.get('ext_agent_host_id'),host)
 accounts.cancel();assert.equal((await accounts.logout()).remoteRevocationConfirmed,true)
 await assert.rejects(accounts.accessToken());assert.ok(!String(await readFile(join(dir,'accounts.enc'))).includes('renewed'))
})

test('ChatGPT broker shapes Responses tools and excludes unsupported fields',()=>{
 const body=chatGptRequest({model:'m',input:[{role:'system',content:'s'}],tools:[{type:'function',name:'test',parameters:{type:'object'}}],max_output_tokens:2,previous_response_id:'r',temperature:1})
 assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(body.input[0].role,'developer');assert.equal(body.tools[0].type,'namespace')
 assert.ok(!('max_output_tokens'in body));assert.ok(!('previous_response_id'in body));assert.ok(!('temperature'in body))
 assert.throws(()=>chatGptRequest({model:'m',input:[],tools:[{type:'computer_use_preview'}]}))
 const env={MODEL_API_KEY:'old'};applyChatGptEnvironment(env,{useModels:true,useCodex:true,model:'m'},{baseUrl:'http://127.0.0.1:1234/v1',secret:'local'})
 assert.equal(env.MODEL_API_KEY,'');assert.equal(env.OPENAI_COMPATIBLE_PROTOCOL,'responses');assert.equal(env.CODEX_API_KEY,'local')
})

test('broker authenticates local caller and forwards only to official endpoint with fresh grant',async t=>{
 let calls=0
 const broker=await createChatGptBroker({accounts:{accessToken:async()=> 'oauth-secret',view:()=>({model:'chosen'})},fetcher:async(url,options)=>{
  calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.headers.authorization,'Bearer oauth-secret');assert.equal(options.redirect,'error')
  assert.equal(JSON.parse(options.body).model,'chosen')
  return new Response('data: {"type":"response.completed"}\n\n',{headers:{'content-type':'text/event-stream'}})
 }})
 t.after(()=>broker.close())
 assert.equal((await fetch(`${broker.baseUrl}/responses`,{method:'POST'})).status,401);assert.equal(calls,0)
 const response=await fetch(`${broker.baseUrl}/responses`,{method:'POST',headers:{authorization:`Bearer ${broker.secret}`},body:JSON.stringify({model:'old',input:[]})})
 assert.match(await response.text(),/response.completed/);assert.equal(calls,1)
})

test('switching accounts keeps ChatGPT routing enabled and invalid patches are atomic',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-chatgpt-switch-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const file=join(dir,'accounts.enc')
 const {writeFile}=await import('node:fs/promises')
 await writeFile(file,JSON.stringify({hostId:'urn:uuid:test',active:'a',accounts:[{clientId:'a'},{clientId:'b'}],useModels:true,useCodex:true,model:'first-model'}))
 const accounts=new ChatGptAccounts({file,codec,openBrowser:async()=>{}});await accounts.load()
 await assert.rejects(accounts.configure({useModels:false,model:''}))
 assert.equal(accounts.view().useModels,true)
 const view=await accounts.configure({active:'b'})
 assert.equal(view.useModels,true);assert.equal(view.useCodex,true);assert.equal(view.model,'')
 const env={MODEL_API_KEY:'paid'};applyChatGptEnvironment(env,view,{baseUrl:'http://127.0.0.1:1234/v1',secret:'local'})
 assert.equal(env.OPENAI_COMPATIBLE_API_KEY,'local');assert.equal(env.MODEL_API_KEY,'');assert.equal(env.CASCADE_LLM_PROVIDER,'openai-compatible')
})

test('account panel clears stale model catalog on switch',async t=>{
 const {createChatGptPanel}=await import('../src/renderer/chatgpt-panel.mjs')
 const oldOption=globalThis.Option;globalThis.Option=class{constructor(label,value){this.text=label;this.value=value}};t.after(()=>{globalThis.Option=oldOption})
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',options:[],checked:false,handlers:{},addEventListener(e,f){this.handlers[e]=f},replaceChildren(...options){this.options=options},add(option){this.options.push(option)}});return nodes.get(id)}
 const state={active:'a',accounts:[{id:'a',email:'A',connected:true,planEnabled:true},{id:'b',email:'B',connected:true,planEnabled:true}],model:'a-model',useModels:true,useCodex:false}
 createChatGptPanel({getElementById:id=>node(id)},{action:async(action,value)=>{if(action==='configure'){state.active=value.active;state.model=''}return {...state}}})
 await node('chatgpt-refresh').handlers.click();await new Promise(setImmediate)
 assert.equal(node('chatgpt-model').options.length,1)
 node('chatgpt-account').value='b';node('chatgpt-account').handlers.change();await new Promise(setImmediate)
 assert.equal(node('chatgpt-model').options.length,0);assert.equal(node('chatgpt-use-models').checked,true)
 state.accounts[1].connected=false;await node('chatgpt-refresh').handlers.click();await new Promise(setImmediate)
 assert.doesNotMatch(node('chatgpt-status').textContent,/授权已连接/)
})

test('account switch during credential refresh never sends the old grant upstream',async t=>{
 let active='a',calls=0
 const broker=await createChatGptBroker({accounts:{view:()=>({active,model:'chosen'}),accessToken:async()=>{active='b';return 'old-account-token'}},fetcher:async()=>{calls++;return new Response('unexpected')}})
 t.after(()=>broker.close())
 const response=await fetch(`${broker.baseUrl}/responses`,{method:'POST',headers:{authorization:`Bearer ${broker.secret}`},body:JSON.stringify({model:'m',input:[]})})
 assert.equal(response.status,503);assert.equal(calls,0)
})

test('failed first code exchange retains issued client for a fresh authorization attempt',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'nova-chatgpt-retry-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 let authorization
 const accounts=new ChatGptAccounts({file:join(dir,'accounts.enc'),codec,openBrowser:async url=>{authorization=new URL(url)},fetcher:async()=>Response.json({error:'invalid_grant'},{status:400})})
 t.after(()=>accounts.cancel());await accounts.login()
 const oldState=authorization.searchParams.get('state'),callback=new URL(authorization.searchParams.get('redirect_uri'))
 callback.search=new URLSearchParams({code:'expired',client_id:'oaiapp_issued',state:oldState})
 assert.equal((await fetch(callback)).status,400)
 assert.equal(accounts.view().active,null)
 await accounts.login();assert.equal(authorization.searchParams.get('client_id'),'oaiapp_issued');assert.notEqual(authorization.searchParams.get('state'),oldState)
 assert.equal(authorization.searchParams.has('agent_name_hint'),false)
})
