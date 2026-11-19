import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, mkdir, rm, stat, writeFile, chmod, readdir, readFile} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parseSpaceCreateRequest, createSpaceCreateHandler, spaceCreateErrorCode} from '../src/main/space-create.mjs'

const TOKEN = 'operator-bootstrap-token-0123456789abcdef'
const settingsSender = {}
const settingsEvent = {sender: settingsSender, senderFrame: 'main'}
settingsSender.mainFrame = 'main'

async function harness(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nova-space-create-'))
  t.after(() => rm(root, {recursive: true, force: true}))
  const directory = join(root, 'space')
  const calls = [], persisted = []
  const runtime = {
    initializeHostSpace: async options => { calls.push(['init', options]); await writeFile(options.configPath, '{}', {mode: 0o600}); return {space: 's', configPath: options.configPath} },
    resumeHostSpaceRegistration: async options => { calls.push(['resume', options]); return {space: 's', configPath: options.configPath} },
    readHostSpaceConfig: () => ({relay_url: 'https://relay.example'}),
    ...overrides.runtime,
  }
  const handler = createSpaceCreateHandler({
    allowed: event => event.sender === settingsSender && event.senderFrame === settingsSender.mainFrame,
    directory: () => directory,
    configured: overrides.configured ?? (() => false),
    loadRuntime: async () => { calls.push(['load']); return runtime },
    persist: async path => { persisted.push(path) },
    prepareRelay: overrides.prepareRelay,
    existingPersonalPath: overrides.existingPersonalPath,
  })
  return {root, directory, calls, persisted, handler}
}

test('space create request accepts only a relay origin and a long bootstrap token', () => {
  for (const payload of [null, [], 'x', {relayUrl: 'https://relay.example'}, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN, configPath: '/elsewhere'},
    {relayUrl: 1, bootstrapToken: TOKEN}, {relayUrl: 'https://relay.example', bootstrapToken: {}}, {relayUrl: 'https://relay.example', bootstrapToken: 'x'.repeat(9000)},
    Object.assign(Object.create({inherited: true}), {relayUrl: 'https://relay.example', bootstrapToken: TOKEN})]) {
    assert.throws(() => parseSpaceCreateRequest(payload), /space create rejected/)
  }
  assert.deepEqual(parseSpaceCreateRequest({relayUrl: ' https://relay.example/ ', bootstrapToken: ` ${TOKEN}\n`}), {relayUrl: 'https://relay.example', bootstrapToken: TOKEN})
  assert.deepEqual(parseSpaceCreateRequest({relayUrl: 'http://127.0.0.1:8787', bootstrapToken: TOKEN}), {relayUrl: 'http://127.0.0.1:8787', bootstrapToken: TOKEN})
  assert.deepEqual(parseSpaceCreateRequest({relayUrl: 'http://relay.example', bootstrapToken: TOKEN}), {error: 'relay_tls_required'})
  for (const relayUrl of ['not a url', 'https://user:pass@relay.example', 'https://relay.example/path', 'https://relay.example/?q=1', 'https://relay.example/#x', 'ftp://relay.example'])
    assert.deepEqual(parseSpaceCreateRequest({relayUrl, bootstrapToken: TOKEN}), {error: relayUrl.startsWith('ftp') ? 'relay_tls_required' : 'relay_url_invalid'}, relayUrl)
  assert.deepEqual(parseSpaceCreateRequest({relayUrl: 'https://relay.example', bootstrapToken: 'short-token'}), {error: 'bootstrap_token_too_short'})
  assert.deepEqual(parseSpaceCreateRequest({relayUrl: 'https://relay.example', bootstrapToken: TOKEN + '\u0000'}), {error: 'bootstrap_token_invalid'})
})

test('automatic mode resolves credentials only after sender validation and returns no secrets', async t => {
  let prepares=0
  const h=await harness(t,{prepareRelay:async()=>{prepares++;return {relayUrl:'https://relay.example',bootstrapToken:TOKEN}}})
  await assert.rejects(h.handler({sender:{}},{mode:'tailscale'}),/space create rejected/)
  assert.equal(prepares,0)
  assert.deepEqual(await h.handler(settingsEvent,{mode:'tailscale'}),{ok:true})
  assert.equal(prepares,1)
  assert.equal(h.calls.find(([name])=>name==='init')[1].bootstrapToken,TOKEN)
  await assert.rejects(h.handler(settingsEvent,{mode:'tailscale',directory:'/anywhere'}),/space create rejected/)
})
test('automatic preparation failures are closed codes and leave creation retryable', async t => {
  let attempts=0
  const h=await harness(t,{prepareRelay:async()=>{if(attempts++===0)throw Error('tailscale_not_running');return {relayUrl:'https://relay.example',bootstrapToken:TOKEN}}})
  assert.deepEqual(await h.handler(settingsEvent,{mode:'tailscale'}),{ok:false,error:'tailscale_not_running'})
  assert.deepEqual(await h.handler(settingsEvent,{mode:'tailscale'}),{ok:true})
})

