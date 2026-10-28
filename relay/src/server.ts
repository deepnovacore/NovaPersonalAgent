import {createServer, type IncomingMessage, type ServerResponse, type Server} from 'node:http';
import {createServer as createSecureServer, type ServerOptions as TlsOptions} from 'node:https';
import type {AddressInfo} from 'node:net';
import {WebSocketServer, WebSocket} from 'ws';
import {MailboxStore, type MailboxOptions} from './mailbox.js';
import {LiveRelay, type LiveOptions} from './live.js';
import {RelayError, type RelayEnvelope, type RelayPrincipal} from './protocol.js';
import {SecurityStore} from './security.js';
import {canonicalAddress,sourceAddress,trustedAddresses} from './source-address.js';

export interface RelayServerOptions {
  securityPath: string;
  mailboxPath: string;
  bootstrapToken: string;
  bind?: string;
  port?: number;
  /** Direct TLS, or an explicitly configured HTTPS reverse proxy. */
  tls?: TlsOptions;
  externalTls?: boolean;
  /** Exact transport-peer IP allowlist; only these peers may supply X-Forwarded-For. */
  trustedProxyAddresses?: string[];
  maxControlOperationsPerSpace?: number;
  publicUrl?: string;
  maxBodyBytes?: number;
  /** Entire JSON mailbox response budget; must fit one configured maximum envelope. */
  maxResponseBytes?: number;
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  requestsPerMinute?: number;
  bootstrapPerMinute?: number;
  globalRequestsPerMinute?: number;
  globalBootstrapPerMinute?: number;
  maxRateSources?: number;
  mailbox?: MailboxOptions;
  live?: LiveOptions;
  /** Non-blocking metadata-only integration, invoked after durable insertion. */
  onMailbox?: (principal: RelayPrincipal, envelope: RelayEnvelope, seq: number) => void | Promise<void>;
}
interface RateBucket {start: number; count: number}
const loopback = (host: string): boolean => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);

