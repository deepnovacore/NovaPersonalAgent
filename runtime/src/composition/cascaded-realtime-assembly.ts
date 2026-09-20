import type {PromptLanguage} from '../realtime/prompt-language.js'
import type {RealtimeTelemetry} from '../realtime/telemetry.js'
import {supportsVision} from '../model/vision-capability.js'
import {captureConversationFrame} from '../core/camera-session.js'
import {usageReporterForEndpoint, type UsageReporter} from '../realtime/usage.js'
import {
  capabilitiesFromSettings,
  resolveSupportModelConnection,
  type CascadedAsrProviderName,
  type CascadedEndpointingProviderName,
  type CascadedLlmProviderName,
  type CascadedTtsProviderName,
  type Settings,
  DASHSCOPE_COMPATIBLE_BASE_URL,
  requireQwenRealtime,
  type QwenRealtimeConfig,
  ConfigurationError,
  requireIntegratedRealtime,
  type IntegratedProviderName,
} from '../config/config.js'
import {buildAssembly, type AssemblyOptions} from './assembly.js'
import {
  requireSelectedCascadedRealtimeConfig,
  type ArkCascadedLlmConfig,
  type AutoEndpointingConfig,
  type QwenCascadedLlmConfig,
  type VolcengineAsrConfig,
  type VolcengineTtsConfig,
} from '../config/cascaded-realtime-config.js'
import {RealClock, type Clock} from '../core/clock.js'
import {type CodingExecutorResource} from '../executors/coding-executor.js'
import {MonotonicIdFactory, type IdFactory} from '../core/ids.js'
import {personalMemoryFactory} from '../memory/factory.js'
import {OpenAIModelGateway, type ModelGateway} from '../model/model-gateway.js'
import {stripLikePython} from '../text/python-text.js'
import {
  composeRealtime,
  validateCodingResource,
  filterDisabledCoding,
  defaultIntake,
  type RealtimeAssembly,
  type RealtimeAssemblyOptions,
} from './realtime-assembly.js'
import {createArkCascadedLlmFactory} from '../realtime/cascaded/ark-llm.js'
import {type CascadedLlmFactory} from '../realtime/cascaded/llm.js'
import {
  type AsrClient,
  type AsrFactory,
  type EndpointingFactory,
  type TtsClient,
  type TtsFactory,
} from '../realtime/cascaded/ports.js'
import {CascadedRealtimeError} from '../realtime/cascaded/adapter.js'
import {CascadedRealtimeProvider} from '../realtime/cascaded/provider.js'
import {createQwenCascadedLlmFactory} from '../realtime/cascaded/qwen-llm.js'
import {frontendInstructions} from '../realtime/frontend-instructions.js'
import {DoubaoAsrClient} from '../realtime/volcengine/asr.js'
import {
  createEndpointingCapabilityFactory,
  type EndpointingCapabilityFactory,
  type LiveKitExecutor,
  type PreparedEndpointingCapability,
} from '../realtime/volcengine/endpointing-capability.js'
import {LiveKitVolcEndpointing} from '../realtime/volcengine/livekit-endpointing.js'
import {SilenceVolcEndpointing} from '../realtime/volcengine/silence-endpointing.js'
import {DoubaoTtsClient} from '../realtime/volcengine/tts.js'
import {type RealtimeProvider} from '../realtime/protocol.js'
import {QwenAudioRealtimeAdapter, type QwenConnector} from '../realtime/qwen.js'
import {webSocketQwenConnector} from '../realtime/qwen-transport.js'

export type {
  ArkCascadedLlmConfig,
  AutoEndpointingConfig,
  QwenCascadedLlmConfig,
  VolcengineAsrConfig,
  VolcengineTtsConfig,
} from '../config/cascaded-realtime-config.js'

export type CascadedAsrClientFactory = (input: {
  readonly onUsage?: UsageReporter
  readonly config: VolcengineAsrConfig
  readonly idFactory: () => string
}) => AsrClient

