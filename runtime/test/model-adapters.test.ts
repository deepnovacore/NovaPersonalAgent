import {GatewayProactivity} from '../src/model/proactivity.js'
import {GatewayPersonalWriter} from '../src/model/personal-writer.js'
import {GatewayTaskVerifier} from '../src/model/task-verifier.js'
import {ProfileWarmup} from '../src/personal-agent/profile-warmup.js'
import {NewsService} from '../src/news/service.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve,join } from 'node:path'
import {mkdtemp,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import { test } from 'node:test'
import { VirtualClock } from '../src/core/clock.js'
import type { ContextView } from '../src/core/context-view.js'
import type { MemoryItem } from '../src/core/memory.js'
import type {
  CompleteRequest,
  GatewayCompletion,
  GatewayDelta,
  ModelGateway,
  StreamRequest,
} from '../src/model/model-gateway.js'
import {
  GatewayCompressor,
  compressorPrompt,
} from '../src/model/model-adapters.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../tests/fixtures/adapters/v1')

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), 'utf8')) as T
}

void new VirtualClock()

class ScriptedGateway implements ModelGateway {
  readonly requests: StreamRequest[] = []
  readonly completions: CompleteRequest[] = []
  constructor(
    private readonly deltas: readonly GatewayDelta[] = [],
    private readonly text = '',
  ) {}

  async *stream(request: StreamRequest): AsyncIterable<GatewayDelta> {
    this.requests.push(request)
    for (const delta of this.deltas) {
      // Yield across a real turn so the consumer cannot depend on synchronous delivery.
      await Promise.resolve()
      yield delta
    }
  }

  complete(request: CompleteRequest): Promise<GatewayCompletion> {
    this.completions.push(request)
    return Promise.resolve({text: this.text})
  }
}

class QueuedGateway implements ModelGateway {
  readonly completions: CompleteRequest[] = []
  constructor(private readonly replies: string[], private readonly error?: Error) {}
  async *stream(): AsyncIterable<GatewayDelta> { /* unused */ }
  complete(request: CompleteRequest): Promise<GatewayCompletion> {
    this.completions.push(request)
    if (this.error && this.completions.length === 1) return Promise.reject(this.error)
    const text = this.replies.shift()
    if (text === undefined) return Promise.reject(new Error('no queued reply'))
    return Promise.resolve({text})
  }
}

const emptyView: ContextView = {
  channels: [], in_flight: [], affordances: [], floor: 'idle', now: 0, trigger_kind: null,
}

test('the compressor prompt matches the Python oracle byte for byte', () => {
  const fixture = loadJson<{
    readonly schema_version: number
    readonly scenarios: readonly {readonly id: string, readonly covers: string,
      readonly items: readonly MemoryItem[]}[]
  }>('compressor-items.json')
  const golden = loadJson<{
    readonly schema_version: number
    readonly prompts: Readonly<Record<string, string>>
  }>('compressor-items-expected.json')
  assert.equal(fixture.schema_version, golden.schema_version)
  assert.deepEqual(
    fixture.scenarios.map(scenario => scenario.id).sort(),
    Object.keys(golden.prompts).sort(),
  )
  for (const scenario of fixture.scenarios) {
    assert.equal(
      compressorPrompt(scenario.items),
      golden.prompts[scenario.id],
      `${scenario.id}: ${scenario.covers}`,
    )
  }
  // Guard the premise: the scenario must actually exercise both hazards.
  const sorted = golden.prompts['sorted-keys-and-float-ts']!
  // Code-point key order, which JavaScript would otherwise reorder.
  assert.match(sorted, /"10": "ten", "2": "two"/u)
  // An integral float renders without a decimal point on BOTH sides, because the
  // oracle routes this through prompt_json. json.dumps would have written 1.0 here,
  // which no JavaScript number can express.
  assert.match(sorted, /"ts": 1\}/u)
  assert.doesNotMatch(sorted, /"ts": 1\.0/u)
})

test('the Proactive selector rejects output that is not contract-shaped', async () => {
  const good = new GatewayProactivity({
    gateway: new ScriptedGateway([], '{"speak":true,"suggestion_id":"s-1","progress_class":"milestone","reason":"因为"}'),
    model: 'm',
    proactivityPreset: 'balanced',
  })
  assert.deepEqual(await good.select(emptyView),
    {speak: true, suggestion_id: 's-1', progress_class: 'milestone', reason: '因为'})

  for (const text of ['not json', '{}', '{"speak":"yes","suggestion_id":null,"reason":"r"}',
    '{"speak":true,"suggestion_id":7,"progress_class":"milestone","reason":"r"}',
    '{"speak":true,"suggestion_id":null,"progress_class":null}',
    '{"speak":true,"suggestion_id":"s-1","reason":"missing classification"}']) {
    const bad = new GatewayProactivity({
      gateway: new ScriptedGateway([], text),
      model: 'm',
      proactivityPreset: 'balanced',
    })
    await assert.rejects(bad.select(emptyView), TypeError, text)
  }
})

test('the Proactive selector preserves its structured progress decision', async () => {
  const proactive = new GatewayProactivity({
    gateway: new ScriptedGateway(
      [],
      '{"speak":true,"suggestion_id":"s-1","progress_class":"routine_delta","reason":"file count changed"}',
    ),
    model: 'm',
    proactivityPreset: 'eager',
  })

  assert.deepEqual(await proactive.select(emptyView), {
    speak: true,
    suggestion_id: 's-1',
    progress_class: 'routine_delta',
    reason: 'file count changed',
  })
})

test('the Proactive selector receives the selected proactivity policy at its model boundary', async () => {
  const systems = new Map<string, string>()
  for (const preset of ['conservative', 'balanced', 'eager'] as const) {
    const gateway = new ScriptedGateway(
      [],
      '{"speak":false,"suggestion_id":null,"progress_class":null,"reason":"routine"}',
    )
    const proactive = new GatewayProactivity({gateway, model: 'm', proactivityPreset: preset})

    await proactive.select(emptyView)

    const system = gateway.completions[0]?.system
    assert.ok(system !== undefined)
    assert.match(system, new RegExp(`<proactivity_policy preset="${preset}">`, 'u'))
    systems.set(preset, system)
  }

  assert.equal(new Set(systems.values()).size, 3)
  assert.match(systems.get('conservative') ?? '', /action_required.*blocker.*验证证据.*milestone/u)
  assert.match(systems.get('balanced') ?? '', /改变用户对任务状态理解的 milestone/u)
  assert.match(systems.get('eager') ?? '', /首次出现的具体工作方向/u)
  assert.doesNotMatch(systems.get('eager') ?? '', /开始或完成验证/u)

  for (const system of systems.values()) {
    const policy = /<proactivity_policy[^>]*>([\s\S]*?)<\/proactivity_policy>/u.exec(system)?.[1]
    assert.match(policy ?? '', /trusted_user.*静默/u)
  }
  for (const preset of ['balanced', 'eager'] as const) {
    const system = systems.get(preset) ?? ''
    assert.doesNotMatch(system, /常规调查结论、实现细节、计划、计数和中间解释/u)
    assert.doesNotMatch(system, /只有需要用户行动或决定、出现风险或阻塞/u)
  }
})

test('compressor selects verified source records without accepting generated facts', async () => {
  const items = [{channel:'conversation',seq:1,ts:1,trust:'trusted_user',priority:100,content:{text:'34 fixtures passed; audit pending'},refs:[],outcome:null}] as MemoryItem[]
  const gateway = new ScriptedGateway([], JSON.stringify({refs:['conversation:1']}))
  const summary = await new GatewayCompressor({gateway,model:'qwen-flash'}).compress(items)
  assert.match(summary,/34 fixtures passed; audit pending/)
  assert.match(summary,/conversation:1/)
  assert.ok(gateway.completions[0]?.jsonSchema)
  for (const output of ['39 fixtures passed', '{"refs":["conversation:99"]}', '{"refs":["conversation:1"],"summary":"39 fixtures passed"}', '{"refs":[]}', '{"refs":["conversation:1","conversation:1"]}']) {
    await assert.rejects(new GatewayCompressor({gateway:new ScriptedGateway([],output),model:'qwen-flash'}).compress(items))
  }
})

test('discovery uses bounded Proactive gateway without speech or execution', async () => {
  const gateway=new ScriptedGateway([],JSON.stringify({proposal:null}))
  const proactive=new GatewayProactivity({gateway,model:'same-model',proactivityPreset:'balanced'})
  const snapshot={user_scope:'local',local_date:'2026-09-11',weekday:'Friday',timezone:'Asia/Shanghai',memory:[],evidence_refs:[],recent_delivery:[]}
  assert.equal(await proactive.discover(snapshot,new AbortController().signal),null)
  assert.match(gateway.completions[0]!.system,/json/i,'JSON mode requires an explicit JSON instruction even when source text has no JSON keyword')
  const conflicted=new GatewayProactivity({gateway:new ScriptedGateway([],JSON.stringify({speak:true,suggestion_id:'s-1',progress_class:null,reason:'bad',proposal:{kind:'question',summary:'Q',why_now:'Now',evidence_refs:['conversation:1'],memory_refs:[]}})),model:'same-model',proactivityPreset:'balanced'})
  await assert.rejects(conflicted.select(emptyView),/契约/)
})

test('read-only preparation makes one completion and rejects invented or stale snapshot references',async()=>{
 const snapshot={user_scope:'local',local_date:'2026-09-14',weekday:'Monday',timezone:'Asia/Shanghai',memory:[],evidence_refs:['file:allowed'],recent_delivery:[]}
 const proposal={kind:'question' as const,summary:'Review project',why_now:'meeting today',evidence_refs:['file:allowed'],memory_refs:[]}
 const gateway=new ScriptedGateway([],JSON.stringify({text:'A source-grounded outline',evidence_refs:['file:allowed'],memory_refs:[]}))
 const writer=new GatewayPersonalWriter({gateway,model:'same'})
 const prepared=await writer.prepareProposal(snapshot,proposal,new AbortController().signal)
 assert.equal(prepared?.prepared.trust,'untrusted_external')
 assert.equal(prepared?.prepared.text,'A source-grounded outline')
 assert.equal(gateway.completions.length,1)
 assert.equal(Object.hasOwn(gateway.completions[0]!,'tools'),false)
 for(const refs of [{evidence_refs:['file:invented'],memory_refs:[]},{evidence_refs:[],memory_refs:[{entry_id:'missing',version:1}]}]){
  const invalid=new GatewayPersonalWriter({gateway:new ScriptedGateway([],JSON.stringify({text:'Do this',...refs})),model:'same'})
  assert.equal(await invalid.prepareProposal(snapshot,proposal,new AbortController().signal),null)
 }
 const brief=await writer.prepareBrief(snapshot,{kind:'outlook',local_date:'2026-09-14',timezone:'Asia/Shanghai',scheduled_at:'2026-09-14T00:30:00Z',dedupe_key:'brief:test'},new AbortController().signal)
 assert.equal(brief?.action_label,'查看简报')
 assert.equal(gateway.completions.length,2)
})


