import {t} from './locale.mjs'
import {iconNode,withIcon} from './icons.mjs'
import {readDisplayPreferences,subscribeDisplayPreferences} from './view-preferences.mjs'

const labels={prepared:'等待执行',awaiting_approval:'待确认',running:'执行中',completed:'已完成',failed:'失败',denied:'已拒绝',refused:'已拒绝',timed_out:'已超时',cancelled:'已取消',cancelled_before_execution:'未执行',cancelled_after_finish:'未执行',outcome_unknown:'结果不确定'}
/** Exported for the source-coverage test; every code must translate. */
export const BUILD_STEP_STATUS_LABELS=labels
export const BUILD_STEP_COMPUTER_LABELS={computer_screenshot:'截图',computer_click:'点击',computer_type:'输入',computer_scroll:'滚动',computer_key:'快捷键'}
const failed=new Set(['failed','timed_out','outcome_unknown','refused','denied'])
const COMPUTER_LABELS=BUILD_STEP_COMPUTER_LABELS
const SHOT_CACHE=12
const ACTIVE_STATUSES=new Set(['running','awaiting_approval'])
const MAX_THINKING_CHARS=200
const THINKING_ICON_PATH='M8.5 4.5a4 4 0 0 1 3.7 5.5 3.2 3.2 0 0 1 .8 6.2V19h-3v-1.5H9V19H6v-2.8a3.2 3.2 0 0 1 .8-6.2 4 4 0 0 1 1.7-5.5zM6.5 22h7'
const SVG_NS='http://www.w3.org/2000/svg'

/** Computer calls read as actions ("点击 · 412, 220"), not as raw JSON arguments. */
export function computerCallTarget(item){
 if(!Object.hasOwn(COMPUTER_LABELS,item.name))return null
 let args={};try{args=JSON.parse(item.input)}catch{ /* a truncated preview keeps only the label */ }
 const detail=item.name==='computer_click'&&Number.isFinite(args.x)&&Number.isFinite(args.y)?`${args.x}, ${args.y}`
  :item.name==='computer_scroll'&&typeof args.direction==='string'?t(({up:'向上',down:'向下',left:'向左',right:'向右'})[args.direction]??args.direction)
  :item.name==='computer_type'&&typeof args.text==='string'?`“${args.text.length>40?args.text.slice(0,40)+'…':args.text}”`
  :item.name==='computer_key'&&typeof args.keys==='string'?args.keys
  :''
 return t(COMPUTER_LABELS[item.name])+(detail?' · '+detail:'')
}

/** One-line reasoning preview: standard rows truncate, detailed rows keep the whole text. */
export function thinkingSummary(text,max=MAX_THINKING_CHARS){
 const clean=String(text??'').replace(/\s+/gu,' ').trim()
 if(!clean||max<=0)return ''
 const points=[...clean]
 return points.length>max?points.slice(0,max).join('')+'…':clean
}

export function relativeStepTime(value){
 const time=Date.parse(value??'')
 if(!Number.isFinite(time))return ''
 const seconds=Math.max(0,Math.round((Date.now()-time)/1000))
 if(seconds<60)return seconds+'s'
 const minutes=Math.round(seconds/60)
 if(minutes<60)return minutes+'m'
 const hours=Math.round(minutes/60)
 if(hours<24)return hours+'h'
 return Math.round(hours/24)+'d'
}

export function stepDuration(milliseconds){
 if(!Number.isFinite(milliseconds)||milliseconds<0)return ''
 if(milliseconds<60_000)return (milliseconds/1000).toFixed(1)+'s'
 const seconds=Math.round(milliseconds/1000)
 return Math.floor(seconds/60)+'m '+(seconds%60)+'s'
}

function thinkIcon(){
 const create=globalThis.document?.createElementNS?.bind(globalThis.document)
 if(!create)return null
 const svg=create(SVG_NS,'svg'),path=create(SVG_NS,'path')
 svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('class','ui-icon')
 path.setAttribute('d',THINKING_ICON_PATH);svg.append(path);return svg
}

