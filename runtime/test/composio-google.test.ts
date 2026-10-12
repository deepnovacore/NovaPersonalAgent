import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeCalendarEvent,normalizeGmailMessage,GoogleProvider} from '../src/connectors/composio/google.js'
const now=Date.now(),window={start:now-30*86400000,end:now+90*86400000}
test('Gmail reads four bodies concurrently without dropping unfinished IDs',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),started:string[]=[];
 const provider=new GoogleProvider({read:async(_view,q)=>{
  if(q.kind==='gmail.profile')return {historyId:'100'};
  if(q.kind==='gmail.list')return {messages:['a','b','c','d'].map(messageId=>({messageId}))};
  if(q.kind==='gmail.message'){started.push(q.messageId);await gate;return {messageId:q.messageId,messageTimestamp:new Date(now-1000).toISOString(),labelIds:['INBOX'],messageText:'body'};}
  throw Error('unexpected read');
 }});
 const run=provider.page({identity:'fixture@example.test',scope:{kind:'gmail',labels:['INBOX'],pastDays:30}},null);
 try{for(let n=0;n<50&&started.length<4;n++)await new Promise(resolve=>setTimeout(resolve,2));assert.deepEqual(started,['a','b','c','d']);}
 finally{release();await run;}
 assert.deepEqual((await run).objects.map(o=>o.metadata.remote_id),['a','b','c','d']);
});
test('mail label-only changes preserve semantics and out-of-scope mail is withdrawn',()=>{
 const message={messageId:'abc',subject:'Meeting',sender:'sender@example.test',messageText:'Tomorrow',messageTimestamp:new Date(now-1000).toISOString(),labelIds:['INBOX','UNREAD']}
 const first=normalizeGmailMessage(message,['INBOX'],window),second=normalizeGmailMessage({...message,labelIds:['INBOX']},['INBOX'],window)
 assert.equal(first.semanticHash,second.semanticHash);assert.notDeepEqual(first.metadata,second.metadata)
 assert.equal(normalizeGmailMessage({...message,labelIds:[]},['INBOX'],window).status,'coverage_removed')
})
test('all-day and recurring instances preserve calendar dates; cancellation withdraws',()=>{
 const a=normalizeCalendarEvent('primary',{id:'e',summary:'Holiday',start:{date:'2026-09-19'},end:{date:'2026-09-20'},recurringEventId:'r',originalStartTime:{date:'2026-09-19'}})
 assert.equal(a.retentionUntil,'2026-10-20T00:00:00.000Z');assert(a.text.includes('2026-09-19'));assert.equal(a.metadata.recurringEventId,'r')
 const b=normalizeCalendarEvent('primary',{id:'e',status:'cancelled'})
 assert.equal(a.key,b.key);assert.equal(b.status,'provider_deleted')
})
test('calendar pagination retains stable window and rejects repeated tokens',async()=>{
 let calls=0
 const provider=new GoogleProvider({read:()=>{calls++;return Promise.resolve({items:[],nextPageToken:'same'})}})
 const v={identity:'fixture@example.test',scope:{kind:'calendar' as const,calendars:['primary'],pastDays:30,futureDays:90}}
 const page=await provider.page(v,null)
 assert.equal(page.complete,false)
 await assert.rejects(provider.page(v,page.continuation),/pagination_loop/)
 assert.equal(calls,2)
})

test('Gmail persists unfinished IDs and catches mail arriving after snapshot began',async()=>{
 const scope={kind:'gmail' as const,labels:['INBOX'],pastDays:30},v={identity:'fixture@example.test',scope}
 const began=Date.now()-60000,messageAt=Date.now()-1000
 const provider=new GoogleProvider({read:(v,q)=>{assert.equal(v.scope.kind,'gmail');return Promise.resolve(q.kind==='gmail.history'?{history:[{messagesAdded:[{message:{id:'abc'}}]}],historyId:'200'}:{messageId:'abc',messageTimestamp:new Date(messageAt).toISOString(),labelIds:['INBOX'],messageText:'new mail'})}})
 const page=await provider.page(v,{phase:'history',start:began-30*86400000,end:began,calendar:0,baseline:'100',token:null,nextToken:null,nextBaseline:null,loaded:false,pending:[],seenTokens:[]})
 assert.equal(page.objects[0]?.status,'current');assert.equal(page.complete,true);assert.equal(page.checkpoint?.historyId,'200')
})

