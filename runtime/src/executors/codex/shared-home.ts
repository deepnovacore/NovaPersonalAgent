import {snapshotJsonRecord} from './safe-json.js'
import {toml} from './managed-mcp.js'

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
  const external = Object.keys(record(config.mcp_servers)).filter(name => !managedNames.includes(name))
  // Codex splits CLI key paths on dots, but parses quoted inline-table keys as TOML.
  if (external.length) args.push('-c', `mcp_servers=${toml(Object.fromEntries(external.map(name => [name, {enabled: false}])))}`)
  const shell = record(config.shell_environment_policy)
  for (const name of Object.keys(record(shell.set))) args.push('-c', `shell_environment_policy.set.${key(name)}=""`)
  args.push('-c', 'shell_environment_policy.ignore_default_excludes=false', '-c', 'shell_environment_policy.experimental_use_profile=false')
  return args
}
