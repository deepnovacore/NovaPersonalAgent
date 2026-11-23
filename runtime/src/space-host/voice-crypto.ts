import {createCipheriv,createDecipheriv,createHash,createPrivateKey,createPublicKey,diffieHellman,generateKeyPairSync,hkdfSync,timingSafeEqual,type KeyObject} from 'node:crypto';

/**
 * Space voice call crypto (docs/design/space-voice.md §2). Pure and volatile: nothing here is
 * persisted. Byte-for-byte compatible with clients/flutter/lib/space/space_voice_crypto.dart;
 * tests/fixtures/space-voice/v1/vectors.json pins both.
 */
export const VOICE_PROTOCOL='nova-voice/v1';
export const FRAME_AUDIO=1,FRAME_CONTROL=2,FRAME_KEEPALIVE=3;
export const FRAME_HEADER_BYTES=12,FRAME_TAG_BYTES=16,FRAME_MIN_BYTES=FRAME_HEADER_BYTES+FRAME_TAG_BYTES,FRAME_MAX_BYTES=4096;
export const AUDIO_PREFIX_BYTES=10,CONTROL_MAX_BYTES=2048;
export const MAX_SEQ=(1n<<48n)-1n;
export const REPLAY_WINDOW=128n;
const PKCS8_X25519=Buffer.from('302e020100300506032b656e04220420','hex');

export class VoiceCryptoError extends Error {constructor(readonly code:string){super(code);this.name='VoiceCryptoError'}}

/** RFC 8785 subset: objects with sorted keys, arrays, strings, booleans, null and safe integers. */
export function canonicalJson(value:unknown):string{
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'){if(!Number.isSafeInteger(value))throw new VoiceCryptoError('canonical_number');return String(value)}
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 if(typeof value==='object'){
  const entries=Object.entries(value as Record<string,unknown>).filter(([,v])=>v!==undefined);
  // JCS orders keys by UTF-16 code units, which is JavaScript's default string comparison.
  entries.sort(([a],[b])=>a<b?-1:a>b?1:0);
  return '{'+entries.map(([k,v])=>JSON.stringify(k)+':'+canonicalJson(v)).join(',')+'}';
 }
 throw new VoiceCryptoError('canonical_type');
}
/** 4-byte big-endian length prefix, then the bytes. */
export function lp(value:Uint8Array|string):Buffer{const bytes=typeof value==='string'?Buffer.from(value,'utf8'):Buffer.from(value);const length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);return Buffer.concat([length,bytes])}

/** Binds the exact decrypted voice.start payload to its Space, epoch and both device identities. */
export function startHash(input:{start:unknown;space:string;epoch:number;client:string;host:string}):Buffer{
 if(!Number.isSafeInteger(input.epoch)||input.epoch<1)throw new VoiceCryptoError('invalid_epoch');
 return createHash('sha256').update(Buffer.concat([lp(canonicalJson(input.start)),lp(input.space),lp(String(input.epoch)),lp(input.client),lp(input.host)])).digest();
}

export interface Ephemeral {readonly privateKey:KeyObject;readonly publicKey:string}
export function generateEphemeral():Ephemeral{const pair=generateKeyPairSync('x25519');return {privateKey:pair.privateKey,publicKey:String(pair.publicKey.export({format:'jwk'}).x)}}
/** Deterministic ephemeral for test vectors only. */
export function ephemeralFromSeed(seed:Uint8Array):Ephemeral{
 if(seed.length!==32)throw new VoiceCryptoError('invalid_seed');
 const privateKey=createPrivateKey({key:Buffer.concat([PKCS8_X25519,seed]),format:'der',type:'pkcs8'});
 return {privateKey,publicKey:String(createPublicKey(privateKey).export({format:'jwk'}).x)};
}
export function decodePublicKey(value:unknown):Buffer{
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))throw new VoiceCryptoError('invalid_public_key');
 const raw=Buffer.from(value,'base64url');if(raw.length!==32||raw.toString('base64url')!==value)throw new VoiceCryptoError('invalid_public_key');return raw;
}

