import {execFile} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {promisify} from 'node:util';

const run=promisify(execFile);

// Windows PowerShell 5 exposes the FileStream constructor that applies a DACL at creation.
// The reader uses the same handle for the ACL and the bytes, denying writes and rename while open.
const loadKey=String.raw`
$ErrorActionPreference='Stop'
$path=$env:NOVA_SPACE_KEY_PATH
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$sidType=[Security.Principal.SecurityIdentifier]
$trusted=@($sid.Value,'S-1-5-18','S-1-5-32-544')
function Read-Key {
  $attributes=[IO.File]::GetAttributes($path)
  if ($attributes -band [IO.FileAttributes]::ReparsePoint) {throw 'space_secret_key_symlink'}
  if ($attributes -band [IO.FileAttributes]::Directory) {throw 'space_secret_key_invalid'}
  $stream=[IO.File]::Open($path,'Open','Read','Read')
  try {
    if ([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) {throw 'space_secret_key_symlink'}
    $acl=$stream.GetAccessControl()
    if ($trusted -notcontains $acl.GetOwner($sidType).Value) {throw 'space_secret_key_permissions'}
    $rules=$acl.GetAccessRules($true,$true,$sidType)
    if ($rules.Count -eq 0) {throw 'space_secret_key_permissions'}
    foreach ($rule in $rules) {
      if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value) {throw 'space_secret_key_permissions'}
    }
    if ($stream.Length -eq 0) {throw 'space_secret_key_empty'}
    if ($stream.Length -ne 64) {throw 'space_secret_key_invalid'}
    $reader=[IO.BinaryReader]::new($stream)
    $key=[Text.Encoding]::ASCII.GetString($reader.ReadBytes(64))
    if ($key -cnotmatch '^[0-9a-f]{64}$') {throw 'space_secret_key_invalid'}
    return $key
  } finally {$stream.Dispose()}
}
try {
  try { [Console]::Write((Read-Key)); exit 0 }
  catch [IO.FileNotFoundException] { }
  $temp=$path+'.'+[guid]::NewGuid().ToString()+'.tmp'
  $acl=[Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
  $stream=[IO.FileStream]::new($temp,'CreateNew',[Security.AccessControl.FileSystemRights]::FullControl,'None',4096,'None',$acl)
  try {
    try {
      $bytes=[byte[]]::new(32)
      $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
      try {$rng.GetBytes($bytes)} finally {$rng.Dispose()}
      $data=[Text.Encoding]::ASCII.GetBytes([BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant())
      $stream.Write($data,0,$data.Length)
      $stream.Flush($true)
    } finally {$stream.Dispose()}
    try {[IO.File]::Move($temp,$path)}
    catch [IO.IOException] {if (-not [IO.File]::Exists($path)) {throw}}
  } finally {[IO.File]::Delete($temp)}
  [Console]::Write((Read-Key))
} catch {
  $reason=$_.Exception.GetBaseException().Message
  if ($reason -notin @('space_secret_key_permissions','space_secret_key_empty','space_secret_key_invalid','space_secret_key_symlink')) {$reason='space_secret_key_unavailable'}
  [Console]::Write($reason)
  exit 1
}
`;

export async function loadWindowsSpaceSecretKey(path:string):Promise<string>{
  await mkdir(dirname(path),{recursive:true});
  const shell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  try {
    const {stdout}=await run(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(loadKey,'utf16le').toString('base64')],{
      env:{...process.env,NOVA_SPACE_KEY_PATH:path},windowsHide:true,maxBuffer:4096,timeout:30000,
    });
    if(/^[a-f0-9]{64}$/u.test(stdout))return stdout;
  } catch(error) {
    const {stdout}=error as {stdout?:string};
    if(stdout && /^space_secret_key_(permissions|empty|invalid|symlink)$/u.test(stdout))throw Object.assign(Error(stdout),{code:stdout});
  }
  throw Object.assign(Error('space_secret_key_unavailable'),{code:'space_secret_key_unavailable'});
}