test('unfinished Gmail message IDs survive a bounded round without skipping the next page',async()=>{
 const v={identity:'fixture@example.test',scope:{kind:'gmail' as const,labels:['INBOX'],pastDays:30}},ids=Array.from({length:10},(_,n)=>(n+1).toString(16))
 let listCalls=0
 const provider=new GoogleProvider({read:(view,q)=>{assert.equal(view.identity,v.identity);return Promise.resolve(q.kind==='gmail.profile'?{historyId:'100'}:q.kind==='gmail.list'?(listCalls++,{messages:ids.map(messageId=>({messageId})),nextPageToken:'next'}):q.kind==='gmail.message'?{messageId:q.messageId,messageTimestamp:new Date(Date.now()-1000).toISOString(),labelIds:['INBOX'],messageText:'body'}:{history:[],historyId:'200'})}})
 const first=await provider.page(v,null)
 assert.equal(first.objects.length,8);assert.equal(first.continuation?.pending.length,2)
 const next=await provider.page(v,first.continuation)
 assert.equal(listCalls,1);assert.equal(next.objects.length,2);assert.equal(next.continuation?.token,'next');assert.equal(next.complete,false)
})

test('large mail keeps a marked bounded excerpt and changes beyond the excerpt remain versioned',()=>{
 const base={messageId:'abc',messageTimestamp:new Date(now-1000).toISOString(),labelIds:['INBOX'],messageText:'x'.repeat(120000)}
 const a=normalizeGmailMessage(base,['INBOX'],window),b=normalizeGmailMessage({...base,messageText:base.messageText+'changed'},['INBOX'],window)
 assert(a.text.length<=100000);assert.equal(a.metadata.truncated,true);assert.match(a.text,/截断/);assert.notEqual(a.semanticHash,b.semanticHash)
})


test('oversized history requests a safe snapshot reset rather than retrying the same page',async()=>{
 const provider=new GoogleProvider({read:()=>Promise.resolve({history:Array.from({length:3},(_,batch)=>({messagesAdded:Array.from({length:100},(_,n)=>({message:{id:(batch*100+n+1).toString(16)}}))})),historyId:'200'})})
 await assert.rejects(provider.page({identity:'fixture@example.test',scope:{kind:'gmail',labels:['INBOX'],pastDays:30}},null,undefined,{historyId:'100'}),/history_too_large/)
})

test('four-way Gmail batches shrink to the remaining metadata/body request budget',async()=>{
 const {createComposioBudget}=await import('../src/connectors/composio/client.js');const budget=createComposioBudget();budget.requests=15;
 const provider=new GoogleProvider({read:(_view,q,b)=>{b.requests++;if(q.kind!=='gmail.message')throw Error('unexpected read');return Promise.resolve({messageId:q.messageId,messageTimestamp:new Date(now-1000).toISOString(),labelIds:['INBOX'],messageText:'body'});}});
 const cursor={phase:'history',start:now-86400000,end:now,calendar:0,baseline:'100',token:null,nextToken:null,nextBaseline:'101',loaded:true,pending:['a','b','c','d'].map(id=>({id,deleted:false})),seenTokens:[]};
 const result=await provider.page({identity:'fixture@example.test',scope:{kind:'gmail',labels:['INBOX'],pastDays:30}},cursor,budget);assert.equal(result.objects.length,1);assert.equal(budget.requests,17);assert.equal(result.continuation?.pending.length,3);
});
