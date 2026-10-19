import test from 'node:test'
import assert from 'node:assert/strict'
import {createIdlePlayback,mountIdleAvatar,mountOrbIdle} from '../src/renderer/idle-avatar.mjs'

function fixture(){
 const listeners=new Map(),mediaListeners=new Map();let plays=0,pauses=0
 const video={hidden:true,addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k),play:()=>{plays++;return Promise.resolve()},pause:()=>{pauses++}},image={hidden:false,style:{}}
 const doc={hidden:false,addEventListener:(k,v)=>listeners.set('doc:'+k,v),removeEventListener:k=>listeners.delete('doc:'+k)}
 const media={matches:false,addEventListener:(k,v)=>mediaListeners.set(k,v),removeEventListener:k=>mediaListeners.delete(k)}
 const control=createIdlePlayback({video,image,document:doc,mediaQuery:media})
 return {video,image,doc,media,listeners,mediaListeners,control,get plays(){return plays},get pauses(){return pauses}}
}
test('idle movie is muted and looped, exposes frames only after playback and pauses outside idle',()=>{
 const f=fixture();f.control.setIdle(true);assert.equal(f.plays,1);assert.equal(f.video.muted,true);assert.equal(f.video.loop,true)
 assert.equal(f.video.hidden,true);f.listeners.get('playing')();assert.equal(f.video.hidden,false);assert.equal(f.image.style.visibility,'hidden')
 f.control.setIdle(false);assert.equal(f.video.hidden,true);assert.equal(f.image.hidden,false);assert.ok(f.pauses>0)
 f.listeners.get('playing')();assert.equal(f.video.hidden,true,'late frame cannot reappear after state change')
 f.control.destroy();assert.equal(f.listeners.size,0)
})
test('custom avatar, reduced motion, hidden/offscreen page and media errors retain the still fallback',()=>{
 const f=fixture();f.control.setIdle(true);f.control.setVisible(false);assert.equal(f.video.hidden,true)
 const count=f.plays;f.doc.hidden=true;f.control.setVisible(true);assert.equal(f.plays,count)
 f.doc.hidden=false;f.listeners.get('doc:visibilitychange')();assert.equal(f.plays,count+1)
 f.media.matches=true;f.mediaListeners.get('change')();assert.equal(f.video.hidden,true)
 f.media.matches=false;f.control.setEnabled(false);f.mediaListeners.get('change')();assert.equal(f.video.hidden,true)
 f.control.setEnabled(true);f.listeners.get('error')();f.control.setIdle(false);f.control.setIdle(true);assert.equal(f.video.hidden,true);assert.equal(f.image.hidden,false)
})

 test('pausing a pending play request does not permanently poison later playback',async()=>{
 const f=fixture();let reject
 f.video.play=()=>new Promise((_,fail)=>{reject=fail})
 f.control.setIdle(true);f.control.setIdle(false);reject(Error('interrupted'))
 await new Promise(resolve=>setImmediate(resolve))
 let resumed=false;f.video.play=()=>{resumed=true;return Promise.resolve()}
 f.control.setIdle(true);assert.equal(resumed,true);f.listeners.get('playing')();assert.equal(f.video.hidden,false)
 f.control.destroy()
 })


test('an unconfigured avatar remains a still image without loading decorative media',()=>{
 const created=[]
 const image={src:'',style:{},replaceWith(){throw Error('still image must remain mounted')},ownerDocument:{createElement:tag=>{created.push(tag);return {play(){}}}}}
 const control=mountIdleAvatar(image)
 control.update({profile:{avatar:null},defaultAvatar:'data:image/png;base64,default'})
 control.setIdle(true)
 assert.equal(image.src,'data:image/png;base64,default')
 control.update({profile:{avatar:'data:image/png;base64,custom'},defaultAvatar:'data:image/png;base64,default'})
 assert.equal(image.src,'data:image/png;base64,custom')
 assert.deepEqual(created,[])
 control.destroy()
})

test('an orb without a configured video keeps its original canvas visible',()=>{
 const canvas={style:{visibility:''}}
 const control=mountOrbIdle({},canvas,null)
 control.profile({profile:{avatar:null},defaultAvatar:'default'})
 control.state('idle');control.settings({skinId:'nova'});control.destroy()
 assert.equal(canvas.style.visibility,'')
})
