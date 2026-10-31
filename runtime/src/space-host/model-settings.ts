import {createHash, randomUUID} from 'node:crypto'
import {EventEmitter} from 'node:events'
import {closeSync, constants, fstatSync, openSync, readFileSync} from 'node:fs'
import {link, mkdir, open, unlink} from 'node:fs/promises'
import {dirname} from 'node:path'
import {z} from 'zod'
import {MODEL_ROUTE_LANE_IDS, MODEL_ROUTE_LANE_PROVIDERS, MODEL_ROUTE_PROVIDER_METADATA, modelRoutesSchema, parseModelRoutes, type ModelRoutes} from '../config/model-routes.js'
import {MODEL_CATALOG_MODELS, MODEL_CATALOG_PROVIDERS} from '../model/model-catalog.js'
import {BoundedJsonStore} from '../storage/bounded-json.js'
import {canonicalJson} from '../text/canonical-json.js'

export const modelRoutesPatchSchema = z.object({
  expected_version: z.number().int().nonnegative(),
  routes: modelRoutesSchema.removeDefault(),
}).strict()

const fileSchema = z.object({
  v: z.literal(1),
  version: z.number().int().nonnegative(),
  routes: modelRoutesSchema.removeDefault(),
  applied_ops: z.array(z.object({
    opId: z.string().min(1).max(256),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
    resultVersion: z.number().int().positive(),
  }).strict()).max(64),
}).strict().superRefine((state, context) => {
  if (new Set(state.applied_ops.map(op => op.opId)).size !== state.applied_ops.length
    || state.applied_ops.some(op => op.resultVersion > state.version)) context.addIssue({code: 'custom', message: 'invalid_model_receipts'})
})
type ModelFile = z.infer<typeof fileSchema>
const CAPACITY = 128 * 1024
const changes = new EventEmitter()
/** Signals carry no settings or credentials. The runtime owns the single writer. */
export function subscribeHostModelRoutesChanges(listener: () => void): () => void {
  changes.on('changed', listener)
  return () => {changes.off('changed', listener)}
}
export const hostModelRoutesPath = (configPath: string): string => configPath + '.models.json'

function readFile(configPath: string): ModelFile | null {
  let fd: number
  try {fd = openSync(hostModelRoutesPath(configPath), constants.O_RDONLY | constants.O_NOFOLLOW)} catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw Error('space_models_invalid')
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > CAPACITY || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw Error('space_models_invalid')
    const text = readFileSync(fd, 'utf8')
    // Existing empty files are damaged documents too; preserve them instead of silently resetting state.
    if (!text) throw Error('space_models_invalid')
    return fileSchema.parse(JSON.parse(text))
  } catch {throw Error('space_models_invalid')} finally {closeSync(fd)}
}

export function readHostModelRoutes(configPath: string): {version: number; routes: ModelRoutes} | null {
  const state = readFile(configPath)
  return state === null ? null : {version: state.version, routes: parseModelRoutes(JSON.stringify(state.routes))}
}

/** Publish a complete initial document without replacing any existing file, including a damaged one. */
export async function seedHostModelRoutes(configPath: string, routes: ModelRoutes): Promise<void> {
  const state = fileSchema.parse({v: 1, version: 0, routes, applied_ops: []})
  const path = hostModelRoutesPath(configPath), temp = path + '.' + randomUUID() + '.tmp'
  await mkdir(dirname(path), {recursive: true, mode: 0o700})
  try {
    const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {await file.writeFile(JSON.stringify(state)); await file.sync()} finally {await file.close()}
    try {await link(temp, path)} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error}
    if (process.platform !== 'win32') {const dir = await open(dirname(path), constants.O_RDONLY); try {await dir.sync()} finally {await dir.close()}}
  } finally {await unlink(temp).catch(() => { /* Unpublished temporary files are never read. */ })}
}

export function overlaySpaceModelRoutes(environment: NodeJS.ProcessEnv, configPath: string | undefined): NodeJS.ProcessEnv {
  if (!configPath || environment.MODEL_ROUTES?.trim()) return environment
  const state = readHostModelRoutes(configPath)
  return state === null ? environment : {...environment, MODEL_ROUTES: JSON.stringify(state.routes)}
}

function endpointConfigured(value: string | undefined): boolean {
  if (!value?.trim()) return false
  try {const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password} catch {return false}
}

