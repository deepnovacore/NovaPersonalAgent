import {snapshotJsonRecord} from './safe-json.js'

/** CLI table overrides merge with disk tables. Disable each external entry explicitly. */
export function sharedHomeOverrides(response: unknown, managedNames: readonly string[]): readonly string[] {
  const config = snapshotJsonRecord(snapshotJsonRecord(response).config)
  const record = (value: unknown): Record<string, unknown> => value == null ? {} : snapshotJsonRecord(value)
  const key = (name: string): string => {
    if (!/^[A-Za-z0-9_-]+$/u.test(name)) throw new TypeError('unsupported shared config key')
    return name
  }
  const args = ['-c', 'notify=[]']
  for (const [name, enabled] of Object.entries(record(config.features))) if (enabled === true) args.push('-c', `features.${key(name)}=false`)
  for (const name of Object.keys(record(config.mcp_servers))) {
    if (!managedNames.includes(name)) args.push('-c', `mcp_servers.${key(name)}.enabled=false`)
  }
  const shell = record(config.shell_environment_policy)
  for (const name of Object.keys(record(shell.set))) args.push('-c', `shell_environment_policy.set.${key(name)}=""`)
  args.push('-c', 'shell_environment_policy.ignore_default_excludes=false', '-c', 'shell_environment_policy.experimental_use_profile=false')
  return args
}
