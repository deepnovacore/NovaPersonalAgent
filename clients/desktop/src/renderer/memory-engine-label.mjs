import {t} from './locale.mjs'

/** Inspection identifies the engine; absent or unknown metadata must not imply mem0. */
export function memoryEngineLabel(inspection) {
  return ['ledger', 'voicemem', 'mem0'].includes(inspection?.engine) ? inspection.engine : t('本机记忆')
}
