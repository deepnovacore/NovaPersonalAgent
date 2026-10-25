import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ensureBuiltInSkills,listSkills,skillsRoot} from '../src/main/skills-dir.mjs'

test('skills live under ~/.nova-personal-agent/skills',()=>{
 assert.equal(skillsRoot('/home/u'),'/home/u/.nova-personal-agent/skills')
})
test('the first run seeds Computer Use and never overwrites an edited SKILL.md',async()=>{
 const root=join(await mkdtemp(join(tmpdir(),'skills-')),'skills')
 try{
  assert.deepEqual(listSkills(root),[])
  ensureBuiltInSkills(root)
  assert.deepEqual(listSkills(root),[{id:'computer-use',name:'Computer Use',description:'真实截图与鼠标键盘操作，在 Build 会话中按需开启'}])
  await writeFile(join(root,'computer-use','SKILL.md'),'---\nname: Mine\n---\n')
  ensureBuiltInSkills(root)
  assert.equal(listSkills(root)[0].name,'Mine')
  await mkdir(join(root,'empty'));await mkdir(join(root,'.hidden'))
  await mkdir(join(root,'notes'));await writeFile(join(root,'notes','SKILL.md'),'---\nname: "Notes"\ndescription: 整理笔记\n---\nbody')
  assert.deepEqual(listSkills(root).map(s=>s.id),['computer-use','notes'])
  assert.equal(listSkills(root)[1].name,'Notes')
 }finally{await rm(join(root,'..'),{recursive:true,force:true})}
})
