import {EAGER_CODING_PROGRESS_INSTRUCTIONS} from './progress-instructions.js'
import type {ManagedCodexMcp} from './managed-mcp.js'
import type {CodingExecutorResource} from '../coding-executor.js'
import {codexAgentDescriptor, codingAgentControllerFactory} from './controller.js'
import {
  OwnedCodexAppServerTransport,
  type CodexAppServerTransport,
  type CodexHostPreflightRunner,
  type CodexLiveSchemaProbe,
  type ProjectConnectionBinding,
  type RunInput,
  type CodingPreflightReport,
  type SteerInput,
  type SteerTransportResult,
  type TransportDeadline,
  type TransportObserver,
  type TransportOutcome,
} from './app-server-transport.js'
import type {
  CodexCredentialProfile,
  ResolvedCodexHostConfig,
  ResolvedCodingHostConfig,
} from './host-config.js'
import {codexCredentialApiKey} from './host-config.js'
import type {CredentialSnapshotter} from './credential-snapshot.js'
import type {PublicProjectView} from '../../projects/project-store.js'
import {
  ProjectStore,
  MAX_PROJECT_WORKSPACE_NAME,
  ProjectStateError,
} from '../../projects/project-store.js'
import type {NativeFileLockAuthority} from '../../storage/native-file-lock.js'
import type {ProjectRootFileAuthority} from '../../projects/project-root-file.js'
import {
  hostWorkspacePath,
  type CodexProcessOwnerFactory,
  type HostBinary,
  type HostCodexHome,
  type HostWorkspace,
} from './process-owner.js'
import type {ExecutorAdapter} from '../../core/causal-runtime.js'
import type {Clock} from '../../core/clock.js'
import {CodexHostConfigurationError} from './host-config.js'
import {ProjectCodexAdapter} from './adapter-project.js'
import {ProjectConfirmationController} from '../../projects/project-confirmation.js'
import {HostApprovalController, type ApprovalPort, type ApprovalResolution} from '../../core/approval.js'
import {type ApprovalView, type ApprovalWork} from '../../core/approval-port.js'
import {basename} from 'node:path'
import {randomUUID} from 'node:crypto'
import {hostPersistentHomeFromConfig} from '../../projects/host-paths.js'
import {hostCodexHomeValue} from './process-owner.js'
import {
  resolveCodexLaunchProfile,
  type CodexLaunchProfile,
} from './launch-profile.js'
import {CodexTransportError} from './app-server-transport.js'
import {CODING_BACKEND_IDS, isAcpBackend, type AcpBackendId, type CodingBackendId} from '../../config/coding-backends.js'
import {CODEX_PROFILE_ID} from '../../config/coding-profiles.js'
import type {ProjectBackendBinding} from './adapter-project.js'
import type {AcpProjectBinding} from '../acp/transport.js'

export type CodexAssemblyMode = 'live' | 'project'
export type CodexApprovalPolicy = 'never' | 'on-request'

export interface CodexTransportBinding {
  readonly preserveHome?: boolean

  readonly managedMcp?: ManagedCodexMcp
  readonly mode: CodexAssemblyMode
  readonly binary: HostBinary
  readonly binaryPrefixArgs: readonly string[]
  readonly workspace: HostWorkspace
  readonly codexHome: HostCodexHome | null
  readonly credential: CodexCredentialProfile
  readonly resumeThreadId: string | null
  readonly workingInterval: number
  readonly eagerProgress?: boolean
  readonly launchProfile: CodexLaunchProfile
  /** Project mode: the shared controller scoped to the run's work (`forWork`), so one work's turn end never drops another's approval. */
  readonly approvalController: ApprovalPort | null
}

export interface CodexBackendTransportFactory {
  readonly available: boolean
  create(binding: CodexTransportBinding): CodexAppServerTransport
}

/** Host resources below the reviewed 6B transport. Task 8 supplies their packaged implementations. */
export interface OwnedCodexBackendTransportFactoryOptions {
  readonly processFactory: CodexProcessOwnerFactory
  readonly credentialSnapshotter: CredentialSnapshotter
  readonly preflightRunner: CodexHostPreflightRunner
  readonly schemaProbe: CodexLiveSchemaProbe
  readonly ephemeralHomeFactory: () => HostCodexHome
}