export type CascadedTtsClientFactory = (input: {
  readonly onUsage?: UsageReporter
  readonly config: VolcengineTtsConfig
  readonly idFactory: () => string
}) => TtsClient

export type QwenCascadedFactory = (input: {
  readonly onUsage?: UsageReporter
  readonly config: QwenCascadedLlmConfig
  readonly clock: Clock
  readonly idFactory: () => string
  readonly instructions: string
}) => CascadedLlmFactory

export type ArkCascadedFactory = (input: {
  readonly onUsage?: UsageReporter
  readonly config: ArkCascadedLlmConfig
  readonly instructions: string
}) => CascadedLlmFactory

export interface BuildCascadedRealtimeAssemblyOptions
  extends Omit<AssemblyOptions, 'gateway'>, Omit<
    RealtimeAssemblyOptions,
    | 'core'
    | 'provider'
    | 'idFactory'
    | 'controlledPreemptiveAlertReconnect'
    | 'preemptiveAlertHistoryRecovery'
    | 'preemptiveAlertHistoryPairs'
    | 'controlledGuardReconnect'
    | 'guardHistoryRecovery'
    | 'guardHistoryPairs'
  > {
  readonly registries?: CascadedProviderRegistries
  readonly supportGateway?: ModelGateway
  readonly endpointingCapability?: EndpointingCapabilityFactory
  readonly asrClient?: CascadedAsrClientFactory
  readonly qwenLlmFactory?: QwenCascadedFactory
  readonly arkLlmFactory?: ArkCascadedFactory
  readonly ttsClient?: CascadedTtsClientFactory
  readonly liveKitExecutor?: LiveKitExecutor
  readonly codexResource?: CodingExecutorResource
}

export interface AutoEndpointingFactoryInput {
  readonly config: AutoEndpointingConfig
  readonly clock: Clock
  readonly capability?: EndpointingCapabilityFactory
  readonly liveKitExecutor?: LiveKitExecutor
}

export interface VolcengineAsrFactoryInput {
  readonly onUsage?: UsageReporter
  readonly config: VolcengineAsrConfig
  readonly ids: IdFactory
  readonly clientFactory?: CascadedAsrClientFactory
}

export interface QwenLlmFactoryInput {
  readonly onUsage?: UsageReporter
  readonly config: QwenCascadedLlmConfig
  readonly clock: Clock
  readonly ids: IdFactory
  readonly instructions: string
  readonly factory?: QwenCascadedFactory
}

export interface ArkLlmFactoryInput {
  readonly onUsage?: UsageReporter
  readonly config: ArkCascadedLlmConfig
  readonly clock: Clock
  readonly ids: IdFactory
  readonly instructions: string
  readonly factory?: ArkCascadedFactory
}

export interface VolcengineTtsFactoryInput {
  readonly onUsage?: UsageReporter
  readonly config: VolcengineTtsConfig
  readonly ids: IdFactory
  readonly clientFactory?: CascadedTtsClientFactory
}

export interface CascadedProviderRegistries {
  readonly endpointing: Readonly<Record<
    CascadedEndpointingProviderName,
    (input: AutoEndpointingFactoryInput) => EndpointingFactory
  >>
  readonly asr: Readonly<Record<
    CascadedAsrProviderName,
    (input: VolcengineAsrFactoryInput) => AsrFactory
  >>
  readonly llm: Readonly<{
    readonly qwen: (input: QwenLlmFactoryInput) => CascadedLlmFactory
    readonly ark: (input: ArkLlmFactoryInput) => CascadedLlmFactory
  }>
  readonly tts: Readonly<Record<
    CascadedTtsProviderName,
    (input: VolcengineTtsFactoryInput) => TtsFactory
  >>
}

