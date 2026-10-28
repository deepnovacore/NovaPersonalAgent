import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,realpathSync,symlinkSync,existsSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),root=args[args.indexOf('--output-root')+1],run=args[args.indexOf('--run-id')+1];
if(!args.includes('--output-root')||!root||!isAbsolute(root)||!args.includes('--run-id')||!run||!/^[A-Za-z0-9_-]{1,100}$/.test(run)){
 console.error('Usage: npm run build:space -- --output-root /existing/build/root --run-id chat-id');process.exit(2);
}
const repo=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const out=join(realpathSync(root),'nova-space-'+createHash('sha256').update(repo).digest('hex').slice(0,16),run);
const modules=join(out,'node_modules');mkdirSync(modules,{recursive:true});
// Resolve ordinary installed dependencies without mutating the shared dependency tree.
for(const entry of readdirSync(join(repo,'node_modules'),{withFileTypes:true})){
 if(entry.name.startsWith('.'))continue;
 if(entry.name==='@nova-personal-agent'){
  mkdirSync(join(modules,entry.name),{recursive:true});
  for(const name of readdirSync(join(repo,'node_modules',entry.name))){
   if(['runtime','relay','push-gateway'].includes(name))continue;
   const target=join(modules,entry.name,name);if(!existsSync(target))symlinkSync(join(repo,'node_modules',entry.name,name),target,'junction');
  }
 }else{const target=join(modules,entry.name);if(!existsSync(target))symlinkSync(join(repo,'node_modules',entry.name),target,'junction');}
}
const compiler=createRequire(import.meta.url).resolve('typescript/bin/tsc');
for(const name of ['relay','push-gateway','runtime']){
 const manifest=JSON.parse(readFileSync(join(repo,name,'package.json'),'utf8'));
 const packageOut=join(modules,...manifest.name.split('/'));mkdirSync(packageOut,{recursive:true});
 writeFileSync(join(packageOut,'package.json'),JSON.stringify(manifest,null,2)+'\n');
 // npm may install version-specific dependencies inside an individual workspace.
 const localModules=join(repo,name,'node_modules');
 if(existsSync(localModules)){
  const isolatedModules=join(packageOut,'node_modules');mkdirSync(isolatedModules,{recursive:true});
  for(const entry of readdirSync(localModules)){
   if(entry.startsWith('.')||entry==='@nova-personal-agent')continue;
   const target=join(isolatedModules,entry);
   if(!existsSync(target))symlinkSync(join(localModules,entry),target,'junction');
  }
 }
 const result=spawnSync(process.execPath,[compiler,'-p',join(repo,name,'tsconfig.json'),'--noEmit','false',
  '--outDir',join(packageOut,'dist'),'--tsBuildInfoFile',join(packageOut,'.tsbuildinfo'),
  '--declaration','true','--declarationMap','false','--sourceMap','false'],{stdio:'inherit'});
 if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);
}
writeFileSync(join(out,'package.json'),'{"type":"module"}\n');
writeFileSync(join(out,'build.json'),JSON.stringify({worktree:repo,run_id:run,packages:['relay','push-gateway','runtime']},null,2)+'\n');
console.log(`Space stack built at ${out}`);