/**
 * Build's interleaved step log: one collapsible group after each user message,
 * rendering provider thinking and tool calls in their chronological order.
 * Reads `build.details {view:'steps'}` incrementally from `build.log_revision`;
 * older hosts that cannot page thoughts gracefully degrade to the `calls` view.
 */
export function createBuildSteps({c,el,changed,display}){
 const readPreferences=display?.read??readDisplayPreferences
 const subscribe=display?.subscribe??subscribeDisplayPreferences
 let prefs=readPreferences()
 let selected='',version=0,items=[],loadedFirstId=null,loadedThoughtsFirstId=null,loading=null,loadedRevision=-1,failedRevision=-1,error='',timer=null,connected=false,mode='steps'
 const nodes=new Map(),groups=new Map(),shots=new Map()
 const notice=el('div',undefined,'build-log-notice'),retry=el('button',t('重试')),errorText=el('span')
 retry.type='button';withIcon(retry,'refresh');{const alert=iconNode('alert');if(alert)notice.append(alert)};notice.append(errorText,retry)
 retry.addEventListener('click',()=>{failedRevision=-1;error='';update()})
 const unsubscribe=subscribe?subscribe(value=>receivePreferences(value)):null
 const current=()=>c.selectedConversation?.kind==='build'?c.selectedConversation:null
 const selection=()=>{const item=current();return item?JSON.stringify([item.id,item.generation??0]):''}
 const activeStatus=()=>ACTIVE_STATUSES.has(current()?.build?.status)
 const stepKey=step=>step?.kind==='thinking'?`thinking:${step.id}`:`tool:${step.id??step.sequence}`

 function receivePreferences(value){
  if(!value)return
  const previous=prefs;prefs={...prefs,...value}
  if(previous.collapse!==prefs.collapse){
   // Only an explicit collapse-mode change re-evaluates open groups; density is a pure render concern.
   for(const node of groups.values()){
    if(!activeStatus()&&prefs.collapse==='after_reply')node.open=false
    applyOpen(node)
   }
  }
  if(previous.steps!==prefs.steps||previous.collapse!==prefs.collapse)changed()
 }
 function elapsed(item,node){
  const start=Date.parse(item.started_at??''),end=item.finished_at?Date.parse(item.finished_at):item.state==='running'?Date.now():NaN
  node.textContent=Number.isFinite(start)&&Number.isFinite(end)?stepDuration(Math.max(0,end-start)):''
 }
 function groupDuration(steps){
  let start=Infinity,end=-Infinity,any=false
  for(const step of steps){
   if(step?.kind!=='tool')continue
   any=true
   const from=Date.parse(step.started_at??step.created_at??'')
   if(Number.isFinite(from))start=Math.min(start,from)
   const to=step.finished_at?Date.parse(step.finished_at):step.state==='running'?Date.now():NaN
   if(Number.isFinite(to))end=Math.max(end,to)
  }
  return any&&Number.isFinite(start)&&Number.isFinite(end)&&end>=start?stepDuration(end-start):''
 }
 async function fetchPage(id,offset){
  if(mode==='calls'){
   const page=await c.command('build.details',{id,view:'calls',offset})
   return {...page,items:(page?.items??[]).map(item=>({kind:'tool',...item}))}
  }
  try{
   const page=await c.command('build.details',{id,view:'steps',offset})
   return {...page,items:(page?.items??[]).map(item=>item?.kind==='thinking'
    ?{kind:'thinking',id:String(item.id??''),text:String(item.text??''),created_at:item.created_at??'',message_id:item.message_id??null}
    :{kind:'tool',...item})}
  }catch(cause){
   // A pre-steps host rejects the unknown view with invalid_params; transient
   // read failures stay on the steps view and are retried from the same offset.
   const code=cause?.refusal_code??cause?.message
   if(items.length||!['invalid_params','unknown_view','unsupported_view'].includes(code))throw cause
   mode='calls'
   const page=await c.command('build.details',{id,view:'calls',offset})
   return {...page,items:(page?.items??[]).map(item=>({kind:'tool',...item}))}
  }
 }
 async function load(revision){
  const token={version:++version},id=c.selectedId,generation=current()?.generation??0
  loading=token
  try{
   // A running call can grow in place; everything before the first unsettled tool row is final.
   let offset=items.findIndex(step=>step?.kind==='tool'&&step.state!=='completed')
   if(offset<0)offset=items.length
   let restarted=false
   do{
    const page=await fetchPage(id,offset)
    if(loading!==token||selection()!==selected||c.selectedId!==id)return
    if(page.generation!==generation||!Array.isArray(page.items)||!Number.isSafeInteger(page.total))throw Error(t('工具日志暂不可用。'))
    // The host evicts the oldest thought after 64 rounds, shifting merged indexes.
    // Restart once so the display never keeps an evicted prefix or skips a tool.
    const firstShifted=loadedFirstId!==null&&typeof page.first_id==='string'&&page.first_id!==loadedFirstId
    const thoughtShifted=loadedThoughtsFirstId!==null&&typeof page.thoughts_first_id==='string'&&page.thoughts_first_id!==loadedThoughtsFirstId
    if(firstShifted||thoughtShifted){
     if(restarted)throw Error(t('工具日志暂不可用。'))
     restarted=true;items=[];offset=0;loadedFirstId=null;loadedThoughtsFirstId=null;continue
    }
    if(page.total<offset){
     if(restarted)throw Error(t('工具日志暂不可用。'))
     restarted=true;items=[];offset=0;loadedFirstId=null;loadedThoughtsFirstId=null;continue
    }
    items.length=offset
    for(const step of page.items)items.push(step)
    if(loadedFirstId===null&&typeof page.first_id==='string')loadedFirstId=page.first_id
    if(loadedThoughtsFirstId===null&&typeof page.thoughts_first_id==='string')loadedThoughtsFirstId=page.thoughts_first_id
    if(page.next_offset!==null&&(!Number.isSafeInteger(page.next_offset)||page.next_offset<=offset))throw Error(t('工具日志暂不可用。'))
    offset=page.next_offset
    changed()
   }while(offset!==null)
   loadedRevision=revision;failedRevision=-1;error=''
  }catch(cause){if(loading===token){error=cause.message;failedRevision=revision}}
  finally{if(loading===token){loading=null;changed();update()}}
 }
 function update(){
  const next=selection()
  if(next!==selected){selected=next;version++;loading=null;items=[];loadedFirstId=null;loadedThoughtsFirstId=null;mode='steps';nodes.clear();groups.clear();shots.clear();loadedRevision=-1;failedRevision=-1;error=''}
  const ready=c.connected&&c.presentationReady!==false
  if(ready&&!connected)failedRevision=-1
  connected=ready
  const item=current(),revision=item?.build?.log_revision
  if(item&&ready&&Number.isSafeInteger(revision)&&revision!==loadedRevision&&revision!==failedRevision&&!loading)void load(revision)
  const active=Boolean(item&&c.connected&&activeStatus())
  if(active&&!timer){timer=setInterval(tick,1000);timer.unref?.()}
  else if(!active&&timer){clearInterval(timer);timer=null}
 }
 function tick(){
  const byKey=new Map(items.map(step=>[stepKey(step),step]))
  for(const [key,node] of nodes){
   if(!node.time)continue
   const step=byKey.get(key)
   if(step?.kind==='tool'&&step.state==='running')elapsed(step,node.time)
  }
  for(const node of groups.values())node.duration.textContent=groupDuration(node.items)
 }
 async function shot(ref){
  if(shots.has(ref))return shots.get(ref)
  const id=c.selectedId,pending=c.command('build.details',{id,view:'image',image_ref:ref}).then(image=>{
   if(!image||!['image/png','image/jpeg'].includes(image.media_type)||typeof image.data_base64!=='string')throw Error(t('截图暂不可用。'))
   return 'data:'+image.media_type+';base64,'+image.data_base64
  })
  shots.set(ref,pending);pending.catch(()=>shots.delete(ref))
  while(shots.size>SHOT_CACHE)shots.delete(shots.keys().next().value)
  return pending
 }
 function showShot(node){
  const ref=node.imageRef;if(!ref||node.image.dataset.ref===ref||!node.details.open)return
  node.image.dataset.ref=ref
  void shot(ref).then(url=>{if(node.imageRef===ref){node.image.src=url;node.image.hidden=false}}).catch(()=>{if(node.imageRef===ref){delete node.image.dataset.ref;node.shotNote.hidden=false}})
 }
 function thinkingRow(step){
  const key=stepKey(step)
  let node=nodes.get(key)
  if(!node){
   const element=el('details',undefined,'build-step build-step-thinking'),summary=el('summary',undefined,'build-step-summary')
   element.dataset.stepKind='thinking'
   const leading=el('span',undefined,'build-step-leading'),icon=thinkIcon()
   if(icon)leading.append(icon);else leading.textContent='✳'
   leading.setAttribute('aria-hidden','true')
   const title=el('span',t('思考'),'build-step-title')
   const separator=el('span',undefined,'build-step-separator');separator.setAttribute('aria-hidden','true')
   const text=el('span',undefined,'build-step-summary-text'),time=el('time',undefined,'build-step-time')
   summary.append(leading,title,separator,text,time)
   const body=el('div',undefined,'build-step-body'),full=el('p',undefined,'build-step-think-text')
   body.append(full);element.append(summary,body)
   node={element,body,full,text,time,level:null};nodes.set(key,node)
  }
  node.time.textContent=relativeStepTime(step.created_at)
  if(step.created_at)node.time.dateTime=step.created_at
  node.full.textContent=String(step.text??'')
  if(node.level!==prefs.steps){
   node.level=prefs.steps
   node.element.open=false
   if(prefs.steps==='detailed')node.element.open=true
  }
  node.element.hidden=prefs.steps==='compact'
  node.text.textContent=prefs.steps==='detailed'?thinkingSummary(step.text,Number.MAX_SAFE_INTEGER):thinkingSummary(step.text)
  return node.element
 }
 function toolRow(step){
  const key=stepKey(step)
  let node=nodes.get(key)
  if(!node){
   const element=el('article',undefined,'message tool-message build-step build-step-tool'),details=el('details',undefined,'build-tool-call'),summary=el('summary')
   element.dataset.stepKind='tool'
   if(step.sequence!==undefined)element.dataset.toolSequence=String(step.sequence)
   const mark=el('span',undefined,'build-tool-mark'),name=el('code'),target=el('span',undefined,'build-tool-target'),state=el('span',undefined,'build-tool-state'),time=el('span',undefined,'build-tool-time')
   summary.append(mark,name,target,state,time)
   const content=el('div',undefined,'build-tool-content'),input=el('pre'),output=el('pre'),inputNote=el('p',t('输入已省略。'),'hint'),outputNote=el('p',t('输出已省略；完整内容见执行记录。'),'hint')
   const image=el('img',undefined,'computer-shot'),shotTitle=el('h4',t('操作后的屏幕')),shotNote=el('p',t('截图暂不可用。'),'hint')
   image.hidden=true;image.alt=t('操作后的屏幕截图');shotTitle.hidden=true;shotNote.hidden=true
   image.addEventListener('click',()=>image.classList.toggle('expanded'))
   content.append(shotTitle,image,shotNote,el('h4',t('输入')),input,inputNote,el('h4',t('输出')),output,outputNote)
   details.append(summary,content);element.append(details)
   node={element,details,mark,name,target,state,time,input,output,inputNote,outputNote,image,shotTitle,shotNote,imageRef:null,level:null};nodes.set(key,node)
   details.addEventListener('toggle',()=>showShot(node))
  }
  node.element.dataset.toolStatus=step.status
  node.mark.textContent=step.status==='completed'?'✓':failed.has(step.status)?'!':step.status==='running'?'→':'·'
  const action=computerCallTarget(step)
  node.element.dataset.computer=String(action!==null)
  node.name.textContent=step.name;node.target.textContent=action??step.target;node.target.title=action??step.target
  node.imageRef=typeof step.image_ref==='string'?step.image_ref:null;node.shotTitle.hidden=!node.imageRef
  if(!node.imageRef){node.image.hidden=true;node.shotNote.hidden=true}else showShot(node)
  node.state.textContent=t(labels[step.status]??step.status)+(step.exit_code!==null&&step.exit_code!==undefined?' · '+t('退出码 {0}',step.exit_code):'')
  node.input.textContent=step.input;node.output.textContent=step.output||(step.state==='completed'?t('无输出'):t('等待执行结果…'))
  node.inputNote.hidden=!step.input_truncated;node.outputNote.hidden=!step.output_truncated
  elapsed(step,node.time)
  if(node.level!==prefs.steps){
   node.level=prefs.steps
   // Detailed display opens the tool payload; other levels leave the reader's own choice alone.
   if(prefs.steps==='detailed')node.details.open=true
  }
  return node.element
 }
 function applyOpen(node){
  node.rows.hidden=!node.open
  node.header.setAttribute('aria-expanded',String(node.open))
  node.header.dataset.open=String(node.open)
 }
 function visibleSteps(steps){return prefs.steps==='compact'?steps.filter(step=>step?.kind!=='thinking'):steps}
 function group(key,steps){
  const shown=visibleSteps(steps)
  if(!shown.length){groups.delete(key);return null}
  let node=groups.get(key)
  if(!node){
   const element=el('article',undefined,'message tool-message-group build-steps')
   const header=el('button',undefined,'build-steps-header');header.type='button'
   const dot=el('span',undefined,'build-steps-dot'),label=el('span','','build-steps-label'),duration=el('span','','build-steps-duration'),chevron=el('span',undefined,'build-steps-chevron')
   header.append(dot,label,duration,chevron)
   const rows=el('div',undefined,'build-steps-rows')
   element.append(header,rows)
   node={element,header,dot,label,duration,chevron,rows,items:shown,open:false,active:null,userToggled:false}
   node.open=Boolean(activeStatus())
   header.addEventListener('click',()=>{node.open=!node.open;node.userToggled=true;applyOpen(node)})
   groups.set(key,node)
  }
  node.items=shown
  const active=Boolean(activeStatus())
  if(node.active!==active){
   node.active=active
   if(active)node.open=true
   else if(prefs.collapse==='after_reply')node.open=false
  }else if(!active&&prefs.collapse==='after_reply'&&!node.userToggled)node.open=false
  const item=current()
  node.element.dataset.buildStatus=item?.build?.status??''
  node.dot.dataset.status=item?.build?.status??''
  node.label.textContent=t('工作步骤 · {0}',shown.length)
  const duration=groupDuration(shown)
  node.duration.textContent=duration;node.duration.hidden=!duration
  node.rows.replaceChildren(...shown.map(step=>step?.kind==='thinking'?thinkingRow(step):toolRow(step)))
  applyOpen(node)
  return node.element
 }
 return {update,
  get key(){return JSON.stringify([selected,mode,items,error,prefs.steps,prefs.collapse])},
  forMessage:id=>{const matching=items.filter(step=>step?.message_id===id);const element=matching.length?group('message:'+id,matching):null;return element?[element]:[]},
  remaining:ids=>{const orphan=items.filter(step=>step&&!ids.has(step.message_id??'')),buckets=new Map();for(const step of orphan){const key=step.message_id??'unlinked';if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(step)}const rows=[...buckets].map(([key,groupItems])=>group('orphan:'+key,groupItems)).filter(Boolean);if(error){errorText.textContent=t('工具日志暂不可用。')+' '+error;rows.push(notice)}return rows},
  destroy:()=>{unsubscribe?.();if(timer)clearInterval(timer);timer=null;nodes.clear();groups.clear();shots.clear()},
 }
}