export const cascadedProviderRegistries: CascadedProviderRegistries = Object.freeze({
  endpointing: Object.freeze({
    auto: (input: AutoEndpointingFactoryInput) => {
      const capability = input.capability
        ?? createEndpointingCapabilityFactory({
          clock: input.clock,
          ...(process.env.NOVA_AUDIO_AGENT_CODEX_RESOURCES_PATH === undefined ? {}
            : {resourcesPath: process.env.NOVA_AUDIO_AGENT_CODEX_RESOURCES_PATH}),
          ...(input.liveKitExecutor === undefined
            ? {}
            : {executor: input.liveKitExecutor}),
        })
      return async (request: Parameters<EndpointingFactory>[0]) => (
        buildEndpointing(await capability(request), input.config, request.telemetry)
      )
    },
  }),
  asr: Object.freeze({
    volcengine: (input: VolcengineAsrFactoryInput) => ({
      openClient: () => (input.clientFactory ?? defaultAsrClient)({
        ...(input.onUsage === undefined ? {} : {onUsage: input.onUsage}),
        config: input.config,
        idFactory: () => input.ids.next('volcengine'),
      }),
    }),
  }),
  llm: Object.freeze({
    qwen: (input: QwenLlmFactoryInput) => (
      input.factory ?? defaultQwenLlmFactory
    )({
      ...(input.onUsage === undefined ? {} : {onUsage: input.onUsage}),
      config: input.config,
      clock: input.clock,
      idFactory: () => input.ids.next('qwen-cascaded'),
      instructions: input.instructions,
    }),
    ark: (input: ArkLlmFactoryInput) => (
      input.factory ?? defaultArkLlmFactory
    )({
      ...(input.onUsage === undefined ? {} : {onUsage: input.onUsage}),
      config: input.config,
      instructions: input.instructions,
    }),
  }),
  tts: Object.freeze({
    volcengine: (input: VolcengineTtsFactoryInput) => ({
      openClient: () => (input.clientFactory ?? defaultTtsClient)({
        ...(input.onUsage === undefined ? {} : {onUsage: input.onUsage}),
        config: input.config,
        idFactory: () => input.ids.next('volcengine'),
      }),
    }),
  }),
})

