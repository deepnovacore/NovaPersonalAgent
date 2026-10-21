import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,readFile,writeFile,mkdir,rm,stat,realpath,readdir,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {executeLocalTool,localPath,localPathEscapesProject,LOCAL_OUTPUT_BYTES,LOCAL_FILE_BYTES,canonicalProject} from '../src/personal-agent/local-tools.js'
import {executeLocalShell,localShellEnvironment,localShellProcessGone,type LocalShellProcess} from '../src/personal-agent/local-shell.js'
import type {JsonValue} from '../src/core/events.js'

const signal=()=>new AbortController().signal
const record=(value:JsonValue)=>value as Record<string,JsonValue>
async function fixture(){return mkdtemp(join(await realpath(tmpdir()),'nova-tools-中文 空格-'))}
const native=['win32','darwin'].includes(process.platform)
let resources=process.env.CODEX_RESOURCES_PATH,nativeRoot:string|undefined
before(async()=>{
 if(process.platform!=='win32'||resources)return
 nativeRoot=await fixture()
 const repository=process.env.NOVA_TEST_REPOSITORY??resolve(import.meta.dirname,'../../..')
 const setup=await import(pathToFileURL(resolve(repository,'clients/desktop/scripts/workbench-test-resources.mjs')).href) as {prepareWorkbenchTestResources:(path:string)=>Promise<string>}
 resources=await setup.prepareWorkbenchTestResources(join(nativeRoot,'resources'))
})
after(async()=>{if(nativeRoot)await rm(nativeRoot,{recursive:true,force:true})})
const shellOptions=()=>({...resources?{resourcesPath:resources}:{}})

test('local file tools preserve BOM, CRLF, exact replacement semantics and atomic targets',async()=>{
 const root=await fixture()
 try{
  const path=join(root,'目录 空格','文件.txt')
  await executeLocalTool('file_write',{path,content:'\ufeff第一行\r\n第二行\r\n重复 重复\r\n'},root,signal())
  const before=await readFile(path)
  await assert.rejects(executeLocalTool('file_edit',{path,old_string:'不存在',new_string:'bad'},root,signal()),/no_match/)
  await assert.rejects(executeLocalTool('file_edit',{path,old_string:'重复',new_string:'bad'},root,signal()),/multiple_matches/)
  assert.deepEqual(await readFile(path),before)
  await executeLocalTool('file_edit',{path,old_string:'第一行',new_string:'修改'},root,signal())
  assert.equal(await readFile(path,'utf8'),'\ufeff修改\r\n第二行\r\n重复 重复\r\n')
  await executeLocalTool('file_edit',{path,old_string:'重复',new_string:'$&',replace_all:true},root,signal())
  assert.match(await readFile(path,'utf8'),/\$& \$&/)
  const read=record(await executeLocalTool('file_read',{path,offset:2,limit:1},root,signal()))
  assert.equal(read.content,'第二行\r\n');assert.equal(read.next_offset,3)
  const mode=(await stat(path)).mode
  await executeLocalTool('file_write',{path,content:'替换\n'},root,signal())
  assert.equal(await readFile(path,'utf8'),'\ufeff替换\n');assert.equal((await stat(path)).mode,mode)
  assert.deepEqual(await readdir(join(root,'目录 空格')),['文件.txt'])
 }finally{await rm(root,{recursive:true,force:true})}
})

test('local file tools paginate directories and bound text, binary and replacement sizes',async()=>{
 const root=await fixture()
 try{
  await Promise.all(Array.from({length:5},(_,i)=>writeFile(join(root,'entry-'+i),'ok')))
  const first=record(await executeLocalTool('file_read',{path:'.',limit:2},root,signal())),second=record(await executeLocalTool('file_read',{path:'.',offset:3,limit:3},root,signal()))
  assert.equal((first.entries as JsonValue[]).length,2);assert.equal(first.next_offset,3);assert.equal((second.entries as JsonValue[]).length,3);assert.equal(second.truncated,false)
  await writeFile(join(root,'binary'),Buffer.from([0,255,1]))
  assert.equal(record(await executeLocalTool('file_read',{path:'binary'},root,signal())).type,'binary')
  await writeFile(join(root,'large'),'中文'.repeat(40000)+'\n')
  const read=record(await executeLocalTool('file_read',{path:'large'},root,signal()))
  assert.equal(read.truncated,true);assert.equal(typeof read.content,'string');assert.ok(Buffer.byteLength(read.content as string)<=LOCAL_OUTPUT_BYTES)
  await writeFile(join(root,'large'),Buffer.alloc(LOCAL_FILE_BYTES+1))
  await executeLocalTool('file_write',{path:'large',content:'small'},root,signal());assert.equal(await readFile(join(root,'large'),'utf8'),'small')
  await assert.rejects(executeLocalTool('file_write',{path:'entry-0',content:'x'.repeat(LOCAL_FILE_BYTES+1)},root,signal()))
  await assert.rejects(executeLocalTool('file_edit',{path:'entry-0',old_string:'ok',new_string:'x'.repeat(LOCAL_FILE_BYTES+1)},root,signal()),/file_too_large/)
  assert.equal(await readFile(join(root,'entry-0'),'utf8'),'ok')
  const abort=new AbortController();abort.abort()
  await assert.rejects(executeLocalTool('file_write',{path:'cancelled',content:'bad'},root,abort.signal));assert.equal((await readdir(root)).includes('cancelled'),false)
  await assert.rejects(executeLocalTool('file_read',{path:'missing'},root,signal()),/ENOENT/)
  await mkdir(join(root,'folder'));await assert.rejects(executeLocalTool('file_write',{path:'folder',content:'bad'},root,signal()),/not_a_file|EISDIR|EPERM/)
  assert.equal(await canonicalProject(root),root)
 }finally{await rm(root,{recursive:true,force:true})}
})

