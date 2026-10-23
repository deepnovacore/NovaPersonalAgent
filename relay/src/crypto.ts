/** Endpoint-only JOSE helpers. Relay uses public signature verification only. */
import {createPublicKey,createPrivateKey,generateKeyPairSync,randomBytes,randomUUID,verify,createHash} from 'node:crypto';
import {openSync,closeSync,writeFileSync,readFileSync,fsyncSync,renameSync,chmodSync,unlinkSync} from 'node:fs';
import {CompactEncrypt,compactDecrypt,CompactSign,importJWK,type JWK} from 'jose';
import {assertId,RelayError,type RelayEnvelope} from './protocol.js';
export type {JWK} from 'jose';
export interface DeviceIdentity {
 device:string; signingPublicKey:JWK; signingPrivateKey:JWK; encryptionPublicKey:JWK; encryptionPrivateKey:JWK;
}
export interface ContentKeyDelivery {v:1;space:string;epoch:number;recipient:string;key:string}
export function generateContentKey():Uint8Array {return randomBytes(32);}
export async function generateDeviceIdentity():Promise<DeviceIdentity> {
 const signing=generateKeyPairSync('ed25519');const agreement=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 return {device:randomUUID(),signingPublicKey:signing.publicKey.export({format:'jwk'}) as JWK,signingPrivateKey:signing.privateKey.export({format:'jwk'}) as JWK,
  encryptionPublicKey:agreement.publicKey.export({format:'jwk'}) as JWK,encryptionPrivateKey:agreement.privateKey.export({format:'jwk'}) as JWK};
}
function base64url(value:unknown,length:number):asserts value is string {
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value)||Buffer.from(value,'base64url').length!==length||Buffer.from(value,'base64url').toString('base64url')!==value)throw new RelayError('invalid_public_key');
}
export function validatePublicKey(key:JWK,kind:'signing'|'encryption'):void {
 if(!key||typeof key!=='object'||key.d!==undefined)throw new RelayError('invalid_public_key');
 if(kind==='signing') {if(key.kty!=='OKP'||key.crv!=='Ed25519')throw new RelayError('invalid_public_key');base64url(key.x,32);}
 else {if(key.kty!=='EC'||key.crv!=='P-256')throw new RelayError('invalid_public_key');base64url(key.x,32);base64url(key.y,32);}
 try {createPublicKey({key:key as import('node:crypto').JsonWebKey,format:'jwk'});}catch{throw new RelayError('invalid_public_key');}
}
export function spaceId(key:JWK):string {
 validatePublicKey(key,'signing');return createHash('sha256').update(JSON.stringify({crv:'Ed25519',kty:'OKP',x:key.x})).digest('base64url');
}
export function deviceFingerprint(signing:JWK,encryption:JWK):string {
 validatePublicKey(signing,'signing');validatePublicKey(encryption,'encryption');
 return createHash('sha256').update(JSON.stringify({signing:{crv:'Ed25519',kty:'OKP',x:signing.x},encryption:{crv:'P-256',kty:'EC',x:encryption.x,y:encryption.y}})).digest('base64url');
}
export async function signControl(payload:unknown,privateKey:JWK):Promise<string> {
 return new CompactSign(Buffer.from(JSON.stringify(payload))).setProtectedHeader({alg:'EdDSA',typ:'nova-control+jws'}).sign(await importJWK(privateKey,'EdDSA'));
}
function verifyJws(compact:string,key:JWK,typ:string):Buffer {
 try {
  validatePublicKey(key,'signing');if(typeof compact!=='string'||compact.length>262_144)throw 0;
  const parts=compact.split('.');if(parts.length!==3||parts.some(p=> !/^[A-Za-z0-9_-]+$/.test(p)))throw 0;
  const [header,payload,signature]=parts as [string,string,string];
  for(const p of parts)if(Buffer.from(p,'base64url').toString('base64url')!==p)throw 0;
  const parsed=JSON.parse(Buffer.from(header,'base64url').toString());
  if(parsed.alg!=='EdDSA'||parsed.typ!==typ||Object.keys(parsed).some(k=> !['alg','typ'].includes(k)))throw 0;
  if(!verify(null,Buffer.from(`${header}.${payload}`),createPublicKey({key:key as import('node:crypto').JsonWebKey,format:'jwk'}),Buffer.from(signature,'base64url')))throw 0;
  return Buffer.from(payload,'base64url');
 }catch{throw new RelayError('invalid_signature');}
}
export function verifyControl(proof:string,key:JWK):unknown {
 try{return JSON.parse(verifyJws(proof,key,'nova-control+jws').toString());}catch{throw new RelayError('invalid_signature');}
}
export function envelopePayload(e:Omit<RelayEnvelope,'sig'>):string {
 return JSON.stringify({v:e.v,space:e.space,id:e.id,from:e.from,to:e.to,chan:e.chan,epoch:e.epoch,expiresAt:e.expiresAt,body:e.body});
}
export async function signEnvelope(e:Omit<RelayEnvelope,'sig'>,privateKey:JWK):Promise<RelayEnvelope> {
 const compact=await new CompactSign(Buffer.from(envelopePayload(e))).setProtectedHeader({alg:'EdDSA',typ:'nova-envelope+jws'}).sign(await importJWK(privateKey,'EdDSA'));
 return {...e,sig:Buffer.from(compact).toString('base64')};
}
export function verifyEnvelope(e:RelayEnvelope,key:JWK):void {
 try {
  if(typeof e.sig!=='string'||Buffer.from(e.sig,'base64').toString('base64')!==e.sig)throw 0;
  if(verifyJws(Buffer.from(e.sig,'base64').toString(),key,'nova-envelope+jws').toString()!==envelopePayload(e))throw 0;
 }catch{throw new RelayError('invalid_signature');}
}
function contentKey(key:Uint8Array):void {if(!(key instanceof Uint8Array)||key.length!==32)throw new RelayError('invalid_content_key');}
export async function encryptBody(value:unknown,key:Uint8Array):Promise<string> {
 contentKey(key);const jwe=await new CompactEncrypt(Buffer.from(JSON.stringify(value))).setProtectedHeader({alg:'dir',enc:'A256GCM'}).encrypt(key);
 return Buffer.from(jwe).toString('base64');
}
export async function decryptBody(body:string,key:Uint8Array):Promise<unknown> {
 contentKey(key);if(Buffer.from(body,'base64').toString('base64')!==body)throw new RelayError('invalid_encoding');
 const result=await compactDecrypt(Buffer.from(body,'base64').toString(),key,{keyManagementAlgorithms:['dir'],contentEncryptionAlgorithms:['A256GCM']});
 return JSON.parse(Buffer.from(result.plaintext).toString());
}
function validateDelivery(value:ContentKeyDelivery):void {
 try{if(value.v!==1||!Number.isSafeInteger(value.epoch)||value.epoch<1)throw 0;assertId(value.space);assertId(value.recipient);base64url(value.key,32);}catch{throw new RelayError('invalid_key_delivery');}
}
export async function wrapContentKey(payload:ContentKeyDelivery,publicKey:JWK):Promise<string> {
 validateDelivery(payload);validatePublicKey(publicKey,'encryption');return new CompactEncrypt(Buffer.from(JSON.stringify(payload)))
  .setProtectedHeader({alg:'ECDH-ES+A256KW',enc:'A256GCM'}).encrypt(await importJWK(publicKey,'ECDH-ES+A256KW'));
}
export async function unwrapContentKey(jwe:string,privateKey:JWK):Promise<ContentKeyDelivery> {
 const result=await compactDecrypt(jwe,await importJWK(privateKey,'ECDH-ES+A256KW'),{keyManagementAlgorithms:['ECDH-ES+A256KW'],contentEncryptionAlgorithms:['A256GCM']});
 const value=JSON.parse(Buffer.from(result.plaintext).toString()) as ContentKeyDelivery;
 validateDelivery(value);return value;
}
function validateIdentity(value:DeviceIdentity):void {
 if(!value)throw new RelayError('invalid_identity');assertId(value.device);
 validatePublicKey(value.signingPublicKey,'signing');validatePublicKey(value.encryptionPublicKey,'encryption');
 for(const [publicKey,privateKey]of [[value.signingPublicKey,value.signingPrivateKey],[value.encryptionPublicKey,value.encryptionPrivateKey]] as const){
  const derived=createPublicKey(createPrivateKey({key:privateKey as import('node:crypto').JsonWebKey,format:'jwk'})).export({format:'jwk'});
  if(derived.x!==publicKey.x||derived.y!==publicKey.y)throw new RelayError('invalid_identity');
 }
}
export function saveDeviceIdentity(path:string,identity:DeviceIdentity):void {
 validateIdentity(identity);const temporary=`${path}.${randomUUID()}.tmp`;const fd=openSync(temporary,'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(identity));fsyncSync(fd);}catch(error){unlinkSync(temporary);throw error;}finally{closeSync(fd);}
 renameSync(temporary,path);chmodSync(path,0o600);
}
export function loadDeviceIdentity(path:string):DeviceIdentity {const value=JSON.parse(readFileSync(path,'utf8')) as DeviceIdentity;validateIdentity(value);return value;}
