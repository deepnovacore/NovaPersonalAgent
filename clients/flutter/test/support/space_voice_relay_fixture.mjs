// Live Space voice fixture: a real relay with media enabled and the real Host
// SpaceVoiceController over relay media legs. Only the Host voice port (the
// provider) is fake. All state is synthetic and in memory.
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';

const relayRoot = process.env.NOVA_RELAY_BUILD_ROOT;
const runtimeRoot = process.env.NOVA_RUNTIME_BUILD_ROOT;
if (!relayRoot || !runtimeRoot) throw Error('compiled runtime and relay roots required');
const {RelayServer} = await import(pathToFileURL(`${relayRoot}/server.js`));
const {RelayClient} = await import(pathToFileURL(`${relayRoot}/client.js`));
const {generateDeviceIdentity, spaceId, signControl} = await import(pathToFileURL(`${relayRoot}/crypto.js`));
const {SpaceVoiceController} = await import(pathToFileURL(`${runtimeRoot}/space-host/voice.js`));
const {AudioOwnerArbiter} = await import(pathToFileURL(`${runtimeRoot}/space-host/audio-owner.js`));

const BOOT = 'voice-fixture-bootstrap-token-32';
const relay = new RelayServer({securityPath: ':memory:', mailboxPath: ':memory:', bootstrapToken: BOOT, bind: '127.0.0.1', port: 0,
  requestsPerMinute: 10000, globalRequestsPerMinute: 20000, media: {enabled: true}});
const url = await relay.listen();
const client = (space, identity) => new RelayClient({url, space, device: identity.device, signChallenge: c => signControl({v: 1, purpose: 'relay-login',
  challengeId: c.id, nonce: c.nonce, space: c.space, device: c.device, epoch: c.epoch, expiresAt: c.expiresAt}, identity.signingPrivateKey)});
const hostId = await generateDeviceIdentity(), phoneId = await generateDeviceIdentity(), space = spaceId(hostId.signingPublicKey);
const h = client(space, hostId), p = client(space, phoneId);
const publicHost = {device: hostId.device, signingPublicKey: hostId.signingPublicKey, encryptionPublicKey: hostId.encryptionPublicKey};
await h.createSpace({space, host: publicHost, proof: await signControl({v: 1, purpose: 'space-create', space, host: publicHost}, hostId.signingPrivateKey)}, BOOT);
const invite = await h.createInvitation();
const pair = {v: 1, purpose: 'pair-request', invitationId: invite.id, secret: invite.secret, device: phoneId.device,
  signingPublicKey: phoneId.signingPublicKey, encryptionPublicKey: phoneId.encryptionPublicKey, business_versions: [1]};
const request = await p.requestPairing({...pair, proof: await signControl(pair, phoneId.signingPrivateKey)});
await h.confirmPairing(request.id, 'confirm-' + request.id);
await p.capabilities(); // logs the phone in
const phoneSession = () => p.session;

const contentKey = randomBytes(32), events = [], audio = [], receipts = [];
const arbiter = new AudioOwnerArbiter();
let voiceId = null;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const voice = new SpaceVoiceController({
  space, epoch: 1, hostDevice: hostId.device, contentKey, policy: () => 'owner', owner: () => phoneId.device,
  host: {
    arbiter,
    requireChat: id => { if (id !== 'chat:main') throw Error('conversation_read_only'); },
    voiceConversationId: () => voiceId,
    // A slow provider start: the Client must not go active (or send mic audio) before it completes.
    startVoice: async id => { events.push(`starting:${id}`); await new Promise(resolve => setTimeout(resolve, 400)); events.push(`start:${id}`); voiceId = id; },
    stopVoice: async id => { events.push(`stop:${id}`); voiceId = null; },
    sendAudio: async (_id, pcm) => { audio.push(pcm.length); },
    receipts: () => ({
      playbackStarted: (u, e) => { receipts.push(`started:${u}:${e}`); return true; },
      playbackDone: (u, e, ms) => { receipts.push(`done:${u}:${e}:${ms}`); return true; },
      playbackStopped: async (u, e, ms) => { receipts.push(`stopped:${u}:${e}:${ms}`); return true; },
      playbackCleared: (u, e, ms) => { receipts.push(`cleared:${u}:${e}:${ms}`); return true; },
    }),
    setRemoteVoice: id => { events.push(`remote:${id}`); },
  },
  media: {capabilities: () => h.capabilities(), reserve: (session, to, ttlMs) => h.reserveMedia(session, to, ttlMs), connect: session => h.connectMedia(session)},
  notify: async (to, body) => { emit({event: 'notify', to, body}); },
  member: device => device === phoneId.device,
  onError: error => console.error(error),
});

async function intent(payload) {
  if (payload.kind === 'voice.start') {
    try {
      const started = await voice.begin(phoneId.device, payload);
      try { await started.call.prepare(); } catch (error) { await started.call.end(started.call.endReason.value ?? 'host_error'); throw error; }
      return {type: 'receipt', op_id: payload.op_id, status: 'accepted', voice: started.accept};
    } catch (error) {
      return {type: 'receipt', op_id: payload.op_id, status: 'rejected', error: error instanceof Error ? error.message : 'invalid_intent'};
    }
  }
  if (payload.kind === 'voice.stop') {
    await voice.stop(phoneId.device, payload.input.op_id);
    return {type: 'receipt', op_id: payload.op_id, status: 'accepted'};
  }
  return {type: 'receipt', op_id: payload.op_id, status: 'rejected', error: 'unsupported'};
}

const commands = {
  intent: ({payload}) => intent(payload),
  downlink: ({utterance, epoch, bytes}) => {
    voice.sink.onAudioFrame({utterance_id: utterance, generation_epoch: epoch, sequence: 0, pcm: new Uint8Array(bytes)});
    voice.sink.onAudioTerminal(utterance, epoch);
    return {};
  },
  state: () => ({events, audio, receipts, owner: arbiter.current != null}),
  renew: async () => { await p.login(); return {token: phoneSession().token, expires_at: phoneSession().expiresAt}; },
};

emit({ready: {relay: url, space, host: hostId.device, phone: phoneId.device, epoch: 1, content_key: contentKey.toString('base64url'),
  token: phoneSession().token, expires_at: phoneSession().expiresAt}});
for await (const line of createInterface({input: process.stdin})) {
  const message = JSON.parse(line);
  try { emit({id: message.id, result: await commands[message.method](message)}); }
  catch (error) { emit({id: message.id, error: error instanceof Error ? error.message : String(error)}); }
}
await voice.closeAll('host_closed');
h.stop(); p.stop();
await relay.close();
