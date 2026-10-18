import {t} from './locale.mjs'
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=t(text);if(cls)n.className=cls;return n}
const action=(text,parent,fn)=>{const b=el('button',text);b.type='button';b.addEventListener('click',fn);parent.append(b);return b}
function editor(root,{api,save,onUpdate}){
 const portrait=el('div',undefined,'assistant-portrait'),image=el('img');image.alt=t('助手头像');portrait.append(image);root.append(portrait)
 const actions=el('div',undefined,'avatar-actions');root.append(actions)
 const error=el('p','','welcome-error');error.setAttribute('role','alert')
 let busy=false,view=null,dirty=false
 const perform=async fn=>{if(busy)return;busy=true;for(const b of root.querySelectorAll('button'))b.disabled=true;error.textContent='';try{await fn()}catch{error.textContent=t('未能保存，请检查连接后重试。头像支持 8 MB 以内的 PNG、JPEG 或 WebP。')}finally{busy=false;for(const b of root.querySelectorAll('button'))b.disabled=false}}
 action('更换头像',actions,()=>perform(async()=>onUpdate(await api.avatar())))
 action('恢复默认头像',actions,()=>perform(async()=>onUpdate(await api.avatar(true))))
 const fields=el('div',undefined,'identity-fields')
 const field=(label,placeholder)=>{const wrap=el('label',label),input=el('input');input.type='text';input.maxLength=40;input.placeholder=t(placeholder);input.setAttribute('aria-label',t(label));input.addEventListener('input',()=>{dirty=true});wrap.append(input);fields.append(wrap);return input}
 const user=field('我该怎么称呼你？','可以先不填'),assistant=field('给我起个名字吧','nova');assistant.value='nova';root.append(fields)
 const choices=el('div',undefined,'identity-name-choices');for(const name of ['nova','小星'])action(name,choices,()=>{assistant.value=name;dirty=true;assistant.focus()});root.append(choices)
 const submit=action('保存',root,()=>perform(async()=>{await save({assistantName:assistant.value,userName:user.value});dirty=false;if(view){user.value=view.profile.userName;assistant.value=view.profile.assistantName}}))
 submit.className='welcome-primary';root.append(error)
 root.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&event.target?.tagName==='INPUT'){event.preventDefault();submit.click()}})
 return {submit,error:()=>{error.textContent=t('暂时无法读取或保存设置，请重试。')},update(value){view=value;image.src=view.profile.avatar??view.defaultAvatar;if(!dirty){user.value=view.profile.userName;assistant.value=view.profile.assistantName}},get busy(){return busy}}
}
export function mountAssistantWelcome(root,{api,c,onIdentity}){
 root.replaceChildren();root.className='chat-intro assistant-welcome'
 const heading=el('div',undefined,'assistant-greeting'),portrait=el('img');portrait.alt='';heading.append(portrait);const title=el('h1');heading.append(title);root.append(heading)
 const hello=el('p','','welcome-bubble'),explain=el('p','你可以和我聊想法，也可以把事情交给我。需要访问文件或操作电脑时，我会根据已配置的能力请求相应授权。','welcome-bubble');root.append(hello,explain)
 const form=el('div',undefined,'welcome-name-card');root.append(form)
 let view=null,synced=null,syncing=false,syncFailed=false,wasConnected=false
 const configure=async profile=>{const result=await c.command('identity.configure',{assistant_name:profile.assistantName.trim()||'nova',user_name:profile.userName.trim()});if(result?.error)throw Error(result.error);synced=JSON.stringify([profile.assistantName.trim()||'nova',profile.userName.trim()]);syncFailed=false}
 const edit=editor(form,{api,onUpdate:onIdentity,save:async patch=>{if(!c.connected)throw Error('not_connected');await configure(patch);onIdentity(await api.save({...patch,introduced:true}))}})
 edit.submit.textContent=t('就这样，开始吧')
 const status=el('p','','hint');status.setAttribute('role','status');root.append(status)
 const retry=action('重试同步名字',root,()=>{syncFailed=false;sync()});retry.hidden=true
 const sync=()=>{
  if(!c.connected){wasConnected=false;syncFailed=false;synced=null}
  else if(!wasConnected){wasConnected=true;syncFailed=false}
  edit.submit.disabled=!c.connected||c.presentationReady===false||edit.busy
  if(!view?.profile.introduced||!c.connected||c.presentationReady===false||syncing||syncFailed)return
  const key=JSON.stringify([view.profile.assistantName,view.profile.userName]);if(key===synced)return
  syncing=true;status.textContent=t('正在记住我们的称呼…')
  void configure(view.profile).then(()=>{status.textContent='';retry.hidden=true},()=>{syncFailed=true;retry.hidden=false;status.textContent=t('名字尚未同步到对话，请重试。')}).finally(()=>{syncing=false})
 }
 return {sync,update(value){view=value;const p=view.profile;portrait.src=p.avatar??view.defaultAvatar;title.textContent=p.assistantName;hello.textContent=p.introduced?t('你好{0}，我是 {1}。今天想一起做点什么？',p.userName?'，'+p.userName:'',p.assistantName):t('你好，我是 {0}，住在你电脑里的私人助理。很高兴认识你。',p.assistantName);form.hidden=p.introduced;explain.hidden=p.introduced;edit.update(value);sync()}}
}
export function mountIdentitySettings(root,{api,command}){
 let view=null
 const edit=editor(root,{api,onUpdate:value=>{view=value;edit.update(value)},save:async patch=>{
  const result=await command('identity.configure',{assistant_name:patch.assistantName.trim()||'nova',user_name:patch.userName.trim()});if(result?.error)throw Error(result.error)
  view=await api.save(patch);edit.update(view)
 }})
 root.append(el('p','名字会用于对话称呼。头像保存在本机，不会发送给模型。','hint'))
 return {update:value=>{view=value;edit.update(value)},error:edit.error}
}
