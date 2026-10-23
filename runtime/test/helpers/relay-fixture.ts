import type {SpaceHostModules} from '../../src/space-host/config.js';
import type {JsonKey, SignedEnvelope} from '../../src/space-host/relay-transport.js';

type Client = InstanceType<SpaceHostModules['RelayClient']>;
interface FixtureClient extends Client {
 stop():void;
 requestPairing(body:unknown):Promise<{id:string}>;
 read(options:{after:number;limit:number}):Promise<{messages:{envelope:SignedEnvelope}[];nextCursor:number;hasMore:boolean}>;
 acknowledge(cursor:number):Promise<unknown>;
}
interface FixtureServer {
 listen():Promise<string>;
 close():Promise<void>;
 live:{presence(session:{space:string;device:string;epoch:number},device:string):boolean};
}
interface RelayFixture {
 RelayServer:new(options:{securityPath:string;mailboxPath:string;bootstrapToken:string;bootstrapPerMinute?:number;requestsPerMinute?:number})=>FixtureServer;
 RelayClient:new(options:ConstructorParameters<SpaceHostModules['RelayClient']>[0]&{pollIntervalMs?:number;reconnectMinMs?:number})=>FixtureClient;
 crypto:SpaceHostModules['crypto']&{
 generateContentKey():Uint8Array;
 unwrapContentKey(body:string,key:JsonKey):Promise<{space:string;recipient:string;epoch:number;key:string}>;
 };
}
/** The runtime loads the separately built relay package; keep its fixture boundary explicit. */
export async function loadRelayFixture():Promise<RelayFixture>{
 const serverPackage='@nova-personal-agent/relay/server',clientPackage='@nova-personal-agent/relay/client',cryptoPackage='@nova-personal-agent/relay/crypto';
 const server:unknown=await import(serverPackage),client:unknown=await import(clientPackage),crypto:unknown=await import(cryptoPackage);
 return {RelayServer:(server as Pick<RelayFixture,'RelayServer'>).RelayServer,RelayClient:(client as Pick<RelayFixture,'RelayClient'>).RelayClient,crypto:crypto as RelayFixture['crypto']};
}