export class OwnedCodexBackendTransportFactory implements CodexBackendTransportFactory {
  readonly available = true
  readonly #options: OwnedCodexBackendTransportFactoryOptions

  constructor(options: OwnedCodexBackendTransportFactoryOptions) {
    this.#options = options
  }

  create(binding: CodexTransportBinding): CodexAppServerTransport {
    const project = binding.mode === 'project'
    const codexHome = project ? binding.codexHome : this.#options.ephemeralHomeFactory()
    if (codexHome === null) throw new CodexHostConfigurationError('codex_host_unavailable')
    const transport = new OwnedCodexAppServerTransport({
      config: {
        ...(binding.managedMcp === undefined ? {} : {managedMcp: binding.managedMcp}),
        generateTitles: project && binding.resumeThreadId === null,
        preserveHome: binding.preserveHome ?? false,
        binary: binding.binary,
        prefixArgs: binding.binaryPrefixArgs,
        workspace: binding.workspace,
        codexHome,
        apiKey: codexCredentialApiKey(binding.credential),
        developerInstructions: binding.eagerProgress === true ? EAGER_CODING_PROGRESS_INSTRUCTIONS : null,
        eagerProgress: binding.eagerProgress === true,
        resumeThreadId: binding.resumeThreadId,
        persistent: project,
        workingInterval: binding.workingInterval,
        launchProfile: binding.launchProfile,
        ...(binding.approvalController === null
          ? {}
          : {approvalController: binding.approvalController}),
      },
      processFactory: this.#options.processFactory,
      credentialSnapshotter: this.#options.credentialSnapshotter,
      preflightRunner: this.#options.preflightRunner,
      schemaProbe: this.#options.schemaProbe,
    })
    return new CredentialHomeOwningTransport(
      transport,
      this.#options.credentialSnapshotter,
      codexHome,
    )
  }
}

class CredentialHomeOwningTransport implements CodexAppServerTransport {
  #closeOperation: Promise<void> | null = null

  constructor(
    readonly inner: CodexAppServerTransport,
    readonly credentials: CredentialSnapshotter,
    readonly codexHome: HostCodexHome,
  ) {}

  preflight(deadline: TransportDeadline): Promise<CodingPreflightReport> {
    return this.inner.preflight(deadline)
  }

  prewarmConnection(deadline: TransportDeadline): Promise<CodingPreflightReport | null> {
    if (!this.inner.prewarmConnection) throw new CodexHostConfigurationError('codex_host_unavailable')
    return this.inner.prewarmConnection(deadline)
  }

  bindProject(binding: ProjectConnectionBinding): void {
    if (!this.inner.bindProject) throw new CodexHostConfigurationError('codex_host_unavailable')
    this.inner.bindProject(binding)
  }

  prewarm(deadline: TransportDeadline): Promise<CodingPreflightReport | null> {
    return this.inner.prewarm(deadline)
  }

  run(
    input: RunInput,
    observer: TransportObserver,
    deadline: TransportDeadline,
    completionDeadline?: TransportDeadline | null,
  ): Promise<TransportOutcome> {
    return this.inner.run(input, observer, deadline, completionDeadline)
  }

  steer(input: SteerInput, deadline: TransportDeadline): Promise<SteerTransportResult> {
    return this.inner.steer(input, deadline)
  }

