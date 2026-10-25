import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

export const skillsRoot=(home=homedir())=>join(home,'.nova-personal-agent','skills')

const COMPUTER_USE=`---
name: Computer Use
description: 真实截图与鼠标键盘操作，在 Build 会话中按需开启
---

在 Build 会话中按需开启。开启后 Nova 可以截取屏幕、移动鼠标、点击和输入，并在屏幕上显示操作指示；你随时可以停止。
`

/** The first run seeds Computer Use as an ordinary skill folder; an existing SKILL.md is never overwritten. */
export function ensureBuiltInSkills(root=skillsRoot()){
 const file=join(root,'computer-use','SKILL.md')
 if(existsSync(file))return
 try{mkdirSync(join(root,'computer-use'),{recursive:true});writeFileSync(file,COMPUTER_USE,{flag:'wx'})}catch{}
}

function frontmatter(text){
 const match=/^---\r?\n([\s\S]*?)\r?\n---/.exec(text),meta={}
 for(const line of match?.[1].split(/\r?\n/)??[]){const at=line.indexOf(':');if(at>0)meta[line.slice(0,at).trim()]=line.slice(at+1).trim().replace(/^["']|["']$/g,'')}
 return meta
}

/** Every `<root>/<id>/SKILL.md` is one skill; unreadable or missing folders simply yield nothing. */
export function listSkills(root=skillsRoot()){
 let names
 try{names=readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.')).map(entry=>entry.name).sort()}catch{return []}
 const skills=[]
 for(const id of names){
  try{const meta=frontmatter(readFileSync(join(root,id,'SKILL.md'),'utf8'));skills.push({id,name:meta.name||id,description:meta.description||''})}catch{}
 }
 return skills
}