test('preparation rejects a stale active-memory version and skips an empty snapshot',async()=>{
 const memory={id:'m',version:2,content:'Meeting plan',kind:'plan' as const,origin:'stated' as const,source_refs:[{type:'conversation' as const,ref:'conversation:1',observed_at:'2026-09-14T00:00:00Z'}],observed_at:'2026-09-14T00:00:00Z',recorded_at:'2026-09-14T00:00:00Z',topic:'work',status:'active' as const,corrected_to:null,confidence_note:null}
 const snapshot={user_scope:'local',local_date:'2026-09-14',weekday:'Monday',timezone:'Asia/Shanghai',memory:[memory],evidence_refs:[],recent_delivery:[]}
 const proposal={kind:'question' as const,summary:'Meeting',why_now:'today',evidence_refs:[],memory_refs:[{entry_id:'m',version:2}]}
 const gateway=new ScriptedGateway([],JSON.stringify({text:'Prepared',evidence_refs:[],memory_refs:[{entry_id:'m',version:1}]}))
 const writer=new GatewayPersonalWriter({gateway,model:'same'})
 assert.equal(await writer.prepareProposal(snapshot,proposal,new AbortController().signal),null)
 assert.equal(await writer.prepareProposal({...snapshot,memory:[]},proposal,new AbortController().signal),null)
 assert.equal(gateway.completions.length,1)
})


test('Proactive receives the actual progress trigger, not an unlabelled snapshot', async () => {
  const gateway = new ScriptedGateway([], '{"speak":false,"suggestion_id":null,"progress_class":"routine_delta","reason":"counter only"}')
  const proactive = new GatewayProactivity({gateway, model: 'm', proactivityPreset: 'eager'})
  await proactive.select({...emptyView, trigger_kind: 'progress'})
  assert.match(gateway.completions[0]!.prompt, /当前触发事件：progress/u)
})

test('task verifier sends its actual decision schema through the JSON-object gateway and applies a correction',async()=>{
 const {OpenAIModelGateway}=await import('../src/model/model-gateway.js'),{TaskService}=await import('../src/personal-agent/tasks.js'),{taskDecisionSchema}=await import('../src/personal-agent/task-loop.js'),{z}=await import('zod')
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-verifier-schema-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{
  await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',goal:'Three steps',acceptance:['three distinct steps'],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.recordDelivery(fence,'first','Step one only');const evidence=tasks.evidence(task.id)
  const decision={kind:'correct' as const,instruction:'Provide all three distinct steps',evidence_refs:[evidence[0]!.ref]};let requests=0,receivedSchema:unknown,receivedFormat:unknown
  const gateway=new OpenAIModelGateway({baseUrl:'https://example.invalid/v1',apiKey:'test',clock:new VirtualClock(),metrics:{record:()=>undefined},fetch:(_url,init)=>{
   assert.ok(typeof init?.body==='string')
   const body=JSON.parse(init.body) as {messages:{role:string;content:string}[];response_format:unknown},prompt=JSON.parse(body.messages.find(message=>message.role==='user')!.content) as {output_schema:unknown}
   requests++;receivedFormat=body.response_format;receivedSchema=prompt.output_schema
   return Promise.resolve(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(decision)}}]}),{status:200}))
  }})
  const verifier=new GatewayTaskVerifier({gateway,model:'test'}),actual=await verifier.evaluateTask(task,evidence,new AbortController().signal)
  assert.deepEqual(receivedFormat,{type:'json_object'});assert.deepEqual(receivedSchema,z.toJSONSchema(taskDecisionSchema));assert.deepEqual(actual,decision);const corrected=await tasks.applyDecision(fence,actual);assert.equal(corrected.corrections,1);assert.equal(corrected.phase,'queued');assert.equal(requests,1)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('task evaluation separates accepted user steering from executor evidence and requests durable reconciliation',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),dir=await mkdtemp(join(await realpath(tmpdir()),'task-input-verifier-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{await tasks.open();let task=await tasks.delegate('declare',{conversation_id:'c',goal:'red',acceptance:['red observed'],origin_ref:'user:1'});let fence={task_id:task.id,control_revision:0,goal_revision:0};await tasks.bindWork(fence,'work','session');task=await tasks.controlClient('take',fence,'client','takeover');fence={...fence,control_revision:task.control_revision};await tasks.input('blue',fence,task.controller,'session','Change goal to blue',()=>Promise.resolve('accepted'));task=await tasks.controlClient('return',fence,'client','return')
 const decision={kind:'reconcile',input_refs:['blue'],goal_change:{goal:'blue',acceptance:['blue observed']}},gateway=new ScriptedGateway([],JSON.stringify(decision)),verifier=new GatewayTaskVerifier({gateway,model:'test'})
 const evaluate=verifier.evaluateTask.bind(verifier) as (...args:unknown[])=>Promise<unknown>;assert.deepEqual(await evaluate(task,[],new AbortController().signal,tasks.inputReceipts(task.id)),decision)
 const prompt=JSON.parse(gateway.completions[0]!.prompt) as {accepted_user_inputs:{request_id:string;text:string}[]};assert.deepEqual(prompt.accepted_user_inputs.map(x=>({request_id:x.request_id,text:x.text})),[{request_id:'blue',text:'Change goal to blue'}])
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('workbench generation includes its schema in the provider-visible prompt',async()=>{
 const gateway=new ScriptedGateway([],JSON.stringify({cards:[]}))
 const writer=new GatewayPersonalWriter({gateway,model:'same'})
 await writer.generateContext([{candidate_id:'c1',id:'c1',version:'v1',content:'A project document',tab:'ideas',primaryFileId:'doc',refs:[{entry_id:'source:doc',version:'v1'}],excerpt:'A project document',reason_code:'document_idea',root:'/project',priority:0,mtime_ms:1}],new AbortController().signal)
 const prompt=JSON.parse(gateway.completions[0]!.prompt) as {output_schema:{properties:{cards:unknown}}}
 assert.ok(prompt.output_schema.properties.cards)
 assert.doesNotMatch(gateway.completions[0]!.prompt,/\/project/u)
 assert.match(gateway.completions[0]!.system,/正文只写一句话/u)
 assert.match(gateway.completions[0]!.system,/每类最多三张/u)
 assert.equal(gateway.completions[0]!.maxTokens,4000,'nine full cards fit under the ceiling')
 const sent=(JSON.parse(gateway.completions[0]!.prompt) as {candidates:Record<string,unknown>[]}).candidates
 assert.deepEqual(sent,[{key:'c1',tab:'ideas',excerpt:'A project document',reason_code:'document_idea'}],'identifiers and refs stay with the adapter')
})
test('context cards cite short keys, and the adapter restores each candidate, its tab and its refs',async()=>{
 const candidate=(id:string,tab:'todos'|'ideas'|'goals',refs:number)=>({candidate_id:id,id,version:'v1',content:'x',tab,primaryFileId:null,refs:Array.from({length:refs},(_,i)=>({entry_id:'source:'+id+String(i),version:'v'+String(i)})),excerpt:'x',reason_code:tab==='todos'?'project_focus' as const:tab==='goals'?'project_direction' as const:'document_idea' as const,root:'project:'+id,priority:3,mtime_ms:0})
 const candidates=[candidate('long-todo-a','todos',6),candidate('long-todo-b','todos',6),candidate('long-idea','ideas',1),candidate('long-goal','goals',2)]
 const card=(key:string,title:string)=>({key,title,body:'B',why:null,next:null})
 const reply={recap:{text:'近况',keys:['c1','c2','c3','c9']},cards:[card('c1','a'),card('c9','forged'),card('c3','idea'),card('c4','goal'),{...card('c2','no refs'),refs:[]},card('c2','b')]}
 const gateway=new ScriptedGateway([],JSON.stringify(reply))
 const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateContext(candidates,new AbortController().signal)
 assert.deepEqual(result.cards.map(item=>[item.candidate_id,item.tab,item.title]),[['long-todo-a','todos','a'],['long-idea','ideas','idea'],['long-goal','goals','goal'],['long-todo-b','todos','b']],'a forged key or an unknown field drops only that card')
 assert.deepEqual(result.cards[2]!.refs,candidates[3]!.refs)
 assert.equal(result.recap,null,'one forged or ungrounded key rejects the whole recap')
 const valid=await new GatewayPersonalWriter({gateway:new ScriptedGateway([],JSON.stringify({...reply,recap:{text:'近况',keys:['c1','c2']}})),model:'m'}).generateContext(candidates,new AbortController().signal)
 assert.deepEqual(valid.recap?.refs.map(ref=>ref.entry_id),['source:long-todo-a0','source:long-todo-b0','source:long-todo-a1','source:long-todo-b1','source:long-todo-a2','source:long-todo-b2','source:long-todo-a3','source:long-todo-b3'],'the recap takes todo refs in turn, at most eight')
 const onlyIdea=await new GatewayPersonalWriter({gateway:new ScriptedGateway([],JSON.stringify({recap:{text:'近况',keys:['c3']},cards:[]})),model:'m'}).generateContext(candidates,new AbortController().signal)
 assert.equal(onlyIdea.recap,null,'a recap citing no todo candidate is withheld')
})
test('recap keys must all resolve and every non-todo ref must have exact todo grounding',async()=>{
 const a={entry_id:'source:a',version:'v1'},b={entry_id:'source:b',version:'v1'},privateRef={entry_id:'memory:private',version:'v1'}
 const candidate=(id:string,tab:'todos'|'ideas'|'goals',refs:typeof a[])=>({candidate_id:id,id,version:'v1',content:'x',tab,primaryFileId:null,refs,excerpt:'x',reason_code:tab==='todos'?'project_focus' as const:tab==='goals'?'project_direction' as const:'stated_idea' as const,root:'project:nova',priority:3,mtime_ms:0})
 const candidates=[candidate('todo','todos',[a,b]),candidate('goal','goals',[a,b]),candidate('partial-goal','goals',[a,privateRef]),candidate('stale-goal','goals',[a,{...b,version:'v2'}]),candidate('idea','ideas',[privateRef]),candidate('empty-goal','goals',[])]
 for(const keys of [['c1','c9'],['c1','c3'],['c1','c4'],['c1','c5'],['c1','c6'],['c5']]){
  const gateway=new ScriptedGateway([],JSON.stringify({recap:{text:'工作台和私人计划。',keys},cards:[]}))
  const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateContext(candidates,new AbortController().signal)
  assert.equal(result.recap,null,`reject the entire recap for ${keys.join(',')}`)
 }
 for(const keys of [['c2'],['c1','c2','c2']]){
  const gateway=new ScriptedGateway([],JSON.stringify({recap:{text:'这周主要在做工作台。',keys},cards:[]}))
  const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateContext(candidates,new AbortController().signal)
  assert.deepEqual(result.recap,{text:'这周主要在做工作台。',refs:[a,b]},'same-project goal refs are fully backed by a todo, with duplicates removed')
 }
})
test('a cut-off context reply retries once with half the candidates, and each tab keeps at most three cards',async()=>{
 const candidate=(id:string)=>({candidate_id:id,id,version:'v1',content:'A project document',tab:'todos' as const,primaryFileId:id,refs:[{entry_id:'source:'+id,version:'v1'}],excerpt:'A project document',reason_code:'document_action' as const,root:'/project',priority:0,mtime_ms:1})
 const card=(key:string)=>({key,title:'T'+key,body:'B',why:null,next:null})
 const replies=['{"recap":null,"cards":[{"key":"c1","title":"cut',JSON.stringify({recap:null,cards:[card('c1'),card('c2'),card('c3'),card('c4'),card('c5')]})]
 const prompts:string[]=[]
 const gateway={complete:(request:CompleteRequest)=>{prompts.push(request.prompt);return Promise.resolve({text:replies.shift()!})}} as unknown as ModelGateway
 const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateContext([...['a','b','c','d'].map(candidate),{...candidate('e'),tab:'ideas' as const}],new AbortController().signal)
 assert.equal(prompts.length,2);assert.equal((JSON.parse(prompts[1]!) as {candidates:unknown[]}).candidates.length,3)
 assert.deepEqual(result.cards.map(item=>item.candidate_id),['a','b','c'],'the retry only knows its own three keys, and each tab keeps at most three')
 const broken={complete:()=>Promise.resolve({text:'{'})} as unknown as ModelGateway
 await assert.rejects(new GatewayPersonalWriter({gateway:broken,model:'m'}).generateContext([candidate('a'),candidate('b')],new AbortController().signal),SyntaxError,'a second failure surfaces for the backoff')
})
test('workbench generation allows no candidates and makes no model call',async()=>{
 const gateway=new ScriptedGateway([],JSON.stringify({cards:[]}))
 const writer=new GatewayPersonalWriter({gateway,model:'same'})
 assert.deepEqual(await writer.generateContext([],new AbortController().signal),{recap:null,cards:[]})
 assert.equal(gateway.completions.length,0)
})
test('a queued digest batch re-checks consent when it leaves the lane, and never sends after revocation',async()=>{
 class HeldGateway extends ScriptedGateway{release!:()=>void
  override complete(request:CompleteRequest):Promise<GatewayCompletion>{this.completions.push(request);if(this.completions.length>1)return Promise.resolve({text:JSON.stringify({digests:[]})});return new Promise(r=>{this.release=()=>r({text:JSON.stringify({cards:[]})})})}}
 const gateway=new HeldGateway(),writer=new GatewayPersonalWriter({gateway,model:'same'})
 const candidate={candidate_id:'c1',id:'c1',version:'v1',content:'x',tab:'ideas' as const,primaryFileId:'doc',refs:[{entry_id:'source:doc',version:'v1'}],excerpt:'x',reason_code:'document_idea' as const,root:'/p',priority:0,mtime_ms:1}
 const foreground=writer.generateContext([candidate],new AbortController().signal)
 let consented=true
 const digest=writer.generateDigests([{project_key:'k',name:'p',signals:{tier:1,own_commits_30d:0,last_own_commit_days:null,last_modified_days:0},documents:[{entry_id:'source:doc',version:'v1',document:'README.md',excerpt:'x'}]}],new AbortController().signal,()=>{if(!consented)throw Error('processing_consent_required')})
 await new Promise(r=>setImmediate(r));assert.equal(gateway.completions.length,1,'the digest waits behind foreground work')
 consented=false;gateway.release();await foreground
 await assert.rejects(digest,/processing_consent_required/u);assert.equal(gateway.completions.length,1,'no digest request was sent')
})


test('coding evaluator cannot complete from prose, truncated checks, or another work/session',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),dir=await mkdtemp(join(await realpath(tmpdir()),'task-proof-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{
  await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Run checks',acceptance:['actual check output'],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.bindWork(fence,'work','session')
  await tasks.appendEvent({task_id:task.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',item_id:'check',kind:'tool',stage:'completed',text:JSON.stringify({type:'commandExecution',status:'completed',command:'node --test',output:'1 passed',exit_code:0}),refs:[]},'check')
  await tasks.recordWorkOutcome('work','ok',{worker:'codex',final_message:'All tests and UI passed'})
  const current=tasks.get(task.id),valid=tasks.evidence(task.id),decision={kind:'complete',evidence_refs:[valid[0]!.ref],criteria:[{index:0,evidence_refs:[valid[0]!.ref]}]}
  for(const invalid of [
   {...valid[0]!,observations:[]},
   {...valid[0]!,outcome:'failed'},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,text:JSON.stringify({type:'commandExecution',status:'completed',command:'node --test',output:'test failed',exit_code:1})}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,text_truncated:true}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,thread_id:undefined}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,text:JSON.stringify({type:'mcpToolCall',server:'cua_live',tool:'js',status:'completed',is_error:true,readback:'tool failed'})}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,work_id:'other'}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,session_id:'other'}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,text:'commandExecution completed'}]},
  ]){
   const gateway=new ScriptedGateway([],JSON.stringify(decision)),verifier=new GatewayTaskVerifier({gateway,model:'test'})
   assert.equal((await verifier.evaluateTask(current,[invalid],new AbortController().signal)).kind,'wait')
   assert.equal((await verifier.evaluateTask({...current,execution_route:undefined},[invalid],new AbortController().signal)).kind,'wait')
  }
  const gateway=new ScriptedGateway([],JSON.stringify(decision)),verifier=new GatewayTaskVerifier({gateway,model:'test'})
  assert.deepEqual(await verifier.evaluateTask(current,valid,new AbortController().signal),decision)
  assert.deepEqual((JSON.parse(gateway.completions[0]!.prompt) as {evidence:{observations:unknown}[]}).evidence[0]!.observations,valid[0]!.observations)
  const mcp=structuredClone(valid);mcp[0]!.observations[0]!.text=JSON.stringify({type:'mcpToolCall',server:'cua_live',tool:'js',status:'completed',is_error:false,readback:'Counter value: 1'})
  assert.deepEqual(await verifier.evaluateTask(current,mcp,new AbortController().signal),decision)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})


