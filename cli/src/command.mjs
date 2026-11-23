import { ensureDesktop, inspectDoctor, launchDesktop, resetPersonalState } from './runtime.mjs'
import { PRODUCT_VERSION } from './target.mjs'
import { migrateData } from './migrate-data.mjs'
import { assertNoPendingDataRootMigration } from './data-root.mjs'
import { homedir } from 'node:os'

export const HELP_TEXT = `Usage: npa [start|config|doctor|reset-state|migrate-data|--version|--help]

  npa                  Install if needed and launch Nova Personal Agent
  npa start            Install if needed and launch Nova Personal Agent
  npa config           Open the desktop settings window
  npa doctor           Inspect local installation and configuration status
  npa doctor --online  Also test voice keys set in the environment against their provider
  npa reset-state      Move an unreadable personal state aside (quit Nova first); prints both paths
  npa migrate-data     Move local data from ~/.nova-audio-agent to ~/.nova-personal-agent (optional; quit Nova first)
  npa migrate-data --dry-run  Show what would move, conflicts and sizes without changing anything

novapersonal and novaaudio remain aliases of npa.`

const VOICE_KEY_SOURCES = Object.freeze({settings: 'saved in settings', environment: 'set in environment', missing: 'missing'})
// Names the selected providers so a missing key reads against the provider that needs it.
function voiceProviders(voice) {
  const providers = voice.providers
  if (!providers) return ''
  if (providers.integrated) return ` (${providers.integrated})`
  return ` (ASR ${providers.asr}, LLM ${providers.llm}, TTS ${providers.tts})`
}
const VOICE_KEY_PROBES = Object.freeze({ok: 'valid', rejected: 'rejected by provider', network: 'could not reach provider', deferred: 'checked on first connection'})

export async function main(argv, {
  stdout = process.stdout,
  ensure = ensureDesktop,
  launch = launchDesktop,
  doctor = inspectDoctor,
  reset = resetPersonalState,
  migrate = migrateData,
} = {}) {
  const command = argv[0] ?? 'start'
  const online = command === 'doctor' && argv.length === 2 && argv[1] === '--online'
  const dryRun = command === 'migrate-data' && argv.length === 2 && argv[1] === '--dry-run'
  if (argv.length > 1 && !online && !dryRun) {
    stdout.write(`${HELP_TEXT}\n`)
    return 2
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    stdout.write(`${HELP_TEXT}\n`)
    return 0
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    stdout.write(`${PRODUCT_VERSION}\n`)
    return 0
  }
  if (command === 'doctor') {
    const report = await doctor({online})
    stdout.write(`Nova Personal Agent ${PRODUCT_VERSION}\n`)
    stdout.write(`Platform: ${report.platform} (${report.supported ? 'supported' : 'unsupported'})\n`)
    if (report.supported) {
      stdout.write(`Desktop cache: ${report.desktopReady ? 'ready' : 'missing'}\n`)
      stdout.write(`Settings: ${report.settingsPresent ? 'present' : 'missing'}\n`)
      stdout.write(`Configured keys: ${report.configuredSecretKeys.length === 0 ? 'none' : report.configuredSecretKeys.join(', ')}\n`)
      stdout.write(`Codex: ${report.codexPresent ? 'found' : 'missing (needed only for the Codex coding backend)'}\n`)
    }
    const missingVoiceKeys = report.voice?.keys.filter(key => key.source === null) ?? []
    const rejectedVoiceKeys = report.voice?.keys.filter(key => key.probe === 'rejected') ?? []
    if (report.voice) {
      stdout.write(`Voice pipeline: ${report.voice.pipeline}${voiceProviders(report.voice)}\n`)
      if (report.voice.keys.length === 0) stdout.write('  No cloud API key required by the selected providers.\n')
      for (const key of report.voice.keys) stdout.write(`  ${key.name}: ${VOICE_KEY_SOURCES[key.source ?? 'missing']}${key.probe ? ` (${VOICE_KEY_PROBES[key.probe] ?? key.probe})` : ''}\n`)
      if (online && report.voice.keys.some(key => key.source === 'settings')) stdout.write('  Saved keys are encrypted; test them in the desktop setup window.\n')
      if (missingVoiceKeys.length > 0) stdout.write(`First run: start \`npa\` and enter ${missingVoiceKeys.map(key => key.name).join(', ')} in the setup window that opens.\n`)
    }
    if (report.capabilities !== undefined) {
      const status = report.capabilities
      stdout.write(`Capabilities: ${status.ok ? 'valid' : 'needs attention'}${status.reason ? ` (${status.reason})` : ''}\n`)
      if (status.modules) {
        for (const [name, module] of Object.entries(status.modules)) stdout.write(`  ${name}: ${module.enabled ? 'enabled' : 'disabled'}${module.provider ? ` (${module.provider})` : ''}\n`)
        stdout.write(`  FrontBrain budget: ${status.toolBudget}; exact count requires runtime composition\n`)
        for (const server of status.servers) stdout.write(`  MCP ${server.name}: ${server.status}${server.reason ? ` (${server.reason})` : ''}\n`)
        for (const name of status.overrides) stdout.write(`  Override: ${name}\n`)
      }
    }
    return report.supported && report.capabilities?.ok !== false && missingVoiceKeys.length === 0 && rejectedVoiceKeys.length === 0 ? 0 : 1
  }
  if (command === 'migrate-data') {
    return migrate({dryRun, write: text => stdout.write(text)})
  }
  if (command === 'reset-state') {
    const result = await reset({})
    if (result.moved.length === 0) {
      stdout.write(`No personal state found at ${result.statePath}\n`)
      return 0
    }
    for (const item of result.moved) stdout.write(`Moved ${item.from}\n  to ${item.to}\n`)
    return 0
  }
  if (command !== 'start' && command !== 'config') {
    stdout.write(`${HELP_TEXT}\n`)
    return 2
  }
  // Refuse before installing or launching anything while a data move is pending or running.
  assertNoPendingDataRootMigration(homedir())
  const installed = await ensure()
  await launch(installed.executable, {openSettings: command === 'config'})
  return 0
}
