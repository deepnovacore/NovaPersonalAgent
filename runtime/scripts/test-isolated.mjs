import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, isAbsolute, join, resolve} from 'node:path'

// Usage: node runtime/scripts/test-isolated.mjs --output-root /private/.../opencode --run-id chat-id [test-name ...]
const args=process.argv.slice(2),outputRoot=args[args.indexOf('--output-root')+1],runId=args[args.indexOf('--run-id')+1]
if(!args.includes('--output-root')||!outputRoot||!isAbsolute(outputRoot)||!args.includes('--run-id')||!/^[A-Za-z0-9_-]{1,100}$/.test(runId??'')){
 console.error('Usage: node runtime/scripts/test-isolated.mjs --output-root /absolute/internal/path --run-id chat-id [test-name ...]')
 process.exit(2)
}
if(process.platform==='win32')throw Error('Use test:runtime:win on Windows; this isolated runner requires POSIX symlinks')
const project=realpathSync(resolve(import.meta.dirname,'../..'))
const scope=createHash('sha256').update(project).digest('hex').slice(0,12)
const canonicalRoot=realpathSync(outputRoot)
if(canonicalRoot.startsWith('/Volumes/'))throw Error('Build outputs must stay on internal storage')
const root=mkdtempSync(join(canonicalRoot,`nova-runtime-${scope}-${runId}-`))
const runtime=join(root,'runtime'),native=join(root,'native')
// macOS Unix sockets have a short path limit; the long isolated build root cannot be TMPDIR.
const tempParent=process.platform==='darwin'?'/private/tmp':realpathSync(tmpdir())
const temporary=mkdtempSync(join(tempParent,`nova-test-${scope.slice(0,8)}-${createHash('sha256').update(runId).digest('hex').slice(0,8)}-`))
mkdirSync(runtime)
const env={...process.env,TMPDIR:temporary,TMP:temporary,TEMP:temporary,npm_config_cache:join(root,'npm-cache'),npm_config_devdir:join(root,'node-gyp')}
const run=(command,argv,cwd)=>{
 const result=spawnSync(command,argv,{cwd,env,stdio:'inherit'})
 if(result.error)throw result.error
 if(result.status!==0)process.exit(result.status??1)
}
for(const entry of readdirSync(project)){
 if(['runtime','node_modules','.git','.env','.data','.tmp','.worktrees','.claude','.agents','.omx'].includes(entry))continue
 symlinkSync(join(project,entry),join(root,entry))
}
symlinkSync(join(project,'node_modules'),join(root,'node_modules'))
for(const entry of readdirSync(join(project,'runtime'))){
 if(['dist','node_modules'].includes(entry))continue
 symlinkSync(join(project,'runtime',entry),join(runtime,entry))
}
mkdirSync(join(runtime,'node_modules'))
for(const entry of readdirSync(join(project,'runtime/node_modules'))){
 if(entry==='mem0ai')cpSync(join(project,'runtime/node_modules',entry),join(runtime,'node_modules',entry),{recursive:true})
 else symlinkSync(join(project,'runtime/node_modules',entry),join(runtime,'node_modules',entry))
}
const version=JSON.parse(readFileSync(join(project,'runtime/package.json'),'utf8')).dependencies['better-sqlite3']
run('npm',['install','--prefix',native,'--no-save','--no-package-lock','--no-audit','--no-fund',`better-sqlite3@${version}`],root)
symlinkSync(join(native,'node_modules/better-sqlite3'),join(runtime,'node_modules/better-sqlite3'))
run(join(project,'node_modules/.bin/tsc'),['-p',join(project,'runtime/tsconfig.json'),'--outDir',join(runtime,'dist'),'--tsBuildInfoFile',join(runtime,'dist/.tsbuildinfo')],root)
const names=args.filter((value,index)=>!['--output-root','--run-id'].includes(value)&&![args.indexOf('--output-root')+1,args.indexOf('--run-id')+1].includes(index))
const tests=names.length?names.map(name=>{
 if(basename(name)!==name||!/^[\w-]+(?:\.test(?:\.js)?)?$/.test(name))throw Error(`Invalid test name: ${name}`)
 return name.endsWith('.js')?name:name.endsWith('.test')?name+'.js':name+'.test.js'
}):readdirSync(join(runtime,'dist/test')).filter(name=>name.endsWith('.test.js')).sort()
console.log(`Isolated runtime tests: ${root}`)
run(process.execPath,['--test','--test-concurrency=4',...tests.map(name=>join(runtime,'dist/test',name))],runtime)
