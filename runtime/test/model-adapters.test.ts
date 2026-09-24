import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

test('workbench generation includes its schema in the provider-visible prompt',async()=>{
 const gateway=new ScriptedGateway([],JSON.stringify({cards:[]}))
 const surrogate=new GatewaySurrogate({gateway,model:'same',proactivityPreset:'balanced'})
 await surrogate.generateContext([{candidate_id:'c1',id:'c1',version:'v1',content:'A project document',tab:'ideas',primaryFileId:'doc',refs:[{entry_id:'source:doc',version:'v1'}],excerpt:'A project document',reason_code:'document_idea',root:'/project',priority:0,mtime_ms:1}],new AbortController().signal)
 const prompt=JSON.parse(gateway.completions[0]!.prompt) as {output_schema:{properties:{cards:unknown}}}
 assert.ok(prompt.output_schema.properties.cards)
 assert.doesNotMatch(gateway.completions[0]!.prompt,/\/project/u)
 assert.match(gateway.completions[0]!.system,/正文只写一句话/u)
})
test('workbench generation allows no candidates and makes no model call',async()=>{
 const gateway=new ScriptedGateway([],JSON.stringify({cards:[]}))
 const surrogate=new GatewaySurrogate({gateway,model:'same',proactivityPreset:'balanced'})
 assert.deepEqual(await surrogate.generateContext([],new AbortController().signal),{recap:null,cards:[]})
 assert.equal(gateway.completions.length,0)
})
test('a queued digest batch re-checks consent when it leaves the lane, and never sends after revocation',async()=>{
 class HeldGateway extends ScriptedGateway{release!:()=>void
  override complete(request:CompleteRequest):Promise<GatewayCompletion>{this.completions.push(request);if(this.completions.length>1)return Promise.resolve({text:JSON.stringify({digests:[]})});return new Promise(r=>{this.release=()=>r({text:JSON.stringify({cards:[]})})})}}
 const gateway=new HeldGateway(),surrogate=new GatewaySurrogate({gateway,model:'same',proactivityPreset:'balanced'})
 const candidate={candidate_id:'c1',id:'c1',version:'v1',content:'x',tab:'ideas' as const,primaryFileId:'doc',refs:[{entry_id:'source:doc',version:'v1'}],excerpt:'x',reason_code:'document_idea' as const,root:'/p',priority:0,mtime_ms:1}
 const foreground=surrogate.generateContext([candidate],new AbortController().signal)
 let consented=true
 const digest=surrogate.generateDigests([{project_key:'k',name:'p',signals:{tier:1,own_commits_30d:0,last_own_commit_days:null,last_modified_days:0},documents:[{entry_id:'source:doc',version:'v1',document:'README.md',excerpt:'x'}]}],new AbortController().signal,()=>{if(!consented)throw Error('processing_consent_required')})
 await new Promise(r=>setImmediate(r));assert.equal(gateway.completions.length,1,'the digest waits behind foreground work')
 consented=false;gateway.release();await foreground
 await assert.rejects(digest,/processing_consent_required/u);assert.equal(gateway.completions.length,1,'no digest request was sent')
})
