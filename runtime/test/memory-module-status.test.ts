import {test} from 'node:test'
import assert from 'node:assert/strict'
import {DASHSCOPE_COMPATIBLE_BASE_URL,loadSettings,memoryStatus} from '../src/config/config.js'

test('memory module status reports the missing embedding key or availability in the search module shape',()=>{
 assert.deepEqual(memoryStatus(loadSettings({MEMORY_CONNECTION:'local'})),{enabled:false,reason:'missing_environment:DASHSCOPE_API_KEY',fallback:null})
 assert.deepEqual(memoryStatus(loadSettings({MEMORY_CONNECTION:'local',MODEL_BASE_URL:'https://example.com/v1'})),{enabled:false,reason:'missing_environment:MODEL_API_KEY',fallback:null})
 assert.deepEqual(memoryStatus(loadSettings({MEMORY_CONNECTION:'local',DASHSCOPE_API_KEY:'memory-key',MODEL_BASE_URL:DASHSCOPE_COMPATIBLE_BASE_URL})),{enabled:true,reason:null,fallback:null})
 assert.deepEqual(memoryStatus(loadSettings({MEMORY_CONNECTION:'disabled'})),{enabled:false,reason:'disabled',fallback:null})
})