  close(reason?: 'shutdown' | 'cancel' | 'failure'): Promise<void> {
    if (this.#closeOperation !== null) return this.#closeOperation
    const work = this.#close(reason)
    const exposed = work.catch(error => {
      if (this.#closeOperation === exposed) this.#closeOperation = null
      throw error
    })
    this.#closeOperation = exposed
    return exposed
  }

  async #close(reason?: 'shutdown' | 'cancel' | 'failure'): Promise<void> {
    await this.inner.close(reason)
    await this.credentials.removeEphemeralHome(this.codexHome)
  }
}

export const unavailableCodexBackendTransportFactory: CodexBackendTransportFactory = Object.freeze({
  available: false,
  create: (): CodexAppServerTransport => {
    throw new CodexHostConfigurationError('codex_host_unavailable')
  },
})

export interface CodexAssemblyResource extends CodingExecutorResource {
  readonly adapter: ExecutorAdapter
  readonly mode: CodexAssemblyMode
  readonly projectView: PublicProjectView | null
  readonly approvalPolicy: CodexApprovalPolicy
  readonly approvalController: HostApprovalController | null
  /** New sessions only; running and existing sessions keep their bound backend. */
  updateDefaultBackend?(backend: CodingBackendId): void
  start(): Promise<void>
  close(): Promise<void>
}

/**
 * Non-Codex backends routed through the same single coding executor. Codex sessions keep the
 * app-server transport; every other session gets an ACP transport built from its own binding.
 */
export interface CodingBackendRouting {
  readonly initialBackend: CodingBackendId
  /** Current default profile identity for new sessions on an ACP backend. */
  readonly defaultProfile: (backend: AcpBackendId) => string
  readonly displayName: (backend: AcpBackendId) => string
  readonly create: (binding: AcpProjectBinding) => CodexAppServerTransport
}

const LEGACY_CODEX_BINDING: ProjectBackendBinding = Object.freeze({backend_id: 'codex', backend_profile_id: CODEX_PROFILE_ID})

export interface CreateCodexAssemblyResourceOptions {
  readonly backends?: CodingBackendRouting
  readonly sharedApprovalController?: HostApprovalController
  readonly managedMcp?: ManagedCodexMcp
  /** Codex launch fields are required only when Codex is the default backend. */
  readonly config: ResolvedCodingHostConfig
  readonly composition: 'realtime'
  readonly transportFactory: CodexBackendTransportFactory
  readonly clock: Clock
  readonly now?: () => number
  readonly idFactory: () => string
  readonly projectHost?: {
    readonly nativeLocks: NativeFileLockAuthority
    readonly rootFiles: ProjectRootFileAuthority
  }
  readonly onProjectView?: (view: PublicProjectView) => void
  readonly platform?: NodeJS.Platform
  readonly codexApprovalBroker?: {
    readonly publish: (view: ApprovalView) => void
  }
  readonly onDiagnostic?: (code: string) => void
}

export async function createCodexAssemblyResource(
  options: CreateCodexAssemblyResourceOptions,
): Promise<CodexAssemblyResource> {
  let available = false
  try { available = options.transportFactory.available === true } catch { /* safe failure below */ }
  const codex = available && options.config.codexAvailable ? options.config : null
  // Codex is mandatory only as the default backend; an ACP default runs with Codex absent.
  const initialBackend = options.backends?.initialBackend ?? 'codex'
  if (codex === null && (options.backends === undefined || !isAcpBackend(initialBackend))) {
    throw new CodexHostConfigurationError('codex_host_unavailable')
  }
  if (codex === null) {
    try { options.onDiagnostic?.('coding_codex_absent') } catch { /* diagnostics are advisory */ }
  }
  return await createProjectResource(options, codex)
}

function isCodexTransport(value: unknown): value is CodexAppServerTransport {
  try {
    return typeof value === 'object'
      && value !== null
      && typeof (value as CodexAppServerTransport).preflight === 'function'
      && typeof (value as CodexAppServerTransport).prewarm === 'function'
      && typeof (value as CodexAppServerTransport).run === 'function'
      && typeof (value as CodexAppServerTransport).steer === 'function'
      && typeof (value as CodexAppServerTransport).close === 'function'
  } catch {
    return false
  }
}

async function createProjectResource(
  options: CreateCodexAssemblyResourceOptions,
  codex: ResolvedCodexHostConfig | null,
): Promise<CodexAssemblyResource> {
  const host = options.projectHost
  const stateRoot = options.config.stateRoot
  const managedRoot = options.config.managedRoot
  const launchProfile = resolveCodexLaunchProfile({
    approvalMode: options.config.codexApprovalMode,
    project: true,
    foregroundBroker: options.codexApprovalBroker !== undefined || options.sharedApprovalController !== undefined,
  })
  const approvalController = launchProfile.controller === 'present'
    ? options.sharedApprovalController ?? new HostApprovalController({clock: options.clock, idFactory: options.idFactory,
        ...(options.onDiagnostic === undefined ? {} : {onDiagnostic: options.onDiagnostic})})
    : null
  if (launchProfile.id === 'ask_headless') {
    try { options.onDiagnostic?.('ask_headless_no_broker') } catch { /* diagnostics are advisory */ }
  }
  const ownsApproval = options.sharedApprovalController === undefined
  const approvalScopes = new Map<string, {port: ApprovalPort; resolution: ApprovalResolution | null}>()
  const scopedApproval = (work: ApprovalWork, identity: {readonly executor: string; readonly display_name: string}
    = {executor: 'codex', display_name: 'Codex'}): ApprovalPort | null => {
    if (approvalController === null) return null
    const port = approvalController.forWork(work)
    const scoped: ApprovalPort = {
      offer: async (offer, signal) => {
        const entry = {port: scoped, resolution: null as ApprovalResolution | null}
        // A duplicate offer must not replace the active request's cleanup ownership.
        if (!approvalScopes.has(work.work_id)) approvalScopes.set(work.work_id, entry)
        try {
          const resolution = await port.offer({...offer, executorIdentity: identity}, signal)
          entry.resolution = resolution
          if (resolution === null && approvalScopes.get(work.work_id) === entry) approvalScopes.delete(work.work_id)
          return resolution
        } catch (error) {
          if (approvalScopes.get(work.work_id) === entry) approvalScopes.delete(work.work_id)
          throw error
        }
      },
      consume: resolution => {
        const entry = approvalScopes.get(work.work_id)
        if (entry?.port === scoped && entry.resolution === resolution) approvalScopes.delete(work.work_id)
        return port.consume(resolution)
      },
      invalidate: reason => {
        if (approvalScopes.get(work.work_id)?.port === scoped) approvalScopes.delete(work.work_id)
        return port.invalidate(reason)
      },
    }
    return scoped
  }
  const invalidateApprovals = (reason: string): void => {
    for (const {port} of [...approvalScopes.values()]) port.invalidate(reason)
    if (ownsApproval) approvalController?.invalidate(reason)
  }
  const unsubscribeApproval = approvalController === null || !ownsApproval
    ? null
    : approvalController.observe(view => { options.codexApprovalBroker?.publish(view) })
  if (host === undefined) {
    unsubscribeApproval?.()
    throw new CodexHostConfigurationError('codex_project_host_unsupported')
  }
  const warmHome = codex !== null && codex.prewarm && codex.localCodexHome
    ? hostPersistentHomeFromConfig(codex.localCodexHome, [codex.localCodexHome]) : null
  let warmReady = false
  const routing = options.backends
  let defaultBackend: CodingBackendId = routing?.initialBackend ?? 'codex'
  const defaultBinding = (): ProjectBackendBinding => defaultBackend === 'codex' || routing === undefined || !isAcpBackend(defaultBackend)
    ? LEGACY_CODEX_BINDING
    : {backend_id: defaultBackend, backend_profile_id: routing.defaultProfile(defaultBackend)}
  let store: ProjectStore | null = null
  let startupTransport: CodexAppServerTransport | null = null
  try {
    // The startup transport certifies Codex; with Codex absent there is nothing to certify up front
    // because ACP backends run their own preflight per task.
    if (codex !== null) {
      startupTransport = options.transportFactory.create(Object.freeze({
        ...(options.managedMcp === undefined ? {} : {managedMcp: options.managedMcp}),
        mode: warmHome === null ? 'live' : 'project',
        preserveHome: warmHome !== null,
        binary: codex.binary,
        binaryPrefixArgs: codex.binaryPrefixArgs,
        workspace: codex.workspace,
        codexHome: warmHome,
        credential: codex.credential,
        resumeThreadId: null,
        workingInterval: codex.workingInterval,
        eagerProgress: codex.eagerProgress,
        launchProfile: warmHome !== null ? launchProfile : resolveCodexLaunchProfile({
          approvalMode: codex.codexApprovalMode, project: false, foregroundBroker: false,
        }),
        approvalController: warmHome === null ? null : scopedApproval({work_id: randomUUID(), project: '', title: 'Codex startup'}),
      }))
      if (!isCodexTransport(startupTransport)) {
        throw new CodexHostConfigurationError('codex_host_unavailable')
      }
    }
    store = await ProjectStore.open({
      stateRoot,
      managedRoot,
      nativeLocks: host.nativeLocks,
      rootFiles: host.rootFiles,
      live: true,
      now: options.now ?? (() => Date.now() / 1_000),
    })
    const derivedName = basename(hostWorkspacePath(options.config.workspace)) || 'workspace'
    const displayName = [...derivedName].slice(0, MAX_PROJECT_WORKSPACE_NAME).join('')
    const defaultWorkspace = await store.ensureImported(displayName, options.config.workspace)
    const confirmation = new ProjectConfirmationController({
      clock: options.clock,
      idFactory: options.idFactory,
    })
    const adapter = new ProjectCodexAdapter({
      defaultWorkspaceId: defaultWorkspace.workspace_id,
      ...(options.managedMcp?{managedMcp:options.managedMcp}:{}),
      store,
      ...(codex?.localCodexHome === undefined ? {} : {localCodexHome: codex.localCodexHome}),
      confirmation,
      ...(approvalController === null ? {} : {codexApproval: approvalController}),
      defaultBackend: defaultBinding,
      transportFactory: {
        create: binding => {
          if (binding.backend_id !== 'codex') {
            const backendId = binding.backend_id
            // A session bound to a backend this host cannot route stays recorded and retryable.
            if (routing === undefined || !isAcpBackend(backendId)) throw new CodexTransportError('resume_unavailable')
            const acpApproval = scopedApproval(binding.work, {executor: 'codex', display_name: routing.displayName(backendId)})
            try {
              return routing.create({backendId, profileId: binding.backend_profile_id, workspace: binding.workspace,
                resumeSessionId: binding.resumeThreadId, approvalController: acpApproval})
            } catch (error) {
              acpApproval?.invalidate('transport_creation_failed')
              throw error
            }
          }
          // A Codex session on a host without Codex stays recorded and retryable, like an unroutable ACP one.
          if (codex === null) throw new CodexTransportError('resume_unavailable')
          const codexHome = binding.codexHome
          if (codexHome === null) throw new CodexHostConfigurationError('codex_host_unavailable')
          const approval = scopedApproval(binding.work)
          try {
            if (warmReady && warmHome !== null && startupTransport?.bindProject
              && hostCodexHomeValue(codexHome).path === hostCodexHomeValue(warmHome).path) {
              warmReady = false
              startupTransport.bindProject({workspace: binding.workspace, resumeThreadId: binding.resumeThreadId,
                approvalController: approval})
              try { options.onDiagnostic?.('project_prewarm_reused') } catch { /* advisory */ }
              return startupTransport
            }
            const transport = options.transportFactory.create(Object.freeze({
              ...(options.managedMcp === undefined ? {} : {managedMcp: options.managedMcp}),
              preserveHome: binding.preserveHome ?? false,
              mode: 'project',
              binary: codex.binary,
              binaryPrefixArgs: codex.binaryPrefixArgs,
              workspace: binding.workspace,
              codexHome,
              credential: codex.credential,
              resumeThreadId: binding.resumeThreadId,
              workingInterval: codex.workingInterval,
              eagerProgress: codex.eagerProgress,
              launchProfile,
              approvalController: approval,
            }))
            if (!isCodexTransport(transport)) {
              throw new CodexHostConfigurationError('codex_host_unavailable')
            }
            return transport
          } catch (error) {
            approval?.invalidate('transport_creation_failed')
            throw error
          }
        },
      },
      ...(options.onProjectView === undefined ? {} : {onProjectView: options.onProjectView}),
    })
    await adapter.initialize()
    return new ProjectCodexAssemblyResource(
      adapter,
      startupTransport,
      launchProfile.thread.approvalPolicy,
      approvalController,
      unsubscribeApproval,
      invalidateApprovals,
      warmHome !== null,
      () => { warmReady = false;try { options.onDiagnostic?.('project_prewarm_failed') } catch { /* advisory */ } },
      ready => { warmReady = ready },
      backend => {
        if (!CODING_BACKEND_IDS.includes(backend) || (backend !== 'codex' && routing === undefined)) throw new Error('invalid_coding_backend')
        // New sessions cannot default to a backend this host cannot launch; the current default stays.
        if (backend === 'codex' && codex === null) throw new Error('coding_backend_unavailable')
        defaultBackend = backend
      },
    )
  } catch (error) {
    invalidateApprovals('resource_creation_failed')
    unsubscribeApproval?.()
    try { await startupTransport?.close('failure') } catch { /* Preserve the construction failure for malformed transports too. */ }
    await store?.close().catch(() => undefined)
    if (error instanceof CodexHostConfigurationError) throw error
    if (error instanceof ProjectStateError) {
      if (['state_busy', 'state_lock_failed', 'state_permissions', 'workspace_not_found', 'workspace_invalid'].includes(error.code)) throw error
      throw new CodexHostConfigurationError('codex_project_state_invalid')
    }
    throw new CodexHostConfigurationError('codex_host_unavailable')
  }
}

class ProjectCodexAssemblyResource implements CodexAssemblyResource {
  readonly agentControllerFactory = codingAgentControllerFactory
  get agentDescriptor() { return codexAgentDescriptor(this.adapter.manifest.name) }
  readonly mode = 'project'
  readonly #startupTransport: CodexAppServerTransport | null
  readonly #unsubscribeApproval: (() => void) | null
  #startOperation: Promise<void> | null = null
  #closeOperation: Promise<void> | null = null
  #closing = false

