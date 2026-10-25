import {t,currentLanguage,setLanguage} from './locale.mjs'
const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n}
const ROLE_LIMIT=1000,INTRO_ROLE_LIMIT=80
const oneLine=(text,limit)=>{const flat=String(text).replace(/\s+/gu,' ').trim();return flat.length>limit?flat.slice(0,limit)+'…':flat}
const filled=value=>typeof value==='string'&&value.trim()!==''
/** Spoken description generated from snapshot fields only. It never reaches a model and invents no traits. */
export function soulIntro(soul,lang=currentLanguage()){
 const previous=currentLanguage();setLanguage(lang)
 try{
  const parts=[]
  if(filled(soul?.assistant_name))parts.push(t('我叫{0}。',soul.assistant_name.trim()))
  parts.push(filled(soul?.role)?t('你希望我是——{0}。',oneLine(soul.role,INTRO_ROLE_LIMIT)):t('你还没告诉我希望我是什么样的，想好了在下面写给我就行。'))
  if(filled(soul?.reply_style))parts.push(t('平时说话我会按你说的来：{0}。',oneLine(soul.reply_style,INTRO_ROLE_LIMIT)))
  const contact=soul?.contact
  if(contact){
   if(contact.briefs_on||contact.discovery_on)parts.push(t('我最多每天主动找你 {0} 次，{1} 到 {2} 不打扰你。',contact.daily_cap,contact.quiet_start,contact.quiet_end))
   else parts.push(t('我不会主动来找你，你叫我我再出现。'))
  }
  return parts.join(lang==='en'?' ':'')
 }finally{setLanguage(previous)}
}
export function contactSummary(contact){
 if(!contact)return ''
 const lines=[t('每天最多主动找你 {0} 次；{1} 到 {2} 不打扰你。',contact.daily_cap,contact.quiet_start,contact.quiet_end)]
 lines.push(contact.briefs_on?t('简报：已开启'):t('简报：未开启'),contact.discovery_on?t('主动发现：已开启'):t('主动发现：未开启'))
 return lines.join(' · ')
}
const failureText=message=>message==='stale'?t('角色设定刚刚在别处被改过，你的草稿还在，请核对最新内容后再保存。'):message==='memory_unavailable'?t('记忆还没开启，所以暂时不能保存角色设定。'):t('保存失败：{0}',message)
export function renderSoulCard(parent,{soul,command,button,local,rerender,openSettings}){
 const card=el('section',undefined,'preference-card soul-card');card.setAttribute('aria-label',t('我的样子'));parent.append(card)
 const head=el('div');head.append(el('h3',t('我的样子')),el('p',t('这是你期望的我，你说了算'),'preference-caption'));card.append(head)
 if(!soul){card.append(el('p',t('正在读取…'),'preference-caption'));return card}
 card.append(el('p',soulIntro(soul),'soul-intro'))
 const name=el('div',undefined,'soul-row');name.append(el('h4',t('名字')),el('p',soul.assistant_name));button(t('改名字'),()=>openSettings?.('general'),name).className='ghost';card.append(name)
 const role=el('div',undefined,'soul-row');role.append(el('h4',t('角色设定')));card.append(role)
 const draft=local.soul
 if(draft){
  const input=el('textarea');input.value=draft.role;input.maxLength=ROLE_LIMIT;input.setAttribute('aria-label',t('角色设定'));input.placeholder=t('比如：一个靠谱、说话直接、不啰嗦的搭档');input.addEventListener('input',()=>{draft.role=input.value});role.append(input);input.pendingKey='soul:save'
  if(draft.error)role.append(Object.assign(el('p',draft.error,'soul-error'),{role:'alert'}))
  const actions=el('div',undefined,'preference-actions');role.append(actions)
  const save=button(t('保存'),async()=>{
   try{await command('soul.set',{role:draft.role,expected_version:draft.version});delete local.soul}
   catch(error){draft.error=failureText(error?.message??'');}
   rerender()
  },actions,'soul:save');save.className='page-add';if(!soul.available)save.disabled=true
  button(t('取消'),()=>{delete local.soul;rerender()},actions,'soul:save')
  if(!soul.available)role.append(el('p',t('记忆还没开启，所以暂时不能保存角色设定。'),'soul-error'))
 }else{
  role.append(el('p',filled(soul.role)?soul.role:t('比如：一个靠谱、说话直接、不啰嗦的搭档'),filled(soul.role)?'soul-role':'soul-role soul-placeholder'))
  const actions=el('div',undefined,'preference-actions');role.append(actions)
  const edit=button(filled(soul.role)?t('编辑'):t('写下来'),()=>{local.soul={role:soul.role??'',version:soul.version??0,error:''};rerender()},actions);if(!soul.available)edit.disabled=true
  if(!soul.available)role.append(el('p',t('记忆还没开启，所以暂时不能保存角色设定。'),'soul-error'))
 }
 const style=el('div',undefined,'soul-row');style.append(el('h4',t('说话方式')),el('p',filled(soul.reply_style)?soul.reply_style:t('还没有特别的要求')),el('p',t('想改就直接跟我说'),'preference-caption'));card.append(style)
 const contact=el('div',undefined,'soul-row');contact.append(el('h4',t('联系方式')),el('p',contactSummary(soul.contact)));button(t('去调整'),()=>openSettings?.('general'),contact).className='ghost';card.append(contact)
 return card
}