test('space create is refused for any sender except the settings main frame, before touching the runtime', async t => {
  const h = await harness(t)
  for (const event of [{sender: {}, senderFrame: 'main'}, {sender: settingsSender, senderFrame: 'child'}])
    await assert.rejects(h.handler(event, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN}), /space create rejected/)
  assert.deepEqual(h.calls, [])
  await assert.rejects(stat(h.directory), {code: 'ENOENT'})
})

test('a new Space is created at the fixed private path and the reply carries no secret or path', async t => {
  const h = await harness(t)
  const logs = []
  for (const name of ['log', 'warn', 'error', 'info']) t.mock.method(console, name, (...args) => logs.push(args.join(' ')))
  const result = await h.handler(settingsEvent, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN})
  assert.deepEqual(result, {ok: true})
  assert.deepEqual(h.calls.map(([name]) => name), ['load', 'init'])
  assert.deepEqual(h.calls[1][1], {configPath: join(h.directory, 'config.json'), personalPath: join(h.directory, 'personal.json'), relayUrl: 'https://relay.example', bootstrapToken: TOKEN})
  assert.equal((await stat(h.directory)).mode & 0o777, 0o700)
  assert.deepEqual(h.persisted, [join(h.directory, 'config.json')])
  assert.ok(!logs.join('\n').includes(TOKEN))
})

test('an unfinished Space resumes the same identity instead of rebuilding, and a finished one is refused', async t => {
  const h = await harness(t)
  await mkdir(h.directory, {mode: 0o700})
  await writeFile(join(h.directory, 'config.json'), '{}', {mode: 0o600})
  assert.deepEqual(await h.handler(settingsEvent, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN}), {ok: true})
  assert.deepEqual(h.calls.map(([name]) => name), ['load', 'resume'])
  assert.deepEqual(h.calls[1][1], {configPath: join(h.directory, 'config.json'), bootstrapToken: TOKEN})
  const done = await harness(t, {configured: () => true})
  assert.deepEqual(await done.handler(settingsEvent, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN}), {ok: false, error: 'space_already_created'})
  assert.deepEqual(done.calls, [])
})

test('failures return only a redacted code, never the token, and do not persist the Space', async t => {
  for (const [error, code] of [
    [Object.assign(new Error('bootstrap_denied'), {code: 'bootstrap_denied', status: 403}), 'bootstrap_denied'],
    [Object.assign(new Error('tls_required'), {code: 'tls_required', status: 0}), 'relay_tls_required'],
    [new TypeError('fetch failed'), 'relay_unreachable'],
    [Object.assign(new Error('timeout'), {name: 'TimeoutError'}), 'relay_unreachable'],
    [Object.assign(new Error('rate_limited'), {code: 'rate_limited', status: 429}), 'relay_rejected'],
    [new Error(`unexpected ${TOKEN}`), 'space_create_failed'],
  ]) {
    const h = await harness(t, {runtime: {initializeHostSpace: async () => { throw error }}})
    const result = await h.handler(settingsEvent, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN})
    assert.deepEqual(result, {ok: false, error: code})
    assert.ok(!JSON.stringify(result).includes(TOKEN))
    assert.deepEqual(h.persisted, [])
  }
  assert.equal(spaceCreateErrorCode(new Error('space_personal_path_exists')), 'space_data_exists')
})

test('validation errors are returned before the runtime loads, and overlapping requests are refused', async t => {
  const h = await harness(t)
  assert.deepEqual(await h.handler(settingsEvent, {relayUrl: 'http://relay.example', bootstrapToken: TOKEN}), {ok: false, error: 'relay_tls_required'})
  assert.deepEqual(h.calls, [])
  let release
  const slow = await harness(t, {runtime: {initializeHostSpace: () => new Promise(resolve => { release = resolve })}})
  const first = slow.handler(settingsEvent, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN})
  assert.deepEqual(await slow.handler(settingsEvent, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN}), {ok: false, error: 'space_create_busy'})
  while (!release) await new Promise(resolve => setImmediate(resolve))
  release()
  assert.deepEqual(await first, {ok: true})
})

test('an existing directory that others can read is refused', {skip: process.platform === 'win32'}, async t => {
  const h = await harness(t)
  await mkdir(h.directory)
  await chmod(h.directory, 0o755)
  assert.deepEqual(await h.handler(settingsEvent, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN}), {ok: false, error: 'space_directory_not_private'})
  assert.deepEqual(h.calls.map(([name]) => name), ['load'])
})

const goodConfig = relay => JSON.stringify({relay_url: relay})
async function seed(h, content, personal) {
  await mkdir(h.directory, {mode: 0o700})
  await writeFile(join(h.directory, 'config.json'), content, {mode: 0o600})
  if (personal !== undefined) await writeFile(join(h.directory, 'personal.json'), personal, {mode: 0o600})
}
function realReader() {
  return {readHostSpaceConfig: path => JSON.parse(readFileSync(path, 'utf8'))}
}

