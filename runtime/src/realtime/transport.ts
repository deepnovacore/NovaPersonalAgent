import type {CommittedConversationPair} from './history.js'
import type {PromptLanguage} from './prompt-language.js'
import type {UsageReporter} from './usage.js'
import type {FrontendModuleSelection} from './frontend-instructions.js'
import type {IntegratedWireProfile} from './integrated-wire-profile.js'
import type {RealtimeTelemetry} from './telemetry.js'

/** Raised by a transport when the peer closed; mapped to a recoverable disconnect. */
export class RealtimeSocketClosedError extends Error {
  constructor(message = 'realtime socket closed') {
    super(message)
    this.name = 'RealtimeSocketClosedError'
  }
}

export type RealtimeConnectFailureCode =
  | 'realtime_auth_rejected'
  | 'realtime_endpoint_not_found'
  | 'realtime_rate_limited'
  | 'realtime_handshake_rejected'
  | 'realtime_unreachable'
  | 'realtime_timeout'
  | 'realtime_tls_failed'
  | 'realtime_connect_failed'

/**
 * A handshake failure reduced to a user-actionable code. The message is the code itself and
 * never carries the provider's text, the endpoint, or the credential.
 */
export class RealtimeConnectError extends Error {
  readonly code: RealtimeConnectFailureCode
  readonly status: number | undefined
  /** Allowlisted-shape system error code (for example `EPROTO`); never provider text. */
  readonly systemCode: string | undefined

  constructor(code: RealtimeConnectFailureCode, status?: number, systemCode?: string) {
    super(code)
    this.systemCode = systemCode
    this.name = 'RealtimeConnectError'
    this.code = code
    this.status = status
  }
}

export interface RealtimeSocket {
  send(payload: string): Promise<void>
  /** Resolves the next text frame, or throws RealtimeSocketClosedError at EOF. */
  receive(): Promise<string>
  close(): Promise<void>
}

export interface RealtimeConnectorOptions {
  readonly binaryJson?: boolean
  readonly endpoint: string
  readonly headers: Readonly<Record<string, string>>
  readonly openTimeout: number
  readonly signal: AbortSignal
}

export type RealtimeConnector = (options: RealtimeConnectorOptions) => Promise<RealtimeSocket>

export interface RealtimeAdapterOptions {
  readonly history?:readonly CommittedConversationPair[]
  readonly language?: PromptLanguage
  readonly url: string
  readonly apiKey: string
  readonly model: string
  readonly voice: string
  readonly connector: RealtimeConnector
  readonly onUsage?: UsageReporter
  readonly idFactory?: () => string
  readonly connectTimeout?: number
  readonly itemConfirmationTimeout?: number
  readonly closeTimeout?: number
  readonly now?: () => number
  readonly executorApproval?: boolean
  readonly modules?: FrontendModuleSelection
  readonly wireProfile?: IntegratedWireProfile
  /** Receives `integrated.connect` outcomes; payloads carry codes only, never the URL or credential. */
  readonly telemetry?: RealtimeTelemetry
}