test('Windows native path resolution accepts UNC and rejects drive-relative ambiguity',()=>{
 assert.equal(localPath('C:\\项目 空格','src\\a.txt','win32'),'C:\\项目 空格\\src\\a.txt')
 assert.equal(localPath('C:\\project','D:\\中文\\a.txt','win32'),'D:\\中文\\a.txt')
 assert.equal(localPath('C:\\project','\\\\server\\share\\a.txt','win32'),'\\\\server\\share\\a.txt')
 for(const path of ['C:foo','C:','\\foo','/foo','bad\0path'])assert.throws(()=>localPath('C:\\project',path,'win32'))
 assert.equal(localPath('/tmp/project','../a','darwin'),'/tmp/a')
})

test('local shell retains development environment while stripping product secrets and controls',()=>{
 const environment=localShellEnvironment({PATH:'tools',HOME:'/users/test',DEVELOPER_DIR:'/xcode',VIRTUAL_ENV:'venv',TEMP:'tmp',OPENAI_API_KEY:'private',DESKTOP_TOKEN:'private',SERVER_TOKEN_FILE:'private',COMPOSIO_API_KEY:'private',MODEL_API_KEY:'private',NOVA_LOCAL_TOOL_APPROVAL:'never',NODE_OPTIONS:'bad'})
 assert.deepEqual(environment,{PATH:'tools',HOME:'/users/test',DEVELOPER_DIR:'/xcode',VIRTUAL_ENV:'venv',TEMP:'tmp'})
})

