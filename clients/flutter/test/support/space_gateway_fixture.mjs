import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root = process.env.NOVA_GATEWAY_BUILD_ROOT;
if (!root) throw Error('NOVA_GATEWAY_BUILD_ROOT_required');
const {Gateway, createGatewayServer} = await import(pathToFileURL(resolve(root,'src/gateway.js')));
const {mintInvitation} = await import(pathToFileURL(resolve(root,'src/admission.js')));
const directory = await mkdtemp(join(tmpdir(),'nova-gateway-contract-'));
const secret='test-only-gateway-invitation-secret-32-chars';
let now=Date.UTC(2026,9,24);
const gateway = new Gateway({statePath:join(directory,'state.json'),admissionKey:secret,now:()=>now,providers:{fcm:{send:async()=>({status:'accepted'})}}});
const handler=createGatewayServer(gateway);
const server=createServer((req,res)=>{
 if(req.method==='POST'&&req.url==='/test/advance'){
  now+=Number(req.headers['x-test-advance-ms']);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({now}));return;
 }
 if(req.method==='POST'&&req.url==='/test/stop'){
  res.end('{}');server.close(async()=>{gateway.close();await rm(directory,{recursive:true,force:true});process.exit(0)});return;
 }
 handler(req,res);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,invitation:mintInvitation(secret,{now}),now}));
