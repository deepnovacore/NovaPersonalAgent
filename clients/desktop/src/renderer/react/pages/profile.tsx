import React from 'react'
import {Sparkles} from 'lucide-react'
import {Action,Field,Sources,PendingCandidates,usePage,t} from './shared'
import {MemorySection} from './memory'
import {Warmup} from './preferences'
import {shortLabel,profileTopics} from './profile-tags'

function InterestTags({interests}:{interests:any[]}){
 const [open,setOpen]=React.useState<number|null>(null),id=React.useId()
 return <section className="profile-interests" aria-label={t('关注')}><h4>{t('关注')}</h4><div className="interest-chips">{interests.map((item:any,i:number)=>{const full=t(item.text),label=shortLabel(full)||full;return <button type="button" className="interest-tag" key={`${item.text}-${i}`} title={full} aria-expanded={open===i} aria-controls={`${id}-detail`} aria-label={label===full?undefined:`${label}：${full}`} onClick={()=>setOpen(open===i?null:i)}>{label}</button>})}</div>{open!==null&&interests[open]&&<p className="interest-detail" id={`${id}-detail`}>{t(interests[open].text)}</p>}</section>
}

export function ProfilePage(){
 const {snapshot:s,local,setLocal,command,delegate,pending}=usePage(),state=s?.life,warmup=s?.profile_preparation,products=s?.derived_understanding
 const manual=state?.profile?.version>0,saved=!manual&&!warmup?.draft?warmup?.last_success:null,portrait=manual?null:warmup?.draft??saved?.draft
 const confirmed=state?.profile?.about??'',about=confirmed||portrait?.about?.text||'',work=portrait?.work??[],draft=local.profile
 const sources=new Map((saved?.sources??warmup?.sources??[]).map((source:any)=>[source.id,source.label+(source.available===false?' · '+t('来源已不可用'):'')])),allInterests=((warmup?.draft??saved?.draft)?.interests??[]).filter((item:any)=>item&&typeof item.text==='string'&&item.text.trim())
 const {keywords,interests}=profileTopics((warmup?.draft??saved?.draft)?.keywords,allInterests,work)
 const edit=()=>setLocal('profile',{about:confirmed||(!saved?[portrait?.about?.text,...work.map((item:any)=>`${item.title}：${item.text}`)].filter(Boolean).join('\n\n'):''),version:state?.profile?.version??0})
 return <><h2>{t('关于我')}</h2><Warmup/><div className="profile-main">
  <section className="preference-card"><h3>{t(manual||draft?'自我介绍':'我眼中的你')}</h3>
   {draft?<><Field label="关于我" multiline maxLength={5000} value={draft.about} disabled={pending.has('profile:save')} onChange={(v:string)=>setLocal('profile',{...draft,about:v})}/><div className="preference-actions"><Action className="page-add" actionKey="profile:save" action={async()=>{await command('life.mutate',{op:'profile',expected_version:draft.version,about:draft.about});setLocal('profile',undefined)}}>{t('保存介绍')}</Action><Action actionKey="profile:save" action={()=>setLocal('profile',undefined)}>{t('取消编辑')}</Action></div></>:<>
    {keywords.length>0&&<ul className="profile-keywords" aria-label={t('关键词')}>{keywords.map(word=><li key={word}>{t(word)}</li>)}</ul>}
    <p className="preference-caption">{t(about||work.length?'这是我目前认识的你，也欢迎你随时补充。':manual?'你想写的时候，随时补上就好。':'我们还可以慢慢认识。你可以先聊聊自己，或者写下一段介绍。')}</p>
    {about&&<div className="profile-about"><p className="profile-preview">{about}</p>{!manual&&portrait?.about&&<Sources title="查看来源" labels={portrait.about.refs?.map((r:any)=>sources.get(r.entry_id))}/>}</div>}
    {work.length>0&&<div className="profile-work">{work.map((item:any,i:number)=><article className="profile-work-item" key={i}><span className="profile-work-icon" aria-hidden="true"><Sparkles size={16}/></span><div className="profile-work-copy"><h4>{item.title}</h4><p>{item.text}</p><Sources labels={item.refs?.map((r:any)=>sources.get(r.entry_id))}/></div></article>)}</div>}
    {interests.length>0&&<InterestTags interests={interests}/>}
    <div className="preference-actions"><Action action={edit}>{t(saved?'补充介绍':about||work.length?'编辑介绍':'介绍一下自己')}</Action><Action action={()=>delegate(t('我想聊聊自己，和你一起补充对我的了解。'))}>{t('聊聊我')}</Action>{warmup&&<Action actionKey="profile:refresh" disabled={warmup.status==='working'} action={()=>command('profile.refresh',{})}>{t(warmup.status==='working'?'正在整理…':'更新一下')}</Action>}</div>
   </>}
  </section>
  {products?.projects?.length>0&&<section className="profile-projects"><h3>{t('项目与参与')}</h3>{products.projects.map((project:any)=><article className="profile-project" key={project.id}><h4>{project.name}</h4><p>{project.summary}</p><div className="card-actions">{[['participating','正在参与'],['historical','历史项目'],['reference','参考资料'],['automatic','自动判断']].map(([value,label])=><Action key={value} className="quiet" aria-pressed={products.corrections?.[project.id]===value} actionKey={`project:${project.id}`} action={()=>command('projects.correct',{id:project.id,value})}>{t(label)}</Action>)}</div></article>)}</section>}
 </div><PendingCandidates kind="profile"/><MemorySection/></>
}
