const noop = Object.freeze({setIdle(){},setEnabled(){},setVisible(){},update(){},destroy(){}})

/** A decorative movie never owns audio, input, or assistant state. */
export function createIdlePlayback({video,image,document,mediaQuery}) {
 let idle=false,enabled=true,visible=true,failed=false,destroyed=false,requested=false,playGeneration=0
 video.muted=true;video.defaultMuted=true;video.loop=true;video.playsInline=true;video.controls=false;video.preload='metadata'
 const eligible=()=>idle&&enabled&&visible&&!failed&&!destroyed&&!document.hidden&&!mediaQuery?.matches
 const still=()=>{video.hidden=true;image.hidden=false;image.style.visibility=''}
 const update=()=>{
  if(!eligible()){playGeneration++;requested=false;video.pause();still();return}
  if(requested)return
  requested=true;const generation=++playGeneration
  try{Promise.resolve(video.play()).catch(()=>{if(destroyed||generation!==playGeneration||!eligible())return;requested=false;failed=true;video.pause();still()})}
  catch{requested=false;failed=true;video.pause();still()}
 }
 const playing=()=>{if(eligible()){video.hidden=false;image.style.visibility='hidden'}else{video.pause();still()}}
 const error=()=>{failed=true;update()}
 video.addEventListener('playing',playing);video.addEventListener('error',error)
 document.addEventListener('visibilitychange',update);mediaQuery?.addEventListener('change',update);still()
 return {
  setIdle(value){idle=Boolean(value);update()},setEnabled(value){enabled=Boolean(value);update()},setVisible(value){visible=Boolean(value);update()},
  destroy(){destroyed=true;update();video.removeEventListener('playing',playing);video.removeEventListener('error',error);document.removeEventListener('visibilitychange',update);mediaQuery?.removeEventListener('change',update)},
 }
}

export function mountIdleAvatar(image,{movieUrl=null}={}) {
 if(!movieUrl)return {...noop,update(value){image.src=value.profile.avatar??value.defaultAvatar}}
 const doc=image.ownerDocument
 if(!image.replaceWith||!doc?.createElement)return noop
 const video=doc.createElement('video')
 if(typeof video.play!=='function')return noop
 const wrapper=doc.createElement('span');wrapper.className='idle-avatar'
 video.src=movieUrl;video.setAttribute('aria-hidden','true');video.tabIndex=-1
 image.replaceWith(wrapper);wrapper.append(image,video)
 const view=doc.defaultView,control=createIdlePlayback({video,image,document:doc,mediaQuery:view?.matchMedia?.('(prefers-reduced-motion: reduce)')})
 const observer=view?.IntersectionObserver?new view.IntersectionObserver(entries=>control.setVisible(entries.some(entry=>entry.isIntersecting))):null
 if(observer){control.setVisible(false);observer.observe(wrapper)}
 return {...control,update(value){image.src=value.profile.avatar??value.defaultAvatar;video.poster=image.src;control.setEnabled(!value.profile.avatar)},destroy(){observer?.disconnect();control.destroy();video.removeAttribute('src');video.load();wrapper.replaceWith(image)}}
}

/** Layer the mascot over the existing orb only for the default skin's idle state. */
export function mountOrbIdle(orb,canvas,video) {
 if(!orb||!video)return {profile(){},state(){},settings(){},destroy(){}}
 const doc=orb.ownerDocument,image=doc.createElement('img'),layer=doc.createElement('span')
 layer.className='orb-idle-avatar';layer.hidden=true;image.alt='';video.remove();layer.append(image,video);orb.append(layer)
 let profile=null,idle=false,defaultSkin=true
 const control=createIdlePlayback({video,image,document:doc,mediaQuery:doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)')})
 const observer=new doc.defaultView.IntersectionObserver(entries=>control.setVisible(entries.some(entry=>entry.isIntersecting)))
 control.setVisible(false);observer.observe(layer)
 const update=()=>{const show=idle&&defaultSkin&&profile&&!profile.profile.avatar;layer.hidden=!show;canvas.style.visibility=show?'hidden':'';control.setIdle(show)}
 return {
  profile(value){profile=value;image.src=value.profile.avatar??value.defaultAvatar;video.poster=image.src;update()},
  state(name,{codexWorking=false}={}){idle=name==='idle'&&!codexWorking;update()},
  settings(value){defaultSkin=!value.skinId||value.skinId==='nova';update()},
  destroy(){observer.disconnect();control.destroy();layer.remove();canvas.style.visibility=''},
 }
}
