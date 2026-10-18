import assert from 'node:assert/strict'
import test from 'node:test'
import {applySettingsUpdate, normalizeSettings, publicSettings, backendSettings, readSecret, SECRET_KEYS} from '../src/main/settings-store.mjs'
import {backendLaunchSpec, capabilityEnvironment, resolveSecretConfiguration} from '../src/main/backend.mjs'
const selected = () => normalizeSettings({pipelineMode:'cascaded',cascadedLlmProvider:'openai-compatible',cascadedAsrProvider:'openai-compatible',cascadedTtsProvider:'openai-compatible',cascadedLlmModels:{'openai-compatible':'vendor/model'}})
const fields = {openaiCompatibleBaseUrl:'https://llm.example/v1',openaiCompatibleProtocol:'responses',compatibleAsrBaseUrl:'https://asr.example/v1',compatibleAsrModel:'vendor/asr',compatibleTtsBaseUrl:'https://tts.example/v1',compatibleTtsModel:'vendor/tts',compatibleTtsVoice:'vendor/voice',compatibleTtsSendSampleRate:true}
test('migration preserves old choices; compatible fields survive public/backend projection',()=>{
 const migrated=normalizeSettings({cascadedLlmProvider:'deepseek',cascadedLlmModels:{deepseek:'kept-model'}})
 assert.equal(migrated.cascadedLlmProvider,'deepseek');assert.equal(migrated.cascadedLlmModels.deepseek,'kept-model')
 assert.equal(migrated.openaiCompatibleBaseUrl,'https://api.openai.com/v1');assert.equal(migrated.cascadedLlmModels['openai-compatible'],'')
 const settings=normalizeSettings({...selected(),...fields})
 for(const view of [settings,publicSettings(settings),backendSettings(settings)]) for(const [key,value] of Object.entries(fields)) assert.equal(view[key],value,key)
 assert.equal(settings.cascadedLlmModels['openai-compatible'],'vendor/model')
})
test('credentials are independent and cleared on any endpoint change',()=>{
 let saved=applySettingsUpdate(selected(),{secrets:{openaiCompatibleApiKey:'llm',compatibleAsrApiKey:'asr',compatibleTtsApiKey:'tts',openaiApiKey:'native'}})
 for(const key of ['openaiCompatibleApiKey','compatibleAsrApiKey','compatibleTtsApiKey']) assert.ok(SECRET_KEYS.includes(key))
 assert.equal(readSecret(saved,'compatibleAsrApiKey'),'asr')
 saved=applySettingsUpdate(saved,{openaiCompatibleBaseUrl:'https://api.openai.com/another-tenant'})
 assert.equal(saved.secrets.openaiCompatibleApiKey.enc,'cleared');assert.equal(readSecret(saved,'openaiApiKey'),'native')
 assert.equal(readSecret(saved,'compatibleTtsApiKey'),'tts')
 assert.equal(resolveSecretConfiguration({openaiCompatibleApiKey:''},{OPENAI_COMPATIBLE_API_KEY:'stale'}).secretsPresent.openaiCompatibleApiKey,false)
 saved=applySettingsUpdate(saved,{openaiCompatibleBaseUrl:'https://other.example/v1',secrets:{openaiCompatibleApiKey:'new'}})
 assert.equal(readSecret(saved,'openaiCompatibleApiKey'),'new')
})
test('unsafe endpoints reject the save',()=>{
 for(const value of ['http://example.com/v1','https://user:pass@example.com/v1','https://example.com/v1?x=1','https://example.com/v1#x','http://localhost/v1']) for(const field of ['openaiCompatibleBaseUrl','compatibleAsrBaseUrl','compatibleTtsBaseUrl']) assert.throws(()=>applySettingsUpdate(selected(),{[field]:value}),{code:'invalid_settings_commit'})
 for(const value of ['https://example.com/v1','http://127.0.0.1:8080/v1','http://[::1]:8080/v1']) assert.equal(applySettingsUpdate(selected(),{compatibleAsrBaseUrl:value}).compatibleAsrBaseUrl,value)
})
test('launch passes models, protocol and only selected saved credentials',()=>{
 const settings=normalizeSettings({...selected(),...fields})
 const secrets={openaiCompatibleApiKey:'llm',compatibleAsrApiKey:'asr',compatibleTtsApiKey:'tts',openaiApiKey:'native'}
 const spec=backendLaunchSpec({nodeEntry:'/tmp/runtime.mjs',nodeResourcesPath:'/tmp',workspace:'/tmp',token:'a'.repeat(32),readyEndpoint:'127.0.0.1:12345',parentEnv:{MEMORY_CONNECTION:'disabled'},settings,decryptedSecrets:secrets})
 const env=spec.env
 assert.equal(env.OPENAI_COMPATIBLE_API_KEY,'llm');assert.equal(env.COMPATIBLE_ASR_API_KEY,'asr');assert.equal(env.COMPATIBLE_TTS_API_KEY,'tts');assert.equal(env.OPENAI_API_KEY,undefined)
 assert.equal(env.OPENAI_COMPATIBLE_PROTOCOL,'responses');assert.equal(env.CASCADE_LLM_MODEL,'vendor/model')
 assert.equal(env.COMPATIBLE_TTS_SEND_SAMPLE_RATE,'true');assert.equal(env.COMPATIBLE_ASR_MODEL,'vendor/asr')
 assert.equal(env.OPENAI_COMPATIBLE_BASE_URL,fields.openaiCompatibleBaseUrl);assert.equal(env.COMPATIBLE_ASR_BASE_URL,fields.compatibleAsrBaseUrl)
 assert.equal(env.COMPATIBLE_TTS_BASE_URL,fields.compatibleTtsBaseUrl);assert.equal(env.COMPATIBLE_TTS_MODEL,fields.compatibleTtsModel);assert.equal(env.COMPATIBLE_TTS_VOICE,fields.compatibleTtsVoice)
 const inactive=capabilityEnvironment({...settings,cascadedLlmProvider:'deepseek',cascadedAsrProvider:'volcengine',cascadedTtsProvider:'volcengine'},secrets,{MEMORY_CONNECTION:'disabled'})
 assert.equal(inactive.OPENAI_COMPATIBLE_API_KEY,undefined);assert.equal(inactive.COMPATIBLE_ASR_API_KEY,undefined);assert.equal(inactive.COMPATIBLE_TTS_API_KEY,undefined)
})

