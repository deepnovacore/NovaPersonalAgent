import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,readFile,writeFile,rm,symlink,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {ReadingCopies,renderReadingCopies,type ReadingSnapshot} from '../src/personal-agent/reading-copies.js'

const fixture=():ReadingSnapshot=>({scope:'local:a',life:{profile:{about:'',version:0},todos:[],goals:[],ideas:[]},timeline:{cards:[],updated_at:null},profile:{status:'ready',draft:{about:{text:'低质量文件版',refs:[]},work:[],interests:[]},last_success:{generated_at:'2026-10-15T11:24:55.741Z',draft:{about:{text:'飞书讨论：交互闭环',refs:[{entry_id:'im:1',version:'1'}]},work:[],interests:[]},sources:[{id:'im:1',label:'讨论消息',url:'https://example.com/thread?a=1&b=2'}]},sources:[]}})

test('profile uses published discussion, respects manual clearing and does not invent generation dates',()=>{
 const value=fixture();let docs=renderReadingCopies(value)
 assert.match(docs['profile.md']!,/飞书讨论/);assert.ok(!docs['profile.md']!.includes('低质量文件版'));assert.match(docs['profile.md']!,/2026-10-15T11:24:55.741Z/);assert.match(docs['profile.md']!,/https:\/\/example.com/)
 value.life.profile={about:'用户自己写的',version:1};docs=renderReadingCopies(value);assert.match(docs['profile.md']!,/用户自己写的/);assert.ok(!docs['profile.md']!.includes('飞书讨论'))
 value.life.profile.about='';assert.ok(!renderReadingCopies(value)['profile.md']!.includes('飞书讨论'))
 value.life.profile.version=0;value.profile.last_success!.generated_at=null;assert.match(renderReadingCopies(value)['profile.md']!,/生成时间未记录/)
 value.profile.last_success=null;value.profile.draft=null;value.profile.status='failed';assert.equal(renderReadingCopies(value)['profile.md'],null)
})

test('writer coalesces updates, retries failures and never follows symlinks',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'reading-writer-'));let value=fixture();const errors:string[]=[]
 const writer=new ReadingCopies(dir,()=>value,code=>errors.push(code))
 try{
  const outside=join(dir,'outside.txt');await writeFile(outside,'keep',{mode:0o600});await symlink(outside,join(dir,'todos.md'))
  writer.start();await writer.flush()
  assert.equal(await readFile(outside,'utf8'),'keep');assert.ok(errors.length>0)
  assert.match(await readFile(join(dir,'profile.md'),'utf8'),/飞书讨论/)
  await rm(join(dir,'todos.md'));writer.schedule();await writer.flush();assert.match(await readFile(join(dir,'todos.md'),'utf8'),/暂无/)
  value.life.profile={about:'old change',version:1};writer.schedule();value.life.profile.about='最新介绍';writer.schedule();await writer.flush()
  const profile=join(dir,'profile.md');assert.match(await readFile(profile,'utf8'),/最新介绍/);const mtime=(await stat(profile)).mtimeMs
  writer.schedule();await writer.flush();assert.equal((await stat(profile)).mtimeMs,mtime)
  value=fixture();value.profile.last_success=null;value.profile.draft=null;value.profile.status='failed';writer.schedule();await writer.flush();assert.match(await readFile(profile,'utf8'),/最新介绍/)
  value.scope='local:b';writer.schedule();await writer.flush();assert.ok(!(await readFile(profile,'utf8')).includes('最新介绍'),'failed load of a different account must not retain prior account content')
 }finally{await writer.close();await rm(dir,{recursive:true,force:true})}
})

test('running app writes queued changes without shutdown and removal does not retain stale rows',async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'reading-live-')),value=fixture(),writer=new ReadingCopies(dir,()=>value)
 try{
  value.life.ideas=[{kind:'idea',id:'idea:one',version:1,title:'临时想法',note:'',created_at:'2026-10-21T00:00:00Z',updated_at:'2026-10-21T00:00:00Z',status:'active',goal_id:null}]
  writer.start()
  const deadline=Date.now()+5000;let content=''
  while(Date.now()<deadline){try{content=await readFile(join(dir,'ideas.md'),'utf8')}catch{/* queued first write */}if(content.includes('临时想法'))break;await new Promise(resolve=>setTimeout(resolve,20))}
  assert.ok(content.includes('临时想法'))
  value.life.ideas=[];writer.schedule();await writer.flush();assert.ok(!(await readFile(join(dir,'ideas.md'),'utf8')).includes('临时想法'))
 }finally{await writer.close();await rm(dir,{recursive:true,force:true})}
})
