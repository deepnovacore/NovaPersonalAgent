const VARIABLES = new Set([
  'MEMORY_PROVIDER', 'MEMORY_RECALL_ENGINE', 'MEMORY_EXTRACTORS', 'MEMORY_BACKEND',
  'MEMORY_CONNECTION', 'MEMORY_URL', 'MEMORY_TOKEN', 'MEMORY_PATH', 'MEMORY_USER_ID',
])

/** Revalidate at both IPC and presentation boundaries; never forward arbitrary hint text. */
export function publicStartupConfiguration(value) {
  if (value?.code !== 'memory_provider_conflict' && value?.code !== 'memory_configuration_invalid') return null
  if (!Array.isArray(value.variables) || value.variables.length === 0 || value.variables.length > VARIABLES.size
    || !value.variables.every(name => typeof name === 'string' && VARIABLES.has(name))) return null
  return Object.freeze({code: value.code, variables: Object.freeze([...new Set(value.variables)])})
}