test('native shell interoperates with files, streams Unicode and reports real nonzero exits',{skip:!native,timeout:30000},async()=>{
 const root=await fixture()
 try{
  const command=process.platform==='win32'?"[IO.File]::WriteAllText((Join-Path $PWD '结果.txt'), '中文', (New-Object Text.UTF8Encoding($false))); [Console]::Out.Write('输出中文'); [Console]::Error.Write('错误中文'); exit 7":"printf '中文' > 结果.txt; printf '输出中文'; printf '错误中文' >&2; exit 7"
  const result=record(await executeLocalShell({command,cwd:root,timeout:10},signal(),shellOptions()))
  assert.equal(result.stdout,'输出中文');assert.equal(result.stderr,'错误中文');assert.equal(result.exit_code,7);assert.equal(result.status,'failed');assert.equal(result.cleanup_confirmed,true);assert.equal(result.output_incomplete,false)
  assert.equal(record(await executeLocalTool('file_read',{path:'结果.txt'},root,signal())).content,'中文')
  const output=process.platform==='win32'?"[Console]::Out.Write(('a' * 90000)); [Console]::Error.Write('end')":"printf '%90000s' x; printf end >&2"
  const bounded=record(await executeLocalShell({command:output,cwd:root,timeout:10},signal(),shellOptions()))
  assert.equal(bounded.truncated,true);assert.equal(typeof bounded.stdout,'string');assert.equal(typeof bounded.stderr,'string');assert.ok(Buffer.byteLength((bounded.stdout as string)+(bounded.stderr as string))<=LOCAL_OUTPUT_BYTES);assert.equal(bounded.status,'completed')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('local shell returns on leader exit and cleans a lingering background server without losing its exit code',{skip:!native,timeout:30000},async()=>{
 const root=await fixture(),marker=join(root,'background.pid'),started=Date.now()
 try{
  const command=process.platform==='win32'
   ? "$p=Start-Process -PassThru -WindowStyle Hidden -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60'; [IO.File]::WriteAllText('"+marker.replaceAll("'","''")+"', [string]$p.Id); [Console]::Out.Write('=== EXIT: 7 ==='); exit 7"
   : 'sleep 60 & child=$!; printf "%s" "$child" > '+"'"+marker.replaceAll("'","'\\''")+"'"+'; printf "=== EXIT: 7 ==="; exit 7'
  const result=record(await executeLocalShell({command,cwd:root,timeout:15},signal(),shellOptions()))
  assert.ok(Date.now()-started<8000,'the guardian must not wait for a daemon that outlives its command leader')
  assert.equal(result.stdout,'=== EXIT: 7 ===');assert.equal(result.exit_code,7);assert.equal(result.status,'failed');assert.equal(result.cleanup_confirmed,true)
  const pid=Number(await readFile(marker,'utf8'));assert.ok(pid>0)
  let alive=true;for(let attempt=0;attempt<50;attempt++){try{process.kill(pid,0)}catch{alive=false;break}await new Promise(resolve=>setTimeout(resolve,25))}
  assert.equal(alive,false,'background descendant must be gone before shell_execute returns')
 }finally{await rm(root,{recursive:true,force:true})}
})

test('native shell timeout and cancellation kill child and grandchild processes',{skip:!native,timeout:45000},async()=>{
 const root=await fixture()
 try{
  for(const cancel of [false,true]){
   const marker=join(root,cancel?'cancel.pid':'timeout.pid'),controller=new AbortController()
   // Spawn a native shell grandchild in the same owned job/process group.
   const command=process.platform==='win32'
    ? "$p=Start-Process -PassThru -WindowStyle Hidden -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60'; [IO.File]::WriteAllText('"+marker.replaceAll("'","''")+"', [string]$p.Id); Start-Sleep -Seconds 60"
    : 'sleep 60 & child=$!; printf "%s" "$child" > '+"'"+marker.replaceAll("'","'\\''")+"'"+'; wait'
   const operation=executeLocalShell({command,cwd:root,timeout:cancel?15:2},controller.signal,shellOptions())
   let pid=0
   for(let attempt=0;attempt<100;attempt++){
    const text=await readFile(marker,'utf8').catch(()=>null);if(text){pid=Number(text);break}await new Promise(resolve=>setTimeout(resolve,50))
   }
   assert.ok(pid>0,'child must actually start')
   if(cancel)controller.abort()
   const result=record(await operation);assert.equal(result.status,cancel?'cancelled':'timed_out');assert.equal(result.cleanup_confirmed,true)
   for(let attempt=0;attempt<50;attempt++){try{process.kill(pid,0)}catch{pid=0;break}await new Promise(resolve=>setTimeout(resolve,25))}
   assert.equal(pid,0,'grandchild must be gone')
  }
 }finally{await rm(root,{recursive:true,force:true})}
})

test('native shell persists its process identity before the execution gate opens',{skip:!native,timeout:30000},async()=>{
 const root=await fixture(),controller=new AbortController();let owner:LocalShellProcess|undefined
 try{
  const command=process.platform==='win32'?"[IO.File]::WriteAllText((Join-Path $PWD 'side-effect'), 'bad')":"printf bad > side-effect"
  const result=record(await executeLocalShell({command,cwd:root,timeout:10},controller.signal,{...shellOptions(),onStarted:process=>{owner=process;controller.abort();return Promise.resolve()}}))
  assert.ok(owner);assert.equal(result.cleanup_confirmed,true);assert.equal(localShellProcessGone(owner),true)
  await assert.rejects(readFile(join(root,'side-effect')))
 }finally{await rm(root,{recursive:true,force:true})}
})

test('local path escape check follows links and treats the project root and its children as inside',async()=>{
 const root=await fixture(),outside=await fixture()
 try{
  await mkdir(join(root,'src'));await writeFile(join(root,'src','a.txt'),'a');await writeFile(join(outside,'secret.txt'),'s')
  for(const inside of ['.','src','src/a.txt','src/missing.txt','./src/../src/a.txt'])assert.equal(await localPathEscapesProject(root,inside),false,inside)
  for(const escaping of ['..','../x',join(outside,'secret.txt'),join(root,'..')])assert.equal(await localPathEscapesProject(root,escaping),true,escaping)
  if(process.platform!=='win32'){
   await symlink(outside,join(root,'link'));await symlink(join(outside,'secret.txt'),join(root,'file-link'))
   for(const linked of ['link','link/secret.txt','link/new.txt','file-link'])assert.equal(await localPathEscapesProject(root,linked),true,linked)
  }
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true})}
})
