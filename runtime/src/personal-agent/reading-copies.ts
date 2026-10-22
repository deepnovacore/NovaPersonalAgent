import {createHash,randomUUID} from 'node:crypto'
import {constants} from 'node:fs'
import {open,rename,unlink} from 'node:fs/promises'
import {join} from 'node:path'
import {preparePrivateDatabasePath} from '../storage/private-database.js'
import type {LifeService} from './life.js'
import type {TimelineBrief} from './timeline-brief.js'
import type {ProfileDraft} from './profile-warmup.js'

interface Source {id?:string|undefined;evidence_id?:string|undefined;label?:string|undefined;type?:string|undefined;url?:string|undefined;available?:boolean|undefined}
interface Profile {status:string;draft:ProfileDraft|null;last_success?:{draft:ProfileDraft;generated_at?:string|null;sources:Source[]}|null|undefined;sources:Source[]}
export interface ReadingSnapshot {
 scope:string
 life:ReturnType<LifeService['snapshot']>
 timeline:Pick<ReturnType<TimelineBrief['snapshot']>,'cards'|'updated_at'>
 timelineLoadFailed?:boolean
 profile:Profile
}
const titles={'profile.md':'个人画像','timeline.md':'时间线','todos.md':'待办','goals.md':'目标','ideas.md':'想法'} as const
type FileName=keyof typeof titles
const text=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/([\\`*_{}[\]()#+|~])/g,'\\$1').replace(/^(\s*)(-|[0-9]+\.) /gm,'$1\\$2 ')
const line=(value:string)=>text(value).replace(/[\r\n]+/g,' ')
const web=(value:string|undefined)=>{try{const u=new URL(value??'');return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href.replace(/[<>()]/g,c=>encodeURIComponent(c)):null}catch{return null}}
const sourceLines=(sources:readonly Source[])=>sources.map(s=>{const url=web(s.url),label=line(s.label??s.type??'来源');return `- ${url?`[${label}](<${url}>)`:label}${s.available===false?'（来源已不可用）':''}${s.id||s.evidence_id?` · ID：${line(s.id??s.evidence_id!)}`:''}`}).join('\n')
const notice='> 应用自动维护的阅读副本。数据库和应用保存状态为权威来源；手工修改不会回写，下次同步会覆盖。\n'
const scopeMarker=(scope:string)=>`<!-- nova-reading-copy:v1 scope=${createHash('sha256').update(scope).digest('hex')} -->`

export function renderReadingCopies(s:ReadingSnapshot):Record<FileName,string|null>{
 const result={} as Record<FileName,string|null>
 const wrap=(name:FileName,body:string)=>`${scopeMarker(s.scope)}\n# ${titles[name]}\n\n${notice}\n${body.trim()}\n`
 const history=s.profile.last_success,draft=history?.draft??s.profile.draft,manual=s.life.profile.version>0
 let profile=''
 if(manual)profile=`你手写的介绍（版本 ${s.life.profile.version}）\n\n${text(s.life.profile.about)||'你已清空个人介绍。'}`
 else if(draft){
  profile=history?.generated_at?`生成时间：${line(history.generated_at)}\n\n`:'生成时间未记录。\n\n'
  if(draft.about)profile+=`## 关于我\n\n${text(draft.about.text)}\n\n`
  for(const work of draft.work)profile+=`## ${line(work.title)}\n\n${text(work.text)}\n\n`
  if(draft.interests.length)profile+=`## 兴趣与关注\n\n${draft.interests.map(i=>'- '+text(i.text)).join('\n')}\n\n`
  const sources=sourceLines(history?.sources??s.profile.sources);if(sources)profile+='## 来源\n\n'+sources
 }else profile='暂无已保存画像。'
 result['profile.md']=!manual&&!draft&&s.profile.status==='failed'?null:wrap('profile.md',profile)
 let timeline=s.timeline.updated_at?`整理时间：${line(s.timeline.updated_at)}\n\n`:''
 for(const card of s.timeline.cards){
  timeline+=`## ${line(card.title)}\n\nID：${line(card.id)} · 分类：${line(card.category)}${card.status_label?' · '+line(card.status_label):''}\n\n`
  const dates=[['发生',card.time.occurred_on],['开始',card.time.started_on],['截止',card.time.due_on],['计划',card.time.scheduled_on],['最近报告',card.time.last_reported_on]].filter(([,d])=>d)
  if(dates.length)timeline+=dates.map(([label,d])=>`${label}：${line(d!)}`).join(' · ')+'\n\n'
  timeline+=text(card.why_now)+'\n\n'+card.facts.map(f=>'- '+text(f.text)).join('\n')+'\n\n'
  if(card.uncertainty)timeline+='待确认：'+text(card.uncertainty)+'\n\n'
  for(const step of card.next_steps)timeline+=`- 建议：${text(step.title)}；${text(step.detail)}\n`
  if(!card.sources_available)timeline+='\n部分原始来源已不可用，保留历史整理内容。\n'
  const sources=sourceLines(card.sources);if(sources)timeline+='\n来源：\n'+sources+'\n'
  timeline+='\n'
 }
 result['timeline.md']=s.timelineLoadFailed?null:wrap('timeline.md',timeline+(s.timeline.cards.length?'':'暂无已保存时间线。'))
 const statuses:Record<string,string>={open:'未开始',doing:'进行中',waiting:'等待中',done:'已完成',cancelled:'已取消',active:'推进中',paused:'暂停',completed:'已完成',archived:'已归档'}
 for(const kind of ['todos','goals','ideas'] as const){
  const rows=s.life[kind];let body=''
  const groups=kind==='todos'?[['未完成',['open','doing','waiting']],['已完成',['done']],['已取消',['cancelled']]]:kind==='goals'?[['进行中',['active','paused']],['已完成',['completed']],['已归档',['archived']]]:[['有效想法',['active']],['已归档',['archived']]]
  for(const [heading,status] of groups as [string,string[]][]){
   const selected=rows.filter(r=>status.includes(r.status));if(!selected.length)continue
   body+=`## ${heading}\n\n`
   for(const row of selected){
    body+=`### ${line(row.title)}\n\nID：${line(row.id)} · 状态：${statuses[row.status]} · 版本：${row.version}\n\n`
    body+=`创建：${line(row.created_at)} · 更新：${line(row.updated_at)}\n\n`
    if(row.note)body+=text(row.note)+'\n\n'
    if(row.importance==='high')body+='重要程度：高\n\n'
    if('due' in row&&row.due)body+='到期：'+line(row.due)+'\n\n'
    if('success_criteria' in row)body+=`达成标准：${text(row.success_criteria)||'未填写'}\n\n关联待办完成：${row.progress.done}/${row.progress.total}（不代表目标已达成）\n\n`
    if('goal_id' in row&&row.goal_id)body+='关联目标：'+line(row.goal_id)+'\n\n'
    if('idea_id' in row&&row.idea_id)body+='来自想法：'+line(row.idea_id)+'\n\n'
    if(kind==='ideas'){const targets=[...s.life.todos,...s.life.goals].filter(r=>r.idea_id===row.id);if(targets.length)body+='已关联：'+targets.map(r=>line(r.title)+'（'+line(r.id)+'）').join('、')+'\n\n'}
    const sources=sourceLines(row.sources??[]);if(sources)body+='来源：\n'+sources+'\n\n'
   }
  }
  const name=`${kind}.md` as FileName;result[name]=wrap(name,body||'暂无已保存记录。')
 }
 return result
}

/** One host owns these derived files under its existing process lock. */
export class ReadingCopies {
 #active=false;#timer:ReturnType<typeof setTimeout>|undefined;#tail:Promise<void>=Promise.resolve()
 constructor(readonly directory:string,readonly snapshot:()=>ReadingSnapshot,readonly diagnostic:(code:string)=>void=()=>{/* optional diagnostics */}){}
 start(){this.#active=true;this.schedule()}
 schedule(){if(!this.#active||this.#timer)return;this.#timer=setTimeout(()=>{this.#timer=undefined;void this.flush()},500);this.#timer.unref()}
 flush():Promise<void>{
  clearTimeout(this.#timer);this.#timer=undefined;if(!this.#active)return this.#tail
  const run=this.#tail.then(async()=>{
   const s=this.snapshot(),docs=renderReadingCopies(s)
   for(const name of Object.keys(titles) as FileName[])try{await this.#write(name,docs[name],s.scope)}catch{this.diagnostic('reading_copy_write_failed:'+name)}
  }).catch(()=>{this.diagnostic('reading_copies_snapshot_failed')})
  this.#tail=run;return run
 }
 async close(){if(!this.#active)return;const last=this.flush();this.#active=false;await last}
 async #write(name:FileName,content:string|null,scope:string){
  const path=preparePrivateDatabasePath(join(this.directory,name))
  const previous=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let old:string
  try{old=await previous.readFile('utf8')}finally{await previous.close()}
  if(content===null){if(old.startsWith(scopeMarker(scope)))return;content=`${scopeMarker(scope)}\n# ${titles[name]}\n\n${notice}\n当前资料暂时无法读取，等待下次同步。\n`}
  if(content===old)return
  const tmp=path+'.'+randomUUID()+'.tmp';let renamed=false
  try{
   const file=await open(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
   try{await file.writeFile(content);await file.sync()}finally{await file.close()}
   preparePrivateDatabasePath(path)
   await rename(tmp,path);renamed=true
   if(process.platform!=='win32'){const directory=await open(this.directory,constants.O_RDONLY);try{await directory.sync()}finally{await directory.close()}}
  }finally{if(!renamed)await unlink(tmp).catch(()=>{/* best-effort temporary file cleanup */})}
 }
}