/** Single controller-owned writer; the PersonalAgentHost process lock excludes other runtimes. */
export class HostModelRoutesStore {
  readonly #store: BoundedJsonStore<ModelFile>
  #state: ModelFile
  readonly #appliedVersion: number
  readonly #environment: NodeJS.ProcessEnv
  #tail: Promise<unknown> = Promise.resolve()
  constructor(readonly configPath: string, environment: NodeJS.ProcessEnv = process.env, readonly options: {credentialConfigured?: (name: string) => boolean} = {}) {
    this.#environment = {...environment}
    const initial: ModelFile = {v: 1, version: 0, routes: {}, applied_ops: []}
    try {this.#state = readFile(configPath) ?? initial} catch (error) {
      // Explicit operator routes stay authoritative; the damaged file remains untouched and locked.
      if (!environment.MODEL_ROUTES?.trim()) throw error
      this.#state = initial
    }
    this.#appliedVersion = this.#state.version
    this.#store = new BoundedJsonStore(hostModelRoutesPath(configPath), fileSchema, CAPACITY)
  }
  #providers() {
    return MODEL_CATALOG_PROVIDERS.map(provider => {
      const metadata = MODEL_ROUTE_PROVIDER_METADATA[provider.id]
      const configured = !!this.#environment[metadata.keyName]?.trim() || this.options.credentialConfigured?.(metadata.keyName) === true
      const endpoint = provider.id === 'self-hosted' ? endpointConfigured(this.#environment.SELF_HOSTED_LLM_BASE_URL)
        : provider.id === 'openai-compatible' ? endpointConfigured(this.#environment.OPENAI_COMPATIBLE_BASE_URL) : true
      return {id: provider.id, label: provider.label, keyName: metadata.keyName, keyOptional: metadata.keyOptional, configured, usable: endpoint && (configured || metadata.keyOptional)}
    })
  }
  view() {
    const locked = !!this.#environment.MODEL_ROUTES?.trim()
    return {version: this.#state.version, applied_version: this.#appliedVersion,
      routes: locked ? parseModelRoutes(this.#environment.MODEL_ROUTES) : parseModelRoutes(JSON.stringify(this.#state.routes)),
      locked, source: locked ? 'environment' as const : 'space' as const,
      providers: this.#providers(), lanes: MODEL_ROUTE_LANE_PROVIDERS, models: MODEL_CATALOG_MODELS}
  }
  configure(params: unknown, opId: string): Promise<{version: number; applies: 'restart'}> {
    const run = this.#tail.then(async () => {
      const patch = modelRoutesPatchSchema.parse(params)
      z.string().min(1).max(256).parse(opId)
      const payloadHash = createHash('sha256').update(canonicalJson(params)).digest('hex')
      const prior = this.#state.applied_ops.find(op => op.opId === opId)
      if (prior) {
        if (prior.payloadHash !== payloadHash) throw Error('op_id_conflict')
        return {version: prior.resultVersion, applies: 'restart' as const}
      }
      if (this.#environment.MODEL_ROUTES?.trim()) throw Error('models_locked_by_environment')
      if (patch.expected_version !== this.#state.version) throw Error('version_conflict')
      const routes = {...this.#state.routes}
      const providers = this.#providers()
      for (const lane of MODEL_ROUTE_LANE_IDS) {
        if (!Object.hasOwn(patch.routes, lane)) continue
        const route = patch.routes[lane]
        if (route == null) delete routes[lane]
        else {
          if (!providers.find(provider => provider.id === route.provider)?.usable) throw Error('model_provider_unconfigured')
          routes[lane] = route
        }
      }
      const version = this.#state.version + 1
      const next: ModelFile = {v: 1, version, routes, applied_ops: [...this.#state.applied_ops, {opId, payloadHash, resultVersion: version}].slice(-64)}
      // Validate the existing bytes before replacement, so a damaged document is preserved even after startup.
      readFile(this.configPath)
      await this.#store.write(next)
      this.#state = next
      try {changes.emit('changed')} catch { /* Observers cannot roll back a durable edit. */ }
      return {version, applies: 'restart' as const}
    })
    this.#tail = run.catch(() => { /* A rejected edit must not poison later edits. */ })
    return run
  }
}