export function buildCascadedRealtimeAssembly(
  options: BuildCascadedRealtimeAssemblyOptions,
  registry: CascadedProviderRegistries = options.registries ?? cascadedProviderRegistries,
): RealtimeAssembly {
  options = filterDisabledCoding(options)
  const selected = requireSelectedCascadedRealtimeConfig(options.settings)
  const selection = selected.selection
  validateCodingResource(options)
  const createPersonalMemory = options.createPersonalMemory
    ?? personalMemoryFactory(options.settings)
  const clock = options.clock ?? new RealClock()
  const ids = options.ids ?? new MonotonicIdFactory()
  const capabilities = options.capabilities ?? capabilitiesFromSettings(options.settings)
  const currentInstructions = () => frontendInstructions({
    search: capabilities.modules.search.enabled,
    camera: options.cameraModuleEnabled ?? capabilities.modules.camera.enabled,
    coding: capabilities.modules.coding.enabled,
    knowledge: capabilities.modules.knowledge.enabled,
  }, (options.executorApproval ?? options.codexResource?.approvalController) != null)

  const endpointingFactory = registry.endpointing[selection.endpointingProvider]({
    config: selected.endpointing,
    clock,
    ...(options.endpointingCapability === undefined
      ? {}
      : {capability: options.endpointingCapability}),
    ...(options.liveKitExecutor === undefined ? {} : {liveKitExecutor: options.liveKitExecutor}),
  })
  const asrFactory = registry.asr[selection.asrProvider]({
    ...(options.onUsage === undefined ? {} : {onUsage: usageReporterForEndpoint(options.onUsage, selected.asr.endpoint)!}),
    config: selected.asr,
    ids,
    ...(options.asrClient === undefined ? {} : {clientFactory: options.asrClient}),
  })
  let instructions = currentInstructions()
  const createLlmFactory = () => selected.llm.provider !== 'ark'
    ? registry.llm.qwen({
      ...(options.onUsage === undefined ? {} : {onUsage: usageReporterForEndpoint(options.onUsage, selected.llm.config.baseUrl)!}),
      config: selected.llm.config,
      clock,
      ids,
      instructions,
      ...(options.qwenLlmFactory === undefined ? {} : {factory: options.qwenLlmFactory}),
    })
    : registry.llm.ark({
      ...(options.onUsage === undefined ? {} : {onUsage: usageReporterForEndpoint(options.onUsage, selected.llm.config.baseUrl)!}),
      config: selected.llm.config,
      clock,
      ids,
      instructions,
      ...(options.arkLlmFactory === undefined ? {} : {factory: options.arkLlmFactory}),
  })
  let selectedLlmFactory = createLlmFactory()
  const llmFactory: CascadedLlmFactory = {open: () => {
    const next = currentInstructions()
    if (next !== instructions) { instructions = next; selectedLlmFactory = createLlmFactory() }
    return selectedLlmFactory.open()
  }}
  const ttsFactory = registry.tts[selection.ttsProvider]({
    ...(options.onUsage === undefined ? {} : {onUsage: usageReporterForEndpoint(options.onUsage, selected.tts.endpoint)!}),
    config: selected.tts,
    ids,
    ...(options.ttsClient === undefined ? {} : {clientFactory: options.ttsClient}),
  })

  const support = supportComposition(
    options,
    selection.llmProvider,
    selection.llmModel,
    selected.llm.config.apiKey,
    selected.llm.config.baseUrl,
    clock,
  )
  const core = buildAssembly({
    ...options,
    settings: support.settings,
    clock,
    ids,
    gateway: support.gateway,
    ...((options.executors === undefined && options.codexResource === undefined)
      ? {}
      : {executors: [...(options.executors ?? []), ...(options.codexResource === undefined ? [] : [options.codexResource.adapter])]}),
  })
  const provider = new CascadedRealtimeProvider({
    language: options.settings.language,
    ...(options.settings.conversation_vision_enabled && supportsVision(selection.llmProvider, selection.llmModel)
      ? {captureFrame: (signal: AbortSignal) => captureConversationFrame(core.frameSource, signal, core.mediaStore)} : {}),
    endpointingFactory,
    asrFactory,
    llmFactory,
    ttsFactory,
    ...(options.telemetry === undefined ? {} : {telemetry: options.telemetry}),
    idFactory: () => ids.next('cascaded'),
  })
  const intake = options.intake ?? defaultIntake(core, support.gateway, support.settings)
  return composeRealtime(core, provider, {
    ...options,
    ...(intake === undefined ? {} : {intake}),
    idFactory: () => ids.next('realtime'),
  }, {
    controlledPreemptiveAlertReconnect: false,
    preemptiveAlertHistoryRecovery: 'none',
    preemptiveAlertHistoryPairs: 4,
    ...(createPersonalMemory === undefined ? {} : {createPersonalMemory}),
  })
}

function supportComposition(
  options: BuildCascadedRealtimeAssemblyOptions,
  provider: CascadedLlmProviderName,
  model: string,
  llmApiKey: string,
  selectedBaseUrl: string,
  clock: Clock,
): {readonly settings: Settings; readonly gateway: ModelGateway} {
  if (options.supportGateway !== undefined) {
    return {settings: options.settings, gateway: options.supportGateway}
  }
  const connection = resolveSupportModelConnection(options.settings, {
    baseUrl: selectedBaseUrl,
    apiKey: llmApiKey,
  })
  const gateway = new OpenAIModelGateway({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    ...(connection.source !== 'generic' && provider === 'deepseek' ? {thinkingControl: 'deepseek' as const} : {}),
    clock,
    ...(options.metrics === undefined ? {} : {metrics: options.metrics}),
  })
  if (connection.source === 'generic') return {settings: options.settings, gateway}
  const watchModel = stripLikePython(options.settings.watch_model ?? '')
    || (provider === 'qwen' ? 'qwen3-vl-plus' : model)
  const settings = Object.create(options.settings) as Settings
  Object.assign(settings, {
    watch_model: watchModel,
    surrogate_model: model,
    planner_model: stripLikePython(options.settings.planner_model) || model,
    compressor_model: model,
  })
  Object.freeze(settings)
  return {settings, gateway}
}

