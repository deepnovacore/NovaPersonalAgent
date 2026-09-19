import {UnifiedRetrieval} from '../src/memory/retrieval.js';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalAgentHost, type DiscoverySnapshot } from '../src/personal-agent/host.js';
import { SuggestionPool } from '../src/core/suggestions.js';
import type { MemoryEntry } from '../src/memory/entry.js';
import type { PersonalMemoryResource } from '../src/memory/personal-memory.js';
import { parseDesktopControl } from '../src/desktop.js';
import { ClientCommands } from '../src/server/client-protocol.js';
const now = new Date('2026-09-11T10:00:00Z');
const entry = (id = 'plan', version = 1): MemoryEntry => ({ id, version, content: 'Today prepare a demo', kind: 'plan', origin: 'stated', source_refs: [{ type: 'conversation', ref: 'conversation:1', observed_at: now.toISOString() }], observed_at: now.toISOString(), recorded_at: now.toISOString(), topic: 'work', status: 'active', corrected_to: null, confidence_note: null });
const proposal = (id = 'plan', version = 1) => ({ kind: 'question' as const, summary: 'Check demo materials?', why_now: 'You said the demo is today', evidence_refs: [] as string[], memory_refs: [{ entry_id: id, version }] });
test('batch notifications coalesce and ready at the same revision is not swallowed',async()=>{
 const f=await fixture();let refreshes=0,discoveries=0
 const refresh=f.host.refreshMemory.bind(f.host)
 f.host.refreshMemory=async()=>{refreshes++;await refresh()}
 f.host.discover=()=>{discoveries++;return Promise.resolve()}
 try{
  await f.host.admit(proposal(),await f.host.discoverySnapshot());const id=f.host.snapshot().feed[0]!.id
  f.entries.delete('plan')
  await Promise.all(Array.from({length:200},()=>f.host.sourceChanged({revision:1,phase:'invalidated'})))
  assert.ok(refreshes<=2);assert.equal(discoveries,0);assert.equal(await f.host.canDeliver(id),false)
  await Promise.all(Array.from({length:200},()=>f.host.sourceChanged({revision:1,phase:'ready'})))
  assert.equal(discoveries,1)
  await f.host.sourceChanged({revision:1,phase:'ready'});assert.equal(discoveries,1)
  await f.host.sourceChanged({revision:3,phase:'ready'});assert.equal(discoveries,2)
  await f.host.sourceChanged({revision:2,phase:'ready'});assert.equal(discoveries,3,'an older batch completing later still triggers discovery')
 }finally{await f.close()}
})
test('failed batch refresh remains retryable and arrivals during refresh are drained',async()=>{
 const f=await fixture();const refresh=f.host.refreshMemory.bind(f.host);let fail=true,discoveries=0
 f.host.refreshMemory=async()=>{if(fail){fail=false;throw Error('temporary')}await refresh()}
 f.host.discover=()=>{discoveries++;return Promise.resolve()}
 try{
  await assert.rejects(f.host.sourceChanged({revision:1,phase:'invalidated'}),/temporary/)
  await f.host.sourceChanged({revision:1,phase:'invalidated'})
  await Promise.all([f.host.sourceChanged({revision:2,phase:'invalidated'}),f.host.sourceChanged({revision:2,phase:'ready'}),f.host.sourceChanged({revision:3,phase:'ready'})])
  assert.equal(discoveries,1)
 }finally{await f.close()}
})
async function fixture() { const dir = await mkdtemp(join(await realpath(tmpdir()), 'nova-host-')); const entries = new Map([['plan', entry()]]); const memory = { get: (id: string) => Promise.resolve(entries.get(id) ?? null), list: () => Promise.resolve({ entries: [...entries.values()], cursor: null }) } as unknown as PersonalMemoryResource; const make = () => new PersonalAgentHost({ path: join(dir, 'feed.json'), userScope: 'local', memory: () => memory, pool: new SuggestionPool(), now: () => now, evidence: ref => ref.startsWith('task:') ? { subject_key: 'task:demo', source: { type: 'task', ref }, task_ref: { work_id: 'demo' } } : ref.startsWith('conversation:') ? {subject_key:ref,source:{type:'conversation',ref}} : null }); const host = make(); await host.open(); return { dir, entries, host, make, close: async () => { await host.close(); await rm(dir, { recursive: true, force: true }); } }; }
test('ten positive deterministic admission cases with stable evidence; not live model quality', async () => { const f = await fixture(); try {
    const cases=JSON.parse(readFileSync(new URL('../../../fixtures/personal-agent/v1/discovery-cases.json',import.meta.url),'utf8')) as {positive:{id:string;content:string;summary:string}[]};
    assert.equal(cases.positive.length,10);
    for (const example of cases.positive) {
        const id=example.id;
        f.entries.set(id,{...entry(id),content:example.content});
        const snapshot = await f.host.discoverySnapshot();
        assert.equal(await f.host.admit({...proposal(id),summary:example.summary}, snapshot), 'admitted');
    }
    assert.equal(f.host.snapshot().feed.length, 10);
    assert(f.host.snapshot().feed.every(item => item.delivery.spoken_at === null));
}
finally {
    await f.close();
} });
test('ten deterministic silence/rejection boundaries', async () => {
    const f = await fixture();
    try {
        const s = await f.host.discoverySnapshot(), p = proposal();
        const cases: [
            unknown,
            DiscoverySnapshot
        ][] = [
            [{ ...p, evidence_refs: [], memory_refs: [] }, s],
            [{ ...p, summary: '' }, s],
            [{ ...p, summary: 'a'.repeat(201) }, s],
            [{ ...p, why_now: 'a'.repeat(201) }, s],
            [{ ...p, kind: 'execute' }, s],
            [{ ...p, memory_refs: [{ entry_id: 'missing', version: 1 }] }, s],
            [{ ...p, memory_refs: [{ entry_id: 'plan', version: 2 }] }, s],
            [{ ...p, evidence_refs: ['task:outside'] }, s],
            [p, { ...s, user_scope: 'other' }],
            [{ ...p, priority: 100 }, s],
        ];
        for (const [input, snapshot] of cases)
            assert.equal(await f.host.admit(input, snapshot), 'rejected');
        assert.equal(f.host.snapshot().feed.length, 0);
    }
    finally {
        await f.close();
    }
});
test('dismissal remains active and dedupe survives restart and unrelated evidence', async () => {
    const f = await fixture();
    try {
        const s = await f.host.discoverySnapshot();
        assert.equal(await f.host.admit(proposal(), s), 'admitted');
        const id = f.host.snapshot().feed[0]!.id;
        await f.host.action({ id, action: 'dismiss' });
        assert.equal(f.host.snapshot().feed[0]!.lifecycle, 'active');
        await f.host.close();
        const reopened = f.make();
        await reopened.open();
        try {
            assert.equal(await reopened.admit({ ...proposal(), evidence_refs: ['conversation:unrelated'] }, { ...s, evidence_refs: ['conversation:unrelated'] }), 'suppressed_duplicate');
            assert.equal(await reopened.admit(proposal(), s), 'suppressed_duplicate');
            assert.equal(reopened.snapshot().feed[0]!.user_state, 'dismissed');
        }
        finally {
            await reopened.close();
        }
    }
    finally {
        await f.close();
    }
});
test('same task date key ignores extra runtime evidence', async () => { const f = await fixture(); try {
    const p = { ...proposal(), memory_refs: [], evidence_refs: ['task:1'] }, s = { ...await f.host.discoverySnapshot(), evidence_refs: ['task:1', 'task:2'] };
    assert.equal(await f.host.admit(p, s), 'admitted');
    assert.equal(await f.host.admit({ ...p, evidence_refs: ['task:1', 'task:2'] }, s), 'suppressed_duplicate');
}
finally {
    await f.close();
} });
test('memory correction race rejects admission and invalidates pending delivery', async () => { const f = await fixture(); try {
    const s = await f.host.discoverySnapshot();
    await f.host.admit(proposal(), s);
    const id = f.host.snapshot().feed[0]!.id;
    f.entries.set('plan', entry('plan', 2));
    assert.equal(await f.host.admit(proposal(), s), 'rejected');
    assert.equal(await f.host.canDeliver(id), false);
    assert.equal(f.host.snapshot().feed[0]!.lifecycle, 'invalidated');
    await assert.rejects(f.host.action({ id, action: 'presented' }));
    assert.equal(f.host.snapshot().feed[0]!.delivery.presented_at, null);
}
finally {
    await f.close();
} });
test('delivery types remain independent and act requires explicit configured authorization', async () => { const f = await fixture(); try {
    await f.host.admit(proposal(), await f.host.discoverySnapshot());
    const id = f.host.snapshot().feed[0]!.id;
    await f.host.action({ id, action: 'presented' });
    assert(f.host.snapshot().feed[0]!.delivery.presented_at);
    assert.equal(f.host.snapshot().feed[0]!.delivery.spoken_at, null);
    await assert.rejects(f.host.action({ id, action: 'act' }), /unsupported/);
    await f.host.action({ id, action: 'snooze', snooze_until: '2026-09-12T00:00:00Z' });
    assert.equal(await f.host.canDeliver(id), false);
}
finally {
    await f.close();
} });
test('authenticated protocol validates bounded controls and remote request dedupe', async () => { const control = { type: 'personal.command', request_id: 'r1', method: 'discovery.configure', params: { enabled: false } }; assert.deepEqual(parseDesktopControl(JSON.stringify(control)), control); assert.throws(() => parseDesktopControl(JSON.stringify({ ...control, request_id: 'x'.repeat(129) }))); let count = 0; const remote = new ClientCommands('conn'), raw = JSON.stringify({ type: 'client.command', request_id: 'r1', connection_id: 'conn', payload: control }); await remote.receive(raw, () => { count++; }); await remote.receive(raw, () => { count++; }); assert.equal(count, 1); });
test('durable configuration, duplicate result and exclusive owner', async () => { const f = await fixture(); try {
    const other = f.make();
    await assert.rejects(other.open(), /locked/);
    const c = { type: 'personal.command', request_id: 'config', method: 'discovery.configure', params: { enabled: false, interval_minutes: 60 } };
    assert.deepEqual(await f.host.command(c), await f.host.command(c));
    await f.host.close();
    await other.open();
    try {
        assert.equal(other.snapshot().settings.discovery_enabled, false);
        assert.equal(other.snapshot().settings.discovery_interval_minutes, 60);
    }
    finally {
        await other.close();
    }
}
finally {
    await f.close();
} });
test('task result updates the same matter and preserves dismissal independently', async () => { const f = await fixture(); try {
    const p = { ...proposal(), memory_refs: [], evidence_refs: ['task:1'] }, s = { ...await f.host.discoverySnapshot(), evidence_refs: ['task:1'] };
    await f.host.admit(p, s);
    const id = f.host.snapshot().feed[0]!.id;
    await f.host.action({ id, action: 'dismiss' });
    await f.host.taskResult('demo', 'Demo completed');
    const item = f.host.snapshot().feed[0]!;
    assert.equal(item.id, id);
    assert.equal(item.lifecycle, 'resolved');
    assert.equal(item.user_state, 'dismissed');
    assert.equal(item.kind, 'task_result');
    await f.host.taskResult('independent', 'Another completed');
    assert.equal(f.host.snapshot().feed.length, 2);
}
finally {
    await f.close();
} });
test('concurrent command retries apply once and scope mismatch fails closed', async () => { const f = await fixture(); try {
    const command = { type: 'personal.command', request_id: 'same', method: 'discovery.configure', params: { enabled: false } };
    const [a, b] = await Promise.all([f.host.command(command), f.host.command(command)]);
    assert.deepEqual(a, b);
    await f.host.close();
    const other = new PersonalAgentHost({ ...f.host.options, userScope: 'another' });
    await assert.rejects(other.open(), /scope_mismatch/);
}
finally {
    await f.close();
} });
test('kernel ownership releases after owner process is killed; durable dedupe remains', async () => {
 const {fork}=await import('node:child_process');const {writeFile}=await import('node:fs/promises');
 const f=await fixture();let child:ReturnType<typeof fork>|undefined;
 try {
  const snapshot=await f.host.discoverySnapshot();await f.host.admit(proposal(),snapshot);await f.host.close();
  const script=join(f.dir,'lock-owner.mjs');await writeFile(script,`import {acquirePersonalLock} from ${JSON.stringify(new URL('../src/personal-agent/store.js',import.meta.url).href)};await acquirePersonalLock(${JSON.stringify(f.host.path)});process.on('message',()=>process.send('alive'));process.send('ready');`);
  child=fork(script,{stdio:['ignore','ignore','pipe','ipc']});await once(child,'message');
  const blocked=f.make();await assert.rejects(blocked.open(),/locked/);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;
  const recovered=f.make();await recovered.open();try{assert.equal(await recovered.admit(proposal(),snapshot),'suppressed_duplicate')}finally{await recovered.close()}
 }finally{child?.kill('SIGKILL');await f.close()}
})
test('turning discovery off fences an in-flight model proposal',async()=>{
 const f=await fixture();await f.host.close();let finish!:(value:ReturnType<typeof proposal>)=>void;let called!:()=>void;const started=new Promise<void>(resolve=>{called=resolve});
 const host=new PersonalAgentHost({...f.host.options,discover:async()=>{called();return await new Promise(resolve=>{finish=resolve})}});
 try{await host.open();const run=host.discover();await started;await host.command({type:'personal.command',request_id:'off',method:'discovery.configure',params:{enabled:false}});finish(proposal());await run;assert.equal(host.snapshot().feed.length,0)}finally{await host.close();await f.close()}
})
test('distinct concrete tasks sharing one preference remain distinct matters',async()=>{
 const f=await fixture();await f.host.close();
 const host=new PersonalAgentHost({...f.host.options,evidence:ref=>({subject_key:ref,source:{type:'task',ref},task_ref:{work_id:ref}})});
 try{await host.open();const snapshot={...await host.discoverySnapshot(),evidence_refs:['task:one','task:two']};assert.equal(await host.admit({...proposal(),evidence_refs:['task:one']},snapshot),'admitted');assert.equal(await host.admit({...proposal(),evidence_refs:['task:two']},snapshot),'admitted');assert.equal(host.snapshot().feed.length,2)}finally{await host.close();await f.close()}
})
test('private receipt replay explicitly requires a fresh projection',async()=>{
 const f=await fixture();try{const command={type:'personal.command',request_id:'page',method:'memory.list',params:{}};const first=await f.host.command(command) as {ok:boolean;data?:unknown};assert(first.ok&&first.data);const replay=await f.host.command(command) as {ok:boolean;data?:unknown;reload_required?:boolean};assert.equal(replay.ok,true);assert.equal(replay.reload_required,true);assert.equal(replay.data,undefined)}finally{await f.close()}
})


