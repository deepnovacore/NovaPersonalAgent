import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mintInvitation, verifyInvitation} from '../src/admission.js';
const secret='operator-only-secret-with-at-least-32-characters';
test('short-lived operator invitations authenticate exact claims and reject tampering or expiry',()=>{
 const ticket=mintInvitation(secret,{now:1000,ttlMs:100});
 const claims=verifyInvitation(secret,ticket,1001);
 assert.equal(claims.expiresAt,1100);
 assert.notEqual(claims.id,claims.installationId);
 assert.throws(()=>verifyInvitation(secret,ticket,1100),/invalid_invitation/);
 assert.throws(()=>verifyInvitation(secret+'wrong',ticket,1001),/invalid_invitation/);
 const [body,signature]=ticket.split('.');
 const changed=Buffer.from(JSON.stringify({...claims,expiresAt:999999})).toString('base64url');
 assert.throws(()=>verifyInvitation(secret,changed+'.'+signature,1001),/invalid_invitation/);
 assert.throws(()=>verifyInvitation(secret,body+'.'+signature+'.extra',1001),/invalid_invitation/);
 assert.throws(()=>mintInvitation(secret,{now:1000,ttlMs:900001}),/invalid_invitation_options/);
 assert.throws(()=>mintInvitation(secret,{now:Number.MAX_SAFE_INTEGER}),/invalid_invitation_options/);
 assert.throws(()=>mintInvitation('public'),/admission_key_too_short/);
});
