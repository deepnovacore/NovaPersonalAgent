#!/usr/bin/env node
import {constants} from 'node:fs';
import {open,mkdir,stat} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {initializeHostSpace,resumeHostSpaceRegistration} from './config.js';
import {adminSocketPath,spaceAdminRequest} from './admin-socket.js';
const usage='usage: nova-space-host init --config /new/space/config.json --data /new/space/personal.json --relay https://relay.example --bootstrap-file /private/operator-token\n       nova-space-host resume --config /existing/space/config.json --bootstrap-file /private/operator-token\n       nova-space-host status|devices --config /existing/space/config.json\n       nova-space-host pair --config /existing/space/config.json [--timeout-seconds 300] [--yes-fingerprint FINGERPRINT]\n       nova-space-host revoke --config /existing/space/config.json --device DEVICE_ID\nstatus, pair, devices and revoke talk to the running Host (novapersonal-server start, or the desktop) through <config>.admin.sock.';
export function parseSpaceInit(args:readonly string[]):{configPath:string;personalPath:string;relayUrl:string;bootstrapFile:string}{
 if(args[0]!=='init'||args.length!==9)throw Error(usage);
 const values=new Map<string,string>();
 for(let i=1;i<args.length;i+=2){const key=args[i]!,value=args[i+1]!;if(!['--config','--data','--relay','--bootstrap-file'].includes(key)||values.has(key)||!value)throw Error(usage);values.set(key,value)}
 const configPath=values.get('--config')!,personalPath=values.get('--data')!,bootstrapFile=values.get('--bootstrap-file')!,relayUrl=values.get('--relay')!;
 if(![configPath,personalPath,bootstrapFile].every(isAbsolute))throw Error(usage);
 if(new Set([resolve(configPath),resolve(personalPath),resolve(bootstrapFile)]).size!==3)throw Error('space_paths_must_be_distinct');
 const url=new URL(relayUrl);
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
  (url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw Error('relay_tls_origin_required');
 return {configPath,personalPath,relayUrl,bootstrapFile};
}
/** Host data stores refuse a group- or world-accessible parent at startup, so init rejects one before registering. */
export async function assertPrivateDirectory(path:string):Promise<void>{
 if(process.platform==='win32')return;
 const info=await stat(path);
 if(!info.isDirectory()||(info.mode&0o077)!==0)throw Error(`space_directory_must_be_private: ${path} (chmod 700)`);
}
export function parseSpaceResume(args:readonly string[]):{configPath:string;bootstrapFile:string}{
 if(args[0]!=='resume'||args.length!==5)throw Error(usage);
 const values=new Map<string,string>();
 for(let i=1;i<args.length;i+=2){const key=args[i]!,value=args[i+1]!;if(!['--config','--bootstrap-file'].includes(key)||values.has(key)||!value)throw Error(usage);values.set(key,value)}
 const configPath=values.get('--config')!,bootstrapFile=values.get('--bootstrap-file')!;
 if(![configPath,bootstrapFile].every(isAbsolute))throw Error(usage);
 if(resolve(configPath)===resolve(bootstrapFile))throw Error('space_paths_must_be_distinct');
 return {configPath,bootstrapFile};
}
export interface SpaceAdminArgs {command:'status'|'pair'|'devices'|'revoke';configPath:string;timeoutSeconds:number;device?:string;yesFingerprint?:string}
export function parseSpaceAdmin(args:readonly string[]):SpaceAdminArgs{
 const command=args[0];if(command!=='status'&&command!=='pair'&&command!=='devices'&&command!=='revoke')throw Error(usage);
 const allowed=['--config',...command==='pair'?['--timeout-seconds','--yes-fingerprint']:[],...command==='revoke'?['--device']:[]];
 const values=new Map<string,string>();
 if(args.length%2===0)throw Error(usage);
 for(let i=1;i<args.length;i+=2){const key=args[i]!,value=args[i+1]!;if(!allowed.includes(key)||values.has(key)||!value||value.startsWith('--'))throw Error(usage);values.set(key,value)}
 const configPath=values.get('--config');if(!configPath||command==='revoke'&&!values.get('--device'))throw Error(usage);
 const seconds=values.has('--timeout-seconds')?Number(values.get('--timeout-seconds')):300;if(!Number.isInteger(seconds)||seconds<1||seconds>3600)throw Error(usage);
 return {command,configPath:resolve(configPath),timeoutSeconds:seconds,...values.has('--device')?{device:values.get('--device')!}:{},...values.has('--yes-fingerprint')?{yesFingerprint:values.get('--yes-fingerprint')!}:{}};
}
/** Same bytes the desktop encodes: the invitation JSON without any rendered image. Compact renderer plus a four-module quiet zone. */
export async function renderInvitationQr(invitation:unknown):Promise<string>{
 const value=JSON.stringify(invitation);if(value.length>8192)throw Error('pairing_payload_too_large');
 const name='qrcode',{default:QRCode}=await import(name) as {default:{create(data:unknown,options:unknown):{modules:{size:number}};toString(data:unknown,options:unknown):Promise<string>}},data=[{data:value,mode:'byte' as const}],options={type:'terminal' as const,small:true,errorCorrectionLevel:'M' as const};
 const width=QRCode.create(data,options).modules.size+8,white='\x1b[47m',reset='\x1b[0m',border=white+' '.repeat(width)+reset+'\n';
 const rows=(await QRCode.toString(data,options)).split('\n').slice(0,-1);
 return border.repeat(2)+rows.map((row:string)=>white+'   '+row+white+'   '+reset+'\n').join('')+border.repeat(2);
}
export interface SpacePairIo {output:{write(text:string):unknown;isTTY?:boolean};interactive:boolean;confirm(question:string):Promise<boolean>;signal:AbortSignal;pollMs?:number}
const pairingRows=(value:unknown)=>Array.isArray(value)?value as {id:string;device:string;fingerprint:string}[]:[];
export async function runSpacePair(options:SpaceAdminArgs,io:SpacePairIo):Promise<number>{
 const socket=adminSocketPath(options.configPath);
 if(!io.interactive&&!options.yesFingerprint)throw Error('space_pair_requires_tty');
 const invitation=await spaceAdminRequest(socket,'invitation');
 io.output.write('在手机 Nova 选择「连接 Host」→「扫描 Host 邀请码」，扫描下方二维码（一次性，Ctrl+C 取消）：\n'+await renderInvitationQr(invitation)+'等待手机发起配对…\n');
 const deadline=Date.now()+options.timeoutSeconds*1000,skipped=new Set<string>();
 while(!io.signal.aborted){
  // Older abandoned requests stay pending until expiry; never let one block the intended phone.
  const rows=pairingRows(await spaceAdminRequest(socket,'pairings')).filter(row=>!skipped.has(row.id));
  const request=options.yesFingerprint!==undefined?rows.find(row=>row.fingerprint===options.yesFingerprint):rows[0];
  if(request){
   io.output.write(`收到配对请求：设备 ${request.device}\n指纹：${request.fingerprint}\n`);
   if(options.yesFingerprint===undefined&&!await io.confirm('确认该手机指纹与手机上显示一致？[y/N] ')){skipped.add(request.id);io.output.write('已跳过该请求，继续等待…\n');continue}
   await spaceAdminRequest(socket,'confirm_pairing',{id:request.id,fingerprint:request.fingerprint});
   io.output.write(`已绑定设备 ${request.device}\n`);return 0;
  }
  if(Date.now()>=deadline){io.output.write(options.yesFingerprint!==undefined&&skipped.size+rows.length>0?'没有指纹与 --yes-fingerprint 一致的请求，未绑定。\n':'等待配对超时，请重新运行 pair。\n');return 1}
  await delay(io.pollMs??2000,undefined,{signal:io.signal}).catch(()=>undefined);
 }
 io.output.write('已取消配对。\n');return 1;
}
async function adminMain(args:readonly string[]):Promise<number>{
 const options=parseSpaceAdmin(args),socket=adminSocketPath(options.configPath);
 if(options.command==='pair'){
  const stop=new AbortController(),cancel=()=>stop.abort(),signals=['SIGINT','SIGTERM','SIGHUP'] as const;for(const name of signals)process.on(name,cancel);
  const interactive=!!process.stdin.isTTY&&!!process.stdout.isTTY;
  try{return await runSpacePair(options,{output:process.stdout,interactive,signal:stop.signal,confirm:async question=>{const rl=createInterface({input:process.stdin,output:process.stdout});const abort=()=>rl.close();stop.signal.addEventListener('abort',abort,{once:true});try{return /^y(es)?$/i.test((await rl.question(question)).trim())}catch{return false}finally{stop.signal.removeEventListener('abort',abort);rl.close()}}})}
  finally{for(const name of signals)process.off(name,cancel)}
 }
 const status=await spaceAdminRequest(socket,options.command==='revoke'?'revoke':'status',options.command==='revoke'?{device:options.device!}:undefined) as {space:string;epoch:number;clients:string[];relay_url:string;pairing_pending:boolean;revocation_pending:boolean};
 if(options.command==='devices')process.stdout.write(status.clients.length?status.clients.join('\n')+'\n':'尚未配对任何手机。\n');
 else process.stdout.write(`Space ${status.space}\nRelay ${status.relay_url}\nEpoch ${status.epoch}\nDevices ${status.clients.length}${status.pairing_pending?'\nPairing pending':''}${status.revocation_pending?'\nRevocation pending':''}\n`);
 return 0;
}
export async function main(args:readonly string[]):Promise<number>{
 if(['status','pair','devices','revoke'].includes(args[0]??''))return adminMain(args);
 if(args.length===1&&args[0]==='--help'){process.stdout.write(usage+'\nHost loss means Space loss. A new mode always requires a new Space.\n');return 0}
 const options=args[0]==='resume'?{mode:'resume' as const,...parseSpaceResume(args)}:{mode:'init' as const,...parseSpaceInit(args)};
 const file=await open(options.bootstrapFile,constants.O_RDONLY|constants.O_NOFOLLOW);
 let bootstrapToken:string;
 try{const stat=await file.stat();if(!stat.isFile()||stat.size>4096||process.platform!=='win32'&&(stat.mode&0o077)!==0)throw Error('bootstrap_file_must_be_private');bootstrapToken=(await file.readFile('utf8')).trim();if(bootstrapToken.length<32)throw Error('bootstrap_token_too_short')}finally{await file.close()}
 let result:{space:string;configPath:string};
 if(options.mode==='init'){
  await mkdir(dirname(options.configPath),{recursive:true,mode:0o700});await mkdir(dirname(options.personalPath),{recursive:true,mode:0o700});
  for(const directory of new Set([dirname(options.configPath),dirname(options.personalPath)]))await assertPrivateDirectory(directory);
  result=await initializeHostSpace({...options,bootstrapToken});
 }else result=await resumeHostSpaceRegistration({...options,bootstrapToken});
 process.stdout.write(`Registered Host Space ${result.space}\nSet NOVA_SPACE_HOST_CONFIG=${result.configPath} for the Host.\nDesktop: open Settings > Connections > Space and pair a phone.\nHeadless: run novapersonal-server start, then nova-space-host pair --config ${result.configPath}\n`);return 0;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{process.exitCode=await main(process.argv.slice(2))}catch(error){process.stderr.write(`nova-space-host: ${error instanceof Error?error.message:'initialization_failed'}\n`);process.exitCode=1}}
