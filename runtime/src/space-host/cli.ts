#!/usr/bin/env node
import {constants} from 'node:fs';
import {open,mkdir} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {initializeHostSpace,resumeHostSpaceRegistration} from './config.js';
const usage='usage: nova-space-host init --config /new/space/config.json --data /new/space/personal.json --relay https://relay.example --bootstrap-file /private/operator-token\n       nova-space-host resume --config /existing/space/config.json --bootstrap-file /private/operator-token';
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
export function parseSpaceResume(args:readonly string[]):{configPath:string;bootstrapFile:string}{
 if(args[0]!=='resume'||args.length!==5)throw Error(usage);
 const values=new Map<string,string>();
 for(let i=1;i<args.length;i+=2){const key=args[i]!,value=args[i+1]!;if(!['--config','--bootstrap-file'].includes(key)||values.has(key)||!value)throw Error(usage);values.set(key,value)}
 const configPath=values.get('--config')!,bootstrapFile=values.get('--bootstrap-file')!;
 if(![configPath,bootstrapFile].every(isAbsolute))throw Error(usage);
 if(resolve(configPath)===resolve(bootstrapFile))throw Error('space_paths_must_be_distinct');
 return {configPath,bootstrapFile};
}
export async function main(args:readonly string[]):Promise<number>{
 if(args.length===1&&args[0]==='--help'){process.stdout.write(usage+'\nHost loss means Space loss. A new mode always requires a new Space.\n');return 0}
 const options=args[0]==='resume'?{mode:'resume' as const,...parseSpaceResume(args)}:{mode:'init' as const,...parseSpaceInit(args)};
 const file=await open(options.bootstrapFile,constants.O_RDONLY|constants.O_NOFOLLOW);
 let bootstrapToken:string;
 try{const stat=await file.stat();if(!stat.isFile()||stat.size>4096||process.platform!=='win32'&&(stat.mode&0o077)!==0)throw Error('bootstrap_file_must_be_private');bootstrapToken=(await file.readFile('utf8')).trim();if(bootstrapToken.length<32)throw Error('bootstrap_token_too_short')}finally{await file.close()}
 let result:{space:string;configPath:string};
 if(options.mode==='init'){
  await mkdir(dirname(options.configPath),{recursive:true,mode:0o700});await mkdir(dirname(options.personalPath),{recursive:true,mode:0o700});
  result=await initializeHostSpace({...options,bootstrapToken});
 }else result=await resumeHostSpaceRegistration({...options,bootstrapToken});
 process.stdout.write(`Registered Host Space ${result.space}\nStart the desktop with NOVA_SPACE_HOST_CONFIG=${result.configPath}\nOpen Settings > Connections > Space and phones to pair a Client.\n`);return 0;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){try{process.exitCode=await main(process.argv.slice(2))}catch(error){process.stderr.write(`nova-space-host: ${error instanceof Error?error.message:'initialization_failed'}\n`);process.exitCode=1}}
