import {isIP} from 'node:net';
import type {IncomingMessage,ServerResponse} from 'node:http';

export interface GatewayHttpOptions {
 trustedProxyAddresses?:string[];
 requestsPerMinute?:number;
 enrollmentsPerMinute?:number;
 registrationsPerMinute?:number;
 globalRequestsPerMinute?:number;
 maxSources?:number;
 maxConcurrent?:number;
 maxConcurrentPerSource?:number;
 now?:()=>number;
}
export class GatewayHttpError extends Error {constructor(readonly status:number,code:string){super(code);}}
interface Source {start:number;requests:number;enrollments:number;registrations:number;active:number}
const normalize=(ip:string)=>{
 const address=ip.startsWith('::ffff:')&&isIP(ip.slice(7))===4?ip.slice(7):ip;
 if(!isIP(address))throw new GatewayHttpError(400,'invalid_source_address');
 return isIP(address)===6?new URL('http://['+address+']/').hostname.slice(1,-1):address;
};
/** Only an explicitly trusted immediate peer may assert a forwarding chain. */
export function gatewaySource(req:Pick<IncomingMessage,'headers'|'socket'>,trusted:Set<string>):string {
 const peer=normalize(req.socket.remoteAddress??'');
 if(!trusted.has(peer)||req.headers['x-forwarded-for']===undefined)return peer;
 const header=req.headers['x-forwarded-for'];
 if(typeof header!=='string'||header.length>1024)throw new GatewayHttpError(400,'invalid_forwarded_address');
 const chain=header.split(',');
 if(chain.length>16)throw new GatewayHttpError(400,'invalid_forwarded_address');
 const addresses=chain.map(value=>normalize(value.trim()));
 addresses.push(peer);
 while(addresses.length>1&&trusted.has(addresses.at(-1)!))addresses.pop();
 return addresses.at(-1)!;
}
export class GatewayHttpGuard {
 private readonly trusted:Set<string>;
 private readonly sources=new Map<string,Source>();
 private global={start:0,count:0};private active=0;private lastSweep=0;
 constructor(private readonly options:GatewayHttpOptions={}){
  this.trusted=new Set((options.trustedProxyAddresses??[]).map(normalize));
  for(const [key,value] of Object.entries(options))if(key!=='trustedProxyAddresses'&&key!=='now'&&(!Number.isSafeInteger(value)||Number(value)<1))throw Error('invalid_http_limit');
 }
 check(req:IncomingMessage,res:ServerResponse):void {
  const now=(this.options.now??Date.now)();
  if(now-this.global.start>=60_000)this.global={start:now,count:0};
  if(++this.global.count>(this.options.globalRequestsPerMinute??20_000))throw new GatewayHttpError(429,'request_limit');
  const source=gatewaySource(req,this.trusted);
  if(now-this.lastSweep>=60_000){for(const [key,row] of this.sources)if(row.active===0&&now-row.start>=60_000)this.sources.delete(key);this.lastSweep=now;}
  let row=this.sources.get(source);
  if(!row){if(this.sources.size>=(this.options.maxSources??10_000))throw new GatewayHttpError(429,'request_limit');row={start:now,requests:0,enrollments:0,registrations:0,active:0};this.sources.set(source,row);}
  if(now-row.start>=60_000){row.start=now;row.requests=0;row.enrollments=0;row.registrations=0;}
  if(++row.requests>(this.options.requestsPerMinute??300))throw new GatewayHttpError(429,'request_limit');
  if(req.method==='POST'&&req.url==='/v1/installations'&&++row.enrollments>(this.options.enrollmentsPerMinute??10))throw new GatewayHttpError(429,'enrollment_limit');
  if(req.method==='POST'&&req.url==='/v1/registrations'&&++row.registrations>(this.options.registrationsPerMinute??30))throw new GatewayHttpError(429,'registration_rate_limit');
  if(this.active>=(this.options.maxConcurrent??256)||row.active>=(this.options.maxConcurrentPerSource??16))throw new GatewayHttpError(429,'concurrency_limit');
  this.active++;row.active++;let released=false;
  const release=()=>{if(released)return;released=true;this.active--;row.active--;};
  res.once('close',release);res.once('finish',release);
 }
}
