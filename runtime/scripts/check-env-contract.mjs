import {readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {publicEnvironmentContract} from '../dist/src/config/environment-contract.js'

// Common user settings only; .env.example retains the complete public contract.
const coreNames = new Set([
  'DASHSCOPE_API_KEY', 'TAVILY_API_KEY', 'DEEPSEEK_API_KEY', 'ARK_API_KEY',
  'DOUBAO_BIGMODEL_API_KEY', 'DOUBAO_ASR_API_KEY',
  'NOVA_AUDIO_AGENT_LANGUAGE',
  'NOVA_AUDIO_AGENT_PIPELINE_MODE', 'NOVA_AUDIO_AGENT_CASCADE_LLM_PROVIDER',
  'NOVA_AUDIO_AGENT_CASCADE_LLM_MODEL', 'NOVA_AUDIO_AGENT_QWEN_REALTIME_MODEL',
  'NOVA_AUDIO_AGENT_QWEN_REALTIME_VOICE', 'NOVA_AUDIO_AGENT_CODEX_BIN',
  'NOVA_AUDIO_AGENT_CODEX_WORKSPACE', 'NOVA_AUDIO_AGENT_CODEX_APPROVAL_MODE',
  'NOVA_AUDIO_AGENT_MEMORY_CONNECTION', 'NOVA_AUDIO_AGENT_MEMORY_PROVIDER',
  'NOVA_AUDIO_AGENT_CAPABILITIES_CONFIG',
])

const mode = process.argv[2]
if (mode !== '--check' && mode !== '--write') {
  process.stderr.write('Usage: node runtime/scripts/check-env-contract.mjs --check|--write\n')
  process.exitCode = 2
} else {
  const runtimeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const repositoryRoot = resolve(runtimeRoot, '..')
  const targets = [
    {
      path: resolve(repositoryRoot, '.env.example'),
      start: '# BEGIN GENERATED ENV CONTRACT',
      end: '# END GENERATED ENV CONTRACT',
      render: renderEnv,
    },
    {
      path: resolve(repositoryRoot, 'docs/configuration.md'),
      start: '<!-- BEGIN GENERATED ENV CONTRACT -->',
      end: '<!-- END GENERATED ENV CONTRACT -->',
      render: () => renderMarkdown('en'),
    },
    {
      path: resolve(repositoryRoot, 'docs/configuration.zh-CN.md'),
      start: '<!-- BEGIN GENERATED ENV CONTRACT -->',
      end: '<!-- END GENERATED ENV CONTRACT -->',
      render: () => renderMarkdown('zh'),
    },
  ]
  let drift = false
  for (const target of targets) {
    const current = await readFile(target.path, 'utf8')
    const generated = `${target.start}\n${target.render()}\n${target.end}`
    const next = replaceBlock(current, target.start, target.end, generated)
    if (next === current) continue
    drift = true
    if (mode === '--write') await writeFile(target.path, next)
    else process.stderr.write(`environment contract drift: ${target.path}\n`)
  }
  if (mode === '--write') process.stdout.write('wrote generated environment contract blocks\n')
  else if (drift) process.exitCode = 1
  else process.stdout.write('generated environment contract blocks match\n')
}

function replaceBlock(current, start, end, generated) {
  const startIndex = current.indexOf(start)
  const endIndex = current.indexOf(end)
  if (startIndex < 0 || endIndex < startIndex) {
    const separator = current.endsWith('\n') ? '\n' : '\n\n'
    return `${current}${separator}${generated}\n`
  }
  const tail = endIndex + end.length
  return `${current.slice(0, startIndex)}${generated}${current.slice(tail)}`
}

function renderEnv() {
  return publicEnvironmentContract().map(entry => {
    const value = entry.secret ? '' : (entry.defaultLabel ?? '')
    return `# ${entry.name}=${value}`
  }).join('\n')
}

function renderMarkdown(language) {
  const heading = language === 'en'
    ? '| Variable | Default | Purpose |\n|---|---|---|'
    : '| 变量 | 默认 | 用途 |\n|---|---|---|'
  const rows = publicEnvironmentContract().filter(entry => coreNames.has(entry.name)).map(entry => {
    const fallback = language === 'en' ? 'None' : '无'
    const description = language === 'en' ? entry.descriptionEn : entry.descriptionZh
    return `| \`${entry.name}\` | ${escapeCell(entry.defaultLabel ?? fallback)} | ${escapeCell(description)} |`
  })
  return [heading, ...rows].join('\n')
}

function escapeCell(value) {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}
