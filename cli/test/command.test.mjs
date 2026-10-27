import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {HELP_TEXT, main} from '../src/command.mjs'
import {resetPersonalState} from '../src/runtime.mjs'

function output() {
  let value = ''
  return {stream: {write: chunk => { value += chunk }}, read: () => value}
}

test('help, version, and invalid commands do not install the desktop', async () => {
  for (const [argv, code, expected] of [
    [['--help'], 0, HELP_TEXT],
    [['--version'], 0, '0.4.0'],
    [['unknown'], 2, HELP_TEXT],
    [['start', 'extra'], 2, HELP_TEXT],
  ]) {
    const sink = output()
    const result = await main(argv, {
      stdout: sink.stream,
      ensure: () => assert.fail('unexpected install'),
    })
    assert.equal(result, code)
    assert.match(sink.read(), new RegExp(expected.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }
})

test('start and config share installation but config passes the settings argument', async () => {
  for (const [argv, openSettings] of [[[], false], [['start'], false], [['config'], true]]) {
    const launches = []
    const code = await main(argv, {
      ensure: async () => ({executable: '/tmp/Nova'}),
      launch: (executable, options) => launches.push({executable, options}),
    })
    assert.equal(code, 0)
    assert.deepEqual(launches, [{executable: '/tmp/Nova', options: {openSettings}}])
  }
})

test('doctor reports key names but never values', async () => {
  const sink = output()
  const code = await main(['doctor'], {
    stdout: sink.stream,
    doctor: async () => ({
      supported: true,
      platform: 'linux-x64',
      desktopReady: true,
      settingsPresent: true,
      configuredSecretKeys: ['OPENAI_API_KEY'],
      codexPresent: true,
    }),
  })
  assert.equal(code, 0)
  assert.match(sink.read(), /Configured keys: OPENAI_API_KEY/u)
  assert.doesNotMatch(sink.read(), /secret-value/u)
})

test('doctor lists voice keys, guides a first run, and fails while one is missing', async () => {
  const doctorReport = voice => async () => ({supported: true, platform: 'darwin-arm64', desktopReady: true, settingsPresent: false, configuredSecretKeys: [], codexPresent: false, voice})
  const sink = output()
  const code = await main(['doctor'], {stdout: sink.stream, doctor: doctorReport({pipeline: 'integrated', keys: [{name: 'DASHSCOPE_API_KEY', source: null}]})})
  assert.equal(code, 1)
  assert.match(sink.read(), /Voice pipeline: integrated\n {2}DASHSCOPE_API_KEY: missing\n/u)
  assert.match(sink.read(), /First run: start `novapersonal` and paste a DashScope API Key/u)

  const ready = output()
  assert.equal(await main(['doctor'], {stdout: ready.stream, doctor: doctorReport({pipeline: 'integrated', keys: [{name: 'DASHSCOPE_API_KEY', source: 'settings'}]})}), 0)
  assert.match(ready.read(), /DASHSCOPE_API_KEY: saved in settings\n/u)
  assert.doesNotMatch(ready.read(), /First run/u)
})

test('doctor --online forwards the flag and fails on a rejected key', async () => {
  const seen = []
  const sink = output()
  const code = await main(['doctor', '--online'], {stdout: sink.stream, doctor: async options => {
    seen.push(options)
    return {supported: true, platform: 'linux-x64', desktopReady: true, settingsPresent: true, configuredSecretKeys: [], codexPresent: true,
      voice: {pipeline: 'cascaded', keys: [{name: 'DEEPSEEK_API_KEY', source: 'environment', probe: 'rejected'}, {name: 'DOUBAO_BIGMODEL_API_KEY', source: 'environment', probe: 'deferred'}]}}
  }})
  assert.equal(code, 1)
  assert.deepEqual(seen, [{online: true}])
  assert.match(sink.read(), /DEEPSEEK_API_KEY: set in environment \(rejected by provider\)/u)
  assert.match(sink.read(), /DOUBAO_BIGMODEL_API_KEY: set in environment \(checked on first connection\)/u)
  assert.equal(await main(['doctor', '--offline'], {stdout: output().stream, doctor: () => assert.fail('unexpected doctor')}), 2)
})

test('reset-state prints the moved state and backup paths', async () => {
  const sink = output()
  const code = await main(['reset-state'], {stdout: sink.stream, reset: async () => ({
    statePath: '/state/personal.json',
    moved: [{from: '/state/personal.json', to: '/state/personal.json.reset-2026-10-27T08-00-00-000Z'}],
  })})
  assert.equal(code, 0)
  assert.match(sink.read(), /Moved \/state\/personal\.json\n {2}to \/state\/personal\.json\.reset-/u)
  const empty = output()
  assert.equal(await main(['reset-state'], {stdout: empty.stream, reset: async () => ({statePath: '/state/personal.json', moved: []})}), 0)
  assert.match(empty.read(), /No personal state found at \/state\/personal\.json/u)
})

test('resetPersonalState moves a corrupt state and its backup without losing bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nova-reset-state-'))
  try {
    const path = join(dir, 'blackboard.sqlite.personal.json')
    await writeFile(path, '{"broken":', {mode: 0o600})
    await writeFile(path + '.before-schedules.json', '{"backup":', {mode: 0o600})
    const result = await resetPersonalState({
      environment: {BLACKBOARD_PATH: join(dir, 'blackboard.sqlite')},
      home: dir,
      now: () => new Date('2026-10-27T08:00:00.000Z'),
    })
    assert.equal(result.statePath, path)
    assert.equal(result.moved.length, 2)
    assert.equal(result.moved[0].to, `${path}.reset-2026-10-27T08-00-00-000Z`)
    assert.equal(result.moved[1].to, `${path}.before-schedules.json.reset-2026-10-27T08-00-00-000Z-before-schedules`)
    assert.equal(await readFile(result.moved[0].to, 'utf8'), '{"broken":')
    await assert.rejects(readFile(path, 'utf8'), /ENOENT/u)
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})

test('resetPersonalState refuses symbolic links and reports a missing state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nova-reset-link-'))
  try {
    const environment = {BLACKBOARD_PATH: join(dir, 'blackboard.sqlite')}
    const target = join(dir, 'elsewhere.json')
    await writeFile(target, '{}', {mode: 0o600})
    const path = join(dir, 'blackboard.sqlite.personal.json')
    await symlink(target, path)
    await assert.rejects(resetPersonalState({environment, home: dir}), /refusing to move non-regular file/u)
    await rm(path)
    const missing = await resetPersonalState({environment, home: dir})
    assert.deepEqual(missing.moved, [])
  } finally {
    await rm(dir, {recursive: true, force: true})
  }
})
