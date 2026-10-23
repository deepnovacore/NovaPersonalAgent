import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSpaceInit,parseSpaceResume} from '../src/space-host/cli.js';
test('Host init requires explicit independent paths and never accepts a bootstrap secret as an argument',()=>{
 assert.throws(()=>parseSpaceInit(['init','--config','/space/config','--data','/space/data','--relay','https://relay.example','--token','secret']),/usage/);
 assert.throws(()=>parseSpaceInit(['init','--config','/same','--data','/same','--relay','https://relay.example','--bootstrap-file','/credential']),/distinct/);
 assert.deepEqual(parseSpaceInit(['init','--config','/space/config','--data','/space/personal','--relay','https://relay.example','--bootstrap-file','/credential']),{configPath:'/space/config',personalPath:'/space/personal',relayUrl:'https://relay.example',bootstrapFile:'/credential'});
});

test('registration resume preserves identity paths and accepts only a private credential file',()=>{
 assert.deepEqual(parseSpaceResume(['resume','--config','/space/config','--bootstrap-file','/credential']),{configPath:'/space/config',bootstrapFile:'/credential'});
 assert.throws(()=>parseSpaceResume(['resume','--config','/space/config','--token','secret']),/usage/);
 assert.throws(()=>parseSpaceResume(['resume','--config','/same','--bootstrap-file','/same']),/distinct/);
});