test('coding evaluator can use complete later checks despite an unrelated truncated observation',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),dir=await mkdtemp(join(await realpath(tmpdir()),'task-partial-proof-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{
  await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Verify the fix',acceptance:['actual check output'],origin_ref:'user:1'})
  await tasks.bindWork({task_id:task.id,control_revision:0,goal_revision:0},'work','session')
  const identity={task_id:task.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',kind:'tool' as const,stage:'completed' as const,refs:[]}
  await tasks.appendEvent({...identity,item_id:'docs',text_truncated:true,text:'Truncated tool documentation'},'docs')
  await tasks.appendEvent({...identity,item_id:'test',text:JSON.stringify({type:'commandExecution',status:'completed',command:'node --test',output:'1 passed',exit_code:0})},'test')
  await tasks.recordWorkOutcome('work','ok',{worker:'codex',final_message:'Done'})
  const current=tasks.get(task.id),evidence=tasks.evidence(task.id),decision={kind:'complete',evidence_refs:[evidence[0]!.ref],criteria:[{index:0,evidence_refs:[evidence[0]!.ref]}]}
  assert.equal(evidence[0]!.observations_truncated,true)
  const gateway=new ScriptedGateway([],JSON.stringify(decision)),verifier=new GatewayTaskVerifier({gateway,model:'test'})
  assert.deepEqual(await verifier.evaluateTask(current,evidence,new AbortController().signal),decision)
  assert.equal((JSON.parse(gateway.completions[0]!.prompt) as {evidence:{observations_truncated:boolean}[]}).evidence[0]!.observations_truncated,true)
  const mcp=structuredClone(evidence);mcp[0]!.observations[1]!.text=JSON.stringify({type:'mcpToolCall',server:'cua_live',tool:'js',status:'completed',is_error:false,readback:'Counter value: 2'})
  assert.deepEqual(await verifier.evaluateTask(current,mcp,new AbortController().signal),decision)
  for(const incomplete of [evidence,mcp]){
   incomplete[0]!.observations[1]!.text_truncated=true
   assert.equal((await verifier.evaluateTask(current,incomplete,new AbortController().signal)).kind,'wait')
  }
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('a verifier completion must map every criterion to evidence, and listing files is not a check',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),dir=await mkdtemp(join(await realpath(tmpdir()),'task-criteria-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{
  await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Fix and test',acceptance:['bug fixed','tests pass'],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.bindWork(fence,'work','session')
  const identity={task_id:task.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',kind:'tool' as const,stage:'completed' as const,refs:[]}
  await tasks.appendEvent({...identity,item_id:'ls',text:JSON.stringify({type:'commandExecution',status:'completed',command:"/bin/zsh -lc 'cd app && ls -la'",output:'a b',exit_code:0})},'ls')
  await tasks.recordWorkOutcome('work','ok',{worker:'codex',final_message:'Done'})
  const current=tasks.get(task.id),ref=tasks.evidence(task.id)[0]!.ref,run=async(decision:object)=>new GatewayTaskVerifier({gateway:new ScriptedGateway([],JSON.stringify(decision)),model:'test'}).evaluateTask(current,tasks.evidence(task.id),new AbortController().signal)
  assert.equal((await run({kind:'complete',evidence_refs:[ref],criteria:[{index:0,evidence_refs:[ref]}]})).kind,'wait','criterion 1 has no evidence')
  assert.equal((await run({kind:'complete',evidence_refs:[ref]})).kind,'wait','no mapping at all')
  assert.equal((await run({kind:'complete',evidence_refs:[ref],criteria:[{index:0,evidence_refs:[ref]},{index:1,evidence_refs:[ref]}]})).kind,'wait','ls is not a check')
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('a coding task without criteria completes on a bound check, and wrapped no-ops are not checks',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js')
 const verdict=async(command:string)=>{
  const dir=await mkdtemp(join(await realpath(tmpdir()),'task-check-')),tasks=new TaskService(join(dir,'tasks.json'))
  try{
   await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Fix and test',acceptance:[],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
   await tasks.bindWork(fence,'work','session')
   await tasks.appendEvent({task_id:task.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',kind:'tool',stage:'completed',refs:[],item_id:'check',text:JSON.stringify({type:'commandExecution',status:'completed',command,output:'ok',exit_code:0})},'check')
   await tasks.recordWorkOutcome('work','ok',{worker:'codex',final_message:'Done'})
   const ref=tasks.evidence(task.id)[0]!.ref
   return (await new GatewayTaskVerifier({gateway:new ScriptedGateway([],JSON.stringify({kind:'complete',evidence_refs:[ref]})),model:'test'}).evaluateTask(tasks.get(task.id),tasks.evidence(task.id),new AbortController().signal)).kind
  }finally{await rm(dir,{recursive:true,force:true})}
 }
 assert.equal(await verdict('node --test'),'complete')
 assert.equal(await verdict('env CI=1 node --test'),'complete')
 assert.equal(await verdict('cat README.md\nnode --test'),'complete')
 assert.equal(await verdict('command true'),'wait')
 assert.equal(await verdict('env'),'wait')
 assert.equal(await verdict("/bin/zsh -lc 'cd app && ls'"),'wait')
})

test('a check observed in another session of the same task does not prove a work bound to a different session',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),dir=await mkdtemp(join(await realpath(tmpdir()),'task-work-session-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{
  await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Fix and test',acceptance:[],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.bindWork(fence,'work','session-a');await tasks.bindWork(fence,'other','session-b')
  await tasks.appendEvent({task_id:task.id,work_id:'work',session_id:'session-b',thread_id:'thread',turn_id:'turn',kind:'tool',stage:'completed',refs:[],item_id:'check',text:JSON.stringify({type:'commandExecution',status:'completed',command:'node --test',output:'ok',exit_code:0})},'check')
  await tasks.recordWorkOutcome('work','ok',{worker:'codex',final_message:'Done'})
  const ref=tasks.evidence(task.id)[0]!.ref
  assert.equal((await new GatewayTaskVerifier({gateway:new ScriptedGateway([],JSON.stringify({kind:'complete',evidence_refs:[ref]})),model:'test'}).evaluateTask(tasks.get(task.id),tasks.evidence(task.id),new AbortController().signal)).kind,'wait')
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('verifier retries once with validation_feedback when the reply is unparsable, schema-invalid, or cites unknown/missing/out-of-range refs',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),{TaskCheckError}=await import('../src/personal-agent/task-loop.js'),{GatewayError}=await import('../src/model/model-gateway.js')
 const dir=await mkdtemp(join(await realpath(tmpdir()),'task-verifier-retry-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{
  await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Fix',acceptance:['tests pass'],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.bindWork(fence,'work','session')
  await tasks.appendEvent({task_id:task.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',kind:'tool',stage:'completed',refs:[],item_id:'check',text:JSON.stringify({type:'commandExecution',status:'completed',command:'node --test',output:'ok',exit_code:0})},'check')
  await tasks.recordWorkOutcome('work','ok',{worker:'codex',final_message:'Done'})
  const current=tasks.get(task.id),ref=tasks.evidence(task.id)[0]!.ref
  const good=JSON.stringify({kind:'complete',evidence_refs:[ref],criteria:[{index:0,evidence_refs:[ref]}]})
  const cases:[string,string][]=[['not json','json_parse'],[JSON.stringify({kind:'wait',reason:'hold',evidence_refs:[],criteria:[{index:0,evidence_refs:[ref]}]}),'schema'],[JSON.stringify({kind:'correct',instruction:'retry',evidence_refs:['call_00_x']}),'evidence_ref'],[JSON.stringify({kind:'complete',evidence_refs:[],criteria:[{index:0,evidence_refs:[ref]}]}),'evidence_ref'],[JSON.stringify({kind:'complete',evidence_refs:[ref],criteria:[{index:1,evidence_refs:[ref]}]}),'evidence_ref']]
  for(const [bad,stage] of cases){
   const gateway=new QueuedGateway([bad,good]),actual=await new GatewayTaskVerifier({gateway,model:'test'}).evaluateTask(current,tasks.evidence(task.id),new AbortController().signal)
   assert.equal(actual.kind,'complete');assert.equal(gateway.completions.length,2)
   const first=JSON.parse(gateway.completions[0]!.prompt) as {valid_evidence_refs:string[]},second=JSON.parse(gateway.completions[1]!.prompt) as {validation_feedback:{stage:string;valid_evidence_refs:string[];previous_response:string}}
   assert.deepEqual(first.valid_evidence_refs,[ref]);assert.equal(second.validation_feedback.stage,stage);assert.deepEqual(second.validation_feedback.valid_evidence_refs,[ref]);assert.ok(second.validation_feedback.previous_response.length<=2000)
  }
  // Live qwen-max shape: a bare string where an array is required; feedback must name the path and expected type.
  const scalar=new QueuedGateway([JSON.stringify({kind:'complete',evidence_refs:[ref],criteria:[{index:0,evidence_refs:ref}]}),good])
  assert.equal((await new GatewayTaskVerifier({gateway:scalar,model:'test'}).evaluateTask(current,tasks.evidence(task.id),new AbortController().signal)).kind,'complete')
  const repair=(JSON.parse(scalar.completions[1]!.prompt) as {validation_feedback:{issues:{path:string;message:string}[]}}).validation_feedback
  assert.equal(repair.issues[0]?.path,'criteria.0.evidence_refs');assert.match(repair.issues[0]?.message ?? '',/array/)
  const indexed=new QueuedGateway([JSON.stringify({kind:'complete',evidence_refs:[ref],criteria:[{index:3,evidence_refs:[ref]}]}),good])
  await new GatewayTaskVerifier({gateway:indexed,model:'test'}).evaluateTask(current,tasks.evidence(task.id),new AbortController().signal)
  assert.match((JSON.parse(indexed.completions[1]!.prompt) as {validation_feedback:{hint:string}}).validation_feedback.hint,/\[0, 1\)/)
  const twice=new QueuedGateway([JSON.stringify({kind:'complete',evidence_refs:[ref],criteria:[{index:1,evidence_refs:[ref]}]}),JSON.stringify({kind:'complete',evidence_refs:[ref],criteria:[{index:2,evidence_refs:[ref]}]})])
  await assert.rejects(new GatewayTaskVerifier({gateway:twice,model:'test'}).evaluateTask(current,tasks.evidence(task.id),new AbortController().signal),error=>error instanceof TaskCheckError&&error.stage==='evidence_ref'&&error.code==='criterion_index')
  assert.equal(twice.completions.length,2)
  // First reply unknown ref retries; second has valid refs but only inspect-only observations so bound check fails.
  const inspectDir=await mkdtemp(join(await realpath(tmpdir()),'task-verifier-nocheck-')),inspectTasks=new TaskService(join(inspectDir,'tasks.json'))
  await inspectTasks.open();const inspectTask=await inspectTasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Fix',acceptance:['tests pass'],origin_ref:'user:1'}),inspectFence={task_id:inspectTask.id,control_revision:0,goal_revision:0}
  await inspectTasks.bindWork(inspectFence,'work','session');await inspectTasks.appendEvent({task_id:inspectTask.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',kind:'tool',stage:'completed',refs:[],item_id:'ls',text:JSON.stringify({type:'commandExecution',status:'completed',command:'ls',output:'a',exit_code:0})},'ls');await inspectTasks.recordWorkOutcome('work','ok',{worker:'codex'})
  const inspectRef=inspectTasks.evidence(inspectTask.id)[0]!.ref
  const inspectGateway=new QueuedGateway([JSON.stringify({kind:'complete',evidence_refs:[inspectRef],criteria:[{index:0,evidence_refs:['nope']}]}),JSON.stringify({kind:'complete',evidence_refs:[inspectRef],criteria:[{index:0,evidence_refs:[inspectRef]}]})])
  assert.equal((await new GatewayTaskVerifier({gateway:inspectGateway,model:'test'}).evaluateTask(inspectTasks.get(inspectTask.id),inspectTasks.evidence(inspectTask.id),new AbortController().signal)).kind,'wait')
  await inspectTasks.close();await rm(inspectDir,{recursive:true,force:true})
  const transport=new QueuedGateway([],new GatewayError('TimeoutError'))
  await assert.rejects(new GatewayTaskVerifier({gateway:transport,model:'test'}).evaluateTask(current,tasks.evidence(task.id),new AbortController().signal),error=>error instanceof TaskCheckError&&error.stage==='model_call'&&error.code==='timeout_error')
  assert.equal(transport.completions.length,1)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})


test('compressor rejects oversized excerpts without truncating source facts', async () => {
  const items = [{channel:'conversation',seq:1,ts:1,trust:'untrusted_external',priority:100,content:{text:'x'.repeat(16001)},refs:[],outcome:null}] as MemoryItem[]
  await assert.rejects(new GatewayCompressor({gateway:new ScriptedGateway([],JSON.stringify({refs:['conversation:1']})),model:'qwen-flash'}).compress(items),/exceeds budget/)
  const gateway = new ScriptedGateway([], 'must not be used')
  assert.equal(await new GatewayCompressor({gateway,model:'qwen-flash'}).compress([]),'')
  assert.equal(gateway.completions.length,0)
})


test('compressor fits whole selected records and preserves trust, time, refs and source order', async () => {
  const items = [
    {channel:'codex',seq:1,ts:1,trust:'untrusted_external',priority:50,content:{text:'x'.repeat(17000)},refs:[],outcome:'ok'},
    {channel:'codex',seq:2,ts:2,trust:'untrusted_external',priority:50,content:{text:'34 passed; 2 failed; audit is NOT complete'},refs:['conversation:1'],outcome:'unknown'},
    {channel:'conversation',seq:1,ts:3,trust:'trusted_user',priority:100,content:{text:'Do not release'},refs:[],outcome:null},
  ] as MemoryItem[]
  const summary=await new GatewayCompressor({gateway:new ScriptedGateway([],JSON.stringify({refs:['conversation:1','codex:1','codex:2']})),model:'qwen-flash'}).compress(items)
  assert.equal(summary.slice(summary.indexOf('\n')+1),compressorPrompt(items.slice(1)))
})

interface ProfileProse {about:{paragraphs:{text:string;refs:string[]}[]}|null;work:{title:string;text:string;refs:string[]}[];interests:{text:string;refs:string[]}[]}
const profileProse=(text:string,refs:string[]):ProfileProse=>({about:{paragraphs:[{text,refs}]},work:[],interests:[]})
function profileFixtureGateway(compose:(request:CompleteRequest)=>unknown,edit?:(request:CompleteRequest)=>ProfileProse):ModelGateway{
 return {complete:(request:CompleteRequest)=>Promise.resolve({text:JSON.stringify(request.system.includes('独立审查整份画像草稿')?{review_notes:[]}:request.system.includes('统一修订整份画像')?{profile:edit?edit(request):(JSON.parse(request.prompt) as {profile:ProfileProse}).profile,review_notes:['private editorial note']}:compose(request))})} as unknown as ModelGateway
}

test('Profile restores exact original references and keeps review notes out of natural prose',async()=>{
 const original={id:'source:'+('a'.repeat(64)),version:'b'.repeat(64),content:'我在设计语音助手',origin:'stated' as const};let prompt=''
 const gateway=profileFixtureGateway(request=>{prompt=request.prompt;return profileProse('你在设计语音助手。',['e0'])})
 const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateProfile([original],new AbortController().signal)
 assert.deepEqual(result.about?.refs,[{entry_id:original.id,version:original.version}]);assert.equal(result.about?.text,'你在设计语音助手。');assert(!prompt.includes(original.id));assert(!prompt.includes(original.version))
})

test('Profile carries time, author, recipients and reply links while screening explicit credentials',async()=>{
 const requests:CompleteRequest[]=[];const gateway=profileFixtureGateway(request=>{requests.push(request);return profileProse('你考虑请同事协助部署。',['e0'])},request=>{requests.push(request);return (JSON.parse(request.prompt) as {profile:ProfileProse}).profile})
 await new GatewayPersonalWriter({gateway,model:'m'}).generateProfile([{id:'msg',version:1,origin:'inferred',content:'@Alex请协助部署。 password=test-only-secret',observed_at:'2026-10-10T00:00:00Z',source:{kind:'im',project:'IM',document:'消息',sender_id:'self',sender_name:'Self',relation:'self',thread_id:'thread',message_id:'message',parent_id:'outside',mention_ids:['alex']}}],new AbortController().signal)
 assert.equal(requests.length,2);for(const request of requests){assert(!request.prompt.includes('test-only-secret'));assert(request.prompt.includes('2026-10-10T00:00:00Z'));assert(request.prompt.includes('outside_authorized_sample'));assert.equal(request.reasoning,'enabled')}
 const input=JSON.parse(requests[0]!.prompt) as {entries:{sender:string;relation:string;targets:string[]}[]};assert.equal(input.entries[0]!.sender,'self');assert.equal(input.entries[0]!.relation,'self');assert.equal(input.entries[0]!.targets.length,1)
})

test('a summary reply that overruns its limit or cites another batch is trimmed instead of failing the profile',async()=>{
 const entries=Array.from({length:30},(_,i)=>({id:'message-'+i,version:1,origin:'stated' as const,content:'我设计语音助手 '+i})),composed:string[][]=[]
 const gateway=profileFixtureGateway(request=>{
  const input=JSON.parse(request.prompt) as {messages?:{id:string}[];entries?:{id:string}[]}
  if(input.messages)return {facts:[...Array.from({length:30},(_,i)=>({text:'index '+i,refs:[input.messages![i%input.messages!.length]!.id]})),{text:'cites a message outside the batch',refs:['e99999']},{text:'x'.repeat(400),refs:input.messages.slice(0,12).map(message=>message.id)},{text:'no support',refs:[]},{text:'',refs:[input.messages[0]!.id]}]}
  composed.push((input.entries??[]).map(entry=>entry.id));return profileProse('你在设计语音助手。',['e0'])
 })
 const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateProfile(entries,new AbortController().signal)
 assert.ok(result.about);assert.ok(composed[0]!.length>0&&composed[0]!.length<=24,'only the first 24 valid facts support evidence')
})

test('rule-based selection gives every kind of observation a share across the whole history',async()=>{
 const entries=Array.from({length:900},(_,i)=>({id:'message-'+i,version:1,origin:'stated' as const,content:'我设计语音助手 '+i+' '+'内容'.repeat(600)}));const kinds:string[]=[]
 const gateway=profileFixtureGateway(request=>{
  const input=JSON.parse(request.prompt) as {messages?:{id:string}[];entries?:{id:string;text:string}[]}
  if(input.messages)return {facts:input.messages.map((message,i)=>({text:['【人】','【风】','【事】'][i%3]+'索引',refs:[message.id]}))}
  const picked=input.entries!;assert.ok(picked.length<=120);kinds.push(...picked.map(entry=>entry.text));return profileProse('你在设计语音助手。',['e0'])
 })
 await new GatewayPersonalWriter({gateway,model:'m'}).generateProfile(entries,new AbortController().signal)
 const numbers=kinds.map(text=>Number(/语音助手 (\d+)/u.exec(text)![1]))
 assert.ok(kinds.length>60&&kinds.length<=120);assert.ok(Math.min(...numbers)<150&&Math.max(...numbers)>750,'the sample spans the whole history')
})

test('a composition that overruns its reference and item counts keeps only items it can cite in full',async()=>{
 const entries=Array.from({length:14},(_,i)=>({id:'message-'+i,version:1,origin:'stated' as const,content:'我设计语音助手 '+i})),all=entries.map((_,i)=>'e'+i),few=['e0','e1','e2']
 const overrun={about:{paragraphs:[...Array.from({length:8},(_,i)=>({text:'你在设计语音助手 '+i+'。',refs:few})),{text:'没有引用的段落。',refs:[]}]},work:[...Array.from({length:9},(_,i)=>({title:'主题'+i,text:'你在做主题 '+i+'。',refs:i%2?all:few})),{title:'没有引用',text:'不能保留。',refs:[]}],interests:Array.from({length:14},(_,i)=>({text:'兴趣'+i,refs:i%2?all:few}))}
 const gateway=profileFixtureGateway(()=>overrun,()=>overrun)
 const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateProfile(entries,new AbortController().signal)
 assert.ok(result.about);assert.equal(result.about.text.split('\n\n').length,6)
 const work=result.work??[];assert.equal(work.length,5,'items citing more than 8 messages are dropped whole, never trimmed');assert.ok(work.every(item=>item.refs.length===3))
 assert.equal(result.interests.length,7);assert.ok(result.interests.every(item=>item.refs.length===3))
})

test('internal message keys and sender aliases never reach the profile prose',async()=>{
 // Synthetic collaborators and RFC 5737 documentation addresses only.
 const entries=Array.from({length:3},(_,i)=>({id:'message-'+i,version:1,origin:'stated' as const,content:'我设计语音助手 '+i}))
 const leaky=(text:string)=>({about:{paragraphs:[{text,refs:['e0']}]},work:[{title:'部署 e5',text:'你和示例甲（p00000001）协作（e14、e40、e91）。',refs:['e1']}],interests:[{text:'示例设计参考图（e50, e51），区间（e12–e15）、（e3–e5，e9）、本地服务（如192.0.2.10:8080、198.51.100.20）',refs:['e2']}]})
 const gateway=profileFixtureGateway(()=>leaky('你与示例乙（p00000002）和示例丙 p00000001 协作，界面渲染限制（e110）要先验证，参考 Qwen3 与 e2e 测试和 Pi5。'))
 const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateProfile(entries,new AbortController().signal)
 const all=[result.about!.text,...(result.work??[]).flatMap(item=>[item.title,item.text]),...result.interests.map(item=>item.text)].join('\n')
 assert.doesNotMatch(all,/\be\d+\b|\bp[0-9a-f]{8}\b|（[\s,，、–—-]*）|\(\s*\)|\d+\.\d+\.\d+\.\d+/u)
 assert.match(all,/示例乙/u);assert.match(all,/示例丙/u);assert.match(all,/Qwen3/u);assert.match(all,/e2e/u);assert.match(all,/Pi5/u)
})

test('a profile item is never kept with fewer citations than its prose needs, so withdrawing any source retires it',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'profile-withdraw-'))
 const entries=Array.from({length:9},(_,i)=>({id:'source-'+i,version:1,origin:'inferred' as const,content:i===8?'项目九只有这份资料支持':'我在做项目'+i,source:{project:'synthetic',document:'doc-'+i}}))
 const draft={about:null,work:[{title:'项目组合',text:'你在做项目零到项目八，也在做项目九。',refs:entries.map((_,i)=>'e'+i)}],interests:[]}
 const gateway=profileFixtureGateway(()=>draft,()=>draft)
 const writer=new GatewayPersonalWriter({gateway,model:'m'}),service=new ProfileWarmup(join(dir,'draft.json'),(input,signal)=>writer.generateProfile(input,signal),()=>{/* observer fixture */})
 try{
  await service.open();service.update(entries);await service.refresh()
  const kept=service.snapshot().draft?.work??[]
  assert.equal(kept.length,0,'a nine-citation item exceeds the eight-citation limit and must not survive with eight citations')
 }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})

test('a profile interest at the generation limit is accepted by the news module',async()=>{
 const entries=[{id:'one',version:1,origin:'stated' as const,content:'我关注AI系统设计'}]
 const within='关'.repeat(100)
 const reply={about:null,work:[],interests:[{text:within,refs:['e0']}]}
 const result=await new GatewayPersonalWriter({gateway:profileFixtureGateway(()=>reply,()=>({about:null,work:[],interests:[{text:within,refs:['e0']}]})),model:'m'}).generateProfile(entries,new AbortController().signal)
 assert.equal(result.interests.length,1);assert.ok(result.interests.every(item=>item.text.length<=100),'the profile stays inside the news module limit')
 const dir=await mkdtemp(join(await realpath(tmpdir()),'profile-news-')),news=new NewsService({path:join(dir,'news.json'),changed:()=>{/* observer fixture */},firstRefreshMs:null})
 try{await news.open?.();assert.equal(await news.seedInterests(result.interests.map(item=>item.text)),true,'every generated interest can seed the news module')}finally{await news.close?.();await rm(dir,{recursive:true,force:true})}
})

test('selection spends its budget across the whole history even when each observation cites several messages',async()=>{
 const entries=Array.from({length:900},(_,i)=>({id:'message-'+i,version:1,origin:'stated' as const,content:'我设计语音助手 '+i+' '+'内容'.repeat(5)}));const seen:number[]=[]
 const gateway=profileFixtureGateway(request=>{
  const input=JSON.parse(request.prompt) as {messages?:{id:string;text:string}[];entries?:{id:string;text:string}[]}
  if(input.messages){const m=input.messages;return {facts:Array.from({length:Math.floor(m.length/3)},(_,i)=>({text:['【人】','【风】','【事】'][i%3]+'索引',refs:[m[i*3]!.id,m[i*3+1]!.id,m[i*3+2]!.id]}))}}
  seen.push(...input.entries!.map(entry=>Number(/语音助手 (\d+)/u.exec(entry.text)![1])));return profileProse('你在设计语音助手。',['e0'])
 })
 await new GatewayPersonalWriter({gateway,model:'m'}).generateProfile(entries,new AbortController().signal)
 assert.ok(seen.length>=60&&seen.length<=120);const sorted=[...seen].sort((a,b)=>a-b)
 assert.ok(sorted[0]!<150&&sorted[sorted.length-1]!>750,'the sample reaches both ends of the history')
 const thirds=[0,1,2].map(third=>seen.filter(n=>n>=third*300&&n<(third+1)*300).length);assert.ok(thirds.every(count=>count>=seen.length*0.2),'no third of the history is starved: '+thirds.join('/'))
})

test('a durable summary store lets a repeated profile run skip batches that already succeeded',async()=>{
 const stored=new Map<string,{text:string;refs:string[]}[]>();let summaries=0
 const store={get:(key:string)=>Promise.resolve(stored.get(key)),set:(key:string,value:{text:string;refs:string[]}[])=>{stored.set(key,value);return Promise.resolve()}}
 const gateway=profileFixtureGateway(request=>{const input=JSON.parse(request.prompt) as {messages?:{id:string}[]};if(input.messages){summaries++;return {facts:[{text:'index only',refs:[input.messages[0]!.id]}]}}return profileProse('你在设计语音助手。',['e0'])})
 const entries=Array.from({length:30},(_,i)=>({id:'message-'+i,version:1,origin:'stated' as const,content:'我设计语音助手 '+i}))
 await new GatewayPersonalWriter({gateway,model:'m',profileSummaryStore:store}).generateProfile(entries,new AbortController().signal)
 const first=summaries;assert.ok(first>=1);assert.equal(stored.size,first)
 await new GatewayPersonalWriter({gateway,model:'m',profileSummaryStore:store}).generateProfile(entries,new AbortController().signal)
 assert.equal(summaries,first)
})

test('large Profile inputs cache unchanged selection summaries without treating their text as facts',async()=>{
 let summaries=0,finals=0
 const gateway=profileFixtureGateway(request=>{const input=JSON.parse(request.prompt) as {messages?:{id:string}[]};if(input.messages){summaries++;return {facts:[{text:'UNSUPPORTED_SUMMARY_INTERPRETATION',refs:[input.messages[0]!.id]}]}}finals++;assert(!request.prompt.includes('UNSUPPORTED_SUMMARY_INTERPRETATION'));return profileProse('你在设计语音助手。',['e0'])},request=>{finals++;assert(!request.prompt.includes('UNSUPPORTED_SUMMARY_INTERPRETATION'));return (JSON.parse(request.prompt) as {profile:ProfileProse}).profile})
 const entries=Array.from({length:30},(_,i)=>({id:'message-'+i,version:1,origin:'stated' as const,content:'我设计语音助手 '+i})),writer=new GatewayPersonalWriter({gateway,model:'m'})
 await writer.generateProfile(entries,new AbortController().signal);await writer.generateProfile(entries,new AbortController().signal);assert.equal(summaries,1);assert.equal(finals,4)
 entries[0]!.version=2;await writer.generateProfile(entries,new AbortController().signal);assert.equal(summaries,2)
})

test('whole Profile editing sees both sections and all cited originals to keep plan states consistent',async()=>{
 let edits=0
 const draft:ProfileProse={about:{paragraphs:[{text:'你已部署云服务器。',refs:['e0']}]},work:[{title:'云资源',text:'你计划采购云服务器。',refs:['e1']}],interests:[]}
 const gateway=profileFixtureGateway(()=>draft,request=>{edits++;const input=JSON.parse(request.prompt) as {profile:ProfileProse;entries:{id:string}[]};assert.equal(input.profile.work.length,1);assert.deepEqual(input.entries.map(x=>x.id),['e0','e1']);return {about:{paragraphs:[{text:'你在准备团队的云资源，已开通账号，接下来计划采购服务器。',refs:['e0','e1']}]},work:[{title:'云资源',text:'你已开通账号，并计划采购服务器。',refs:['e0','e1']}],interests:[]}})
 const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateProfile([{id:'account',version:1,origin:'stated',content:'我已开通账号'},{id:'plan',version:2,origin:'stated',content:'我计划下月采购服务器'}],new AbortController().signal)
 assert.equal(edits,1);assert(result.about?.text.includes('计划'));assert.deepEqual(result.work?.[0]!.refs,[{entry_id:'account',version:1},{entry_id:'plan',version:2}])
})

test('Profile composition and final editing cannot introduce unsupplied references',async()=>{
 const entries=[{id:'own',version:1,origin:'stated' as const,content:'我做语音助手'},{id:'other',version:1,origin:'stated' as const,content:'另一条消息'}]
 await assert.rejects(new GatewayPersonalWriter({gateway:profileFixtureGateway(()=>profileProse('语音',['e9'])),model:'m'}).generateProfile(entries,new AbortController().signal),/invalid_profile_evidence/)
 await assert.rejects(new GatewayPersonalWriter({gateway:profileFixtureGateway(()=>profileProse('语音',['e0']),()=>profileProse('另一个领域',['e9'])),model:'m'}).generateProfile(entries,new AbortController().signal),/invalid_profile_evidence/)
})

test('whole Profile editing receives only the sources selected by batches and their authors',async()=>{
 const gateway=profileFixtureGateway(request=>{const input=JSON.parse(request.prompt) as {messages?:{id:string}[]};if(input.messages)return {facts:[{text:'selected topic',refs:['e0']}]};assert(!request.prompt.includes('UNSELECTED_PERSON'));return profileProse('你关注语音助手。',['e0'])},request=>{assert(!request.prompt.includes('UNSELECTED_PERSON'));assert(!request.prompt.includes('UNSELECTED_CONTENT'));return (JSON.parse(request.prompt) as {profile:ProfileProse}).profile})
 const entries=Array.from({length:30},(_,i)=>({id:'message-'+i,version:1,origin:'stated' as const,content:i===0?'我关注语音助手':'UNSELECTED_CONTENT',source:{kind:'im' as const,project:'IM',document:'消息',relation:'self' as const,sender_id:i===0?'self':'other',sender_name:i===0?'User':'UNSELECTED_PERSON'}}))
 await new GatewayPersonalWriter({gateway,model:'m'}).generateProfile(entries,new AbortController().signal)
})

test('copied message bodies with different media IDs are supplied with the original author, not as self',async()=>{
 const body='@Self I built the simulator for our team. '.repeat(5),source={kind:'im' as const,project:'IM',document:'消息'}
 const gateway=profileFixtureGateway(request=>{const input=JSON.parse(request.prompt) as {entries:{relation:string}[]};assert.equal(input.entries.length,1);assert.equal(input.entries[0]!.relation,'addressed');return {about:null,work:[],interests:[]}})
 const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateProfile([{id:'copy',version:1,origin:'inferred',content:'![Image](new)'+body,observed_at:'2026-10-10T01:00:00Z',source:{...source,relation:'self'}},{id:'original',version:1,origin:'inferred',content:'![Image](old)'+body,observed_at:'2026-10-10T00:00:00Z',source:{...source,relation:'addressed',sender_id:'other'}}],new AbortController().signal)
 assert.equal(result.about,null)
})

test('a later copy does not disqualify the original own statement',async()=>{
 const body='I build a voice assistant for our team. '.repeat(5),source={kind:'im' as const,project:'IM',document:'消息'}
 const result=await new GatewayPersonalWriter({gateway:profileFixtureGateway(()=>profileProse('你做语音助手',['e0'])),model:'m'}).generateProfile([{id:'own',version:1,origin:'stated',content:body,observed_at:'2026-10-10T00:00:00Z',source:{...source,relation:'self'}},{id:'copy',version:1,origin:'inferred',content:body,observed_at:'2026-10-10T01:00:00Z',source:{...source,relation:'addressed',sender_id:'other'}}],new AbortController().signal)
 assert.equal(result.about?.refs[0]?.entry_id,'own')
})

test('natural topic paragraphs preserve multi-message provenance without automatic dates',async()=>{
 const refs=Array.from({length:10},(_,i)=>'e'+i),draft:ProfileProse={about:{paragraphs:[{text:'你关心团队的工具和资源。',refs:refs.slice(0,5)},{text:'你也在打磨语音助手。',refs:refs.slice(5)}]},work:[{title:'语音助手',text:'你在打磨交互体验。',refs:['e9']}],interests:[]}
 const result=await new GatewayPersonalWriter({gateway:profileFixtureGateway(()=>draft),model:'m'}).generateProfile(refs.map((_,i)=>({id:'message-'+i,version:i+1,origin:'stated' as const,content:'我在做工具与语音 '+i,observed_at:'2026-10-10T00:00:00Z'})),new AbortController().signal)
 assert.equal(result.about?.refs.length,10);assert(result.about?.text.includes('\n\n'));assert.equal(result.work?.[0]?.title,'语音助手');assert.equal(result.work?.[0]?.text,'你在打磨交互体验。');assert.deepEqual(result.about?.refs[9],{entry_id:'message-9',version:10})
})

test('an invalid short interest retries only the whole editing call and does not repeat composition',async()=>{
 let compositions=0,edits=0
 const gateway=profileFixtureGateway(()=>{compositions++;return {about:null,work:[],interests:[{text:'AI系统设计',refs:['e0']}] }},request=>{edits++;const schema=request.jsonSchema as {properties:{profile:{properties:{interests:{items:{properties:{text:{maxLength:number}}}}}}}};assert.equal(schema.properties.profile.properties.interests.items.properties.text.maxLength,100);return {about:null,work:[],interests:[{text:edits===1?'x'.repeat(101):'AI系统设计',refs:['e0']}]}})
 const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateProfile([{id:'design',version:1,origin:'stated',content:'我关注AI系统设计'}],new AbortController().signal)
 assert.equal(result.interests[0]?.text,'AI系统设计');assert.equal(edits,2);assert.equal(compositions,1)
})

test('large Profile selection bounds originals by rule and rekeys them without losing versions',async()=>{
 const entries=Array.from({length:150},(_,i)=>({id:'message-'+i,version:i+1,origin:'stated' as const,content:'original content '+i}))
 let selections=0,composed=0
 const gateway=profileFixtureGateway(request=>{
  const input=JSON.parse(request.prompt) as {messages?:{id:string}[];entries?:{id:string;text:string}[]}
  if(input.messages)return {facts:input.messages.map((entry,i)=>({text:(['【事】','【人】','【风】'][i%3])+'索引',refs:[entry.id]}))}
  if(request.system.includes('只选择画像'))selections++
  composed++;const ids=input.entries!.map(entry=>entry.id)
  assert.ok(ids.length>0&&ids.length<=120);assert.deepEqual(ids,ids.map((_,i)=>'e'+i))
  const last=input.entries![ids.length-1]!;return profileProse('你在打磨自己的项目。',[last.id])
 })
 const result=await new GatewayPersonalWriter({gateway,model:'m'}).generateProfile(entries,new AbortController().signal)
 assert.equal(selections,0,'selection no longer costs a model call');assert.equal(composed,1)
 const ref=result.about!.refs[0]!;assert.match(ref.entry_id,/^message-\d+$/);assert.equal(ref.version,Number(ref.entry_id.slice(8))+1)
})

test('a configured independent Profile editor receives originals and does not replace composition or other writers',async()=>{
 let compositions=0,edits=0
 const gateway=profileFixtureGateway(()=>{compositions++;return profileProse('你已部署服务器。',['e0'])})
 const editor={complete:(request:CompleteRequest)=>{edits++;assert.equal(request.model,'editor');assert(request.prompt.includes('我计划采购服务器'));if(request.system.includes('独立审查整份画像草稿'))return Promise.resolve({text:JSON.stringify({review_notes:['采购只是计划，部署完成没有原文支持。']})});assert.deepEqual((JSON.parse(request.prompt) as {review_notes:string[]}).review_notes,['采购只是计划，部署完成没有原文支持。']);return Promise.resolve({text:JSON.stringify({profile:profileProse('你正在准备云资源，计划采购服务器。',['e0']),review_notes:['plan corrected']})})}}
 const result=await new GatewayPersonalWriter({gateway,model:'composer',profileReviewer:{gateway:editor,model:'editor'}}).generateProfile([{id:'plan',version:1,origin:'stated',content:'我计划采购服务器'}],new AbortController().signal)
 assert.equal(compositions,1);assert.equal(edits,2);assert.equal(result.about?.text,'你正在准备云资源，计划采购服务器。');assert.deepEqual(result.about?.refs,[{entry_id:'plan',version:1}])
})

test('timeline writer accepts ordinary signals and restores only supplied short evidence keys',async()=>{
 const card={temporal:{kind:'deadline',dates:[{role:'deadline',date:'2026-10-20',ref:'e0',quote:'2026-10-20'}]},category:'Approval',title:'Check the pending approval',why_now:'Its current status needs checking',facts:[{text:'A request is pending',quote:'request is pending',ref:'e0'}],uncertainty:'No deadline supplied',actions:[{label:'Draft a question',kind:'draft'}],refs:['e0']}
 const gateway=new ScriptedGateway([],JSON.stringify({cards:[card,{...card,refs:['outside']}]}))
 const writer=new GatewayPersonalWriter({gateway,model:'same'})
 const result=await writer.generateTimeline([{id:'ordinary-message',version:'v1',kind:'im',text:'The request is pending. Due 2026-10-20.',observed_at:'2026-10-17T01:00:00Z',relation:'participant'}],{local_date:'2026-10-17',timezone:'Asia/Shanghai'},new AbortController().signal)
 assert.equal(result.cards.length,1);assert.deepEqual(result.cards[0]!.refs,['ordinary-message']);assert.equal(result.cards[0]!.facts[0]!.ref,'ordinary-message');assert.equal(result.cards[0]!.temporal?.dates[0]?.ref,'ordinary-message')
})

test('timeline repairs unsupported event dates once instead of silently losing grounded cards',async()=>{
 let calls=0
 const card={category:'Design',title:'Clarification design advanced',why_now:'A concrete design choice was recorded',facts:[{text:'Ask a question first',quote:'Ask first',ref:'e0'}],uncertainty:'',actions:[],refs:['e0']}
 const gateway={complete:()=>{try{return Promise.resolve(({text:JSON.stringify({cards:[{...card,temporal:calls++===0?{kind:'event',dates:[{role:'occurred',date:'2026-10-17',quote:'Ask first',ref:'e0'}]}:{kind:'synthesis',dates:[]}}]})}))}catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}} as unknown as ModelGateway
 const writer=new GatewayPersonalWriter({gateway,model:'same'})
 const result=await writer.generateTimeline([{id:'m',version:'v1',kind:'im',text:'Ask first',observed_at:'2026-10-13T01:00:00Z'}],{local_date:'2026-10-17',timezone:'Asia/Shanghai'},new AbortController().signal)
 assert.equal(calls,3);assert.equal(result.cards.length,1);assert.deepEqual(result.cards[0]!.temporal?.dates,[])
})

test('timeline can retain nine original references for a multi-day synthesis within conversation limits',async()=>{
 const card={temporal:{kind:'synthesis',dates:[]},category:'Design',title:'Design decisions converged across discussions',why_now:'Several dated messages support the same decision',facts:[{text:'Ask first',quote:'Ask first',ref:'e0'}],uncertainty:'',actions:[],refs:Array.from({length:9},(_,i)=>'e'+i)}
 const gateway=new ScriptedGateway([],JSON.stringify({cards:[card]})),writer=new GatewayPersonalWriter({gateway,model:'same'})
 const result=await writer.generateTimeline(Array.from({length:9},(_,i)=>({id:'m'+i,version:'v1',kind:'im',text:'Ask first',observed_at:'2026-10-13T01:00:00Z'})),{local_date:'2026-10-17',timezone:'Asia/Shanghai'},new AbortController().signal)
 assert.deepEqual(result.cards[0]!.refs,Array.from({length:9},(_,i)=>'m'+i))
})

test('timeline composition preserves conversation boundaries after screening',async()=>{
 const gateway={complete:(request:CompleteRequest)=>{try{
  const prompt=JSON.parse(request.prompt) as {inputs:{group:string}[]}
  assert.notEqual(prompt.inputs[0]!.group,prompt.inputs[1]!.group)
  assert.match(request.system,/仅当原文明示指向同一事项才跨group合并/)
  return Promise.resolve({text:JSON.stringify({cards:[]})});
 }catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}} as unknown as ModelGateway
 const writer=new GatewayPersonalWriter({gateway,model:'fixture'})
 await writer.generateTimeline([{id:'a',version:'1',kind:'im',group:'project-a',text:'Windows UI is updated',observed_at:'2026-10-17T00:00:00Z'},{id:'b',version:'1',kind:'im',group:'project-b',text:'Deploy next week',observed_at:'2026-10-17T00:00:00Z'}],{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal)
})

test('timeline reviews causal claims against bounded original context before publication',async()=>{
 let calls=0
 const card={temporal:{kind:'event',dates:[]},category:'Storage',title:'Alert recovered',why_now:'Cleanup freed capacity',facts:[{text:'The alert recovered',quote:'Alert recovered',ref:'e0'}],uncertainty:'Cause unknown',actions:[],refs:['e0']}
 const gateway={complete:(request:CompleteRequest)=>{try{
  calls++
  if(request.system.includes('现在是发布前的事实校对')){
   const prompt=JSON.parse(request.prompt) as {inputs:{key:string}[]}
   assert.deepEqual(prompt.inputs.map(x=>x.key),['e0','e1'])
   return Promise.resolve({text:JSON.stringify({cards:[{...card,why_now:'The alert recovered; its cause is not reported'}]})});
  }
  return Promise.resolve({text:JSON.stringify({cards:[card]})});
 }catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}} as unknown as ModelGateway
 const writer=new GatewayPersonalWriter({gateway,model:'fixture'})
 const result=await writer.generateTimeline([{id:'alert',version:'1',kind:'im',text:'Alert recovered',observed_at:'2026-10-17T00:00:00Z'},{id:'other',version:'1',kind:'im',text:'Unrelated data',observed_at:'2026-10-17T00:00:00Z'}],{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal)
 assert.equal(calls,2);assert.equal(result.cards[0]!.why_now,'The alert recovered; its cause is not reported')
})

test('one malformed card after repair does not discard unrelated grounded cards',async()=>{
 const card={temporal:{kind:'event',dates:[]},category:'Storage',title:'Alert recovered',why_now:'An update was reported',facts:[{text:'Alert recovered',quote:'Alert recovered',ref:'e0'}],uncertainty:'',actions:[],refs:['e0']}
 const gateway=new ScriptedGateway([],JSON.stringify({cards:[card,{...card,title:'x'.repeat(200)}]}))
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline([{id:'alert',version:'1',kind:'im',text:'Alert recovered',observed_at:'2026-10-17T00:00:00Z'}],{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal)
 assert.equal(result.cards.length,1);assert.equal(result.cards[0]!.title,'Alert recovered')
})

test('timeline accepts a complete fenced JSON response from a reasoning model',async()=>{
 const card={temporal:{kind:'event',dates:[]},category:'Storage',title:'Alert recovered',why_now:'An update was reported',facts:[{text:'Alert recovered',quote:'Alert recovered',ref:'e0'}],uncertainty:'',actions:[],refs:['e0']}
 const gateway=new ScriptedGateway([],'```json\n'+JSON.stringify({cards:[card]})+'\n```')
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline([{id:'alert',version:'1',kind:'im',text:'Alert recovered',observed_at:'2026-10-17T00:00:00Z'}],{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal)
 assert.equal(result.cards.length,1);assert.equal(result.cards[0]!.facts[0]!.ref,'alert')
})

test('timeline normalizes array and double encoded wrappers without changing card evidence',async()=>{
 const card={temporal:{kind:'event',dates:[]},category:'Storage',title:'Alert recovered',why_now:'An update was reported',facts:[{text:'Alert recovered',quote:'Alert recovered',ref:'e0'}],uncertainty:'',actions:[],refs:['e0']}
 for(const body of [JSON.stringify([card]),JSON.stringify(JSON.stringify({cards:[card]}))]){
  const result=await new GatewayPersonalWriter({gateway:new ScriptedGateway([],body),model:'fixture'}).generateTimeline([{id:'alert',version:'1',kind:'im',text:'Alert recovered',observed_at:'2026-10-17T00:00:00Z'}],{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal)
  assert.equal(result.cards.length,1);assert.equal(result.cards[0]!.facts[0]!.ref,'alert')
 }
})

test('timeline prose does not expose evidence keys while exact quotes and references survive',async()=>{
 const card={temporal:{kind:'event',dates:[]},category:'Storage',title:'Alert recovered (e0)',why_now:'The latest report (e0/e1) records recovery',facts:[{text:'Alert recovered (e0/e1)',quote:'Alert recovered',ref:'e0'}],uncertainty:'',actions:[],refs:['e0','e1']}
 const result=await new GatewayPersonalWriter({gateway:new ScriptedGateway([],JSON.stringify({cards:[card]})),model:'fixture'}).generateTimeline(['a','b'].map(id=>({id,version:'1',kind:'im',text:'Alert recovered',observed_at:'2026-10-17T00:00:00Z'})),{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal)
 assert.equal(result.cards[0]!.title,'Alert recovered');assert.equal(result.cards[0]!.facts[0]!.text,'Alert recovered')
 assert.equal(result.cards[0]!.facts[0]!.quote,'Alert recovered');assert.deepEqual(result.cards[0]!.refs,['a','b'])
})

test('timeline composes every screened topic in batches and reports validation losses',async()=>{
 const inputs=Array.from({length:201},(_,i)=>({id:'m'+i,version:'1',kind:'im',text:'Update '+i,observed_at:'2026-10-17T00:00:00Z'}))
 const gateway={complete:(request:CompleteRequest)=>{try{
  if(request.usage?.operation==='reconcile'){const body=JSON.parse(request.prompt) as {topics:{id:string}[]};return Promise.resolve({text:JSON.stringify({groups:body.topics.map(topic=>({members:[topic.id]}))})});}
  const prompt=JSON.parse(request.prompt) as {output_schema?:unknown;inputs:{key:string;text:string}[];cards?:unknown[]}
  if(prompt.output_schema)return Promise.resolve({text:JSON.stringify({topics:prompt.inputs.slice(0,12).map(input=>({title:input.text,refs:[input.key]}))})});
  if(prompt.cards)return Promise.resolve({text:JSON.stringify({cards:prompt.cards})});
  return Promise.resolve({text:JSON.stringify({cards:prompt.inputs.map(input=>({temporal:{kind:'event',dates:[]},category:'Progress',title:input.text,why_now:'A result was recorded',facts:[{text:input.text,quote:input.text,ref:input.key}],uncertainty:'',actions:[],refs:[input.key]}))})});
 }catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}} as unknown as ModelGateway
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline(inputs,{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal)
 assert.equal(result.cards.length,13);assert.ok(result.cards.some(card=>card.refs.includes('m200')))
 assert.equal(result.diagnostics?.screened_topics,13)
 assert.equal(result.diagnostics?.selected_inputs,13)
 assert.ok((result.diagnostics?.composition_batches??0)>1)
 assert.equal(result.diagnostics?.stages.filter(stage=>stage.phase==='compose').reduce((sum,stage)=>sum+stage.accepted,0),13)
})

test('a failed composition batch does not discard separately grounded updates',async()=>{
 const inputs=Array.from({length:201},(_,i)=>({id:'m'+i,version:'1',kind:'im',text:'Update '+i,observed_at:'2026-10-17T00:00:00Z'}))
 const gateway={complete:(request:CompleteRequest)=>{try{
  if(request.usage?.operation==='reconcile'){const body=JSON.parse(request.prompt) as {topics:{id:string}[]};return Promise.resolve({text:JSON.stringify({groups:body.topics.map(topic=>({members:[topic.id]}))})});}
  const prompt=JSON.parse(request.prompt) as {output_schema?:unknown;inputs:{key:string;text:string}[];cards?:unknown[]}
  if(prompt.output_schema)return Promise.resolve({text:JSON.stringify({topics:prompt.inputs.slice(0,4).map(input=>({title:input.text,refs:[input.key]}))})});
  if(prompt.inputs[0]!.text==='Update 0')throw Error('transport unavailable')
  if(prompt.cards)return Promise.resolve({text:JSON.stringify({cards:prompt.cards})});
  const input=prompt.inputs[0]!
  return Promise.resolve({text:JSON.stringify({cards:[{temporal:{kind:'event',dates:[]},category:'Progress',title:input.text,why_now:'A result was recorded',facts:[{text:input.text,quote:input.text,ref:input.key}],uncertainty:'',actions:[],refs:[input.key]}]})});
 }catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}} as unknown as ModelGateway
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline(inputs,{local_date:'2026-10-17',timezone:'UTC'},new AbortController().signal)
 assert.equal(result.cards.length,1);assert.deepEqual(result.cards[0]!.refs,['m200'])
 assert.deepEqual(result.diagnostics?.failed_batches,[{batch:0,reason:'generation_failed'}])
})

test('timeline writer grounds name-only people tags and restores their evidence keys',async()=>{
 const text='林舟负责 Windows 复现，陈雨提供测试素材。'
 const card={category:'协作',title:'林舟与陈雨配合复现',why_now:'复现与素材准备有明确分工',facts:[{text,quote:text,ref:'e0'}],people:[{name:'林舟',quote:'林舟负责 Windows 复现',ref:'e0'},{name:'陈雨',quote:'陈雨提供测试素材',ref:'e0'},{name:'杜撰姓名',quote:text,ref:'e0'}],uncertainty:'',actions:[],refs:['e0']}
 const gateway=new ScriptedGateway([],JSON.stringify({cards:[card]})),writer=new GatewayPersonalWriter({gateway,model:'same'})
 const result=await writer.generateTimeline([{id:'original-message',version:'1',kind:'im',text,observed_at:'2026-10-17T01:00:00Z'}],{local_date:'2026-10-17',timezone:'Asia/Shanghai'},new AbortController().signal)
 assert.deepEqual(result.cards[0]!.people?.map(person=>[person.name,person.ref]),[['林舟','original-message'],['陈雨','original-message']])
})

test('timeline review keeps viewer identity even when selected evidence has only other speakers',async()=>{
 const inputs=Array.from({length:201},(_,i)=>({id:'m'+i,version:'1',kind:'im',text:i===200?'我叫许明':i===0?'林舟将在2026-10-20把我需要的复现结果交给我。':'系统收到例行通知',observed_at:'2026-10-17T01:00:00Z',relation:i===200?'self' as const:'participant' as const,author:{key:i===200?'self':'peer',name:i===200?'许明':'林舟',is_user:i===200,kind:'person' as const}}))
 const card={category:'协作',title:'复现结果将在10月20日交付',why_now:'你的复现依赖这份结果',facts:[{text:inputs[0]!.text,quote:inputs[0]!.text,ref:'e0'}],uncertainty:'',actions:[],refs:['e0']}
 let composition=0
 const gateway={complete:(request:CompleteRequest)=>{try{
  const body=JSON.parse(request.prompt) as {context:{viewer_names:string[]};output_schema?:unknown;inputs:{text:string;author:{name:string;is_user:boolean}}[]}
  assert.deepEqual(body.context.viewer_names,['许明'])
  if(body.output_schema)return Promise.resolve({text:JSON.stringify({topics:body.inputs.some((i:{text:string})=>i.text===inputs[0]!.text)?[{title:'复现交付',refs:['e0']}]:[]})});
  assert.equal(body.inputs[0]!.author.name,'林舟');assert.equal(body.inputs[0]!.author.is_user,false)
  composition++;return Promise.resolve({text:JSON.stringify({cards:[card]})});
 }catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}} as unknown as ModelGateway
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline(inputs,{local_date:'2026-10-18',timezone:'Asia/Shanghai'},new AbortController().signal)
 assert.equal(composition,2);assert.equal(result.cards.length,1)
})

test('timeline review retains the user request even when the draft cites only the collaborator update',async()=>{
 const inputs=[{id:'request',version:'1',kind:'im',text:'请帮我复现 Windows 上的语音问题。',observed_at:'2026-10-16T01:00:00Z',group:'thread',author:{key:'self',name:'许明',kind:'person' as const,is_user:true}},{id:'reply',version:'1',kind:'im',text:'我已完成复现，正在整理结果。',observed_at:'2026-10-17T01:00:00Z',group:'thread',author:{key:'peer',name:'林舟',kind:'person' as const,is_user:false}}]
 const card={temporal:{kind:'event',dates:[]},category:'协作',title:'林舟已完成语音问题复现',why_now:'你提出的复现请求有了结果',facts:[{text:'林舟已完成复现，正在整理结果。',quote:inputs[1]!.text,ref:'e1'}],uncertainty:'',actions:[],refs:['e1']}
 let reviewed=false
 const gateway={complete:(request:CompleteRequest)=>{try{
  const body=JSON.parse(request.prompt) as {cards?:unknown[];inputs:{text:string;author:{is_user:boolean}}[]}
  if(body.cards){reviewed=true;assert.equal(request.reasoning,'disabled');assert.equal(body.inputs.length,2);assert.equal(body.inputs[0]!.author.is_user,true);assert.equal(body.inputs[0]!.text,inputs[0]!.text)}
  return Promise.resolve({text:JSON.stringify({cards:[card]})});
 }catch(error){return Promise.reject(error instanceof Error ? error : new Error('Non-Error fixture failure',{cause:error}))}}} as unknown as ModelGateway
 const result=await new GatewayPersonalWriter({gateway,model:'fixture'}).generateTimeline(inputs,{local_date:'2026-10-18',timezone:'Asia/Shanghai'},new AbortController().signal)
 assert.equal(reviewed,true);assert.equal(result.cards.length,1)
})
