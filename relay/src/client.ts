import {WebSocket} from 'ws';
import type {RelayEnvelope, RelayPrincipal} from './protocol.js';
import type {MailboxPage, MailboxStatus} from './mailbox.js';
import type {LoginChallenge,Invitation,PairingRequest,DeviceRecord,PairingInput,SpaceRecord,DevicePublicIdentity} from './security.js';

export class RelayClientError extends Error {
  constructor(readonly code: string,readonly status: number) {super(code);this.name='RelayClientError';}
}
export interface RelayClientOptions {
  url: string;
  space: string;
  device: string;
  signChallenge(challenge: LoginChallenge): Promise<string> | string;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}
/** One media leg (docs/design/space-voice.md §1). Frames are opaque AEAD frames sealed by the endpoint. */
export interface RelayMediaSocket {
  send(frame: Uint8Array): Promise<void>;
  onFrame(listener: (frame: Uint8Array) => void): void;
  onClose(listener: (reason: string) => void): void;
  close(): void;
  /** True while an in-band renewal is scheduled; false once the socket closed. */
  readonly renewalPending?: boolean;
}
export interface RelayMediaCapability {v:number;codecs:string[];maxKbpsPerDirection:number;maxFrameBytes:number}
export interface RelaySubscription {
  /** Resolve only after ciphertext is verified, decrypted and durably applied/deduplicated. */
  onMailbox(envelope: RelayEnvelope,seq: number): Promise<void>;
  onStream?(envelope: RelayEnvelope): void;
  /** Must return the last cursor saveCursor durably stored; the client ACKs it as processed. */
  loadCursor?(): Promise<number | undefined>;
  saveCursor?(cursor: number): Promise<void>;
  onError?(error: unknown): void;
  onConnection?(online: boolean): void;
}
/** Outbound SDK shared by Host and Client. It never decrypts business content or executes a model. */
export class RelayClient {
  private readonly base: URL;
  private session: {token: string;principal: RelayPrincipal;expiresAt:number;selected_version:number} | undefined;
  private loggingIn: Promise<void> | undefined;
  private synchronizing: Promise<void> | undefined;
  private stopped = true;
  private socket: WebSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  constructor(private readonly options: RelayClientOptions) {
    this.base = new URL(options.url);
    if (this.base.username || this.base.password || this.base.search || this.base.hash ||
      (this.base.protocol !== 'https:' && !(this.base.protocol === 'http:' &&
       ['127.0.0.1','localhost','[::1]','::1'].includes(this.base.hostname)))) throw new RelayClientError('tls_required',0);
    if (this.base.pathname !== '/' && this.base.pathname !== '') throw new RelayClientError('origin_url_required',0);
    for (const name of ['requestTimeoutMs','pollIntervalMs','reconnectMinMs','reconnectMaxMs'] as const) {
      if (options[name] !== undefined && (!Number.isSafeInteger(options[name]) || options[name]! <= 0)) throw new RelayClientError('invalid_options',0);
    }
  }
  async login(): Promise<void> {
    if (this.loggingIn) return this.loggingIn;
    this.loggingIn = (async () => {
      const challenge = await this.request<LoginChallenge>('POST','/v1/auth/challenge',
        {space:this.options.space,device:this.options.device},false);
      if (challenge.space!==this.options.space || challenge.device!==this.options.device ||
        !Number.isSafeInteger(challenge.epoch) || challenge.epoch<1 || !Number.isSafeInteger(challenge.expiresAt) ||
        challenge.expiresAt<=Date.now()) throw new RelayClientError('invalid_challenge',0);
      const proof = await this.options.signChallenge(challenge);
      const session = await this.request<NonNullable<typeof this.session>>('POST','/v1/auth/session',{challengeId:challenge.id,proof},false);
      if(session.selected_version!==1)throw new RelayClientError('unsupported_business_version',0);
      this.session=session;
    })();
    try {await this.loggingIn;} finally {this.loggingIn=undefined;}
  }
  private async authorized(): Promise<string> {
    if (!this.session || this.session.expiresAt <= Date.now()+5000) await this.login();
    return this.session!.token;
  }
  private async request<T>(method: string,path: string,body?: unknown,auth=true): Promise<T> {
    const headers: Record<string,string> = {'accept':'application/json'};
    if (body !== undefined) headers['content-type']='application/json';
    if (auth) headers.authorization=`Bearer ${await this.authorized()}`;
    const response = await fetch(new URL(path,this.base),{method,headers,
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),signal:AbortSignal.timeout(this.options.requestTimeoutMs ?? 10000),redirect:'error'});
    const value: unknown = await response.json();
    if (!response.ok) {
      const code = value && typeof value === 'object' && 'error' in value ? String(value.error) : 'relay_error';
      if (response.status === 401) this.session=undefined;
      throw new RelayClientError(code,response.status);
    }
    return value as T;
  }
  send(envelope: RelayEnvelope): Promise<{seq:number;duplicate:boolean}> {return this.request('POST','/v1/mailbox',envelope);}
  read(options: {after?:number;limit?:number}={}): Promise<MailboxPage> {
    const query = new URLSearchParams();
    if (options.after !== undefined) query.set('after',String(options.after));
    if (options.limit !== undefined) query.set('limit',String(options.limit));
    return this.request('GET',`/v1/mailbox?${query}`);
  }
  async acknowledge(cursor: number): Promise<number> {
    return (await this.request<{ackCursor:number}>('POST','/v1/mailbox/ack',{cursor})).ackCursor;
  }
  status(): Promise<MailboxStatus> {return this.request('GET','/v1/mailbox/status');}
  async presence(device: string): Promise<boolean> {
    return (await this.request<{online:boolean}>('GET',`/v1/presence?device=${encodeURIComponent(device)}`)).online;
  }
  async stream(envelope: RelayEnvelope): Promise<void> {await this.request('POST','/v1/stream',envelope);}
  /** Media capability hint; null when the relay has no media route (older or media disabled). It never weakens crypto. */
  async capabilities(): Promise<{media:RelayMediaCapability|null}> {
    try {
      const value = await this.request<{media?:RelayMediaCapability}>('GET','/v1/capabilities');
      return {media:value.media && value.media.v===1 && Array.isArray(value.media.codecs) ? value.media : null};
    } catch (error) {if (error instanceof RelayClientError && error.status===404) return {media:null};throw error;}
  }
  /** Host only: reserve a media session for one Client device. */
  reserveMedia(session: string,client: string,ttlMs?: number): Promise<{session:string;expiresAt:number}> {
    return this.request('POST','/v1/media/sessions',{session,client,...(ttlMs===undefined?{}:{ttlMs})});
  }
  /** Join a reserved media session. The bearer token is renewed in-band before it expires. */
  async connectMedia(session: string): Promise<RelayMediaSocket> {
    const token = await this.authorized();
    const url=new URL('/v1/media',this.base);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const ws=new WebSocket(url,{headers:{authorization:`Bearer ${token}`,'x-nova-media-session':session},maxPayload:8192,
      handshakeTimeout:this.options.requestTimeoutMs ?? 10000,followRedirects:false,perMessageDeflate:false});
    await new Promise<void>((resolve,reject) => {
      ws.once('message',data => {try {const v=JSON.parse(data.toString()) as {type?:string};if(v.type==='ready')resolve();else reject(new RelayClientError('media_rejected',0));} catch {reject(new RelayClientError('media_rejected',0));}});
      ws.once('close',(code,reason) => reject(new RelayClientError(reason.toString()||'media_rejected',code)));
      ws.once('error',reject);
    });
    const frames: ((frame: Uint8Array) => void)[] = [], closes: ((reason: string) => void)[] = [];
    let renewal: ReturnType<typeof setTimeout> | undefined, closed=false;
    const schedule = (): void => {
      if (closed) return;
      const expiresAt=this.session?.expiresAt ?? Date.now();
      renewal=setTimeout(() => {renewal=undefined;void (async () => {
        try {
          await this.login();
          // The socket may have closed while the login was in flight: no renew, no new timer.
          if (closed || ws.readyState!==WebSocket.OPEN) return;
          ws.send(JSON.stringify({type:'renew',token:this.session!.token}));schedule();
        } catch {if (!closed) ws.close(1000,'renewal_failed');}
      })();},Math.max(1000,expiresAt-Date.now()-60_000));
      renewal.unref?.();
    };
    const stop = (): void => {closed=true;if (renewal) clearTimeout(renewal);renewal=undefined;};
    schedule();
    ws.on('message',(data,isBinary) => {if (!isBinary) return;const bytes=Array.isArray(data)?Buffer.concat(data):Buffer.from(data as ArrayBuffer);for (const f of frames) f(new Uint8Array(bytes));});
    ws.on('close',(_code,reason) => {stop();for (const c of closes) c(reason.toString()||'closed');});
    ws.on('error',() => ws.terminate());
    return {
      send: frame => new Promise<void>((resolve,reject) => {if (ws.readyState!==WebSocket.OPEN) {reject(new RelayClientError('media_closed',0));return;}ws.send(frame,{binary:true},e => e?reject(e):resolve());}),
      onFrame: listener => {frames.push(listener);},
      onClose: listener => {closes.push(listener);},
      /** Pending renewal timer, for tests. */
      get renewalPending() {return renewal!==undefined;},
      close: () => {stop();ws.close(1000,'closed');},
    };
  }
  createInvitation(options: {ttlMs?:number;business_versions?:number[]}={}): Promise<Invitation> {return this.request('POST','/v1/pairing/invitations',options);}
  pendingPairings(): Promise<PairingRequest[]> {return this.request('GET','/v1/pairing/requests');}
  confirmPairing(requestId: string,opId:string): Promise<DeviceRecord> {return this.request('POST','/v1/pairing/confirm',{requestId,opId});}
  devices(): Promise<DeviceRecord[]> {return this.request('GET','/v1/devices');}
  async revokeDevice(device: string,opId:string): Promise<{epoch:number;remainingDevices:DeviceRecord[]}> {
    try {return await this.request<{epoch:number;remainingDevices:DeviceRecord[]}>('POST','/v1/devices/revoke',{device,opId});}
    finally {this.session=undefined;}
  }
  requestPairing(body: PairingInput): Promise<PairingRequest> {return this.request('POST','/v1/pairing/requests',body,false);}
  /** Bootstrap is an operator action. This method never persists the deployment secret. */
  async createSpace(body: {space:string;host:DevicePublicIdentity;proof:string},bootstrapToken: string): Promise<SpaceRecord> {
    const response = await fetch(new URL('/v1/spaces',this.base),{method:'POST',headers:{'content-type':'application/json',
      'x-relay-bootstrap-token':bootstrapToken},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(this.options.requestTimeoutMs ?? 10000)});
    const value: unknown = await response.json();
    if (!response.ok) throw new RelayClientError(value && typeof value==='object' && 'error' in value ? String(value.error) : 'relay_error',response.status);
    return value as SpaceRecord;
  }
  /** Pulls from the durable cursor; never advances ACK before durable endpoint handling succeeds. */
  async synchronize(subscription: RelaySubscription): Promise<void> {
    if (this.synchronizing) return this.synchronizing;
    this.synchronizing=(async () => {
      let after = await subscription.loadCursor?.();
      for (;;) {
        const page = await this.read(after === undefined ? {} : {after});
        for (const message of page.messages) await subscription.onMailbox(message.envelope,message.seq);
        // `after` is always durable: loadCursor must return the last successfully saved cursor, and inside this loop it
        // only advances after a save resolved. An idle poll returns an empty page at that cursor and needs neither a
        // rewrite nor an ACK. A moved cursor (messages, or skipped expired rows) is saved first, so a failed save throws
        // before any ACK. An ACK lost after a successful save is repaired from the ACK cursor the relay reports per page.
        if (page.nextCursor !== after) await subscription.saveCursor?.(page.nextCursor);
        if (page.nextCursor > page.ackCursor) await this.acknowledge(page.nextCursor);
        after=page.nextCursor;
        if (!page.hasMore) return;
      }
    })();
    try {await this.synchronizing;} finally {this.synchronizing=undefined;}
  }
  /** Persistent outbound connection with bounded reconnect delay and durable HTTP catch-up. */
  start(subscription: RelaySubscription): () => void {
    if (!this.stopped) throw new RelayClientError('already_started',0);
    this.stopped=false;const generation=++this.generation;
    let delay=this.options.reconnectMinMs ?? 250;
    const report = (error: unknown): void => {try {subscription.onError?.(error);} catch {/* Consumer reporting cannot break retries. */}};
    const notify = (online: boolean): void => {try {subscription.onConnection?.(online);} catch (error) {report(error);}};
    const sync = (): void => {void this.synchronize(subscription).catch(report);};
    const connect = async (): Promise<void> => {
      if (this.stopped || generation!==this.generation) return;
      try {
        const token = await this.authorized();
        if (this.stopped || generation!==this.generation) return;
        const url=new URL('/v1/live',this.base);url.protocol=url.protocol==='https:'?'wss:':'ws:';
        const ws=new WebSocket(url,{headers:{authorization:`Bearer ${token}`},maxPayload:512*1024+256,
          handshakeTimeout:this.options.requestTimeoutMs ?? 10000,followRedirects:false,perMessageDeflate:false});
        this.socket=ws;
        const retry=():void => {
          if (this.stopped || generation!==this.generation) return;
          notify(false);
          this.timer=setTimeout(() => {void connect();},delay);
          delay=Math.min(delay*2,this.options.reconnectMaxMs ?? 30000);
        };
        ws.on('message',data => {
          try {
            const frame=JSON.parse(data.toString()) as {type?:string;envelope?:RelayEnvelope};
            if (frame.type==='ready') {delay=this.options.reconnectMinMs ?? 250;notify(true);sync();}
            else if (frame.type==='stream' && frame.envelope) subscription.onStream?.(frame.envelope);
          } catch (error) {report(error);}
        });
        ws.on('error',report);
        ws.once('close',retry);
      } catch (error) {
        report(error);
        if (!this.stopped && generation===this.generation) {
          this.timer=setTimeout(() => {void connect();},delay);delay=Math.min(delay*2,this.options.reconnectMaxMs ?? 30000);
        }
      }
    };
    this.polling=setInterval(sync,this.options.pollIntervalMs ?? 1000);
    void connect();
    return () => this.stop();
  }
  stop(): void {
    this.stopped=true;++this.generation;
    if (this.timer) clearTimeout(this.timer);
    if (this.polling) clearInterval(this.polling);
    this.socket?.terminate();this.socket=undefined;
  }
}
