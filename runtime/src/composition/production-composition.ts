import {blackboardOptionsFromSettings} from '../memory/blackboard-session.js'
import type {UsageReporter} from '../realtime/usage.js'
import {prepareKnowledge} from '../knowledge/assembly.js'
/** Shared production graph for the Electron child and the headless remote service. */
import {randomUUID} from 'node:crypto'
import {loadCapabilityRegistry} from '../config/capability-registry.js'
import {prepareExternalMcp} from '../executors/mcp.js'
import {loadSettings, requireIntegratedRealtime} from '../config/config.js'
import {requireSelectedCascadedRealtimeConfig} from '../config/cascaded-realtime-config.js'
import {remoteClientMedia} from '../server/server-config.js'
import type {ClientMedia} from '../server/client-protocol.js'
import {buildDesktopRealtimeComposition, type DesktopConstructionOwnership} from '../desktop/desktop-session.js'
import type {DesktopRealtimeOptions} from '../desktop/desktop-session.js'
import {selectDesktopCameraSource} from '../desktop/desktop-camera-source.js'
import {ChromiumFrameSource} from '../executors/chromium-frame-source.js'
import {RealClock} from '../core/clock.js'
import {buildProductionRealtimeAssembly, type BuildProductionRealtimeAssemblyOptions} from './cascaded-realtime-assembly.js'
import {createRealtimeTelemetry} from '../realtime/telemetry.js'
import type {ApprovalView as ExecutorApprovalView} from '../core/approval-port.js'
import {buildIntegratedRealtimeAssembly, type IntegratedProviderRegistry} from './cascaded-realtime-assembly.js'

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
  if (loadedSettings.pipeline_mode === 'integrated') requireIntegratedRealtime(loadedSettings)
  else requireSelectedCascadedRealtimeConfig(loadedSettings)
  const externalMcp = await prepareExternalMcp(loadCapabilityRegistry({environment: remote
      ? {...environment, CAMERA_MODULE_ENABLED: 'false'} : environment}), stop.signal)
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
  telemetry.record('pipeline.configuration', {
    pipeline: settings.pipeline_mode,
    provider: settings.pipeline_mode === 'cascaded' ? settings.cascade_llm_provider : settings.integrated_provider,
    model: settings.pipeline_mode === 'cascaded'
      ? requireSelectedCascadedRealtimeConfig(settings).selection.llmModel
      : settings.qwen_realtime_model,
    asr: settings.cascade_asr_provider, tts: settings.cascade_tts_provider,
    vision: settings.conversation_vision_enabled,
  })
  let publishExecutorApproval: (view: ExecutorApprovalView) => void = () => undefined
  const codexResource = !capabilities.modules.coding.enabled || !settings.executors.includes('codex')
    ? null
    : await (async () => {
      const {createCodexAssemblyResource, createProductionCodexHost, resolveCodexHostConfig, prepareManagedCodexMcp} = await import('../executors/codex/host.js')
      const sourceResourcesPath = environment.CODEX_RESOURCES_PATH
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
            onDiagnostic: code => {
              telemetry.record('executor.diagnostic', {code})
              onDiagnostic(code)
            },
            codexApprovalBroker: {
              publish: view => { publishExecutorApproval(view) },
            },
            ...(codexHost.projectHost === null ? {} : {projectHost: codexHost.projectHost}),
          })
    })()
  const releaseCodex = codexResource === null ? undefined : ownership.own(() => codexResource.close())
  const camera = remote ? null : selectDesktopCameraSource(environment)
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
  ownership.own(() => composition.desktop.server.close())
  publishExecutorApproval = view => { composition.desktop.bridge.onExecutorApproval(view) }
  return {
    ...composition,
    closeAuxiliary: () => telemetry.close(),
  }
}
