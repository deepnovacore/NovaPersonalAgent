const MEMORY_CONFIGURATION_VARIABLES = new Set([
  'MEMORY_PROVIDER', 'MEMORY_RECALL_ENGINE', 'MEMORY_EXTRACTORS', 'MEMORY_BACKEND',
  'MEMORY_CONNECTION', 'MEMORY_URL', 'MEMORY_TOKEN', 'MEMORY_PATH', 'MEMORY_USER_ID',
])

export interface StartupConfiguration {
  readonly code: 'memory_provider_conflict' | 'memory_configuration_invalid'
  readonly variables: readonly string[]
}

/** Project only the fixed configuration contract, never exception messages or setting values. */
export function startupConfiguration(error: unknown): StartupConfiguration | undefined {
  const value = (error as {readonly startupConfiguration?: unknown} | null)?.startupConfiguration as
    {readonly code?: unknown; readonly variables?: unknown} | undefined
  if (value?.code !== 'memory_provider_conflict' && value?.code !== 'memory_configuration_invalid') return undefined
  if (!Array.isArray(value.variables) || value.variables.length === 0 || value.variables.length > MEMORY_CONFIGURATION_VARIABLES.size
    || !value.variables.every(name => typeof name === 'string' && MEMORY_CONFIGURATION_VARIABLES.has(name))) return undefined
  return {code: value.code, variables: [...new Set(value.variables as string[])]}
}

/** Terminal diagnostics share the same allowlisted contract as the desktop; raw errors stay private. */
export function describeStartupError(error: unknown): string {
  const configuration = startupConfiguration(error)
  return configuration === undefined ? 'startup_failed' : `${configuration.code}: ${configuration.variables.join(', ')}`
}
