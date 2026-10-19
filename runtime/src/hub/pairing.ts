import {z} from 'zod'

export const pairingDeviceName=z.string().trim().min(1).max(100)
export const pairingRequest=z.object({code:z.string().regex(/^[A-Za-z0-9_-]{43}$/),device_name:pairingDeviceName,
 hub_id:z.string().min(1).max(200),account_id:z.string().min(1).max(200)}).strict()
export interface PairingInvitation {type:'nova.hub';version:1;url:string;code:string;expires_at:number;hub_id:string;account_id:string}

/** Reject normalization tricks as well as origins outside the tailnet namespace. */
export function pairingOrigin(raw:string):string {
 if(typeof raw!=='string'||raw.length>2048||raw.includes('@')||!/^https:\/\/[^/?#\\\s]+\/?$/.test(raw))throw Error('invalid_hub_url')
 let url:URL
 try{url=new URL(raw)}catch{throw Error('invalid_hub_url')}
 const host=url.hostname,labels=host.split('.')
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!host.endsWith('.ts.net')||host.length>253||
  labels.some(label=>!label.length||label.length>63||!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))throw Error('invalid_hub_url')
 return url.origin
}
