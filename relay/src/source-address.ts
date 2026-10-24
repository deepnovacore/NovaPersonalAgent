import {isIP} from 'node:net';
import type {IncomingMessage} from 'node:http';
import {RelayError} from './protocol.js';

/** Exact IP trust, never hostnames, arbitrary forwarding headers or implicit hop counts. */
export function canonicalAddress(value:string):string {
 const version=isIP(value);if(version===4)return value;
 if(version!==6)throw new RelayError('invalid_source_address');
 let canonical:string;try{canonical=new URL(`http://[${value}]/`).hostname.slice(1,-1);}catch{throw new RelayError('invalid_source_address');}
 const mapped=/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(canonical);
 if(mapped){const high=parseInt(mapped[1]!,16),low=parseInt(mapped[2]!,16);return [high>>>8,high&255,low>>>8,low&255].join('.');}
 return canonical;
}
export function trustedAddresses(values:readonly string[]=[]):ReadonlySet<string> {
 if(!Array.isArray(values)||values.length>64||values.some(value=>typeof value!=='string'))throw new RelayError('invalid_trusted_proxies');
 try{return new Set(values.map(canonicalAddress));}catch{throw new RelayError('invalid_trusted_proxies');}
}
export function sourceAddress(req:Pick<IncomingMessage,'socket'|'headers'>,trusted:ReadonlySet<string>):string {
 let current=canonicalAddress(req.socket.remoteAddress??'0.0.0.0');
 // A direct client can forge forwarding headers; they are deliberately ignored.
 if(!trusted.has(current))return current;
 const raw=req.headers['x-forwarded-for'];if(raw===undefined)return current;
 if(typeof raw!=='string'||raw.length>2048)throw new RelayError('invalid_forwarded_address');
 const chain=raw.split(',');if(chain.length>16)throw new RelayError('invalid_forwarded_address');
 let addresses:string[];try{addresses=chain.map(value=>canonicalAddress(value.trim()));}catch{throw new RelayError('invalid_forwarded_address');}
 // Stop at the first untrusted hop from the socket. Attacker-controlled prefixes never win.
 while(trusted.has(current)&&addresses.length)current=addresses.pop()!;
 return current;
}
