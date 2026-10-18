import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {inspectProject} from '../src/personal-agent/project-history.js'
test('linked worktrees share project identity but retain their own unmerged work and authors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'project-history-')),repo=join(dir,'project'),branch=join(dir,'old-directory-name')
 const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
 try{git('init','-b','main',repo);git('-C',repo,'config','user.name','Fixture Author');git('-C',repo,'config','user.email','fixture@example.invalid');await writeFile(join(repo,'plan.md'),'Initial work');git('-C',repo,'add','.');git('-C',repo,'commit','-m','Initial project');git('-C',repo,'worktree','add','-b','feature/work',branch);await writeFile(join(branch,'plan.md'),'Unique research');git('-C',branch,'commit','-am','Unmerged research')
 const main=await inspectProject(repo),linked=await inspectProject(branch)
 assert.equal(main.id,linked.id);assert.equal(main.name,linked.name);assert.equal(linked.unmerged[0]?.subject,'Unmerged research');assert.equal(linked.commits[0]?.author,'Fixture Author');assert.equal(linked.commits[0]?.self,true);assert.equal(linked.worktree_alias,'old-directory-name')
 }finally{await rm(dir,{recursive:true,force:true})}
})


test('a clone reports upstream authors separately from the user work added to a fork',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'project-clone-')),upstream=join(dir,'upstream'),fork=join(dir,'fork')
 const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
 try{git('init','-b','main',upstream);git('-C',upstream,'config','user.name','Upstream Author');git('-C',upstream,'config','user.email','upstream@example.invalid');await writeFile(join(upstream,'plan.md'),'Upstream plan');git('-C',upstream,'add','.');git('-C',upstream,'commit','-m','Upstream project');git('clone',upstream,fork);git('-C',fork,'config','user.name','Fixture User');git('-C',fork,'config','user.email','fixture-user@example.invalid')
 const cloned=await inspectProject(fork);assert.equal(cloned.commits[0]?.self,false);assert.equal(cloned.commits[0]?.author,'Upstream Author')
 await writeFile(join(fork,'plan.md'),'User implementation');git('-C',fork,'commit','-am','User implementation');const developed=await inspectProject(fork);assert.equal(developed.id,cloned.id);assert.equal(developed.commits[0]?.self,true);assert.equal(developed.commits[1]?.self,false)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('a missing archived directory has unavailable history instead of stopping other projects',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'project-missing-'))
 try{const result=await inspectProject(join(dir,'missing'));assert.equal(result.history_available,false);assert.equal(result.git,false);assert.deepEqual(result.commits,[])}finally{await rm(dir,{recursive:true,force:true})}
})
