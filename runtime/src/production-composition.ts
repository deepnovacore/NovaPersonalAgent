import {scopeApprovalController} from './personal-agent/approval-scope.js'
import type {PersonalAgentHost} from './personal-agent/host.js'
import {conversationRuntimeFactory} from './personal-agent/conversation-runtime.js'
import {join} from 'node:path'
import {FeishuConnector} from './connectors/feishu/index.js'
import {SubstrateMemoryResource} from './memory-substrate/resource.js'
import {z} from 'zod'
import {blackboardOptionsFromSettings} from './memory/blackboard-session.js'
import type {UsageReporter} from './realtime/usage.js'
import {prepareKnowledge} from './knowledge/assembly.js'
import {LocalDirectorySources} from './personal-agent/sources.js'
/** Shared production graph for the Electron child and the headless remote service. */
import {randomUUID} from 'node:crypto'
import {loadCapabilityRegistry} from './capability-registry.js'
import {prepareExternalMcp} from './executors/mcp.js'
import {loadSettings} from './config.js'
import {requireSelectedCascadedLlmConfig} from './cascaded-realtime-config.js'
import {remoteClientMedia} from './server-config.js'
import type {ClientMedia} from './client-protocol.js'
import {buildDesktopRealtimeComposition, type DesktopConstructionOwnership} from './desktop-service.js'
import type {DesktopRealtimeOptions} from './desktop-realtime.js'
import {selectDesktopCameraSource} from './desktop-camera-source.js'
import {ChromiumFrameSource} from './executors/chromium-frame-source.js'
import {RealClock} from './clock.js'
import {buildProductionRealtimeAssembly, type BuildProductionRealtimeAssemblyOptions} from './production-realtime-assembly.js'
import {createRealtimeTelemetry} from './realtime/telemetry.js'
import type {ApprovalView as ExecutorApprovalView} from './approval-port.js'
import {buildIntegratedRealtimeAssembly, type IntegratedProviderRegistry} from './integrated-realtime-assembly.js'