test('an unregistered config pinned to a different relay is archived unread and a fresh Space is created', async t => {
  const secret = 'SECRET-IDENTITY-MARKER'
  const h = await harness(t, {runtime: {readHostSpaceConfig: path => { const c = JSON.parse(readFileSync(path, 'utf8')); return {relay_url: c.relay_url} }}})
  const logs = []
  for (const name of ['log', 'warn', 'error', 'info']) t.mock.method(console, name, (...args) => logs.push(args.join(' ')))
  await seed(h, JSON.stringify({relay_url: 'https://typo.example', secret}), '')
  const result = await h.handler(settingsEvent, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN})
  assert.deepEqual(result, {ok: true})
  assert.deepEqual(h.calls.map(([name]) => name), ['load', 'init'])
  const names = await readdir(h.directory)
  const archived = names.filter(name => /^config\.unfinished-\d+\.json$/u.test(name))
  assert.equal(archived.length, 1)
  assert.equal((await stat(join(h.directory, archived[0]))).mode & 0o777, 0o600)
  assert.match(await readFile(join(h.directory, archived[0]), 'utf8'), /typo\.example/u)
  assert.ok(!JSON.stringify(result).includes(secret) && !logs.join('\n').includes(secret))
  assert.equal((await stat(h.directory)).mode & 0o777, 0o700)
  assert.deepEqual(h.persisted, [join(h.directory, 'config.json')])
})

test('a different relay with a non-empty personal.json keeps the mismatch refusal and archives nothing', async t => {
  const h = await harness(t, {runtime: realReader()})
  await seed(h, goodConfig('https://typo.example'), '{"data":1}')
  assert.deepEqual(await h.handler(settingsEvent, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN}), {ok: false, error: 'space_relay_mismatch', relayUrl: 'https://typo.example'})
  assert.deepEqual((await readdir(h.directory)).sort(), ['config.json', 'personal.json'])
  assert.deepEqual(h.calls.map(([name]) => name), ['load'])
})

test('the same relay still resumes the original identity', async t => {
  const h = await harness(t, {runtime: realReader()})
  await seed(h, goodConfig('https://relay.example'), '')
  assert.deepEqual(await h.handler(settingsEvent, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN}), {ok: true})
  assert.deepEqual(h.calls.map(([name]) => name), ['load', 'resume'])
  assert.deepEqual((await readdir(h.directory)).sort(), ['config.json', 'personal.json'])
})

test('an empty config.json left by an interrupted write is removed and creation proceeds; a non-empty broken one is invalid', async t => {
  const h = await harness(t, {runtime: {readHostSpaceConfig: path => JSON.parse(readFileSync(path, 'utf8'))}})
  await seed(h, '')
  assert.deepEqual(await h.handler(settingsEvent, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN}), {ok: true})
  assert.deepEqual(h.calls.map(([name]) => name), ['load', 'init'])
  assert.deepEqual((await readdir(h.directory)).sort(), ['config.json'])
  const bad = await harness(t, {runtime: {readHostSpaceConfig: path => JSON.parse(readFileSync(path, 'utf8'))}})
  await seed(bad, '{not json')
  assert.deepEqual(await bad.handler(settingsEvent, {relayUrl: 'https://relay.example', bootstrapToken: TOKEN}), {ok: false, error: 'space_config_invalid'})
})


test('existing data is attached only from the trusted main callback, including automatic relay setup', async t => {
  const original=join(tmpdir(),'trusted-original.personal.json')
  const h=await harness(t,{existingPersonalPath:()=>original,prepareRelay:async()=>({relayUrl:'https://relay.example',bootstrapToken:TOKEN}),runtime:{attachExistingHostSpace:async options=>{h.calls.push(['attach',options]);await writeFile(options.configPath,'{}',{mode:0o600})}}})
  assert.deepEqual(await h.handler(settingsEvent,{mode:'tailscale',dataMode:'existing'}),{ok:true})
  assert.equal(h.calls.find(([name])=>name==='attach')[1].personalPath,original)
  assert.ok(!h.calls.some(([name])=>name==='init'))
  for(const payload of [{mode:'tailscale',dataMode:'existing',personalPath:original},{relayUrl:'https://relay.example',bootstrapToken:TOKEN,dataMode:'existing',personalPath:original},{mode:'tailscale',dataMode:'unknown'}])await assert.rejects(h.handler(settingsEvent,payload),/space create rejected/)
})
test('missing original path or interrupted config for another mode cannot attach or replace data', async t => {
  const missing=await harness(t)
  assert.deepEqual(await missing.handler(settingsEvent,{relayUrl:'https://relay.example',bootstrapToken:TOKEN,dataMode:'existing'}),{ok:false,error:'space_existing_data_unavailable'})
  const h=await harness(t,{existingPersonalPath:()=>join(tmpdir(),'original.personal.json'),runtime:{readHostSpaceConfig:()=>({relay_url:'https://relay.example',data_mode:'isolated'})}})
  await seed(h,'{}')
  assert.deepEqual(await h.handler(settingsEvent,{relayUrl:'https://relay.example',bootstrapToken:TOKEN,dataMode:'existing'}),{ok:false,error:'space_config_invalid'})
  assert.deepEqual(h.calls.map(([name])=>name),['load'])
  assert.equal(await readFile(join(h.directory,'config.json'),'utf8'),'{}')
})
