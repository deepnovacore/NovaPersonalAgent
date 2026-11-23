import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import type {PlaybackFrame} from '../realtime/playback.js';
import type {AudioOwnerArbiter} from './audio-owner.js';
import {AUDIO_PREFIX_BYTES,decodeAudio,decodeControl,deriveCallKeys,encodeAudio,encodeControl,FRAME_AUDIO,FRAME_CONTROL,FRAME_HEADER_BYTES,FRAME_KEEPALIVE,FRAME_TAG_BYTES,FrameReceiver,FrameSender,generateEphemeral,startHash,type Ephemeral} from './voice-crypto.js';

/** Host side of Space voice (docs/design/space-voice.md §§2–5). All call state is volatile. */
export type VoicePolicy='off'|'owner'|'members';
export const VOICE_CODEC='pcm16',VOICE_FRAME_MS=40;
/** 40 ms of 24 kHz mono PCM16. */
export const DOWNLINK_PACKET_BYTES=1920;
const DOWNLINK_BYTES_PER_MS=48;
/** Uplink is 16 kHz mono PCM16. The mic backlog toward the provider is bounded (§5). */
const UPLINK_BYTES_PER_MS=32;
/** Largest sealed audio frame either direction sends at 40 ms (§2, §3): a relay must carry it. */
export const VOICE_MAX_AUDIO_FRAME_BYTES=FRAME_HEADER_BYTES+AUDIO_PREFIX_BYTES+Math.max(DOWNLINK_PACKET_BYTES,UPLINK_BYTES_PER_MS*VOICE_FRAME_MS)+FRAME_TAG_BYTES;
export const UPLINK_MAX_QUEUED_MS=500,UPLINK_MAX_QUEUED_FRAMES=16;
export const VOICE_CAPABILITY='voice.v1';
/** Best-effort sends: a lost keepalive, clear or goodbye is covered by leases, deadlines and relay teardown. */
const ignore=():void=>undefined;

export interface VoiceReceipts {
 playbackStarted(utteranceId:string,generationEpoch:number):boolean;
 playbackDone(utteranceId:string,generationEpoch:number,playedMs:number|null):boolean;
 playbackStopped(utteranceId:string,generationEpoch:number,playedMs:number|null):Promise<boolean>;
 playbackCleared(utteranceId:string,generationEpoch:number,playedMs:number|null):boolean;
}
export interface SpaceVoiceHostPort {
 readonly arbiter:AudioOwnerArbiter;
 /** Same rule as chat.send: only chat/topic conversations in chat mode. Throws a code. */
 requireChat(conversationId:string):void;
 /** Host voice owner other than this module (desktop orb, legacy paths); null when free. */
 voiceConversationId():string|null;
 startVoice(conversationId:string):Promise<void>;
 stopVoice(conversationId:string):Promise<void>;
 sendAudio(conversationId:string,pcm:Uint8Array):Promise<void>;
 receipts():VoiceReceipts|undefined;
 /** Scoped background-presentation exemption for the call's conversation (approved decision 5). */
 setRemoteVoice(conversationId:string|null):void;
}
export interface VoiceMediaSocket {send(frame:Uint8Array):Promise<void>;onFrame(listener:(frame:Uint8Array)=>void):void;onClose(listener:(reason:string)=>void):void;close():void}
export interface SpaceVoiceMedia {
 capabilities():Promise<{media:{codecs:string[];maxKbpsPerDirection:number;maxFrameBytes?:number}|null}>;
 reserve(session:string,client:string,ttlMs:number):Promise<unknown>;
 connect(session:string):Promise<VoiceMediaSocket>;
}
export interface SpaceVoiceOptions {
 space:string;epoch:number;hostDevice:string;contentKey:Uint8Array;
 policy:()=>VoicePolicy;owner:()=>string|undefined;
 host:SpaceVoiceHostPort;media:SpaceVoiceMedia;
 /** Best-effort signed stream message to a Client (voice.accept / voice.ended). */
 notify:(to:string,body:Record<string,unknown>)=>Promise<void>;
 onAvailabilityChanged?:()=>void;
 onError?:(error:unknown)=>void;
 /** Whether the device is still a paired, non-revoked member; re-checked at provider admission. */
 member?:(device:string)=>boolean;
 now?:()=>number;
 joinTimeoutMs?:number;
 /** A single provider sendAudio pending this long ends the call; teardown waits at most this long for it. */
 providerStallMs?:number;idleMs?:number;keepaliveMs?:number;leadMs?:number;paceFactor?:number;tickMs?:number;
 maxSessionMinutes?:number;maxQueuedAudioMs?:number;
}
const b64=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const voiceStartSchema=z.object({
 conversation_id:z.string().min(1).max(128),voice_mode:z.string().max(32).optional(),eph:b64,nonce:b64,
 offers:z.object({codecs:z.array(z.string().max(32)).min(1).max(8),frame_ms:z.array(z.number().int().positive().max(1000)).min(1).max(8)}).strict(),
 deadline:z.number().int().nonnegative(),
}).strict();
export const voiceStopSchema=z.object({op_id:z.string().min(1).max(128)}).strict();
export interface VoiceAccept {type:'voice.accept';op_id:string;start_hash:string;session:string;eph:string;selected:{codec:string;frame_ms:number};call_deadline:number}

