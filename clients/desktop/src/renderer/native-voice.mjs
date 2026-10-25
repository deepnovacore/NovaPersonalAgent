export const NATIVE_VOICE_PROVIDERS = Object.freeze({
  'minicpm-o': {endpoint:'minicpmRealtimeUrl', secret:'minicpmRealtimeApiKey', model:'minicpm-o', voice:'', defaultUrl:'ws://127.0.0.1:18580/v1/realtime'},
  personaplex: {endpoint:'personaplexRealtimeUrl', secret:'personaplexRealtimeApiKey', model:'personaplex', voice:'NATF2', defaultUrl:'ws://127.0.0.1:18581/v1/realtime'},
})
export function validNativeRealtimeUrl(value) {
  if(typeof value!=='string'||value.length>2048||/[\s\\]/u.test(value))return null
  try {
    const url=new URL(value)
    if(url.username||url.password||url.hash||url.search)return null
    if(url.protocol!=='wss:'&&!(url.protocol==='ws:'&&/^ws:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\//u.test(value)))return null
    return url.toString()
  } catch {return null}
}
