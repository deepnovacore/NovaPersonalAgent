import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {GatewayHttpGuard,gatewaySource} from '../src/http-policy.js';
function request(peer:string,forwarded?:string,url='/v1/installations') {return {socket:{remoteAddress:peer},headers:forwarded?{'x-forwarded-for':forwarded}:{},method:'POST',url} as IncomingMessage;}
const response=()=>new EventEmitter() as ServerResponse;
test('gateway ignores spoofed forwarding unless immediate peer is explicitly trusted',()=>{
 assert.equal(gatewaySource(request('192.0.2.1','198.51.100.2'),new Set()),'192.0.2.1');
 const trusted=new Set(['127.0.0.1']);
 assert.equal(gatewaySource(request('::ffff:127.0.0.1','198.51.100.2'),trusted),'198.51.100.2');
 assert.equal(gatewaySource(request('127.0.0.1','203.0.113.10, 198.51.100.2'),trusted),'198.51.100.2');
 assert.throws(()=>gatewaySource(request('127.0.0.1','not-an-ip'),trusted),/invalid_source_address/);
});
test('enrollment limits precede body work and are isolated behind trusted proxy; release is idempotent',()=>{
 let now=100_000;const guard=new GatewayHttpGuard({trustedProxyAddresses:['127.0.0.1'],enrollmentsPerMinute:1,maxConcurrent:1,now:()=>now});
 const first=response();guard.check(request('127.0.0.1','192.0.2.1'),first);
 assert.throws(()=>guard.check(request('127.0.0.1','192.0.2.2'),response()),/concurrency_limit/);
 first.emit('finish');first.emit('close');
 assert.throws(()=>guard.check(request('127.0.0.1','192.0.2.1'),response()),/enrollment_limit/);
 now+=60_000;const next=response();guard.check(request('127.0.0.1','192.0.2.2'),next);next.emit('finish');
});
