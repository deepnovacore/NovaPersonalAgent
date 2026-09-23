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
  GatewaySurrogate,
  compressorPrompt,
} from '../src/model/model-adapters.js'

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/adapters/v1')

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

test('the Surrogate rejects output that is not contract-shaped', async () => {
  const good = new GatewaySurrogate({
    gateway: new ScriptedGateway([], '{"speak":true,"suggestion_id":"s-1","progress_class":"milestone","reason":"因为"}'),
    model: 'm',
    proactivityPreset: 'balanced',
  })
  assert.deepEqual(await good.watch(emptyView),
    {speak: true, suggestion_id: 's-1', progress_class: 'milestone', reason: '因为'})

  for (const text of ['not json', '{}', '{"speak":"yes","suggestion_id":null,"reason":"r"}',
    '{"speak":true,"suggestion_id":7,"progress_class":"milestone","reason":"r"}',
    '{"speak":true,"suggestion_id":null,"progress_class":null}',
    '{"speak":true,"suggestion_id":"s-1","reason":"missing classification"}']) {
    const bad = new GatewaySurrogate({
      gateway: new ScriptedGateway([], text),
      model: 'm',
      proactivityPreset: 'balanced',
    })
    await assert.rejects(bad.watch(emptyView), TypeError, text)
  }
})

test('the Surrogate preserves its structured progress decision', async () => {
  const surrogate = new GatewaySurrogate({
    gateway: new ScriptedGateway(
      [],
      '{"speak":true,"suggestion_id":"s-1","progress_class":"routine_delta","reason":"file count changed"}',
    ),
    model: 'm',
    proactivityPreset: 'eager',
  })

  assert.deepEqual(await surrogate.watch(emptyView), {
    speak: true,
    suggestion_id: 's-1',
    progress_class: 'routine_delta',
    reason: 'file count changed',
  })
})