function buildEndpointing(
  prepared: PreparedEndpointingCapability,
  config: AutoEndpointingConfig,
  telemetry?: RealtimeTelemetry,
): LiveKitVolcEndpointing | SilenceVolcEndpointing {
  if (prepared.result.mode !== 'livekit_v1_mini') return new SilenceVolcEndpointing(config)
  if (prepared.surface === undefined || prepared.executor === undefined) {
    throw new CascadedRealtimeError('configuration')
  }
  return new LiveKitVolcEndpointing({
    ...(telemetry === undefined ? {} : {telemetry}),
    surface: prepared.surface,
    executor: prepared.executor,
    config,
  })
}

const defaultAsrClient: CascadedAsrClientFactory = input => new DoubaoAsrClient({
  ...(input.onUsage === undefined ? {} : {onUsage: input.onUsage}),
  endpoint: input.config.endpoint,
  apiKey: input.config.apiKey,
  resourceId: input.config.resourceId,
  chunkMs: input.config.chunkMs,
  idFactory: input.idFactory,
})

const defaultTtsClient: CascadedTtsClientFactory = input => new DoubaoTtsClient({
  ...(input.onUsage === undefined ? {} : {onUsage: input.onUsage}),
  endpoint: input.config.endpoint,
  apiKey: input.config.apiKey,
  resourceId: input.config.resourceId,
  voice: input.config.voice,
  outputSampleRate: input.config.outputSampleRate,
  idFactory: input.idFactory,
})

const defaultQwenLlmFactory: QwenCascadedFactory = input => createQwenCascadedLlmFactory({
  ...(input.onUsage === undefined ? {} : {onUsage: input.onUsage}),
  ...input.config,
  instructions: input.instructions,
  clock: input.clock,
  idFactory: input.idFactory,
})

const defaultArkLlmFactory: ArkCascadedFactory = input => createArkCascadedLlmFactory({
  ...(input.onUsage === undefined ? {} : {onUsage: input.onUsage}),
  ...input.config,
  instructions: input.instructions,
})

export interface BuildQwenRealtimeAssemblyOptions
  extends Omit<AssemblyOptions, 'gateway'>, Omit<
    RealtimeAssemblyOptions,
    | 'core'
    | 'provider'
    | 'idFactory'
    | 'controlledPreemptiveAlertReconnect'
    | 'preemptiveAlertHistoryRecovery'
    | 'preemptiveAlertHistoryPairs'
    | 'controlledGuardReconnect'
    | 'guardHistoryRecovery'
    | 'guardHistoryPairs'
  > {
  /** Deterministic test seam; production uses the bounded WebSocket connector. */
  readonly connector?: QwenConnector
  /** Host-resolved selected-provider config; integrated production never re-resolves settings. */
  readonly qwenConfig?: QwenRealtimeConfig
  /** Host-selected provider; integrated registries never receive host composition options. */
  readonly qwenProvider?: RealtimeProvider
  /** Host-resolved Codex resource; never derived from provider or renderer input. */
  readonly codexResource?: CodingExecutorResource
}

/** Narrow provider-only form used by the integrated provider registry. */
export interface BuildQwenRealtimeProviderOptions {
  readonly language?: PromptLanguage
  readonly onUsage?: UsageReporter


  readonly config: QwenRealtimeConfig
  readonly connector?: QwenConnector
  readonly idFactory: () => string
  readonly now: () => number
  readonly executorApproval: boolean
  readonly modules?: {readonly workspace?: boolean; readonly search: boolean; readonly camera: boolean; readonly coding: boolean; readonly knowledge?: boolean}
}

/**
 * Build the narrow Qwen provider selected by a registry, or one complete ownership graph.
 *
 * The narrow overload cannot see host settings or core resources. Full composition resolves host
 * settings before construction. Connection and rollback remain owned by `RealtimeAssembly.start()`.
 */
