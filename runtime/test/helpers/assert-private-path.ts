import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';

const run=promisify(execFile);
export async function assertPrivatePath(path:string,posixMode=0o600){
 if(process.platform!=='win32'){assert.equal((await stat(path)).mode&0o777,posixMode);return}
 const shell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const check=`$ErrorActionPreference='Stop';$sid=[Security.Principal.SecurityIdentifier];$acl=Get-Acl -LiteralPath $env:NOVA_TEST_PATH;
 $trusted=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544');
 if ($trusted -notcontains $acl.GetOwner($sid).Value) {exit 1}
 $grants=@($acl.GetAccessRules($true,$true,$sid) | Where-Object AccessControlType -eq Allow);
 if (!$grants.Count -or @($grants | Where-Object {$trusted -notcontains $_.IdentityReference.Value -and !($_.IdentityReference.Value -eq 'S-1-3-0' -and ($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly))}).Count) {exit 1}`;
 await run(shell,['-NoProfile','-NonInteractive','-Command',check],{env:{...process.env,NOVA_TEST_PATH:path},windowsHide:true});
}
