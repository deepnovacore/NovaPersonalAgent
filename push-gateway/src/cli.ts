import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {Gateway,createGatewayServer} from './gateway.js';
import {ApnsProvider,FcmProvider,MiPushProvider} from './providers.js';
import type {ProviderName,PushProvider} from './providers.js';
function required(name:string){const value=process.env[name];if(!value)throw new Error(`missing_${name}`);return value;}
const providers:Partial<Record<ProviderName,PushProvider>>={};
if(process.env.NOVA_APNS_KEY_FILE)providers.apns=new ApnsProvider({teamId:required('NOVA_APNS_TEAM_ID'),keyId:required('NOVA_APNS_KEY_ID'),topic:required('NOVA_APNS_TOPIC'),privateKey:readFileSync(required('NOVA_APNS_KEY_FILE'),'utf8')});
if(process.env.NOVA_FCM_SERVICE_ACCOUNT_FILE){const account=JSON.parse(readFileSync(required('NOVA_FCM_SERVICE_ACCOUNT_FILE'),'utf8')) as {project_id:string;client_email:string;private_key:string};providers.fcm=new FcmProvider({projectId:account.project_id,clientEmail:account.client_email,privateKey:account.private_key});}
if(process.env.NOVA_MIPUSH_SECRET_FILE)providers.mipush=new MiPushProvider({appSecret:readFileSync(required('NOVA_MIPUSH_SECRET_FILE'),'utf8').trim(),packageName:required('NOVA_MIPUSH_PACKAGE'),channelId:required('NOVA_MIPUSH_PUBLIC_CHANNEL')});
if(!Object.keys(providers).length)throw new Error('no_push_provider_configured');
const gateway=new Gateway({statePath:required('NOVA_PUSH_STATE_FILE'),admissionKey:readFileSync(required('NOVA_PUSH_ADMISSION_KEY_FILE'),'utf8').trim(),providers,limits:{perHandle:Number(process.env.NOVA_PUSH_DEVICE_DAILY_LIMIT??100),global:Number(process.env.NOVA_PUSH_GLOBAL_DAILY_LIMIT??10_000)}});
const server=createServer({requestTimeout:15_000,headersTimeout:10_000,maxHeaderSize:8192},createGatewayServer(gateway));server.maxHeadersCount=32;
server.listen(Number(process.env.NOVA_PUSH_PORT??8788),process.env.NOVA_PUSH_BIND??'127.0.0.1');
let stopping=false;for(const event of ['SIGINT','SIGTERM'] as const)process.on(event,()=>{if(stopping)return;stopping=true;server.close(()=>{gateway.close();process.exit(0);});});
