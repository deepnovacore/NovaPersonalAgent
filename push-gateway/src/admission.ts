import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';

export interface InvitationClaims {v:1;id:string;installationId:string;issuedAt:number;expiresAt:number}
const maximumLifetime=15*60_000;
const opaque=()=>randomBytes(32).toString('base64url');
function checkSecret(secret:string){if(Buffer.byteLength(secret)<32)throw Error('admission_key_too_short');}
const sign=(secret:string,body:string)=>createHmac('sha256',secret).update('nova-push-invitation-v1\0'+body).digest();

/** Operator-only issuer. Never ship this secret in an app or expose an anonymous mint endpoint. */
export function mintInvitation(secret:string,options:{now?:number;ttlMs?:number}={}):string {
 checkSecret(secret);
 const now=options.now??Date.now(),ttl=options.ttlMs??maximumLifetime;
 if(!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(ttl)||ttl<=0||ttl>maximumLifetime||!Number.isSafeInteger(now+ttl))throw Error('invalid_invitation_options');
 const claims:InvitationClaims={v:1,id:opaque(),installationId:opaque(),issuedAt:now,expiresAt:now+ttl};
 const body=Buffer.from(JSON.stringify(claims)).toString('base64url');
 return body+'.'+sign(secret,body).toString('base64url');
}

export function verifyInvitation(secret:string,ticket:string,now=Date.now()):InvitationClaims {
 checkSecret(secret);
 const invalid=()=>{throw Error('invalid_invitation');};
 if(typeof ticket!=='string'||ticket.length>2048)return invalid();
 const parts=ticket.split('.');
 if(parts.length!==2||!parts.every(part=>/^[A-Za-z0-9_-]+$/.test(part)))return invalid();
 const body=parts[0]!,signature=Buffer.from(parts[1]!,'base64url'),expected=sign(secret,body);
 if(signature.length!==expected.length||!timingSafeEqual(signature,expected)||signature.toString('base64url')!==parts[1])return invalid();
 let value:unknown;try{value=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{return invalid();}
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
 const c=value as Record<string,unknown>;
 if(Object.keys(c).sort().join(',')!=='expiresAt,id,installationId,issuedAt,v'||c.v!==1||
  typeof c.id!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(c.id)||typeof c.installationId!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(c.installationId)||
  typeof c.issuedAt!=='number'||!Number.isSafeInteger(c.issuedAt)||c.issuedAt<0||typeof c.expiresAt!=='number'||!Number.isSafeInteger(c.expiresAt)||
  c.issuedAt>now+30_000||c.expiresAt<=now||c.expiresAt<=c.issuedAt||c.expiresAt-c.issuedAt>maximumLifetime)return invalid();
 return c as unknown as InvitationClaims;
}