test('the Surrogate receives the selected proactivity policy at its model boundary', async () => {
  const systems = new Map<string, string>()
  for (const preset of ['conservative', 'balanced', 'eager'] as const) {
    const gateway = new ScriptedGateway(
      [],
      '{"speak":false,"suggestion_id":null,"progress_class":null,"reason":"routine"}',
    )
    const surrogate = new GatewaySurrogate({gateway, model: 'm', proactivityPreset: preset})

    await surrogate.watch(emptyView)

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

test('the compressor trims its answer and sends the schema-free request', async () => {
  const gateway = new ScriptedGateway([], '  摘要文本  ')
  const compressor = new GatewayCompressor({gateway, model: 'qwen-flash'})
  assert.equal(await compressor.compress([]), '摘要文本')
  assert.equal(gateway.completions[0]?.jsonSchema, undefined)
  assert.equal(gateway.completions[0]?.prompt, '[]')
})

test('the compressor strips exactly the whitespace Python strips', async () => {
  const compressor = new GatewayCompressor({
    gateway: new ScriptedGateway([], '\u001c\u0085\ufeffsummary\ufeff\u0085\u001c'),
    model: 'qwen-flash',
  })
  assert.equal(await compressor.compress([]), '\ufeffsummary\ufeff')
})

test('discovery uses bounded existing Surrogate gateway without speech or execution', async () => {
  const gateway=new ScriptedGateway([],JSON.stringify({proposal:null}))
  const surrogate=new GatewaySurrogate({gateway,model:'same-model',proactivityPreset:'balanced'})
  const snapshot={user_scope:'local',local_date:'2026-09-11',weekday:'Friday',timezone:'Asia/Shanghai',memory:[],evidence_refs:[],recent_delivery:[]}
  assert.equal(await surrogate.discover(snapshot,new AbortController().signal),null)
  const conflicted=new GatewaySurrogate({gateway:new ScriptedGateway([],JSON.stringify({speak:true,suggestion_id:'s-1',progress_class:null,reason:'bad',proposal:{kind:'question',summary:'Q',why_now:'Now',evidence_refs:['conversation:1'],memory_refs:[]}})),model:'same-model',proactivityPreset:'balanced'})
  await assert.rejects(conflicted.watch(emptyView),/契约/)
})

test('read-only preparation makes one completion and rejects invented or stale snapshot references',async()=>{
 const snapshot={user_scope:'local',local_date:'2026-09-14',weekday:'Monday',timezone:'Asia/Shanghai',memory:[],evidence_refs:['file:allowed'],recent_delivery:[]}
 const proposal={kind:'question' as const,summary:'Review project',why_now:'meeting today',evidence_refs:['file:allowed'],memory_refs:[]}
 const gateway=new ScriptedGateway([],JSON.stringify({text:'A source-grounded outline',evidence_refs:['file:allowed'],memory_refs:[]}))
 const surrogate=new GatewaySurrogate({gateway,model:'same',proactivityPreset:'balanced'})
 const prepared=await surrogate.prepareProposal(snapshot,proposal,new AbortController().signal)
 assert.equal(prepared?.prepared.trust,'untrusted_external')
 assert.equal(prepared?.prepared.text,'A source-grounded outline')
 assert.equal(gateway.completions.length,1)
 assert.equal(Object.hasOwn(gateway.completions[0]!,'tools'),false)
 for(const refs of [{evidence_refs:['file:invented'],memory_refs:[]},{evidence_refs:[],memory_refs:[{entry_id:'missing',version:1}]}]){
  const invalid=new GatewaySurrogate({gateway:new ScriptedGateway([],JSON.stringify({text:'Do this',...refs})),model:'same',proactivityPreset:'balanced'})
  assert.equal(await invalid.prepareProposal(snapshot,proposal,new AbortController().signal),null)
 }
 const brief=await surrogate.prepareBrief(snapshot,{kind:'outlook',local_date:'2026-09-14',timezone:'Asia/Shanghai',scheduled_at:'2026-09-14T00:30:00Z',dedupe_key:'brief:test'},new AbortController().signal)
 assert.equal(brief?.action_label,'查看简报')
 assert.equal(gateway.completions.length,2)
})


test('preparation rejects a stale active-memory version and skips an empty snapshot',async()=>{
 const memory={id:'m',version:2,content:'Meeting plan',kind:'plan' as const,origin:'stated' as const,source_refs:[{type:'conversation' as const,ref:'conversation:1',observed_at:'2026-09-14T00:00:00Z'}],observed_at:'2026-09-14T00:00:00Z',recorded_at:'2026-09-14T00:00:00Z',topic:'work',status:'active' as const,corrected_to:null,confidence_note:null}
 const snapshot={user_scope:'local',local_date:'2026-09-14',weekday:'Monday',timezone:'Asia/Shanghai',memory:[memory],evidence_refs:[],recent_delivery:[]}
 const proposal={kind:'question' as const,summary:'Meeting',why_now:'today',evidence_refs:[],memory_refs:[{entry_id:'m',version:2}]}
 const gateway=new ScriptedGateway([],JSON.stringify({text:'Prepared',evidence_refs:[],memory_refs:[{entry_id:'m',version:1}]}))
 const surrogate=new GatewaySurrogate({gateway,model:'same',proactivityPreset:'balanced'})
 assert.equal(await surrogate.prepareProposal(snapshot,proposal,new AbortController().signal),null)
 assert.equal(await surrogate.prepareProposal({...snapshot,memory:[]},proposal,new AbortController().signal),null)
 assert.equal(gateway.completions.length,1)
})


test('Surrogate receives the actual progress trigger, not an unlabelled snapshot', async () => {
  const gateway = new ScriptedGateway([], '{"speak":false,"suggestion_id":null,"progress_class":"routine_delta","reason":"counter only"}')
  const surrogate = new GatewaySurrogate({gateway, model: 'm', proactivityPreset: 'eager'})
  await surrogate.watch({...emptyView, trigger_kind: 'progress'})
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
  const verifier=new GatewaySurrogate({gateway,model:'test',proactivityPreset:'balanced'}),actual=await verifier.evaluateTask(task,evidence,new AbortController().signal)
  assert.deepEqual(receivedFormat,{type:'json_object'});assert.deepEqual(receivedSchema,z.toJSONSchema(taskDecisionSchema));assert.deepEqual(actual,decision);const corrected=await tasks.applyDecision(fence,actual);assert.equal(corrected.corrections,1);assert.equal(corrected.phase,'queued');assert.equal(requests,1)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('task evaluation separates accepted user steering from executor evidence and requests durable reconciliation',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),dir=await mkdtemp(join(await realpath(tmpdir()),'task-input-verifier-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{await tasks.open();let task=await tasks.delegate('declare',{conversation_id:'c',goal:'red',acceptance:['red observed'],origin_ref:'user:1'});let fence={task_id:task.id,control_revision:0,goal_revision:0};await tasks.bindWork(fence,'work','session');task=await tasks.controlClient('take',fence,'client','takeover');fence={...fence,control_revision:task.control_revision};await tasks.input('blue',fence,task.controller,'session','Change goal to blue',()=>Promise.resolve('accepted'));task=await tasks.controlClient('return',fence,'client','return')
 const decision={kind:'reconcile',input_refs:['blue'],goal_change:{goal:'blue',acceptance:['blue observed']}},gateway=new ScriptedGateway([],JSON.stringify(decision)),verifier=new GatewaySurrogate({gateway,model:'test',proactivityPreset:'balanced'})
 const evaluate=verifier.evaluateTask.bind(verifier) as (...args:unknown[])=>Promise<unknown>;assert.deepEqual(await evaluate(task,[],new AbortController().signal,tasks.inputReceipts(task.id)),decision)
 const prompt=JSON.parse(gateway.completions[0]!.prompt) as {accepted_user_inputs:{request_id:string;text:string}[]};assert.deepEqual(prompt.accepted_user_inputs.map(x=>({request_id:x.request_id,text:x.text})),[{request_id:'blue',text:'Change goal to blue'}])
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})

test('workbench generation includes its schema in the provider-visible prompt',async()=>{
 const gateway=new ScriptedGateway([],JSON.stringify({cards:[]}))
 const surrogate=new GatewaySurrogate({gateway,model:'same',proactivityPreset:'balanced'})
 await surrogate.generateContext([{id:'source:doc',version:'v1',content:'A project document'}],new AbortController().signal)
 const prompt=JSON.parse(gateway.completions[0]!.prompt) as {output_schema:{properties:{cards:unknown}}}
 assert.ok(prompt.output_schema.properties.cards)
})


test('coding evaluator cannot complete from prose, truncated checks, or another work/session',async()=>{
 const {TaskService}=await import('../src/personal-agent/tasks.js'),dir=await mkdtemp(join(await realpath(tmpdir()),'task-proof-')),tasks=new TaskService(join(dir,'tasks.json'))
 try{
  await tasks.open();const task=await tasks.delegate('declare',{conversation_id:'c',execution_route:'codex',goal:'Run checks',acceptance:['actual check output'],origin_ref:'user:1'}),fence={task_id:task.id,control_revision:0,goal_revision:0}
  await tasks.bindWork(fence,'work','session')
  await tasks.appendEvent({task_id:task.id,work_id:'work',session_id:'session',thread_id:'thread',turn_id:'turn',item_id:'check',kind:'tool',stage:'completed',text:JSON.stringify({type:'commandExecution',status:'completed',command:'node --test',output:'1 passed',exit_code:0}),refs:[]},'check')
  await tasks.recordWorkOutcome('work','ok',{worker:'codex',final_message:'All tests and UI passed'})
  const current=tasks.get(task.id),valid=tasks.evidence(task.id),decision={kind:'complete',evidence_refs:[valid[0]!.ref]}
  for(const invalid of [
   {...valid[0]!,observations:[]},
   {...valid[0]!,observations_truncated:true},
   {...valid[0]!,outcome:'failed'},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,text:JSON.stringify({type:'commandExecution',status:'completed',command:'node --test',output:'test failed',exit_code:1})}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,text_truncated:true}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,thread_id:undefined}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,text:JSON.stringify({type:'mcpToolCall',server:'cua_live',tool:'js',status:'completed',is_error:true,readback:'tool failed'})}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,work_id:'other'}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,session_id:'other'}]},
   {...valid[0]!,observations:[{...valid[0]!.observations[0]!,text:'commandExecution completed'}]},
  ]){
   const gateway=new ScriptedGateway([],JSON.stringify(decision)),verifier=new GatewaySurrogate({gateway,model:'test',proactivityPreset:'balanced'})
   assert.equal((await verifier.evaluateTask(current,[invalid],new AbortController().signal)).kind,'wait')
   assert.equal((await verifier.evaluateTask({...current,execution_route:undefined},[invalid],new AbortController().signal)).kind,'wait')
  }
  const gateway=new ScriptedGateway([],JSON.stringify(decision)),verifier=new GatewaySurrogate({gateway,model:'test',proactivityPreset:'balanced'})
  assert.deepEqual(await verifier.evaluateTask(current,valid,new AbortController().signal),decision)
  assert.deepEqual((JSON.parse(gateway.completions[0]!.prompt) as {evidence:{observations:unknown}[]}).evidence[0]!.observations,valid[0]!.observations)
  const mcp=structuredClone(valid);mcp[0]!.observations[0]!.text=JSON.stringify({type:'mcpToolCall',server:'cua_live',tool:'js',status:'completed',is_error:false,readback:'Counter value: 1'})
  assert.deepEqual(await verifier.evaluateTask(current,mcp,new AbortController().signal),decision)
 }finally{await tasks.close();await rm(dir,{recursive:true,force:true})}
})