type State='joining'|'active'|'ending'|'ended';
interface Generation {gen:number;utterance_id:string;generation_epoch:number;nativeSeq:number;sampleOffset:number;fenced:boolean}
type Outbound={kind:'audio';gen:number;plaintext:Buffer;ms:number}|{kind:'control';gen:number|null;body:Record<string,unknown>};

/** Authorization order from §4: policy (with owner rules), chat-only conversation, chat voice mode. */
export function authorizeVoice(input:{policy:VoicePolicy;owner:string|undefined;sender:string;conversationId:string;voiceMode:string|undefined;requireChat:(id:string)=>void}):void{
 if(input.policy==='off')throw Error('voice_disabled');
 if(input.policy==='owner'){if(input.owner===undefined)throw Error('owner_unassigned');if(input.owner!==input.sender)throw Error('owner_required')}
 input.requireChat(input.conversationId);
 if(input.voiceMode!==undefined&&input.voiceMode!=='chat')throw Error('voice_mode_unavailable');
}

export class SpaceVoiceCall {
 state:State='joining';
 readonly started:number;
 #socket:VoiceMediaSocket|undefined;#sender:FrameSender;#receiver:FrameReceiver;
 #lease:number|undefined;#voiceStarted=false;#remoteSet=false;
 #timers=new Set<ReturnType<typeof setTimeout>>();#lastHeard:number;
 #queue:Outbound[]=[];#queuedMs=0;#budgetMs:number;#budgetAt:number;#pumping=false;#pace:ReturnType<typeof setTimeout>|undefined;
 #gens=new Map<string,Generation>();#nextGen=0;#startSent=new Set<number>();
 #uplink:Buffer[]=[];#uplinkBytes=0;#uplinkPump:Promise<void>|undefined;
 #starting:Promise<void>|undefined;
 #ending:Promise<void>|undefined;#endSignal:Promise<void>;#signalEnd!:()=>void;
 constructor(readonly controller:SpaceVoiceController,readonly device:string,readonly opId:string,readonly conversationId:string,readonly voiceMode:string|undefined,readonly session:string,readonly hash:Buffer,keys:{up:Buffer;down:Buffer},readonly endReason:{value?:string}={}){
  this.#endSignal=new Promise(resolve=>{this.#signalEnd=resolve});
  this.#sender=new FrameSender(keys.down);this.#receiver=new FrameReceiver(keys.up);keys.up.fill(0);keys.down.fill(0);
  this.started=controller.now();this.#lastHeard=this.started;this.#budgetMs=controller.timing.leadMs;this.#budgetAt=this.started;
 }
 set lease(value:number){this.#lease=value}
 get lease():number|undefined{return this.#lease}

 /**
  * Reserve the relay session and join the Host leg. The accept is published only after this
  * resolves, so a fast Client never meets an unknown session (§1). Throws the end reason.
  */
 async prepare():Promise<void>{
  const c=this.controller;
  this.#timer(()=>{if(this.state==='joining')void this.end('join_timeout')},c.timing.joinTimeoutMs);
  const ended=this.#endSignal.then(()=>undefined);
  try{
   await Promise.race([c.options.media.reserve(this.session,this.device,c.timing.maxSessionMinutes*60_000),ended]);
   if(this.state!=='joining')throw Error(this.endReason.value??'voice_ended');
   const connecting=c.options.media.connect(this.session);
   const socket=await Promise.race([connecting,ended]);
   if(!socket||this.state!=='joining'){void connecting.then(late=>{late.close()},ignore);throw Error(this.endReason.value??'voice_ended')}
   this.#socket=socket;
   socket.onClose(()=>{void this.end('transport_lost')});
   socket.onFrame(frame=>{void this.#receive(frame).catch(error=>{c.options.onError?.(error);void this.end('protocol_error')})});
  }catch(error){
   if(this.state==='joining'){c.options.onError?.(error);await this.end('relay_media_unavailable')}
   throw Error(this.endReason.value??'relay_media_unavailable');
  }
 }

 async #receive(frame:Uint8Array):Promise<void>{
  if(this.state==='ending'||this.state==='ended')return;
  let opened;
  try{opened=this.#receiver.open(frame)}catch(error){if(error instanceof Error&&error.message==='voice_crypto_failed')await this.end('voice_crypto_failed');return}
  if(!opened)return;
  this.#lastHeard=this.controller.now();
  if(this.state==='joining'){
   if(opened.type!==FRAME_CONTROL)return;
   const body=decodeControl(opened.plaintext);
   if(body.type!=='ready'||body.start_hash!==this.hash.toString('base64url')){await this.end('protocol_error');return}
   // The Host's ready is the Client's go signal: it is sent only once the provider is up.
   await this.#activate();return;
  }
  if(opened.type===FRAME_KEEPALIVE)return;
  if(opened.type===FRAME_AUDIO){
   if(this.state!=='active')return;
   const pcm=Buffer.from(decodeAudio(opened.plaintext).pcm);
   this.#uplink.push(pcm);this.#uplinkBytes+=pcm.length;
   // Realtime: shed the oldest mic audio rather than build latency behind a slow provider.
   while(this.#uplink.length>UPLINK_MAX_QUEUED_FRAMES||this.#uplinkBytes>UPLINK_MAX_QUEUED_MS*UPLINK_BYTES_PER_MS){this.#uplinkBytes-=this.#uplink.shift()!.length}
   this.#uplinkPump??=this.#pumpUplink().finally(()=>{this.#uplinkPump=undefined});
   return;
  }
  await this.#control(decodeControl(opened.plaintext));
 }
 get uplinkQueuedMs():number{return this.#uplinkBytes/UPLINK_BYTES_PER_MS}
 async #pumpUplink():Promise<void>{
  const c=this.controller,host=c.options.host;
  while(this.state==='active'&&this.#uplink.length){
   const pcm=this.#uplink.shift()!;this.#uplinkBytes-=pcm.length;
   let stalled:ReturnType<typeof setTimeout>|undefined;
   const stall=new Promise<'stalled'>(resolve=>{stalled=setTimeout(()=>resolve('stalled'),c.timing.providerStallMs);stalled.unref?.()});
   try{
    const sent=host.sendAudio(this.conversationId,pcm).then(()=>'sent' as const,(error:unknown)=>{c.options.onError?.(error);return 'sent' as const});
    if(await Promise.race([sent,stall])==='stalled'){void this.end('provider_stalled');return}
   }finally{clearTimeout(stalled)}
  }
 }
 /** Only after an authenticated ready does provider work start (§4 step 4). */
 async #activate():Promise<void>{
  const host=this.controller.options.host;
  if(this.state!=='joining'||this.#lease===undefined||!host.arbiter.owns(this.#lease))return;
  try{
   // Membership, policy, chat-only and mode may have changed during the join: re-check at admission.
   this.controller.authorize(this);
   host.setRemoteVoice(this.conversationId);this.#remoteSet=true;
   this.#starting=host.startVoice(this.conversationId).then(()=>{this.#voiceStarted=true});
   await this.#starting;
  }catch(error){this.controller.options.onError?.(error);await this.end(error instanceof Error&&/^[a-z_]{1,64}$/.test(error.message)?error.message:'voice_unavailable');return}
  if(this.state!=='joining'){return}
  this.state='active';
  try{await this.#send(FRAME_CONTROL,encodeControl({type:'ready',start_hash:this.hash.toString('base64url')}))}
  catch{await this.end('transport_lost');return}
  const keepalive=()=>{if(this.state!=='active')return;void this.#send(FRAME_KEEPALIVE,new Uint8Array(0)).catch(ignore);
   if(this.controller.now()-this.#lastHeard>=this.controller.timing.idleMs){void this.end('idle');return}
   this.#timer(keepalive,this.controller.timing.keepaliveMs)};
  this.#timer(keepalive,this.controller.timing.keepaliveMs);
  this.#timer(()=>{void this.end('max_duration')},this.controller.timing.maxSessionMinutes*60_000);
 }
 async #control(body:Record<string,unknown>):Promise<void>{
  if(body.type==='end'){await this.end('stopped');return}
  const receipts=this.controller.options.host.receipts();
  const utterance=typeof body.utterance_id==='string'?body.utterance_id:undefined,epoch=typeof body.generation_epoch==='number'?body.generation_epoch:undefined;
  if(!receipts||utterance===undefined||epoch===undefined||![...this.#gens.values()].some(g=>g.utterance_id===utterance&&g.generation_epoch===epoch))return;
  const played=typeof body.played_ms==='number'&&Number.isSafeInteger(body.played_ms)&&body.played_ms>=0?body.played_ms:null;
  if(body.type==='playback.started')receipts.playbackStarted(utterance,epoch);
  else if(body.type==='playback.done')receipts.playbackDone(utterance,epoch,played);
  else if(body.type==='playback.cleared')receipts.playbackCleared(utterance,epoch,played);
  // A loss fence (§3) is an interrupted playback truncated at the confirmed contiguous prefix.
  else if(body.type==='playback.stopped')await receipts.playbackStopped(utterance,epoch,played);
 }

 // ---- downlink (SpaceVoiceBridge sink) ----
 audioFrame(frame:PlaybackFrame):void{
  if(this.state!=='active')return;
  const key=`${frame.generation_epoch}:${frame.utterance_id}`;let gen=this.#gens.get(key);
  if(!gen){
   gen={gen:this.#nextGen++&0xffff,utterance_id:frame.utterance_id,generation_epoch:frame.generation_epoch,nativeSeq:0,sampleOffset:0,fenced:false};
   this.#gens.set(key,gen);
   this.#startSent.delete(gen.gen);
   while(this.#gens.size>64){const oldest=this.#gens.keys().next().value!;this.#startSent.delete(this.#gens.get(oldest)!.gen);this.#gens.delete(oldest)}
   this.#enqueue({kind:'control',gen:gen.gen,body:{type:'playback.start',gen:gen.gen,utterance_id:gen.utterance_id,generation_epoch:gen.generation_epoch}});
  }
  if(gen.fenced)return;
  // Re-chunk Host frames (up to 64 KiB) into ≤40 ms packets with contiguous native sequence numbers.
  for(let offset=0;offset<frame.pcm.length;offset+=DOWNLINK_PACKET_BYTES){
   const pcm=frame.pcm.subarray(offset,Math.min(frame.pcm.length,offset+DOWNLINK_PACKET_BYTES));
   const plaintext=encodeAudio({gen:gen.gen,nativeSeq:gen.nativeSeq++,sampleOffset:gen.sampleOffset,pcm});
   gen.sampleOffset+=pcm.length/2;
   const ms=pcm.length/DOWNLINK_BYTES_PER_MS;
   this.#enqueue({kind:'audio',gen:gen.gen,plaintext,ms});
  }
 }
 audioClear(utteranceId:string,generationEpoch:number):void{
  if(this.state!=='active')return;
  const gen=this.#gens.get(`${generationEpoch}:${utteranceId}`);
  if(gen){
   gen.fenced=true;this.#drop(gen.gen);
   // Dropped before playback.start left the Host: the Client never heard of it, so the Host
   // records the clear itself (nothing was played) and sends nothing (§3).
   if(!this.#startSent.has(gen.gen)){this.controller.options.host.receipts()?.playbackCleared(utteranceId,generationEpoch,0);return}
  }
  // A clear overtakes queued (unwritten) audio; bytes already written cannot be recalled (§5).
  void this.#send(FRAME_CONTROL,encodeControl({type:'playback.clear',utterance_id:utteranceId,generation_epoch:generationEpoch})).catch(ignore);
 }
 audioTerminal(utteranceId:string,generationEpoch:number):void{
  if(this.state!=='active')return;
  const gen=this.#gens.get(`${generationEpoch}:${utteranceId}`);
  if(!gen||gen.fenced)return;
  // The relay may deliver control ahead of queued audio, so terminal names its end position:
  // the Client finalizes only after the contiguous prefix up to it, else applies the loss fence (§3).
  this.#enqueue({kind:'control',gen:gen.gen,body:{type:'playback.terminal',utterance_id:utteranceId,generation_epoch:generationEpoch,
   last_native_seq:gen.nativeSeq>0?gen.nativeSeq-1:null,end_offset:gen.sampleOffset}});
 }
 audioAlert(utteranceId:string|null,generationEpoch:number|null):void{
  if(this.state!=='active')return;
  void this.#send(FRAME_CONTROL,encodeControl({type:'playback.alert',utterance_id:utteranceId,generation_epoch:generationEpoch})).catch(ignore);
 }
 get queuedAudioMs():number{return this.#queuedMs}
 #enqueue(item:Outbound):void{
  if(item.kind==='audio'){this.#queuedMs+=item.ms;if(this.#queuedMs>this.controller.timing.maxQueuedAudioMs){void this.end('downlink_overflow');return}}
  this.#queue.push(item);this.#schedule(0);
 }
 #drop(gen:number):void{this.#queue=this.#queue.filter(item=>{if(item.gen!==gen)return true;if(item.kind==='audio')this.#queuedMs-=item.ms;return false})}
 #schedule(delay:number):void{if(this.#pace||this.#pumping)return;this.#pace=setTimeout(()=>{this.#pace=undefined;void this.#pump()},delay);this.#pace.unref?.()}
 /** ≤ paceFactor × realtime with ≤ leadMs lead: a token budget in milliseconds of audio. */
 async #pump():Promise<void>{
  if(this.state!=='active'||this.#pumping)return;
  this.#pumping=true;
  try{
   while(this.state==='active'&&this.#queue.length){
    const now=this.controller.now(),t=this.controller.timing;
    this.#budgetMs=Math.min(t.leadMs,this.#budgetMs+(now-this.#budgetAt)*t.paceFactor);this.#budgetAt=now;
    const item=this.#queue[0]!;
    if(item.kind==='audio'&&this.#budgetMs<item.ms)break;
    this.#queue.shift();
    // Once shifted it is written (or the socket fails): the Client may now know this generation.
    if(item.kind==='control'&&item.body.type==='playback.start'&&item.gen!==null)this.#startSent.add(item.gen);
    if(item.kind==='audio'){this.#budgetMs-=item.ms;this.#queuedMs-=item.ms;await this.#send(FRAME_AUDIO,item.plaintext)}
    else await this.#send(FRAME_CONTROL,encodeControl(item.body));
   }
  }catch{void this.end('transport_lost')}
  finally{this.#pumping=false}
  if(this.state==='active'&&this.#queue.length)this.#schedule(this.controller.timing.tickMs);
 }
 async #send(type:number,plaintext:Uint8Array):Promise<void>{
  const socket=this.#socket;if(!socket)throw Error('media_closed');
  // The sequence number is consumed even if the write then fails.
  const frame=this.#sender.seal(type,plaintext);await socket.send(frame);
 }

 /** Fence first (state, queues, sink), then clean up provider, owner, socket and keys (§4 teardown). */
 end(reason:string):Promise<void>{
  if(this.#ending)return this.#ending;
  this.endReason.value=reason;
  const wasActive=this.state==='active';
  this.state='ending';this.#signalEnd();this.#uplink=[];this.#uplinkBytes=0;
  for(const timer of this.#timers)clearTimeout(timer);this.#timers.clear();
  if(this.#pace)clearTimeout(this.#pace);this.#pace=undefined;this.#queue=[];this.#queuedMs=0;
  this.#ending=(async()=>{
   const c=this.controller,host=c.options.host;
   if(this.#socket&&wasActive)await this.#send(FRAME_CONTROL,encodeControl({type:'voice.ended',reason})).catch(ignore);
   // A start still in flight is awaited, so a provider that comes up after the fence is stopped too.
   await this.#starting?.catch(ignore);
   if(this.#voiceStarted&&this.#lease!==undefined&&(host.arbiter.owns(this.#lease)||host.arbiter.current===null)){
    // Never wait indefinitely on a stalled provider write.
    if(this.#uplinkPump){let timer:ReturnType<typeof setTimeout>|undefined;await Promise.race([this.#uplinkPump.catch(ignore),new Promise<void>(resolve=>{timer=setTimeout(resolve,c.timing.providerStallMs);timer.unref?.()})]);clearTimeout(timer)}
    await host.stopVoice(this.conversationId).catch(error=>c.options.onError?.(error));
   }
   if(this.#remoteSet)host.setRemoteVoice(null);
   if(this.#lease!==undefined)host.arbiter.release(this.#lease);
   try{this.#socket?.close()}catch{ /* closing an already-closed socket */ }
   this.#sender.destroy();this.#receiver.destroy();
   this.state='ended';
   c.forget(this);
   await c.options.notify(this.device,{type:'voice.ended',op_id:this.opId,session:this.session,reason}).catch(ignore);
  })();
  return this.#ending;
 }
 #timer(run:()=>void,ms:number):void{const timer=setTimeout(()=>{this.#timers.delete(timer);run()},ms);timer.unref?.();this.#timers.add(timer)}
}

export class SpaceVoiceController {
 readonly timing:{joinTimeoutMs:number;idleMs:number;keepaliveMs:number;leadMs:number;paceFactor:number;tickMs:number;maxSessionMinutes:number;maxQueuedAudioMs:number;providerStallMs:number};
 #calls=new Map<string,SpaceVoiceCall>();#media:{codecs:string[];maxKbpsPerDirection:number}|null|undefined;#closed=false;
 constructor(readonly options:SpaceVoiceOptions){
  this.timing={joinTimeoutMs:options.joinTimeoutMs??15_000,idleMs:options.idleMs??20_000,keepaliveMs:options.keepaliveMs??5_000,leadMs:options.leadMs??1_000,
   paceFactor:options.paceFactor??1.25,tickMs:options.tickMs??20,maxSessionMinutes:options.maxSessionMinutes??60,maxQueuedAudioMs:options.maxQueuedAudioMs??120_000,providerStallMs:options.providerStallMs??2_000};
 }
 now():number{return this.options.now?.()??Date.now()}
 /** Capability hint for one recipient: only hides or shows the call button (§8). */
 available(device:string):boolean{
  if(this.#closed||!this.#media?.codecs.includes(VOICE_CODEC))return false;
  const policy=this.options.policy(),owner=this.options.owner();
  return policy==='members'||policy==='owner'&&owner!==undefined&&owner===device;
 }
 async refreshCapability():Promise<void>{
  const before=JSON.stringify(this.#media??null);
  try{
   const media=(await this.options.media.capabilities()).media;
   // pcm16 is advertised and admitted only on a relay that can carry its largest packet.
   this.#media=media&&(media.maxFrameBytes??0)>=VOICE_MAX_AUDIO_FRAME_BYTES?media:null;
  }catch(error){this.#media=null;this.options.onError?.(error)}
  if(JSON.stringify(this.#media??null)!==before)this.options.onAvailabilityChanged?.();
 }
 call(device:string):SpaceVoiceCall|undefined{return this.#calls.get(device)}
 /** Full §4 authorization for a call, used again at provider admission. Throws a stable code. */
 authorize(call:{device:string;conversationId:string;voiceMode:string|undefined}):void{
  if(this.#closed)throw Error('voice_unavailable');
  if(this.options.member&&!this.options.member(call.device))throw Error('sender_not_paired');
  authorizeVoice({policy:this.options.policy(),owner:this.options.owner(),sender:call.device,conversationId:call.conversationId,voiceMode:call.voiceMode,requireChat:id=>this.options.host.requireChat(id)});
 }
 /**
  * Authorize, reserve the owner slot and derive keys. `raw` is the exact decrypted intent the
  * Client sealed; its canonical hash binds the accept. Throws a stable code on refusal.
  */
 async begin(sender:string,raw:Record<string,unknown>,now=this.now()):Promise<{call:SpaceVoiceCall;accept:VoiceAccept}>{
  if(this.#closed)throw Error('voice_unavailable');
  const parsed=voiceStartSchema.safeParse(raw.input);if(!parsed.success||typeof raw.op_id!=='string')throw Error('invalid_voice_start');const opId=raw.op_id,input=parsed.data;
  if(typeof raw.expires_at!=='number'||typeof raw.created_at!=='number'||raw.expires_at-raw.created_at>15_000||input.deadline>raw.expires_at)throw Error('voice_deadline_required');
  if(raw.expires_at<=now)throw Error('expired');
  const host=this.options.host;
  this.authorize({device:sender,conversationId:input.conversation_id,voiceMode:input.voice_mode});
  if(!input.offers.codecs.includes(VOICE_CODEC)||!input.offers.frame_ms.includes(VOICE_FRAME_MS))throw Error('codec_unavailable');
  if(this.#media===undefined)await this.refreshCapability();
  if(!this.#media?.codecs.includes(VOICE_CODEC))throw Error('relay_media_unavailable');
  return host.arbiter.serial(async()=>{
   // A device's second start replaces only its own call.
   await this.#calls.get(sender)?.end('replaced');
   if(host.arbiter.current||host.voiceConversationId()!==null)throw Error('voice_active');
   const own:Ephemeral=generateEphemeral(),session=randomBytes(18).toString('base64url');
   const hash=startHash({start:raw,space:this.options.space,epoch:this.options.epoch,client:sender,host:this.options.hostDevice});
   const keys=deriveCallKeys({own,peer:input.eph,contentKey:this.options.contentKey,startHash:hash,ephC:input.eph,ephH:own.publicKey,session,codec:VOICE_CODEC,frameMs:VOICE_FRAME_MS});
   const call=new SpaceVoiceCall(this,sender,opId,input.conversation_id,input.voice_mode,session,hash,keys);
   call.lease=host.arbiter.claim(`space:${sender}`,reason=>call.end(reason));
   this.#calls.set(sender,call);
   return {call,accept:{type:'voice.accept',op_id:opId,start_hash:hash.toString('base64url'),session,eph:own.publicKey,selected:{codec:VOICE_CODEC,frame_ms:VOICE_FRAME_MS},call_deadline:now+this.timing.maxSessionMinutes*60_000}};
  });
 }
 /** voice.stop: ends the sender's call only if it is the one started by `opId`. */
 async stop(sender:string,opId:string):Promise<boolean>{const call=this.#calls.get(sender);if(call?.opId!==opId)return false;await call.end('stopped');return true}
 /** Policy or owner changes re-evaluate every active call. */
 async policyChanged():Promise<void>{
  const policy=this.options.policy(),owner=this.options.owner();
  await Promise.all([...this.#calls.values()].filter(call=>policy==='off'||policy==='owner'&&owner!==call.device).map(call=>call.end('policy_changed')));
  this.options.onAvailabilityChanged?.();
 }
 async closeAll(reason:string):Promise<void>{this.#closed=true;await Promise.all([...this.#calls.values()].map(call=>call.end(reason)))}
 forget(call:SpaceVoiceCall):void{if(this.#calls.get(call.device)===call)this.#calls.delete(call.device)}
 /** SpaceVoiceBridge: the audio sink the Host routes to while a Space call owns audio. */
 readonly sink={
  onAudioFrame:(frame:PlaybackFrame)=>{this.#owning()?.audioFrame(frame)},
  onAudioClear:(utteranceId:string,generationEpoch:number)=>{this.#owning()?.audioClear(utteranceId,generationEpoch)},
  onAudioAlert:(utteranceId:string|null,generationEpoch:number|null)=>{this.#owning()?.audioAlert(utteranceId,generationEpoch)},
  onAudioTerminal:(utteranceId:string,generationEpoch:number)=>{this.#owning()?.audioTerminal(utteranceId,generationEpoch)},
 };
 #owning():SpaceVoiceCall|undefined{const device=this.options.host.arbiter.spaceDevice;const call=device===undefined?undefined:this.#calls.get(device);return call?.lease !== undefined&&this.options.host.arbiter.owns(call.lease)?call:undefined}
}