/** Inbound infrastructure only: endpoints still initiate all connections. No model or plaintext API. */
export class RelayServer {
  readonly security: SecurityStore;
  readonly mailbox: MailboxStore;
  readonly live: LiveRelay;
  readonly http: Server;
  private readonly sockets = new WebSocketServer({noServer:true, maxPayload:1024, perMessageDeflate:false});
  private readonly rates = new Map<string, RateBucket>();
  private readonly trustedProxies:ReadonlySet<string>;
  private readonly forwardedConnections=new Map<string,number>();
  private readonly requestSources=new WeakMap<IncomingMessage,string>();
  private readonly ipConnections = new Map<string, number>();
  private readonly options: Required<Pick<RelayServerOptions, 'bind' | 'port' | 'maxBodyBytes' | 'maxConnections' |
    'maxResponseBytes' | 'maxConnectionsPerIp' | 'requestsPerMinute' | 'bootstrapPerMinute' | 'maxRateSources' | 'globalRequestsPerMinute' | 'globalBootstrapPerMinute'>> & RelayServerOptions;
  private readonly maintenance: ReturnType<typeof setInterval>;
  constructor(options: RelayServerOptions) {
    this.options = {bind:'127.0.0.1',port:0,maxBodyBytes:768*1024,maxResponseBytes:1536*1024,maxConnections:1024,
      maxConnectionsPerIp:32,requestsPerMinute:600,bootstrapPerMinute:20,maxRateSources:10000,globalRequestsPerMinute:30000,globalBootstrapPerMinute:200,...options};
    for (const key of ['maxBodyBytes','maxResponseBytes','maxConnections','maxConnectionsPerIp','requestsPerMinute','bootstrapPerMinute','maxRateSources','globalRequestsPerMinute','globalBootstrapPerMinute'] as const) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1) throw new RelayError('invalid_options');
    }
    if (!Number.isSafeInteger(this.options.port) || this.options.port < 0 || this.options.port > 65535) throw new RelayError('invalid_port');
    if (!loopback(this.options.bind) && !options.tls &&
      !(options.externalTls && options.publicUrl && new URL(options.publicUrl).protocol === 'https:')) throw new RelayError('tls_required');
    if (this.options.maxResponseBytes < (options.mailbox?.maxMessageBytes ?? 512*1024) + 256) throw new RelayError('invalid_response_budget');
    this.trustedProxies=trustedAddresses(options.trustedProxyAddresses);
    this.security = new SecurityStore(options.securityPath,{bootstrapToken:options.bootstrapToken,...(options.maxControlOperationsPerSpace===undefined?{}:{maxControlOperations:options.maxControlOperationsPerSpace})});
    this.mailbox = new MailboxStore(options.mailboxPath,this.security,{maxMessageBytes:512*1024,...options.mailbox});
    this.live = new LiveRelay(this.security,{...options.live,maxConnections:this.options.maxConnections});
    const listener = (req: IncomingMessage,res: ServerResponse): void => {void this.route(req,res);};
    this.http = options.tls ? createSecureServer(options.tls,listener) : createServer(listener);
    this.http.maxConnections = this.options.maxConnections;
    this.http.requestTimeout = 10000;
    this.http.headersTimeout = 10000;
    this.http.keepAliveTimeout = 5000;
    this.http.maxHeadersCount = 32;
    this.http.on('connection',socket => {
      let ip:string;try{ip=canonicalAddress(socket.remoteAddress??'0.0.0.0');}catch{socket.destroy();return;}
      // Before HTTP headers exist, a trusted proxy is bounded by the global TCP cap.
      // Its clients are counted separately for each HTTP request and WS lifetime below.
      if(this.trustedProxies.has(ip))return;
      const count = this.ipConnections.get(ip) ?? 0;
      if (count >= this.options.maxConnectionsPerIp) {socket.destroy();return;}
      this.ipConnections.set(ip,count+1);
      socket.on('close',() => {
        const left = (this.ipConnections.get(ip) ?? 1)-1;
        if (left) this.ipConnections.set(ip,left); else this.ipConnections.delete(ip);
      });
    });
    this.http.on('upgrade',(req,socket,head) => {
      let release:(()=>void)|undefined;
      try {
        release=this.reserveForwardedConnection(req);socket.once('close',release);
        this.rate(req,false);
        const url = new URL(req.url ?? '/', 'http://relay.invalid');
        if (url.pathname !== '/v1/live' || url.search) throw new RelayError('invalid_route');
        const p = this.security.authenticate(req.headers.authorization);
        this.sockets.handleUpgrade(req,socket,head,ws => {if(release)ws.once('close',release);this.connected(p,ws,req);});
      } catch (error) {
        release?.();
        const code = this.errorCode(error);
        socket.end(`HTTP/1.1 ${this.errorStatus(code)} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      }
    });
    this.maintenance = setInterval(() => {
      this.live.sweep();
      const before = Date.now()-60000;
      for (const [key,value] of this.rates) if (value.start <= before) this.rates.delete(key);
    },1000);
    this.maintenance.unref();
  }
  async listen(): Promise<string> {
    await new Promise<void>((resolve,reject) => {
      const failed = (error: Error): void => {reject(error);};
      this.http.once('error',failed);
      this.http.listen(this.options.port,this.options.bind,() => {this.http.off('error',failed);resolve();});
    });
    const address = this.http.address() as AddressInfo;
    return `${this.options.tls ? 'https' : 'http'}://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`;
  }
  async close(): Promise<void> {
    clearInterval(this.maintenance);
    for (const ws of this.sockets.clients) ws.terminate();
    await new Promise<void>(resolve => this.sockets.close(() => resolve()));
    try {
      await new Promise<void>((resolve,reject) => this.http.close(error => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
      }));
    } finally {this.security.close(); this.mailbox.close();}
  }
  private source(req:IncomingMessage):string {
    let value=this.requestSources.get(req);if(value===undefined){value=sourceAddress(req,this.trustedProxies);this.requestSources.set(req,value);}return value;
  }
  private reserveForwardedConnection(req:IncomingMessage):()=>void {
    if(!this.trustedProxies.has(canonicalAddress(req.socket.remoteAddress??'0.0.0.0')))return ()=>{};
    const ip=this.source(req),count=this.forwardedConnections.get(ip)??0;
    if(count>=this.options.maxConnectionsPerIp)throw new RelayError('rate_limited');
    this.forwardedConnections.set(ip,count+1);let released=false;
    return ()=>{if(released)return;released=true;const remaining=(this.forwardedConnections.get(ip)??1)-1;if(remaining>0)this.forwardedConnections.set(ip,remaining);else this.forwardedConnections.delete(ip);};
  }
  private rate(req: IncomingMessage,bootstrap: boolean): void {
    const now = Date.now();
    const prefix=bootstrap?'bootstrap':'all';
    for (const [key,limit] of [[`${prefix}:source:${this.source(req)}`,bootstrap?this.options.bootstrapPerMinute:this.options.requestsPerMinute],
      [`${prefix}:global`,bootstrap?this.options.globalBootstrapPerMinute:this.options.globalRequestsPerMinute]] as const) {
      let bucket = this.rates.get(key);
      if (!bucket || now-bucket.start >= 60000) {
        if (!bucket && this.rates.size >= this.options.maxRateSources) throw new RelayError('rate_limited');
        bucket = {start:now,count:0};this.rates.set(key,bucket);
      }
      if (++bucket.count > limit) throw new RelayError('rate_limited');
    }
  }
  private async body(req: IncomingMessage): Promise<Record<string,unknown>> {
    if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new RelayError('json_required');
    const declared = req.headers['content-length'];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > this.options.maxBodyBytes)) throw new RelayError('body_too_large');
    const chunks: Buffer[] = [];let bytes = 0;
    for await (const chunk of req) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += value.length;if (bytes > this.options.maxBodyBytes) throw new RelayError('body_too_large');
      chunks.push(value);
    }
    let body: unknown;
    try {body = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new RelayError('invalid_json');}
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RelayError('invalid_json');
    return body as Record<string,unknown>;
  }
  private integer(value: string | null): number | undefined {
    if (value === null) return undefined;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new RelayError('invalid_cursor');
    return Number(value);
  }
  private async route(req: IncomingMessage,res: ServerResponse): Promise<void> {
    try {
      const release=this.reserveForwardedConnection(req);res.once('finish',release);res.once('close',release);
      this.rate(req,false);
      const url = new URL(req.url ?? '/', 'http://relay.invalid');
      const route = `${req.method} ${url.pathname}`;
      let result: unknown;
      // Source-limited bootstrap endpoints require proof of key possession; no caller-supplied principal.
      if (['POST /v1/spaces','POST /v1/auth/challenge','POST /v1/auth/session','POST /v1/pairing/requests'].includes(route)) {
        this.rate(req,true);
        const body = await this.body(req);
        if (route === 'POST /v1/spaces') result = this.security.createSpace(body as unknown as Parameters<SecurityStore['createSpace']>[0], String(req.headers['x-relay-bootstrap-token'] ?? ''));
        else if (route === 'POST /v1/auth/challenge') result = this.security.beginLogin(String(body.space ?? ''),String(body.device ?? ''));
        else if (route === 'POST /v1/auth/session') result = this.security.completeLogin(body as unknown as Parameters<SecurityStore['completeLogin']>[0]);
        else result = this.security.requestPairing(body as unknown as Parameters<SecurityStore['requestPairing']>[0]);
      } else {
        const p = this.security.authenticate(req.headers.authorization);
        switch (route) {
          case 'GET /v1/mailbox': {
            const after = this.integer(url.searchParams.get('after'));const limit = this.integer(url.searchParams.get('limit'));
            result = this.mailbox.read(p,{maxBytes:this.options.maxResponseBytes-256,...(after === undefined ? {} : {after}),...(limit === undefined ? {} : {limit})});break;
          }
          case 'GET /v1/mailbox/status': result = this.mailbox.status(p);break;
          case 'POST /v1/mailbox': {
            const envelope = await this.body(req) as unknown as RelayEnvelope;
            const accepted = this.mailbox.send(p,envelope);result = accepted;
            if (!accepted.duplicate && this.options.onMailbox) {
              // A failed external wake never rolls back durable mail or changes its HTTP outcome.
              try {void Promise.resolve(this.options.onMailbox(p,envelope,accepted.seq)).catch(() => {});} catch { /* Wake is best effort. */ }
            }
            break;
          }
          case 'POST /v1/mailbox/ack': result = {ackCursor:this.mailbox.acknowledge(p,(await this.body(req)).cursor as number)};break;
          case 'GET /v1/presence': result = {online:this.live.presence(p,url.searchParams.get('device') ?? '')};break;
          case 'POST /v1/stream': this.live.send(p,await this.body(req) as unknown as RelayEnvelope);result={accepted:true};break;
          case 'POST /v1/pairing/invitations': result = this.security.createInvitation(p,await this.body(req));break;
          case 'GET /v1/pairing/requests': result = this.security.pendingPairings(p);break;
          case 'POST /v1/pairing/confirm': {const body=await this.body(req);result=this.security.confirmPairing(p,String(body.requestId??''),String(body.opId??''));break;}
          case 'GET /v1/devices': result = this.security.listDevices(p);break;
          case 'POST /v1/devices/revoke': {const body=await this.body(req);result=this.security.revokeDevice(p,String(body.device??''),String(body.opId??''));this.live.sweep();break;}
          default: throw new RelayError('invalid_route');
        }
      }
      this.json(res,200,result);
    } catch (error) {
      const code = this.errorCode(error);this.json(res,this.errorStatus(code),{error:code});
    }
  }
  private json(res: ServerResponse,status: number,value: unknown): void {
    if (res.destroyed || res.headersSent) return;
    const body = JSON.stringify(value);
    res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
      'x-content-type-options':'nosniff','content-length':Buffer.byteLength(body)});res.end(body);
  }
  private errorCode(error: unknown): string {return error instanceof RelayError ? error.code : 'invalid_request';}
  private errorStatus(code: string): number {
    if (code === 'rate_limited') return 429;
    if (['body_too_large','message_too_large'].includes(code)) return 413;
    if (code === 'invalid_route') return 404;
    if (['offline','id_conflict','cursor_expired','capacity_exceeded','history_capacity_exceeded','backpressure','page_too_small'].includes(code)) return 409;
    if (/auth|session|token|signature|proof|revoked|epoch|forbidden|host_required|inactive|unknown_device/.test(code)) return 401;
    return 400;
  }
  private connected(p: RelayPrincipal,ws: WebSocket,req: IncomingMessage): void {
    let connection: ReturnType<LiveRelay['connect']>;
    try {
      connection = this.live.connect(p,{
        send: envelope => new Promise<void>((resolve,reject) => {
          try {this.security.authenticate(req.headers.authorization);} catch (error) {reject(error);return;}
          if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1024*1024) {reject(new RelayError('backpressure'));return;}
          ws.send(JSON.stringify({type:'stream',envelope}),error => error ? reject(error) : resolve());
        }),
        close: () => ws.terminate(),
      });
    } catch {ws.terminate();return;}
    const heartbeat = (): void => {try {this.security.authenticate(req.headers.authorization);connection.heartbeat();} catch {ws.terminate();}};
    const timer = setInterval(() => {if (ws.readyState === WebSocket.OPEN) ws.ping();},10000);timer.unref();
    const controlFrame = (): void => {try {this.rate(req,false);heartbeat();} catch {ws.terminate();}};
    ws.on('pong',controlFrame);
    ws.on('ping',controlFrame);
    ws.on('message',(data,isBinary) => {
      try {
        this.rate(req,false);
        if (isBinary) throw new RelayError('invalid_frame');
        if (JSON.parse(data.toString()).type !== 'heartbeat') throw new RelayError('invalid_frame');
        heartbeat();
      } catch {ws.close(1008,'invalid_frame');}
    });
    ws.on('error',() => ws.terminate());
    ws.on('close',() => {clearInterval(timer);try {connection.close();} catch {/* Revoked connections already dropped. */}});
    ws.send(JSON.stringify({type:'ready',principal:p}));
  }
}
