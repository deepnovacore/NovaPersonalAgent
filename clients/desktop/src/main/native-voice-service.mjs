import {NATIVE_VOICE_PROVIDERS,validNativeRealtimeUrl} from '../renderer/native-voice.mjs'
export async function probeNativeVoice(provider, settings, secrets, fetcher=globalThis.fetch) {
  const profile=NATIVE_VOICE_PROVIDERS[provider]
  const endpoint=profile&&validNativeRealtimeUrl(settings[profile.endpoint])
  if(!endpoint)throw Error('native_service_configuration_invalid')
  const url=new URL(endpoint);url.protocol=url.protocol==='wss:'?'https:':'http:';url.pathname=url.pathname.replace(/\/$/u,'')+'/capabilities'
  const key=secrets[profile.secret]
  let result
  try {
    const response=await fetcher(url.toString(),{headers:key?{Authorization:`Bearer ${key}`}:{},redirect:'error',signal:AbortSignal.timeout(10000)})
    if(!response.ok)throw Error('http')
    const chunks=[];let size=0
    for await(const chunk of response.body){size+=chunk.byteLength;if(size>65536)throw Error('oversize');chunks.push(chunk)}
    result=JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }catch {throw Error('native_service_unavailable')}
  if(result?.native_full_duplex!==true||result.input_audio_format?.rate!==(provider==='personaplex'?24000:16000)||result.output_audio_format?.rate!==24000)throw Error('native_service_incompatible')
  const voices=Array.isArray(result.voices)?result.voices.filter(value=>typeof value==='string'&&value.length>0&&value.length<=64).slice(0,64):[]
  return {nativeFullDuplex:true,voices,endpoint}
}
