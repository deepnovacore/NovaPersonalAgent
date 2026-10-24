import {CompactEncrypt} from 'jose';
import {spawnSync} from 'node:child_process';
import {mkdirSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),index=args.indexOf('--output-root');
if(index<0||!args[index+1])throw Error('required --output-root /existing/selected/build/root');
const root=realpathSync(args[index+1]);
const worktree=realpathSync(fileURLToPath(new URL('../..',import.meta.url)));
const runIndex=args.indexOf('--run-id'),runId=args[runIndex+1];
if(runIndex<0||!runId||!/^[-_A-Za-z0-9]{1,100}$/.test(runId))throw Error('required --run-id chat-id');
const output=join(root,'nova-push-native-'+createHash('sha256').update(worktree).digest('hex').slice(0,16),runId);mkdirSync(output,{recursive:true});
const source=resolve(worktree,'clients/flutter/android/app/src');
const compile=spawnSync('java',['--module','jdk.compiler/com.sun.tools.javac.Main','-d',output,join(source,'main/java/com/nova/nova_mobile/NovaPushJwe.java'),join(source,'test/java/com/nova/nova_mobile/NovaPushJweChecks.java')],{stdio:'inherit'});
if(compile.error)throw compile.error;
if(compile.status!==0)process.exit(compile.status??1);
const key=new Uint8Array(32).fill(7),plain=JSON.stringify({title:'Nova',body:'跨端 JWE contract'});
const compact=await new CompactEncrypt(Buffer.from(plain)).setProtectedHeader({alg:'dir',enc:'A256GCM'}).encrypt(key);
const check=spawnSync('java',['-cp',output,'com.nova.nova_mobile.NovaPushJweChecks',Buffer.from(key).toString('base64url'),compact,plain],{stdio:'inherit'});
if(check.status!==0)process.exit(check.status??1);
if(process.platform==='darwin'){
 const binary=join(output,'space-date-check');
 const compiled=spawnSync('swiftc',['-module-cache-path',join(output,'swift-cache'),join(worktree,'clients/flutter/ios/Runner/NovaSpaceDate.swift'),join(worktree,'clients/flutter/tool/space_date_test.swift'),'-o',binary],{stdio:'inherit'});
 if(compiled.error)throw compiled.error;if(compiled.status!==0)process.exit(compiled.status??1);
 const dates=spawnSync(binary,[],{stdio:'inherit'});if(dates.error)throw dates.error;if(dates.status!==0)process.exit(dates.status??1);
}