export interface CallParams {startHash:Uint8Array;ephC:string;ephH:string;session:string;codec:string;frameMs:number}
export interface CallKeys {up:Buffer;down:Buffer}
/** X25519 → HKDF-SHA256 with the epoch content key as salt and every negotiated value in `info`. */
export function deriveCallKeys(input:{own:Ephemeral;peer:string;contentKey:Uint8Array}&CallParams):CallKeys{
 if(input.contentKey.length!==32)throw new VoiceCryptoError('invalid_content_key');
 if(input.startHash.length!==32)throw new VoiceCryptoError('invalid_start_hash');
 if(!Number.isSafeInteger(input.frameMs)||input.frameMs<1||input.frameMs>0xffff)throw new VoiceCryptoError('invalid_frame_ms');
 const peer=decodePublicKey(input.peer);
 let shared:Buffer;
 try{shared=diffieHellman({privateKey:input.own.privateKey,publicKey:createPublicKey({key:{kty:'OKP',crv:'X25519',x:peer.toString('base64url')},format:'jwk'})})}
 catch{throw new VoiceCryptoError('invalid_shared_secret')}
 if(shared.length!==32||timingSafeEqual(shared,Buffer.alloc(32)))throw new VoiceCryptoError('invalid_shared_secret');
 const frame=Buffer.alloc(2);frame.writeUInt16BE(input.frameMs);
 const info=(direction:'up'|'down')=>Buffer.concat([lp(VOICE_PROTOCOL),lp(input.startHash),lp(input.ephC),lp(input.ephH),lp(input.session),lp(input.codec),lp(frame),lp(direction)]);
 const key=(direction:'up'|'down')=>Buffer.from(hkdfSync('sha256',shared,input.contentKey,info(direction),32));
 const keys={up:key('up'),down:key('down')};shared.fill(0);return keys;
}

function header(type:number,seq:bigint):Buffer{
 if(seq<0n||seq>MAX_SEQ)throw new VoiceCryptoError('seq_exhausted');
 const value=Buffer.alloc(FRAME_HEADER_BYTES);value[0]=1;value[1]=type;value.writeBigUInt64BE(seq,4);return value;
}
function nonce(seq:bigint):Buffer{const value=Buffer.alloc(12);value.writeBigUInt64BE(seq,4);return value}
function validPlaintext(type:number,plaintext:Uint8Array):boolean{
 if(type===FRAME_KEEPALIVE)return plaintext.length===0;
 if(type===FRAME_AUDIO)return plaintext.length>=AUDIO_PREFIX_BYTES+2&&(plaintext.length-AUDIO_PREFIX_BYTES)%2===0;
 if(type===FRAME_CONTROL)return plaintext.length>=2&&plaintext.length<=CONTROL_MAX_BYTES;
 return false;
}
export function sealFrame(key:Uint8Array,type:number,seq:bigint,plaintext:Uint8Array):Buffer{
 if(key.length!==32)throw new VoiceCryptoError('invalid_key');
 if(!validPlaintext(type,plaintext))throw new VoiceCryptoError('invalid_plaintext');
 const head=header(type,seq),cipher=createCipheriv('aes-256-gcm',key,nonce(seq));cipher.setAAD(head);
 const body=Buffer.concat([cipher.update(plaintext),cipher.final()]),frame=Buffer.concat([head,body,cipher.getAuthTag()]);
 if(frame.length>FRAME_MAX_BYTES)throw new VoiceCryptoError('frame_too_large');return frame;
}
export interface OpenedFrame {type:number;seq:bigint;plaintext:Buffer}
/** Structural checks before decryption, then AES-256-GCM. Throws VoiceCryptoError. */
export function openFrame(key:Uint8Array,frame:Uint8Array):OpenedFrame{
 const value=parseHeader(frame);
 const raw=Buffer.from(frame),decipher=createDecipheriv('aes-256-gcm',key,nonce(value.seq));decipher.setAAD(raw.subarray(0,FRAME_HEADER_BYTES));decipher.setAuthTag(raw.subarray(raw.length-FRAME_TAG_BYTES));
 let plaintext:Buffer;
 try{plaintext=Buffer.concat([decipher.update(raw.subarray(FRAME_HEADER_BYTES,raw.length-FRAME_TAG_BYTES)),decipher.final()])}catch{throw new VoiceCryptoError('auth_failed')}
 if(!validPlaintext(value.type,plaintext))throw new VoiceCryptoError('invalid_plaintext');
 return {type:value.type,seq:value.seq,plaintext};
}
export function parseHeader(frame:Uint8Array):{type:number;seq:bigint}{
 if(frame.length<FRAME_MIN_BYTES||frame.length>FRAME_MAX_BYTES)throw new VoiceCryptoError('invalid_length');
 if(frame[0]!==1)throw new VoiceCryptoError('invalid_version');
 if(frame[1]!==FRAME_AUDIO&&frame[1]!==FRAME_CONTROL&&frame[1]!==FRAME_KEEPALIVE)throw new VoiceCryptoError('invalid_type');
 if(frame[2]!==0||frame[3]!==0)throw new VoiceCryptoError('invalid_flags');
 const seq=Buffer.from(frame.buffer,frame.byteOffset,frame.byteLength).readBigUInt64BE(4);
 if(seq>MAX_SEQ)throw new VoiceCryptoError('seq_exhausted');
 return {type:frame[1],seq};
}

