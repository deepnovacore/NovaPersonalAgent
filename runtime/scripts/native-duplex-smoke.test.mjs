import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {WebSocketServer} from 'ws'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'

for (const [model,fail] of [['minicpm-o',false],['personaplex',false],['personaplex',true]]) test(`smoke CLI over real localhost WebSocket: ${model}${fail?' failure evidence':''}`,{timeout:15000},async () => {
  const directory = await mkdtemp(join(tmpdir(),'nova-native-smoke-'))
  const input = join(directory,'input.pcm'), output = join(directory,'result')
  await writeFile(input,Buffer.alloc(32000))
  const http = createServer((request,response) => {
    assert.equal(request.url,'/v1/realtime/capabilities')
    response.setHeader('content-type','application/json')
    response.end(JSON.stringify({native_full_duplex:true,input_audio_format:{rate:model === 'personaplex'?24000:16000},output_audio_format:{rate:24000}}))
  })
  const server = new WebSocketServer({server:http,path:'/v1/realtime'})
  let expectedSequence = 0, inputBytes = 0, firstInputAt, inputEndAt
  server.on('connection',socket => {
    const send = frame => socket.send(JSON.stringify(frame))
    send({type:'session.created',session:{id:'fixture-session'}})
    socket.on('message',payload => {
      const frame = JSON.parse(payload.toString())
      assert.equal(typeof frame.event_id,'string')
      if (frame.type === 'session.update') {
        assert.deepEqual(frame.session,{output_modalities:['audio']})
        setTimeout(() => send({type:'session.updated'}),model === 'minicpm-o' ? 1000 : 0)
      } else if (frame.type === 'input_audio_buffer.append') {
        firstInputAt ??= performance.now()
        assert.equal(frame.sglang.seq,expectedSequence++)
        inputBytes += Buffer.from(frame.audio,'base64').length
        if (expectedSequence === 1) {
          send({type:'response.created',response:{id:'r1',status:'in_progress'}})
          send({type:'response.output_audio.delta',response_id:'r1',delta:'AAA='})
          send({type:'response.output_audio_transcript.delta',response_id:'r1',delta:'hello'})
          if(fail)send({type:'error',error:{code:'fixture_failure'}})
        }
      } else if (frame.type === 'sglang.input_audio.end') {
        inputEndAt = performance.now()
        send({type:'response.output_audio_transcript.done',response_id:'r1',transcript:'hello final'})
        send({type:'response.done',response:{id:'r1',status:'completed'}})
        send({type:'sglang.input_audio.drained'})
      } else { assert.equal(frame.type,'session.close'); socket.close() }
    })
  })
  http.listen(0,'127.0.0.1'); await once(http,'listening')
  try {
    const child = spawn(process.execPath,[new URL('./native-duplex-smoke.mjs',import.meta.url).pathname,model,input,output],{
      env:{...process.env,NATIVE_REALTIME_URL:`ws://127.0.0.1:${http.address().port}/v1/realtime`,NATIVE_REALTIME_API_KEY:'',NATIVE_REALTIME_VOICE:''},stdio:['ignore','pipe','pipe'],
    })
    let errors = ''; child.stderr.on('data',chunk => {errors += chunk})
    const [code] = await once(child,'exit')
    if(fail){
      assert.equal(code,1)
      const result=JSON.parse(await readFile(join(output,'result.json'),'utf8'))
      assert.equal(result.status,'failed')
      assert.deepEqual(result.serverErrorCodes,['fixture_failure'])
      assert.ok(result.events.some(event=>event.kind==='provider_error'))
      assert.equal((await readFile(join(output,'partial-reply-24k.pcm'))).length,2)
      return
    }
    assert.equal(code,0,errors)
    assert.ok(inputEndAt-firstInputAt >= 3800,'Handshake latency must not compress the audio replay timeline')
    assert.equal(inputBytes,model === 'personaplex'?191998:128000)
    const result = JSON.parse(await readFile(join(output,'result.json'),'utf8'))
    assert.equal(result.transcript,'hello final')
    assert.equal(result.status,'completed')
    assert.ok(result.events.some(event => event.kind === 'response_transcript_final'))
    assert.equal((await readFile(join(output,'reply-24k.pcm'))).length,2)
  } finally { for (const client of server.clients) client.terminate(); server.close(); await new Promise(resolve => http.close(resolve)); await rm(directory,{recursive:true}) }
})