export function buildQwenRealtimeAssembly(
  options: BuildQwenRealtimeProviderOptions,
): QwenAudioRealtimeAdapter
export function buildQwenRealtimeAssembly(
  options: BuildQwenRealtimeAssemblyOptions,
): RealtimeAssembly
export function buildQwenRealtimeAssembly(
  options: BuildQwenRealtimeAssemblyOptions | BuildQwenRealtimeProviderOptions,
): RealtimeAssembly | QwenAudioRealtimeAdapter {
  if ('config' in options) {
    return new QwenAudioRealtimeAdapter({
      ...(options.language === undefined ? {} : {language: options.language}),
      ...(options.onUsage === undefined ? {} : {onUsage: usageReporterForEndpoint(options.onUsage, options.config.url)!}),
      url: options.config.url,
      apiKey: options.config.apiKey,
      model: options.config.model,
      voice: options.config.voice,
      connector: options.connector ?? webSocketQwenConnector,
      idFactory: options.idFactory,
      now: options.now,
      executorApproval: options.executorApproval,
      ...(options.modules === undefined ? {} : {modules: options.modules}),
    })
  }
  options = filterDisabledCoding(options)
  validateCodingResource(options)
  const qwen = options.qwenConfig ?? requireQwenRealtime(options.settings)
  const createPersonalMemory = options.createPersonalMemory
    ?? personalMemoryFactory(options.settings)
  const clock = options.clock ?? new RealClock()
  const ids = options.ids ?? new MonotonicIdFactory()
  const support = resolveSupportModelConnection(options.settings, {
    baseUrl: DASHSCOPE_COMPATIBLE_BASE_URL,
    apiKey: qwen.apiKey,
  })
  const gateway = new OpenAIModelGateway({
    baseUrl: support.baseUrl,
    apiKey: support.apiKey,
    clock,
    ...(options.metrics === undefined ? {} : {metrics: options.metrics}),
  })
  const core = buildAssembly({
    ...options,
    settings: options.settings,
    clock,
    ids,
    gateway: gateway,
    ...((options.executors === undefined && options.codexResource === undefined)
      ? {}
      : {executors: [...(options.executors ?? []), ...(options.codexResource === undefined ? [] : [options.codexResource.adapter])]}),
  })
  const provider = options.qwenProvider ?? buildQwenRealtimeAssembly({
    language: options.settings.language,
    ...(options.onUsage === undefined ? {} : {onUsage: options.onUsage}),
    config: qwen,
    ...(options.connector === undefined ? {} : {connector: options.connector}),
    idFactory: () => ids.next('qwen'),
    now: () => clock.now(),
    modules: {
      search: core.capabilities.modules.search.enabled,
      camera: options.cameraModuleEnabled ?? core.capabilities.modules.camera.enabled,
      coding: core.capabilities.modules.coding.enabled,
      knowledge: core.capabilities.modules.knowledge.enabled,
    },
    executorApproval: (options.executorApproval ?? options.codexResource?.approvalController) != null,
  })
  const intake = options.intake ?? defaultIntake(core, gateway, options.settings)
  return composeRealtime(core, provider, {
    ...options,
    ...(intake === undefined ? {} : {intake}),
    idFactory: () => ids.next('realtime'),
  }, {
    controlledPreemptiveAlertReconnect: options.settings.qwen_controlled_guard_reconnect,
    preemptiveAlertHistoryRecovery: options.settings.qwen_guard_history_recovery,
    preemptiveAlertHistoryPairs: options.settings.qwen_guard_history_pairs,
    ...(createPersonalMemory === undefined ? {} : {createPersonalMemory}),
  })
}

export type BuildIntegratedRealtimeAssemblyOptions = Omit<
  BuildQwenRealtimeAssemblyOptions,
  'qwenConfig' | 'qwenProvider'
>

export type IntegratedQwenFactoryInput = BuildQwenRealtimeProviderOptions