/** One sender per direction: each sequence number is allocated exactly once, including for failed sends. */
export class FrameSender {
 #next=0n;readonly #key:Buffer;
 constructor(key:Uint8Array){this.#key=Buffer.from(key)}
 seal(type:number,plaintext:Uint8Array):Buffer{const seq=this.#next;if(seq>MAX_SEQ)throw new VoiceCryptoError('seq_exhausted');this.#next=seq+1n;return sealFrame(this.#key,type,seq,plaintext)}
 get next():bigint{return this.#next}
 destroy():void{this.#key.fill(0)}
}
/** Per-direction receive state; it advances only after a frame authenticates. */
export class FrameReceiver {
 #highest=-1n;#bitmap=0n;#failures=0;readonly #key:Buffer;
 constructor(key:Uint8Array,readonly maxConsecutiveFailures=8){this.#key=Buffer.from(key)}
 /** Returns null for a replayed/too-old frame; throws on structure or authentication failure. */
 open(frame:Uint8Array):OpenedFrame|null{
  let opened:OpenedFrame;
  try{
   const {seq}=parseHeader(frame);
   if(this.#seen(seq))return null;
   opened=openFrame(this.#key,frame);
  }catch(error){if(++this.#failures>this.maxConsecutiveFailures)throw new VoiceCryptoError('voice_crypto_failed');throw error}
  this.#failures=0;this.#accept(opened.seq);return opened;
 }
 #seen(seq:bigint):boolean{
  if(seq>this.#highest)return false;
  const offset=this.#highest-seq;if(offset>=REPLAY_WINDOW)return true;
  return ((this.#bitmap>>offset)&1n)===1n;
 }
 #accept(seq:bigint):void{
  if(seq>this.#highest){const shift=seq-this.#highest;this.#bitmap=shift>=REPLAY_WINDOW?1n:((this.#bitmap<<shift)|1n)&((1n<<REPLAY_WINDOW)-1n);this.#highest=seq}
  else this.#bitmap|=1n<<(this.#highest-seq);
 }
 destroy():void{this.#key.fill(0)}
}

export interface AudioPayload {gen:number;nativeSeq:number;sampleOffset:number;pcm:Uint8Array}
export function encodeAudio(value:AudioPayload):Buffer{
 if(!Number.isInteger(value.gen)||value.gen<0||value.gen>0xffff)throw new VoiceCryptoError('invalid_gen');
 const out=Buffer.alloc(AUDIO_PREFIX_BYTES);out.writeUInt16BE(value.gen,0);out.writeUInt32BE(value.nativeSeq,2);out.writeUInt32BE(value.sampleOffset>>>0,6);
 return Buffer.concat([out,Buffer.from(value.pcm)]);
}
export function decodeAudio(plaintext:Uint8Array):AudioPayload{
 const raw=Buffer.from(plaintext);if(raw.length<AUDIO_PREFIX_BYTES+2||(raw.length-AUDIO_PREFIX_BYTES)%2!==0)throw new VoiceCryptoError('invalid_plaintext');
 return {gen:raw.readUInt16BE(0),nativeSeq:raw.readUInt32BE(2),sampleOffset:raw.readUInt32BE(6),pcm:raw.subarray(AUDIO_PREFIX_BYTES)};
}
export function encodeControl(value:Record<string,unknown>):Buffer{const raw=Buffer.from(JSON.stringify(value),'utf8');if(raw.length<2||raw.length>CONTROL_MAX_BYTES)throw new VoiceCryptoError('invalid_plaintext');return raw}
export function decodeControl(plaintext:Uint8Array):Record<string,unknown>{
 let value:unknown;try{value=JSON.parse(Buffer.from(plaintext).toString('utf8'))}catch{throw new VoiceCryptoError('invalid_control')}
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof (value as {type?:unknown}).type!=='string')throw new VoiceCryptoError('invalid_control');
 return value as Record<string,unknown>;
}
