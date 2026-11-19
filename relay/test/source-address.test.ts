import test from 'node:test';
import assert from 'node:assert/strict';
import type {IncomingMessage} from 'node:http';
import {canonicalAddress,sourceAddress,trustedAddresses} from '../src/source-address.js';
const request=(peer:string,forwarded?:string)=>({socket:{remoteAddress:peer},headers:forwarded===undefined?{}:{'x-forwarded-for':forwarded}} as Pick<IncomingMessage,'socket'|'headers'>);
test('proxy trust is explicit, canonical and stops at the first untrusted hop',()=>{
 const trust=trustedAddresses(['127.0.0.1','2001:db8::1']);
 assert.equal(canonicalAddress('::ffff:127.0.0.1'),'127.0.0.1');
 assert.equal(canonicalAddress('2001:0db8:0:0:0:0:0:1'),'2001:db8::1');
 assert.equal(sourceAddress(request('::ffff:127.0.0.1','198.51.100.8, 192.0.2.4, 2001:db8::1'),trust),'192.0.2.4');
 assert.equal(sourceAddress(request('192.0.2.4','198.51.100.8'),trust),'192.0.2.4');
 assert.equal(sourceAddress(request('127.0.0.1'),trust),'127.0.0.1');
 assert.throws(()=>trustedAddresses(['localhost']),/invalid_trusted_proxies/);
 assert.throws(()=>trustedAddresses(['0.0.0.0\/0']),/invalid_trusted_proxies/);
 for(const header of ['', '192.0.2.4,', 'unknown','192.0.2.4:443',Array(17).fill('192.0.2.4').join(',')])assert.throws(()=>sourceAddress(request('127.0.0.1',header),trust),/invalid_forwarded_address/);
});
