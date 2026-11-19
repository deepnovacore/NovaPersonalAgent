import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chatFailure,chatFailureSchema} from '../src/personal-agent/chat-failure.js';

test('chat failures expose only closed categories from known runtime codes',()=>{
 for(const [code,category] of Object.entries({http_auth:'authentication',http_quota:'quota',http_rate_limited:'rate_limited',network:'network',timeout:'timeout',output_limit:'output_limit'})){
  assert.equal(chatFailure(Error('model_'+code)),category);
  assert.equal(chatFailure(Object.assign(Error('private endpoint sk-secret'),{reason:'provider_'+code})),category);
 }
 assert.equal(chatFailure(new DOMException('private endpoint','TimeoutError')),'timeout');
 assert.equal(chatFailure(Error('processing_model_unavailable')),'configuration');
 assert.equal(chatFailure(Object.assign(Error('private key details'),{code:'invalid_configuration'})),'configuration');
 assert.equal(chatFailure(Error('model_output_limit_tool_arguments')),'output_limit');
 for(const error of [Error('401 sk-secret https://private.example'),Error('model_http_auth_sk_secret'),Object.assign(Error('secret'),{reason:'provider_http_auth_secret'}),null])assert.equal(chatFailure(error),'unknown');
 assert.equal(chatFailureSchema.safeParse('sk-secret').success,false);
});
