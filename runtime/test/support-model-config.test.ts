import assert from 'node:assert/strict'
import {test} from 'node:test'
import {loadSettings} from '../src/config/config.js'

test('SUPPORT_MODEL selects the shared auxiliary LLM and preserves raw values',()=>{
 for(const value of ['custom-support','','  ']){
  const settings=loadSettings({SUPPORT_MODEL:value})
  assert.equal(settings.support_model,value)
 }
})
test('removed SURROGATE_MODEL cannot override the support model or its default',()=>{
 const explicit=loadSettings({SUPPORT_MODEL:'new-model',SURROGATE_MODEL:'old-model'})
 assert.equal(explicit.support_model,'new-model')
 const legacy=loadSettings({SURROGATE_MODEL:'old-model'})
 assert.equal(legacy.support_model,'qwen-plus')
})
