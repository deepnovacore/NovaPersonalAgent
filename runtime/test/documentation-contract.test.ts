import assert from 'node:assert/strict'
import {readdir, readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {test} from 'node:test'

import {
  environmentContract,
  publicEnvironmentContract,
} from '../src/config/environment-contract.js'

const repositoryRoot = process.env.NOVA_TEST_REPOSITORY_ROOT ?? resolve(import.meta.dirname, '../../..')
const currentDocs = [
  'README.md',
  'README.zh-CN.md',
  'docs/en/getting-started.md',
  'docs/zh-CN/getting-started.md',
  'docs/en/architecture.md',
  'docs/en/archs/06-verification.md',
  'docs/zh-CN/archs/06-verification.md',
] as const

test('current docs do not name retired environment selectors', async () => {
  for (const file of currentDocs) {
    const text = await readFile(resolve(repositoryRoot, file), 'utf8')
    assert.doesNotMatch(text, /workspace-graph surfaces|工作区图谱|WORKSPACE_GRAPH/u, file)
    assert.doesNotMatch(text, /(?:REALTIME_PROVIDER|VOLCENGINE_ARK_MODEL|VOLCENGINE_ARK_SUPPORT_MODEL|DOUBAO_ASR_API_KEY)/u, file)
  }
})

test('configuration guides share a concise public subset and env example stays complete', async () => {
  const example = generatedBlock(await readFile(resolve(repositoryRoot, '.env.example'), 'utf8'))
  for (const entry of publicEnvironmentContract()) {
    assert.equal(example.split(`# ${entry.name}=`).length - 1, 1, entry.name)
  }
  const publicNames = new Set(publicEnvironmentContract().map(entry => entry.name))
  const selections: string[][] = []
  for (const file of ['docs/en/configuration.md', 'docs/zh-CN/configuration.md']) {
    const block = generatedBlock(await readFile(resolve(repositoryRoot, file), 'utf8'))
    const names = [...block.matchAll(/^\| `([A-Z0-9_]+)` \|/gmu)].map(match => match[1]!)
    assert.equal(new Set(names).size, names.length, file)
    // Keep guides concise while allowing a few additional public settings.
    assert.ok(names.length <= 40 && names.length > 0, file)
    for (const name of names) assert.ok(publicNames.has(name), `${file}: ${name}`)
    for (const essential of ['NOVA_SPACE_HOST_CONFIG', 'DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY', 'PIPELINE_MODE', 'MEMORY_CONNECTION', 'MEMORY_RECALL_ENGINE', 'MEMORY_EXTRACTORS']) {
      assert.ok(names.includes(essential), `${file}: ${essential}`)
    }
    selections.push(names)
  }
  assert.deepEqual(selections[0], selections[1])
  for (const file of ['docs/en/getting-started.md', 'docs/zh-CN/getting-started.md']) {
    assert.doesNotMatch(await readFile(resolve(repositoryRoot, file), 'utf8'), /BEGIN GENERATED ENV CONTRACT/u)
  }
})

test('the public contract exposes product-shaped pipeline selectors and retires the vendor selector', () => {
  const publicNames = new Set(publicEnvironmentContract().map(entry => entry.name))
  assert.deepEqual([
    'PIPELINE_MODE',
    'INTEGRATED_PROVIDER',
    'CASCADE_ENDPOINTING_PROVIDER',
    'CASCADE_ASR_PROVIDER',
    'CASCADE_LLM_PROVIDER',
    'CASCADE_LLM_MODEL',
    'CASCADE_TTS_PROVIDER',
  ].every(name => publicNames.has(name)), true)
  assert.equal(publicNames.has('REALTIME_PROVIDER'), false)
})

test('the v4 settings environment additions are classified as public overrides', () => {
  const publicNames = new Set(publicEnvironmentContract().map(entry => entry.name))
  assert.deepEqual([
    'CODEX_APPROVAL_MODE',
    'CLARIFICATION_DEPTH',
    'PLAN_READBACK',
    'PROGRESS_BUBBLES',
    'CAPABILITIES_CONFIG',
    'SEARCH_PROVIDER',
    'SEARCH_MCP_URL',
    'SEARCH_MCP_TOOL',
    'KNOWLEDGE_PATH',
    'EMBEDDING_PROVIDER',
    'EMBEDDING_MODEL',
  ].every(name => publicNames.has(name)), true)
})

test('each model provider documents its own endpoint and keeps other channels separate', () => {
  for (const name of [
    'DASHSCOPE_MODEL_BASE_URL',
    'DEEPSEEK_MODEL_BASE_URL',
    'OPENAI_MODEL_BASE_URL',
    'GEMINI_MODEL_BASE_URL',
    'STEPFUN_MODEL_BASE_URL',
  ]) {
    const entry = environmentContract.find(candidate => candidate.name === name)
    assert.ok(entry !== undefined, name)
    assert.equal(entry.owner !== 'core' && entry.owner !== 'host_private', true, name)
    assert.equal(entry.secret, false, name)
    assert.match(entry.descriptionEn, /model endpoint/iu, name)
    assert.match(entry.descriptionZh, /模型地址/u, name)
  }
  assert.equal(environmentContract.some(entry => ['MODEL_BASE_URL', 'MODEL_API_KEY'].includes(entry.name)), false)
})

function generatedBlock(document: string): string {
  const start = document.indexOf('BEGIN GENERATED ENV CONTRACT')
  const end = document.indexOf('END GENERATED ENV CONTRACT')
  assert.ok(start >= 0 && end > start)
  return document.slice(start, end)
}

test('every production environment name is classified and private names stay private', async () => {
  const classified = new Map(environmentContract.map(entry => [entry.name, entry]))
  assert.equal(classified.size, environmentContract.length, 'environment names must be unique')
  const sources = [
    ...await sourceFiles(resolve(repositoryRoot, 'runtime/src')),
    ...await sourceFiles(resolve(repositoryRoot, 'clients/desktop/src')),
  ]
  const systemNames = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'PATH', 'APPDATA', 'USERPROFILE', 'SYSTEMROOT', 'NPM_CONFIG_PREFIX'])
  const environmentName = /\b(?:process\.env|environment|parentEnv|env)\.([A-Z][A-Z0-9_]+)\b/gu
  for (const source of sources) {
    const text = await readFile(source, 'utf8')
    for (const match of text.matchAll(environmentName)) {
      assert.ok(classified.has(match[1]!) || systemNames.has(match[1]!), `${source}: ${match[1]}`)
    }
  }
  for (const entry of environmentContract) {
    if (entry.owner === 'host_private') {
      assert.equal(entry.public, false, entry.name)
    }
  }
})

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.isFile() && /\.(?:js|mjs|ts)$/u.test(entry.name)) files.push(path)
  }
  return files
}


test('current architecture and numbered specs do not depend on the retired graph', async () => {
  const roots = ['docs/en/archs']
  for (const root of roots) {
    for (const file of await readdir(resolve(repositoryRoot, root))) {
      if (!/^\d.*\.md$/u.test(file)) continue
      const text = await readFile(resolve(repositoryRoot, root, file), 'utf8')
      assert.doesNotMatch(text, /workspace-graph\/|workspace_graph|WORKSPACE_GRAPH|GraphContext|PublishedGraphSnapshot/u, `${root}/${file}`)
      assert.doesNotMatch(text, /Workspace Graph|workspace graph|工作区图/u, `${root}/${file}`)
    }
  }
})