test('provider switching preserves compatible settings and model while inactive inherited keys are masked',()=>{
 const configured=applySettingsUpdate(selected(),{...fields,secrets:{openaiCompatibleApiKey:'saved',compatibleAsrApiKey:'asr'}})
 const switched=applySettingsUpdate(configured,{cascadedLlmProvider:'deepseek',cascadedAsrProvider:'volcengine'})
 const returned=applySettingsUpdate(switched,{cascadedLlmProvider:'openai-compatible',cascadedAsrProvider:'openai-compatible'})
 assert.equal(returned.cascadedLlmModels['openai-compatible'],'vendor/model')
 assert.equal(returned.openaiCompatibleProtocol,'responses');assert.equal(readSecret(returned,'openaiCompatibleApiKey'),'saved')
 const env=capabilityEnvironment(switched,{}, {OPENAI_COMPATIBLE_API_KEY:'inherited',COMPATIBLE_ASR_API_KEY:'inherited-asr'})
 assert.equal(env.OPENAI_COMPATIBLE_API_KEY,'');assert.equal(env.COMPATIBLE_ASR_API_KEY,'')
 const effective=resolveSecretConfiguration({openaiCompatibleApiKey:'saved'}, {}, {OPENAI_COMPATIBLE_API_KEY:'dotenv'})
 assert.equal(effective.secrets.openaiCompatibleApiKey,'saved')
})
test('compatible models support qualified IDs without widening native model bounds or exposing secrets',()=>{
 const model='vendor/'+ 'x'.repeat(120)
 const settings=applySettingsUpdate(selected(),{cascadedLlmModels:{'openai-compatible':model,openai:model},compatibleTtsModel:model,secrets:{compatibleTtsApiKey:'private'}})
 assert.equal(settings.cascadedLlmModels['openai-compatible'],model);assert.equal(settings.compatibleTtsModel,model)
 assert.equal(settings.cascadedLlmModels.openai,'gpt-6-luna')
 assert.equal(JSON.stringify(publicSettings(settings)).includes('private'),false)
 for(const endpoint of ['https://example.com/v1\\escape','https://example.com/v1\n','http://127.1/v1','http://2130706433/v1','https://example.com/'+ 'x'.repeat(2048)]) assert.throws(()=>applySettingsUpdate(settings,{compatibleTtsBaseUrl:endpoint}),{code:'invalid_settings_commit'})
})

test('speech endpoint replacement clears only that stage and integrated text uses the generic credential',()=>{
 for(const [endpoint,secret,other] of [['compatibleAsrBaseUrl','compatibleAsrApiKey','compatibleTtsApiKey'],['compatibleTtsBaseUrl','compatibleTtsApiKey','compatibleAsrApiKey']]) {
   const stored=applySettingsUpdate(selected(),{secrets:{compatibleAsrApiKey:'asr',compatibleTtsApiKey:'tts'}})
   const updated=applySettingsUpdate(stored,{[endpoint]:'https://new.example/v1'})
   assert.equal(readSecret(updated,secret),'');assert.equal(readSecret(updated,other),readSecret(stored,other))
   const effective=resolveSecretConfiguration({[secret]:readSecret(updated,secret)}, {}, {[secret==='compatibleAsrApiKey'?'COMPATIBLE_ASR_API_KEY':'COMPATIBLE_TTS_API_KEY']:'stale'})
   assert.equal(effective.secretsPresent[secret],false)
 }
 const env=capabilityEnvironment({...selected(),pipelineMode:'integrated',integratedProvider:'openai'},{openaiCompatibleApiKey:'generic',openaiApiKey:'realtime',compatibleAsrApiKey:'unused'})
 assert.equal(env.OPENAI_COMPATIBLE_API_KEY,'generic');assert.equal(env.OPENAI_API_KEY,'realtime');assert.equal(env.COMPATIBLE_ASR_API_KEY,undefined)
})
