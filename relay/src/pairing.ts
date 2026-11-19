import {SecurityStore,type PairingInput} from './security.js';
import type {RelayPrincipal} from './protocol.js';
/** HTTP adapter façade; all mutations share SecurityStore's durable SQLite transaction. */
export class PairingStore {
 constructor(private readonly security:SecurityStore){}
 createInvitation(host:RelayPrincipal,options:{ttlMs?:number;business_versions?:number[]}={}){return this.security.createInvitation(host,options);}
 requestPairing(input:PairingInput){return this.security.requestPairing(input);}
 pendingPairings(host:RelayPrincipal){return this.security.pendingPairings(host);}
 confirmPairing(host:RelayPrincipal,requestId:string,opId:string){return this.security.confirmPairing(host,requestId,opId);}
 revokeDevice(host:RelayPrincipal,device:string,opId:string){return this.security.revokeDevice(host,device,opId);}
}
