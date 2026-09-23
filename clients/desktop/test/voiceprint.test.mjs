import assert from 'node:assert/strict'
import {test} from 'node:test'
import {registerVoiceprint} from '../src/main/voiceprint.mjs'
import {normalizeSettings, publicSettings} from '../src/main/settings-store.mjs'

test('registration keeps the speech key off the upload service and always cleans temporary audio', async () => {
  const ticket = 'b'.repeat(64)
  const calls = []
  const id = '6d7dd0de-6563-4b1f-885e-f39db4f7b360'
  let fail = false
  const fetcher = async (url, init) => {
    calls.push([url,init])
    if (url === 'https://upload.example/uploads') {
      assert.equal(init.headers['X-Api-Key'], undefined)
      return Response.json({ticket,audioUrl:`https://upload.example/audio/${ticket}`}, {status:201})
    }
    if (url.includes('/api/proxy/invoke/?Action=UpdateVoiceprint')) {
      assert.equal(init.headers['X-Api-Key'],'private-key')
      assert.equal(init.redirect,'error', 'never forward credentials across redirects')
      const body = JSON.parse(init.body)
      assert.equal(body.AudioUrl, `https://upload.example/audio/${ticket}`)
      assert.equal(body.Action,0)
      assert.match(body.SpeakerName, /^nova-/)
      return Response.json({Result:{Code:fail?1001:1000,SpeakID:id}})
    }
    assert.equal(url, `https://upload.example/uploads/${ticket}`)
    assert.equal(init.method,'DELETE')
    return new Response(null,{status:204})
  }
  const input = {audio:new Uint8Array(160044),uploadUrl:'https://upload.example',apiKey:'private-key',fetcher}
  const result = await registerVoiceprint(input)
  assert.ok(result)
  assert.equal(result.id,id)
  assert.match(result.name,/^nova-/)
  assert.equal(calls.length,3)
  fail = true
  await assert.rejects(registerVoiceprint(input), /voiceprint_provider_failed/)
  assert.equal(calls.at(-1)[1].method,'DELETE')
})

test('voiceprint settings survive normalization without exposing credentials', () => {
  const raw = {voiceprintEnabled:true,voiceprintId:'6d7dd0de-6563-4b1f-885e-f39db4f7b360', voiceprintName:'nova-example',voiceprintUploadUrl:'https://upload.example'}
  const settings = normalizeSettings(raw)
  assert.equal(settings.voiceprintEnabled,true)
  assert.equal(publicSettings(settings).voiceprintId,raw.voiceprintId)
  assert.equal(normalizeSettings({voiceprintUploadUrl:'http://untrusted.example'}).voiceprintUploadUrl,'')
})

test('only the active settings recording window may request microphone audio', async () => {
  const {configureWindowSecurity} = await import('../src/main/security.mjs')
  let check, request, active = null
  const settings = {}, other = {}
  const renderer = {setWindowOpenHandler(){},on(){},session:{setPermissionCheckHandler(fn){check=fn},setPermissionRequestHandler(fn){request=fn}}}
  configureWindowSecurity({webContents:renderer}, () => active)
  assert.equal(check(settings,'media','nova://orb',{mediaType:'audio'}),false)
  active = settings
  assert.equal(check(settings,'media','nova://orb',{mediaType:'audio'}),true)
  assert.equal(check(settings,'media','nova://orb',{mediaType:'video'}),false)
  assert.equal(check(other,'media','nova://orb',{mediaType:'audio'}),false)
  request(settings,'media',value=>assert.equal(value,false),{securityOrigin:'nova://orb',mediaTypes:['audio','video']})
  active = null
  assert.equal(check(settings,'media','nova://orb',{mediaType:'audio'}),false)
})

test('recorded WAV format and unhealthy settings hide registration while retaining the saved target', async () => {
  const {voiceprintWav,createVoiceprintPanel} = await import('../src/renderer/voiceprint-panel.mjs')
  const bytes = voiceprintWav(new Float32Array(48000*5),48000)
  const wav = Buffer.from(bytes)
  assert.equal(wav.length,160044)
  assert.equal(wav.toString('ascii',0,4),'RIFF')
  assert.equal(wav.readUInt32LE(24),16000)
  assert.equal(wav.readUInt32LE(40),160000)
  assert.throws(()=>voiceprintWav(new Float32Array(100),16000),/voiceprint_audio_invalid/)
  const elements = new Map()
  const doc = {querySelector(id) {if (!elements.has(id)) elements.set(id,{addEventListener(){}}); return elements.get(id)}}
  let ready = true, cleanup
  const previous = globalThis.window
  globalThis.window = {addEventListener(name,fn){if(name==='pagehide') cleanup=fn}}
  const saved = {pipelineMode:'cascaded',cascadedAsrProvider:'volcengine',voiceprintId:'saved',voiceprintName:'name',voiceprintEnabled:true,voiceprintUploadUrl:'https://one.example'}
  try {
    const panel = createVoiceprintPanel({document:doc,api:{voiceprint:async()=>({healthy:ready})},stage(){throw new Error('health must not erase saved preferences')}})
    panel.render(saved)
    await new Promise(setImmediate)
    assert.equal(elements.get('#voiceprint-controls').hidden,false)
    assert.equal(elements.get('#voiceprint-enabled').checked,true)
    ready = false
    panel.render({...saved,voiceprintUploadUrl:'https://two.example'})
    await new Promise(setImmediate)
    assert.equal(elements.get('#voiceprint-controls').hidden,true)
    assert.equal(elements.get('#voiceprint-enabled').checked,false)
    assert.equal(elements.get('#voiceprint-identity').textContent,'saved')
  } finally {cleanup?.();globalThis.window=previous}
})