test('a supporting memory and a concrete task do not suppress each other in either admission order',async()=>{
 for(const memoryFirst of [true,false]) {
  const f=await fixture()
  try {
   const snapshot={...await f.host.discoverySnapshot(),evidence_refs:['task:one']}
   const memoryOnly=proposal(),task={...proposal(),evidence_refs:['task:one']}
   for(const candidate of memoryFirst?[memoryOnly,task]:[task,memoryOnly])assert.equal(await f.host.admit(candidate,snapshot),'admitted')
   assert.equal(f.host.snapshot().feed.length,2)
  }finally{await f.close()}
 }
})

test('Feishu controls and delivery ledger stay separate from execution authorization', async () => {
    const f = await fixture();
    let calls=0;
    try {
        f.host.setFeishu({snapshot:()=>({available:true,state:'ready'}),open:()=>Promise.resolve(),close:()=>Promise.resolve(),command:(method)=>{calls++;return Promise.resolve({method})}});
        const command={type:'personal.command',request_id:'feishu-configure-test',method:'feishu.bot.configure',params:{enabled:true}};
        assert.equal((await f.host.command(command) as {ok:boolean}).ok,true);
        await f.host.command(command);assert.equal(calls,1);
        assert.deepEqual(f.host.snapshot().feishu,{available:true,state:'ready'});
        await f.host.admit(proposal(),await f.host.discoverySnapshot());
        const item=f.host.snapshot().feed[0]!;
        await f.host.imDelivered(item.id);
        const delivered=f.host.snapshot().feed[0]!;
        assert(delivered.delivery.im_sent_at);
        assert.equal(delivered.delivery.presented_at,null);
        assert.equal(delivered.delivery.notified_at,null);
        assert.equal(delivered.delivery.spoken_at,null);
        await f.host.action({id:item.id,action:'open'});
        await assert.rejects(f.host.action({id:item.id,action:'act'}),/unsupported/);
    } finally { await f.close(); }
});

