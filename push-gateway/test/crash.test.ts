import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Gateway} from '../src/gateway.js';
const key='install-admission-key-at-least-32-chars';
const jwe='eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA';
test('SIGKILL releases process ownership but retains an unknown receipt before provider I/O',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'gateway-process-crash-')),statePath=join(dir,'state.json');
 const code=`import {Gateway} from ${JSON.stringify(new URL('../src/gateway.js',import.meta.url).href)};
 import {mintInvitation} from ${JSON.stringify(new URL('../src/admission.js',import.meta.url).href)};
 import {randomBytes} from 'node:crypto';
 const credential=randomBytes(32).toString('base64url');let registration;
 const gateway=new Gateway({statePath:${JSON.stringify(statePath)},admissionKey:${JSON.stringify(key)},providers:{fcm:{send:()=>{process.stdout.write(JSON.stringify(registration)+String.fromCharCode(10));return new Promise(()=>{})}}}});
 gateway.enroll(mintInvitation(${JSON.stringify(key)}),credential);registration=gateway.register({provider:'fcm',token:'test-token'},credential);
 setInterval(()=>{},1000);await gateway.push({...registration,notificationId:'interrupted',ciphertext:${JSON.stringify(jwe)}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});const lines=createInterface({input:child.stdout});let reopened:Gateway|undefined;let diagnostics='';child.stderr.on('data',(chunk:Buffer)=>{diagnostics+=chunk.toString().slice(0,4096)});
 try{
  const [line]=await Promise.race([once(lines,'line',{signal:AbortSignal.timeout(15_000)}),once(child,'exit').then(([code])=>{throw Error('provider child exited before reservation: '+String(code)+' '+diagnostics)})]) as [string];const registration=JSON.parse(line) as {handle:string;credential:string};
  assert.throws(()=>new Gateway({statePath,admissionKey:key,providers:{}}),/locked/);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  let calls=0;reopened=new Gateway({statePath,admissionKey:key,providers:{fcm:{send:async()=>{calls++;return {status:'accepted'}}}}});
  assert.deepEqual(await reopened.push({...registration,notificationId:'interrupted',ciphertext:jwe}),{status:'unknown',retryable:false});assert.equal(calls,0);
 }finally{lines.close();if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited}reopened?.close();rmSync(dir,{recursive:true,force:true})}
});
