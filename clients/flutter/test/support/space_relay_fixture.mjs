// Local integration fixture: no model, external push, or deployment credentials.
import {pathToFileURL} from 'node:url';
const root=process.env.NOVA_RELAY_BUILD_ROOT;
if(!root)throw Error('NOVA_RELAY_BUILD_ROOT required');
const {RelayServer}=await import(pathToFileURL(`${root}/server.js`));
const {generateDeviceIdentity,generateContentKey,spaceId,signControl,signEnvelope,encryptBody,decryptBody,wrapContentKey,verifyEnvelope}=await import(pathToFileURL(`${root}/crypto.js`));
const {WebSocket}=await import(pathToFileURL(`${root}/../../../node_modules/ws/wrapper.mjs`)).catch(()=>import('ws'));
const server=new RelayServer({securityPath:':memory:',mailboxPath:':memory:',bootstrapToken:'local-fixture-bootstrap-token-32',bind:'127.0.0.1',port:0,requestsPerMinute:10000,globalRequestsPerMinute:20000});
const url=await server.listen();
const host=await generateDeviceIdentity(),space=spaceId(host.signingPublicKey),key=generateContentKey();
const descriptor={device:host.device,signingPublicKey:host.signingPublicKey,encryptionPublicKey:host.encryptionPublicKey};
server.security.createSpace({space,host:descriptor,proof:await signControl({v:1,purpose:'space-create',space,host:descriptor},host.signingPrivateKey)},'local-fixture-bootstrap-token-32');
async function request(method,path,body,token){const response=await fetch(url+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();if(!response.ok)throw Error(JSON.stringify(value));return value;}
const challenge=await request('POST','/v1/auth/challenge',{space,device:host.device});
const session=await request('POST','/v1/auth/session',{challengeId:challenge.id,proof:await signControl({v:1,purpose:'relay-login',challengeId:challenge.id,nonce:challenge.nonce,space,device:host.device,epoch:1,expiresAt:challenge.expiresAt},host.signingPrivateKey)});
const token=session.token;
const ws=new WebSocket(url.replace('http','ws')+'/v1/live',{headers:{authorization:`Bearer ${token}`}});
await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
let client,counter=0;
async function send(payload,{stream=false,wrapped=false}={}){
  const body=wrapped?Buffer.from(await wrapContentKey(payload,client.encryptionPublicKey)).toString('base64'):await encryptBody(payload,key);
  const envelope=await signEnvelope({v:1,space,id:`test_${counter++}`,from:host.device,to:client.device,chan:stream?'stream':'mailbox',epoch:1,expiresAt:stream?Date.now()+60000:null,body},host.signingPrivateKey);
  await request('POST',stream?'/v1/stream':'/v1/mailbox',envelope,token);
}
ws.on('message',async raw=>{
  try{
    const frame=JSON.parse(String(raw));if(frame.type!=='stream')return;
    verifyEnvelope(frame.envelope,client.signingPublicKey);
    const payload=await decryptBody(frame.envelope.body,key);
    if(payload.kind==='chat.send'){
      await send({v:1,type:'chat.delta',op_id:payload.op_id,conversation_id:'chat:main',text:'Host preview 中文',sequence:1},{stream:true});
      await send({v:1,type:'chat.final',op_id:payload.op_id,conversation_id:'chat:main',message_id:`final_${payload.op_id}`,text:'Host final 中文🙂',status:'completed'});
    }
  }catch(error){console.error(error);}
});
const invitation=await request('POST','/v1/pairing/invitations',{},token);
console.log(JSON.stringify({invitation:{...invitation,relay:url,business_versions:[1]}}));
let pairing=false;
const timer=setInterval(async()=>{
  if(pairing)return;
  try{
    const pending=await request('GET','/v1/pairing/requests',undefined,token);
    if(!pending.length)return;
    pairing=true;client=pending[0];
    await request('POST','/v1/pairing/confirm',{requestId:client.id,opId:'confirm-fixture-client'},token);
    await send({v:1,space,epoch:1,recipient:client.device,key:Buffer.from(key).toString('base64url')},{wrapped:true});
    await send({v:1,type:'push.key',handle:'stall-handle',notification_key:Buffer.alloc(32,7).toString('base64url')});
    const snapshot=JSON.stringify({schema_version:1,revision:1,goals:[],todos:[],ideas:[],profile:{about:'Host only',version:1},timeline:[],notifications:[],chat:[],feed:[{id:'large',kind:'future.card',title:'Large Host snapshot',body:'x'.repeat(48*1024*34)}]});
    const size=48*1024,total=Math.ceil(snapshot.length/size);
    for(let index=0;index<total;index++)await send({v:1,type:'snapshot.chunk',snapshot_id:'large_snapshot',index,total,data:snapshot.slice(index*size,(index+1)*size)});
  }catch(error){console.error(error);}
},25);
process.on('SIGTERM',async()=>{clearInterval(timer);ws.terminate();await server.close();process.exit(0);});
