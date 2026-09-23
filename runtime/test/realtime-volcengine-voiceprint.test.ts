import assert from 'node:assert/strict'
import {test} from 'node:test'
import {gzipSync, gunzipSync} from 'node:zlib'
import {DoubaoAsrProtocol} from '../src/realtime/volcengine/asr.js'

const target = {id: '6d7dd0de-6563-4b1f-885e-f39db4f7b360', name: 'nova-test-speaker'}
function response(body: unknown, final = true): Uint8Array {
  const payload = gzipSync(JSON.stringify(body))
  const frame = Buffer.alloc(12 + payload.length)
  frame.set([0x11, final ? 0x93 : 0x91, 0x11, 0])
  frame.writeInt32BE(final ? -1 : 1, 4)
  frame.writeUInt32BE(payload.length, 8)
  frame.set(payload, 12)
  return frame
}

test('voiceprint requests identity verification and only releases matching final utterances', () => {
  const protocol = new DoubaoAsrProtocol(target)
  const wire = protocol.fullRequest({sequence: 1, sampleRate: 16000, userId: 'test'})
  const request = (JSON.parse(gunzipSync(wire.subarray(12)).toString()) as {request: Record<string, unknown>}).request
  assert.equal(request.ssd_mode, 2)
  assert.equal(request.enable_nonstream, true)
  assert.equal(request.enable_speaker_info, true)
  assert.deepEqual(request.voiceprints, [{id: target.id}])
  const utterance = (speaker: string) => ({text: '打开设置', definite: true, additions: {speaker_id: speaker}})
  const body = {result: {text: '未过滤全文', utterances: [utterance(target.name), utterance('0')]}}
  assert.equal(protocol.decode(response(body, false)), null)
  assert.deepEqual(protocol.decode(response(body)), {text: '打开设置', final: true})
  for (const result of [
    {text: '旁人声音', utterances: [utterance('0')]},
    {text: '没有身份字段'},
    {utterances: [{text: '尚未确认', definite: false, additions: {speaker_id: target.name}}]},
  ]) assert.deepEqual(protocol.decode(response({result})), {text: '', final: true})
  assert.deepEqual(new DoubaoAsrProtocol().decode(response({result: {text: '普通识别'}})), {text: '普通识别', final: true})
})

test('unhealthy registration service disables ASR voiceprint flags without disabling transcription', async t => {
  const {DoubaoAsrClient} = await import('../src/realtime/volcengine/asr.js')
  for (const healthy of [false,true]) {
    t.mock.method(globalThis,'fetch', () => Promise.resolve(Response.json({ok:healthy})))
    const sent: Uint8Array[] = []
    const options = {apiKey:'test',resourceId:'test',endpoint:'wss://example.test/asr',chunkMs:200,
      voiceprint:target,voiceprintHealthUrl:'https://upload.example/healthz',
      connector: () => Promise.resolve({send:(frame:Uint8Array)=>{sent.push(frame); return Promise.resolve()},receive:()=>Promise.resolve(new Uint8Array([0x11,0,0,0,0,0,0,0,0,0,0,0])),close:()=>Promise.resolve()})}
    const session = await new DoubaoAsrClient(options).open()
    const request = (JSON.parse(gunzipSync(sent[0]!.subarray(12)).toString()) as {request:Record<string,unknown>}).request
    assert.equal(request.ssd_mode,healthy ? 2 : undefined)
    await session.close()
    t.mock.restoreAll()
  }
})
