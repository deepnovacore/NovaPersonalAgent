import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {requestJson,summarize,classify,effectiveKey,createBudget,executeRead} from './composio-probe.mjs'

const path='/api/v3.1/tools/GMAIL_GET_PROFILE?version=20260915_00'
const options={method:'GET',apiKey:'fixture'}
test('probe report drops all raw private response fields',()=>{
 assert.deepEqual(summarize({caseId:'routing',status:'pass',layer:'live',checks:{identity_matches:true},raw:'private body',token:'secret'}),{caseId:'routing',status:'pass',layer:'live',checks:{identity_matches:true}})
 assert.throws(()=>summarize({caseId:'routing',status:'pass',layer:'live',checks:{body:'private'}}))
})
test('response cap works without Content-Length and request cannot follow redirects',async()=>{
 await assert.rejects(requestJson(path,options,async()=>new Response('x'.repeat(2*1024*1024+1))),/response_too_large/)
 await assert.rejects(requestJson(path,options,async(_url,init)=>{assert.equal(init.redirect,'error');return new Response(null,{status:302})}),/redirect_denied/)
 await assert.rejects(requestJson('https://evil.test/',options,async()=>{assert.fail('must not send key')}),/route_denied/)
})
test('HTML errors do not leak snippets and Retry-After survives',async()=>{
 assert.deepEqual(await requestJson(path,options,async()=>new Response('secret HTML',{status:500})),{status:500,data:null,retryAfter:null,error:'invalid_json'})
 const result=await requestJson(path,options,async()=>new Response('{}',{status:429,headers:{'Retry-After':'120'}}))
 assert.equal(result.retryAfter,'120');assert.equal(result.status,429)
})
test('cancel and round budgets stop requests before admission',async()=>{
 await assert.rejects(requestJson(path,{...options,signal:AbortSignal.abort()},async()=>assert.fail('aborted request sent')))
 const budget=createBudget();budget.requests=20
 await assert.rejects(requestJson(path,{...options,budget},async()=>assert.fail('budget request sent')),/budget_exhausted/)
})
test('write tools, dynamic versions and unverified scope never reach transport',async()=>{
 let calls=0;const fetch=async()=>{calls++;return new Response('{}')}
 for(const input of [{slug:'GMAIL_SEND_EMAIL',version:'20260915_00'},{slug:'GMAIL_GET_PROFILE',version:'latest'},{slug:'GMAIL_FETCH_EMAILS',version:'20260915_00'}])await assert.rejects(executeRead({...input,userId:'u',accountId:'a',arguments:{},apiKey:'fixture'},fetch))
 assert.equal(calls,0)
})
test('provider status classification separates cursor failure from absent object',()=>{
 assert.equal(classify('gmail-history',404),'cursor_expired')
 assert.equal(classify('gmail-message',404),'object_unavailable')
 assert.equal(classify('calendar-events',410),'cursor_expired')
 assert.equal(classify('calendar-events',403),'permission_denied')
 assert.equal(classify('calendar-events',429),'rate_limited')
 assert.equal(classify('calendar-events',undefined),'unknown')
})
test('explicit clear blocks stale parent key while unset preserves CLI inheritance',()=>{
 assert.equal(effectiveKey({kind:'cleared'},'fixture-old'),undefined)
 assert.equal(effectiveKey({kind:'unset'},'fixture-old'),'fixture-old')
 assert.equal(effectiveKey({kind:'saved',value:'fixture-new'},'fixture-old'),'fixture-new')
})
test('cancellation interrupts an open body stream',async()=>{
 const controller=new AbortController()
 const pending=requestJson(path,{...options,signal:controller.signal},async()=>new Response(new ReadableStream({start(){controller.abort()}})))
 await assert.rejects(pending)
})
test('spawn captures environment until a new process starts',async()=>{
 const child=spawn(process.execPath,['-e',"process.stdin.once('data',()=>console.log(JSON.stringify({matchesExpected:process.env.COMPOSIO_API_KEY==='fixture-old'})))"],{env:{...process.env,COMPOSIO_API_KEY:'fixture-old'},stdio:['pipe','pipe','pipe']})
 const nextEnv={...process.env,COMPOSIO_API_KEY:'fixture-new'}
 const collect=process=>new Promise((resolve,reject)=>{let out='';process.stdout.on('data',chunk=>out+=chunk);process.on('error',reject);process.on('close',code=>code===0?resolve(JSON.parse(out)):reject(Error('child_failed')))})
 const oldResult=collect(child);child.stdin.end('check')
 assert.deepEqual(await oldResult,{matchesExpected:true})
 const next=spawn(process.execPath,['-e',"console.log(JSON.stringify({matchesExpected:process.env.COMPOSIO_API_KEY==='fixture-new'}))"],{env:nextEnv,stdio:['ignore','pipe','pipe']})
 assert.deepEqual(await collect(next),{matchesExpected:true})
})
