import assert from 'node:assert/strict'
import {test} from 'node:test'
import {loadSettings} from '../src/config/config.js'
import {VirtualClock} from '../src/core/clock.js'
import {executorManifestSchema} from '../src/core/ports.js'
import {buildCascadedRealtimeAssembly} from '../src/composition/cascaded-realtime-assembly.js'
import type {CodingAgentControllerFactory} from '../src/composition/realtime-assembly.js'
import {codexAgentDescriptor, CodexAgentController} from '../src/executors/codex/controller.js'
import type {CodexAssemblyResource} from '../src/executors/codex/factory.js'
import {ProjectConfirmationController} from '../src/projects/project-confirmation.js'

test('cascaded intake binds assessment and planning models to the selected support endpoint', async () => {
  const coding = {
    dispatch: () => Promise.resolve({outcome: 'ok' as const, trust: 'trusted_system' as const, content: {}, refs: []}),
    manifest: executorManifestSchema.parse({
      name: 'workspace_coder', display_name: 'Workspace coder', model_visibility: 'hidden', roles: ['coding'],
      policy: {channel: 'workspace_coder', priority: 50, wake: 'fast', typical_latency: 5, compress_watermark: 8},
      ops: [
        {name: 'run', description: 'run', params: {type: 'object', properties: {work_order: {type: 'string'}}, required: ['work_order'], additionalProperties: false}},
        {name: 'status', description: 'status', readonly: true, params: {type: 'object', properties: {}, additionalProperties: false}},
      ],
    }),
  }
  const contexts: Parameters<CodingAgentControllerFactory['create']>[0][] = []
  const factory: CodingAgentControllerFactory = {
    create: context => {
      contexts.push(context)
      return new CodexAgentController({
        channel: context.channel,
        ...(context.intake === undefined ? {} : {intake: context.intake}),
        ...(context.executor === undefined ? {} : {executor: context.executor}),
        dispatchPort: context.dispatchPort,
        resolveCancelTarget: context.resolveCancelTarget,
      })
    },
  }
  const confirmationController = new ProjectConfirmationController({
    clock: new VirtualClock(), idFactory: () => 'cascaded-coding-confirmation',
  })
  const adapter = {
    ...coding,
    confirmationController,
    initialize: () => Promise.resolve(),
    commitConfirmed: () => Promise.resolve({accepted: false, code: 'unused'}),
    publicProjectView: () => ({workspace_display_name: null, session_title: null, pending_confirmation: false}),
    publicProjectContext: () => ({
      workspace_id: null,
      view: {workspace_display_name: null, session_title: null, pending_confirmation: false},
    }),
    activeCommittedWorkspace: () => Promise.resolve(null),
    observeProjectView: () => () => undefined,
    observeProjectContext: () => () => undefined,
  }
  const resource: CodexAssemblyResource = {
    adapter,
    mode: 'project', projectView: null, approvalPolicy: 'never', approvalController: null,
    start: () => Promise.resolve(), close: () => Promise.resolve(),
  }
  for (const scenario of [
    {provider: 'deepseek', model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions'},
    {provider: 'ark', model: 'ark-selected', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'},
    {provider: 'qwen', model: 'qwen-plus', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'},
    {provider: 'deepseek', model: 'deepseek-flash', endpoint: 'https://generic.example/v1/chat/completions', generic: true},
    {provider: 'deepseek', model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/chat/completions', planner: 'deepseek-v4-pro'},
  ]) {
    contexts.length = 0
    const records: {endpoint: string; model: string}[] = []
    const previous = globalThis.fetch
    globalThis.fetch = (url, init) => {
      assert.equal(typeof init?.body, 'string')
      const body = JSON.parse(init!.body as string) as {model: string; thinking?: unknown}
      assert.deepEqual(body.thinking, scenario.provider === 'deepseek' && !scenario.generic ? {type: 'disabled'} : undefined)
      records.push({endpoint: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, model: body.model})
      return Promise.resolve(new Response(JSON.stringify({choices: [{message: {content: '{}'}}]}), {status: 200}))
    }
    const configured = loadSettings({
      PIPELINE_MODE: 'cascaded',
      CASCADE_LLM_PROVIDER: scenario.provider,
      CASCADE_LLM_MODEL: scenario.model,
      EXECUTORS: 'workspace_coder',
      DEEPSEEK_API_KEY: 'fixture', ARK_API_KEY: 'fixture', DASHSCOPE_API_KEY: 'fixture',
      DOUBAO_BIGMODEL_API_KEY: 'fixture', TAVILY_API_KEY: 'fixture',
      ...(scenario.generic ? {MODEL_API_KEY: 'fixture', MODEL_BASE_URL: 'https://generic.example/v1'} : {}),
      ...(scenario.planner ? {PLANNER_MODEL: scenario.planner} : {}),
    })
    let realtime: ReturnType<typeof buildCascadedRealtimeAssembly> | undefined
    try {
      realtime = buildCascadedRealtimeAssembly({
        settings: configured,
        codexResource: resource,
        agentDescriptors: [codexAgentDescriptor('workspace_coder')],
        codingAgentControllerFactory: factory,
        metrics: {record: () => undefined},
      })
      const models = contexts[0]?.intake?.models
      assert.ok(models)
      await models.assess({running: []}, new AbortController().signal)
      await models.plan({}, new AbortController().signal)
      assert.deepEqual(records, [
        {endpoint: scenario.endpoint, model: scenario.generic ? 'qwen-plus' : scenario.model},
        {endpoint: scenario.endpoint, model: scenario.generic ? 'qwen3-vl-plus' : scenario.planner ?? scenario.model},
      ], scenario.provider)
      assert.equal(configured.surrogate_model, 'qwen-plus', 'source settings remain unchanged')
    } finally {
      globalThis.fetch = previous
      await realtime?.stop()
    }
  }
})