test('shared C retrieval reuses exact prefetch and rereads originals before admission and delivery', async () => {
    const dir=await mkdtemp(join(await realpath(tmpdir()),'nova-host-c-'));
    let live=true, recalls=0;
    const original={evidence_id:'canonical:one',source_kind:'file',locator:'notes/demo',text:'The demo is today',observed_at:now.toISOString(),trust:'untrusted_external' as const};
    const memory:PersonalMemoryResource={open:()=>Promise.resolve(),close:()=>Promise.resolve(),recall:()=>Promise.resolve({source:'personal',state:'empty',scope:'recent',hits:[],degraded:false}),readEvidence:()=>Promise.resolve(live?original:null)};
    const retrieval=new UnifiedRetrieval({memory:()=>memory,rawRecall:()=>{recalls++;return Promise.resolve([{evidence_id:original.evidence_id}])}});
    const host=new PersonalAgentHost({path:join(dir,'feed.json'),userScope:'local',memory:()=>memory,pool:new SuggestionPool(),now:()=>now,evidence:()=>null});
    host.setRetrieval(retrieval);
    try {
        await host.open();
        const query=now.toLocaleDateString('en-CA');
        host.setPrefetchedRetrieval(query,await retrieval.recall(query));
        const snapshot=await host.discoverySnapshot();
        assert.equal(recalls,1);
        assert.deepEqual(snapshot.evidence_refs,[original.evidence_id]);
        assert.equal(snapshot.retrieval?.snippets[0]?.trust,'untrusted_external');
        const read={type:'personal.command',request_id:'raw-debug',method:'memory.evidence',params:{evidence_id:original.evidence_id}};
        const shown=await host.command(read) as {ok:boolean;data:{state:string;evidence:{text:string}}};
        assert.equal(shown.ok,true);assert.equal(shown.data.state,'ok');assert.equal(shown.data.evidence.text,original.text);
        const replay=await host.command(read) as {reload_required:boolean;data?:unknown};
        assert.equal(replay.reload_required,true);assert.equal(replay.data,undefined);
        const p={...proposal(),memory_refs:[],evidence_refs:[original.evidence_id]};
        assert.equal(await host.admit(p,snapshot),'admitted');
        live=false;
        const gone=await host.command({...read,request_id:'raw-debug-after-delete'}) as {data:{state:string;evidence:unknown}};
        assert.equal(gone.data.state,'gone');assert.equal(gone.data.evidence,null);
        assert.equal(await host.canDeliver(host.snapshot().feed[0]!.id),false);
        assert.equal(await host.admit(p,snapshot),'rejected');
        assert.deepEqual((await host.discoverySnapshot()).retrieval?.snippets,[]);
        assert.equal(recalls,1);
    } finally {await host.close();await rm(dir,{recursive:true,force:true});}
});