  constructor(
    readonly adapter: ProjectCodexAdapter,
    startupTransport: CodexAppServerTransport | null,
    readonly approvalPolicy: CodexApprovalPolicy,
    readonly approvalController: HostApprovalController | null,
    unsubscribeApproval: (() => void) | null,
    readonly invalidateApprovals: (reason: string) => void,
    readonly prewarmConnection = false,
    readonly onPrewarmFailure: () => void = () => undefined,
    readonly onPrewarmReady: (ready: boolean) => void = () => undefined,
    readonly setDefaultBackend: (backend: CodingBackendId) => void = () => { throw new Error('invalid_coding_backend') },
  ) {
    this.#startupTransport = startupTransport
    this.#unsubscribeApproval = unsubscribeApproval
  }

  get projectView(): PublicProjectView {
    return this.adapter.publicProjectView(this.adapter.confirmationController.pending)
  }

  updateDefaultBackend(backend: CodingBackendId): void {
    this.setDefaultBackend(backend)
  }

  start(): Promise<void> {
    if (this.#startOperation !== null) return this.#startOperation
    this.#startOperation = this.#startFresh()
    return this.#startOperation
  }

  async #startFresh(): Promise<void> {
    if (this.#startupTransport === null) return
    if (this.prewarmConnection && this.#startupTransport.prewarmConnection) {
      // Certification remains mandatory; warming a certified connection is only an optimization.
      try { await this.#startupTransport.preflight({expiresAtMs: Date.now() + 20_000}) }
      catch (error) {
        try { await this.#startupTransport.close('failure') } catch { /* Preserve the certification failure. */ }
        throw error
      }
      try {
        const report = await this.#startupTransport.prewarmConnection({expiresAtMs: Date.now() + 20_000})
        if (!this.#closing && report !== null) this.onPrewarmReady(true)
      }
      catch {
        this.onPrewarmFailure()
        await this.#startupTransport.close('failure')
      }
      return
    }
    let failure: unknown = null
    try {
      await this.#startupTransport.preflight({expiresAtMs: Date.now() + 20_000})
    } catch (error) {
      failure = error
    }
    try {
      await this.#startupTransport.close(failure === null ? 'shutdown' : 'failure')
    } catch (error) {
      failure ??= error
    }
    if (failure instanceof Error) throw failure
    if (failure !== null) throw new Error('codex startup failed')
  }

  close(): Promise<void> {
    if (this.#closeOperation !== null) return this.#closeOperation
    const work = this.#close()
    const projectClose = work.catch(error => {
      if (this.#closeOperation === projectClose) this.#closeOperation = null
      throw error
    })
    this.#closeOperation = projectClose
    return projectClose
  }

  async #close(): Promise<void> {
    this.#closing = true
    this.onPrewarmReady(false)
    this.invalidateApprovals('shutdown')
    try {
      await this.#startupTransport?.close('shutdown')
      await this.adapter.close()
    } finally {
      // Approvals scoped to Codex work end with it even when shutdown fails; a borrowed controller stays open.
      this.invalidateApprovals('shutdown')
      this.#unsubscribeApproval?.()
    }
  }
}
