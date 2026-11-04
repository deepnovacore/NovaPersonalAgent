import {createHash} from 'node:crypto'
import {isAbsolute, join, resolve} from 'node:path'
import {Worker} from 'node:worker_threads'
import {PersonalMemoryError, type PersonalMemoryResource} from '../memory/personal-memory.js'
import {PersonalMemoryStoreClient, type PersonalMemoryStoreClientOptions} from '../voicemem/store-client.js'

/** The SDK and native database stay in the existing bounded Worker lifecycle. */
export function createMem0PersonalMemory(options: PersonalMemoryStoreClientOptions): PersonalMemoryResource {
  if (!isAbsolute(options.path) || options.path !== resolve(options.path) || options.path.includes('\0')
    || !options.userId.trim() || options.userId === '*' || /\s/u.test(options.userId)) throw new PersonalMemoryError('unavailable')
  const owner = createHash('sha256').update(options.userId).digest('hex')
  const path = join(`${options.path}.mem0`, owner)
  const store = new PersonalMemoryStoreClient({...options, path, supportsForget:true,
    workerFactory: (_url, configured) => {
      const worker = new Worker(new URL('./store-worker.js', import.meta.url), {
        ...configured, stdout:true, stderr:true,
        env:{...process.env, MEM0_TELEMETRY:'false', MEM0_DIR:join(path,'sdk')},
      })
      // SDK diagnostics may include provider responses; expose only credential-safe RPC errors.
      worker.stdout.resume()
      worker.stderr.resume()
      return worker
    },
  })
  return {
    maxRecallLimit: store.maxRecallLimit,
    recallEngine: 'mem0',
    requiresConversationConsumer: true,
    capabilities: () => ({list:true,get:true,correct:true,forgetEntry:true,forgetSource:true}),
    get: id => store.get(id),
    getMany: ids => store.getMem0Many(ids),
    list: options => store.list(options),
    correct: (...args) => store.correct(...args),
    forgetEntry: (...args) => store.forgetEntry(...args),
    readEvidence: id => store.readMem0Evidence(id),
    canReadConversationEvidence: (id,consumer) => store.canReadMem0ConversationEvidence(id,consumer),
    forgetSource: ref => store.forgetSource(ref),
    forgetSources: async refs => {
      let failed=false
      for (const ref of refs) {try {await store.forgetSource(ref)} catch {failed=true}}
      if (failed) throw new PersonalMemoryError('error')
    },
    open: () => store.open(),
    inspect: query => store.inspectStore(query),
    close: () => store.close(),
    recall: (query, recallOptions) => store.recall(query, recallOptions),
    ...(store.remember ? {remember:store.remember} : {}),
    forget: store.forget!,
    // No responseAdaptation: arbitrary retrieved memories are not verified reply preferences.
  }
}