export type IntegratedProviderRegistry = Readonly<Record<
  IntegratedProviderName,
  (input: IntegratedQwenFactoryInput) => RealtimeProvider
>>

export const integratedProviderRegistry: IntegratedProviderRegistry = Object.freeze({
  qwen: input => buildQwenRealtimeAssembly(input),
})

export function buildIntegratedRealtimeAssembly(
  options: BuildIntegratedRealtimeAssemblyOptions,
  registry: IntegratedProviderRegistry = integratedProviderRegistry,
): RealtimeAssembly {
  options = filterDisabledCoding(options)
  const provider = options.settings.integrated_provider
  if (!Object.hasOwn(registry, provider)) {
    throw new ConfigurationError('NOVA_AUDIO_AGENT_INTEGRATED_PROVIDER 无效')
  }
  const config = Object.freeze({...requireIntegratedRealtime(options.settings)})
  const clock = options.clock ?? new RealClock()
  const ids = options.ids ?? new MonotonicIdFactory()
  const capabilities = options.capabilities ?? capabilitiesFromSettings(options.settings)
  const qwenProvider = registry[provider]({
    language: options.settings.language,
    ...(options.onUsage === undefined ? {} : {onUsage: options.onUsage}),
    config,
    ...(options.connector === undefined ? {} : {connector: options.connector}),
    idFactory: () => ids.next('qwen'),
    now: () => clock.now(),
    modules: {
      search: capabilities.modules.search.enabled,
      camera: options.cameraModuleEnabled ?? capabilities.modules.camera.enabled,
      coding: capabilities.modules.coding.enabled,
      knowledge: capabilities.modules.knowledge.enabled,
    },
    executorApproval: (options.executorApproval ?? options.codexResource?.approvalController) != null,
  })
  return buildQwenRealtimeAssembly({
    ...options,
    clock,
    ids,
    qwenConfig: config,
    qwenProvider,
  })
}

export type BuildProductionRealtimeAssemblyOptions =
  BuildIntegratedRealtimeAssemblyOptions & BuildCascadedRealtimeAssemblyOptions

export interface ProductionRealtimeAssemblyBuilders {
  readonly integrated?: (
    options: BuildIntegratedRealtimeAssemblyOptions,
  ) => RealtimeAssembly
  readonly cascaded?: (
    options: BuildCascadedRealtimeAssemblyOptions,
  ) => RealtimeAssembly
}

export function buildProductionRealtimeAssembly(
  options: BuildProductionRealtimeAssemblyOptions,
  builders: ProductionRealtimeAssemblyBuilders = {},
): RealtimeAssembly {
  const composition = productionCodingComposition(filterDisabledCoding(options))
  if (options.settings.pipeline_mode === 'integrated') {
    return (builders.integrated ?? buildIntegratedRealtimeAssembly)(composition)
  }
  if (options.settings.pipeline_mode === 'cascaded') {
    return (builders.cascaded ?? buildCascadedRealtimeAssembly)(composition)
  }
  throw new ConfigurationError('NOVA_AUDIO_AGENT_PIPELINE_MODE 无效')
}

function productionCodingComposition(
  options: BuildProductionRealtimeAssemblyOptions,
): BuildProductionRealtimeAssemblyOptions {
  const resource = options.codexResource
  if (resource === undefined) return options
  const descriptor = resource.agentDescriptor
  if (descriptor === undefined) throw new ConfigurationError('coding resource must supply its agent descriptor')
  const descriptors = options.agentDescriptors ?? []
  if (descriptors.some(value => value.name === descriptor.name
    || value.ownedChannels.includes(resource.adapter.manifest.name))) {
    throw new ConfigurationError('production coding descriptor cannot be overridden')
  }
  const factory = options.codingAgentControllerFactory ?? resource.agentControllerFactory
  if (factory === undefined) throw new ConfigurationError('coding resource must supply its agent controller factory')
  return {
    ...options,
    codingAgentControllerFactory: factory,
    agentDescriptors: [...descriptors, descriptor],
  }
}