export async function buildProductionComposition({token, stop, ownership, onDiagnostic, remote = false, createServer, integratedProviders, onKnowledge, onUsage, environment = process.env}: {
  readonly onUsage?: UsageReporter
  readonly token: string
  readonly stop: AbortController
  readonly ownership: DesktopConstructionOwnership
  readonly onDiagnostic: (line: string) => void
  readonly onKnowledge?: (knowledge: NonNullable<Awaited<ReturnType<typeof prepareKnowledge>>>) => void
  readonly remote?: boolean
  readonly environment?: NodeJS.ProcessEnv
  readonly integratedProviders?: IntegratedProviderRegistry
  readonly createServer?: (options: Parameters<NonNullable<DesktopRealtimeOptions['createServer']>>[0], media?: ClientMedia) => ReturnType<NonNullable<DesktopRealtimeOptions['createServer']>>
}) {
  const loadedSettings = loadSettings(environment)
  const media = remote ? remoteClientMedia(loadedSettings) : undefined
  requireSelectedCascadedLlmConfig(loadedSettings)
  const externalMcp = await prepareExternalMcp(loadCapabilityRegistry({environment: remote
      ? {...environment, NOVA_AUDIO_AGENT_CAMERA_MODULE_ENABLED: 'false'} : environment}), stop.signal)
  const releaseExternal = ownership.own(() => externalMcp.close())
  const capabilities = externalMcp.capabilities
  // This entry owns the concrete Codex package; core gates injected adapters by their declared role.
  const settings = capabilities.modules.coding.enabled ? loadedSettings : {
    ...loadedSettings, executors: loadedSettings.executors.filter(name => name !== 'codex'),
  }
  for (const override of capabilities.overrides) onDiagnostic(`[capability-override] ${override}`)
  const knowledge = await prepareKnowledge(settings, capabilities, stop.signal)
  if (knowledge !== undefined) {
    ownership.own(() => knowledge.close())
    onKnowledge?.(knowledge)
  }
  const clock = new RealClock()
  const telemetry = createRealtimeTelemetry(environment, {clock})
  ownership.own(() => telemetry.close())
  let publishExecutorApproval: (view: ExecutorApprovalView) => void = () => undefined
  const codexResource = !capabilities.modules.coding.enabled || !settings.executors.includes('codex')
    ? null
    : await (async () => {
      const {createCodexAssemblyResource, createProductionCodexHost, resolveCodexHostConfig, prepareManagedCodexMcp} = await import('./executors/codex/host.js')
      const sourceResourcesPath = environment.NOVA_AUDIO_AGENT_CODEX_RESOURCES_PATH
      const codexHost = createProductionCodexHost(settings, {
        ...(sourceResourcesPath === undefined ? {} : {resourcesPath: sourceResourcesPath}),
        onDiagnostic: code => onDiagnostic(`[runtime-diagnostic] ${code}`),
      })
      const codexConfig = resolveCodexHostConfig(settings, codexHost.catalog)
      return codexConfig === null
        ? null
        : await createCodexAssemblyResource({
            managedMcp: prepareManagedCodexMcp(capabilities, knowledge?.codexEntries),
            config: codexConfig,
            composition: 'realtime',
            transportFactory: codexHost.transportFactory,
            clock,
            idFactory: () => randomUUID().replaceAll('-', ''),
            onDiagnostic,
            codexApprovalBroker: {
              publish: view => { publishExecutorApproval(view) },
            },
            ...(codexHost.projectHost === null ? {} : {projectHost: codexHost.projectHost}),
          })
    })()
  const releaseCodex = codexResource === null ? undefined : ownership.own(() => codexResource.close())
  const conversationOwner:{host?:PersonalAgentHost}={}
  const camera = remote ? null : selectDesktopCameraSource(environment)
  let playbackEpoch=0
  const nextPlaybackGeneration=()=>++playbackEpoch
  const composition = buildDesktopRealtimeComposition({
    token,
    stop,
    ...(createServer === undefined ? {} : {createServer: options => createServer(options, media)}),
    ...(remote ? {transportFailure: 'disconnect' as const} : {}),
    telemetry,
    progressBubbles: settings.progress_bubbles,
    ...(codexResource?.projectView === null || codexResource === null
      ? {}
      : {projectView: codexResource.projectView}),
    ...(codexResource?.approvalController === null || codexResource === null
      ? {}
      : {approvalView: codexResource.approvalController.view}),
    buildRealtime: (callbacks, transport) => {
      const frameSource = camera === null ? undefined : new ChromiumFrameSource({
        source: camera.source,
        transport,
        clock,
      })
      const realtimeOptions: BuildProductionRealtimeAssemblyOptions = {
        textOnly:true,
        nextPlaybackGeneration,
        blackboard: blackboardOptionsFromSettings(settings),
        settings,
        ...(onUsage === undefined ? {} : {onUsage}),
        capabilities,
        externalMcp,
        ...(knowledge === undefined ? {} : {knowledge}),
        telemetry,
        onDiagnostic,
        clock,
        ...(frameSource === undefined ? {} : {frameSource}),
        ...(codexResource === null ? {} : {codexResource}),
        ...callbacks,
        ...(codexResource?.approvalController?{executorApproval:scopeApprovalController(codexResource.approvalController,view=>!view.work||!conversationOwner.host?.workConversation(view.work.work_id))}:{}),
      }
      const realtime = buildProductionRealtimeAssembly(realtimeOptions, integratedProviders === undefined ? {} : {
        integrated: options => buildIntegratedRealtimeAssembly(options, integratedProviders),
      })
      ownership.own(() => realtime.stop())
      releaseExternal()
      releaseCodex?.()
      return realtime
    },
  })
  if (knowledge !== undefined) {
    const host = composition.realtime.personalAgent
    host.setSources(new LocalDirectorySources({
      path: host.path + '.sources.json', knowledge: knowledge.service,
      onChange: () => host.sourceChanged(),
      onInvalidate: async ref => {
        await host.invalidateEvidence(ref)
        await composition.realtime.personalMemory?.forgetSource?.(ref)
        await host.revalidate()
        await host.refreshMemory()
      },
      onObserve: async observation => {
        const memory = composition.realtime.personalMemory
        if (!memory?.observeSource) return // Knowledge-only mode indexes A without enabling personal extraction.
        await memory.observeSource({...observation, embedding_consent: true})
      },
    }))
  }
  const host = composition.realtime.personalAgent
  conversationOwner.host=host
  host.setConversationRuntime(conversationRuntimeFactory({settings,capabilities,externalMcp,telemetry,mediaStore:composition.realtime.core.mediaStore,
    ...(onUsage===undefined?{}:{onUsage}),
    ...(composition.realtime.core.frameSource?{frameSource:composition.realtime.core.frameSource}:{}),
    blackboard:blackboardOptionsFromSettings(settings),clock,gateway:composition.realtime.core.gateway,
    ...(knowledge?{knowledge}:{}),...(codexResource?{codexResource}:{}),onDiagnostic,
    host,memory:()=>composition.realtime.personalMemory,nextPlaybackGeneration,
    onExecutorProgress:(progress,result)=>composition.desktop.bridge.onExecutorProgress(progress,result),
    onAudioFrame:frame=>composition.desktop.bridge.onAudioFrame(frame),onAudioClear:(id,epoch)=>composition.desktop.bridge.onAudioClear(id,epoch),onAudioAlert:(id,epoch)=>composition.desktop.bridge.onAudioAlert(id,epoch),onAudioTerminal:(id,epoch)=>composition.desktop.bridge.onAudioTerminal(id,epoch),
  }),frame=>composition.desktop.bridge.onPersonalFrame(frame))
  const feishu = new FeishuConnector({
    executable: environment.NOVA_AUDIO_AGENT_FEISHU_CLI_PATH ?? 'lark-cli',
    credentialRoot: join(host.path + '.feishu', 'credentials'),
    statePath: join(host.path + '.feishu', 'state.json'),
    onChange:()=>host.connectionChanged(),
    ingest: async message => {
      const memory = composition.realtime.personalMemory
      if (!(memory instanceof SubstrateMemoryResource)) throw Error('请先启用本地记忆')
      await memory.ingestEvidence({sourceId:message.source_id,locator:message.locator,text:message.raw_text,observedAt:message.observed_at,kind:'im',embeddingConsent:true,retentionUntil:message.retention_until,senderId:message.sender_id,accountId:message.account_id})
      await host.sourceChanged()
    },
    deleteSource: async ref => {
      const memory = composition.realtime.personalMemory
      if (!memory?.forgetSource) throw Error('memory_unavailable')
      await memory.forgetSource(ref)
      await host.revalidate()
      await host.refreshMemory()
    },
    onAction: async action => {
      // Card feedback is never an execution capability. 'open' only marks the item seen.
      const result = await host.command({type:'personal.command',request_id:'feishu:'+action.event_id,
        method:'feed.action',params:{id:action.proposal_id,action:action.action==='ignore'?'dismiss':action.action,
          ...(action.action==='snooze'?{snooze_until:new Date(Date.now()+60*60000).toISOString()}:{})}})
      if (!(result as {ok?:boolean}).ok) throw Error('feishu_action_rejected')
    },
  })
  host.setFeishu({snapshot:()=>feishu.snapshot(),command:(method,params)=>feishu.command(method,z.record(z.string(),z.unknown()).parse(params)),open:()=>feishu.open(),close:async()=>{await feishu.close()}})
  let delivering = false
  const deliver = async () => {
    if (delivering || stop.signal.aborted) return
    delivering = true
    try {
      for (const item of host.snapshot().feed) {
        if (stop.signal.aborted || item.delivery.im_sent_at || !await host.canDeliver(item.id)) continue
        if (await feishu.sendReminder({id:item.id,title:item.title,body:item.why_now})) await host.imDelivered(item.id)
      }
    } catch { onDiagnostic('[runtime-diagnostic] feishu_delivery_unavailable') }
    finally { delivering = false }
  }
  const unsubscribeFeishu = host.subscribe(() => { void deliver() })
  const deliveryTimer=setInterval(()=>{void deliver()},30000)
  deliveryTimer.unref()
  ownership.own(() => {clearInterval(deliveryTimer);unsubscribeFeishu()})
  ownership.own(() => composition.desktop.server.close())
  publishExecutorApproval = view => { if(view.work&&host.workConversation(view.work.work_id))return;composition.desktop.bridge.onExecutorApproval(view) }
  return {
    ...composition,
    closeAuxiliary: () => telemetry.close(),
  }
}
