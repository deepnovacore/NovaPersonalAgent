import {t} from './locale.mjs'

const labels={prepared:'等待执行',awaiting_approval:'待确认',running:'执行中',completed:'已完成',failed:'失败',denied:'已拒绝',refused:'已拒绝',timed_out:'已超时',cancelled:'已取消',cancelled_before_execution:'未执行',outcome_unknown:'结果不确定'}
const failed=new Set(['failed','timed_out','outcome_unknown','refused'])
const COMPUTER_LABELS={computer_screenshot:'截图',computer_click:'点击',computer_type:'输入',computer_scroll:'滚动',computer_key:'快捷键',computer_run:'电脑助手'}
const SHOT_CACHE=12

/** Computer calls read as actions ("点击 · 412, 220"), not as raw JSON arguments. */
export function computerCallTarget(item){
 if(!Object.hasOwn(COMPUTER_LABELS,item.name))return null
 let args={};try{args=JSON.parse(item.input)}catch{ /* a truncated preview keeps only the label */ }
 const detail=item.name==='computer_click'&&Number.isFinite(args.x)&&Number.isFinite(args.y)?`${args.x}, ${args.y}`
  :item.name==='computer_scroll'&&typeof args.direction==='string'?t(({up:'向上',down:'向下',left:'向左',right:'向右'})[args.direction]??args.direction)
  :item.name==='computer_type'&&typeof args.text==='string'?`“${args.text.length>40?args.text.slice(0,40)+'…':args.text}”`
  :item.name==='computer_key'&&typeof args.keys==='string'?args.keys
  :item.name==='computer_run'&&typeof args.instruction==='string'?args.instruction:''
 return t(COMPUTER_LABELS[item.name])+(detail?' · '+detail:'')
}

/** Refresh only the changed tail of the durable tool journal; never ship the model checkpoint. */
export function createBuildCallLog({c,el,changed}){
 let selected='',version=0,items=[],loading=null,loadedRevision=-1,failedRevision=-1,error='',timer=null,connected=false
 const nodes=new Map(),groups=new Map(),shots=new Map()
 const notice=el('div',undefined,'build-log-notice'),retry=el('button',t('重试')),errorText=el('span')
 retry.type='button';notice.append(errorText,retry)
 retry.addEventListener('click',()=>{failedRevision=-1;error='';update()})
 const current=()=>c.selectedConversation?.kind==='build'?c.selectedConversation:null
 const selection=()=>{const item=current();return item?JSON.stringify([item.id,item.generation??0]):''}
 function elapsed(item,node){
  const start=Date.parse(item.started_at??''),end=item.finished_at?Date.parse(item.finished_at):item.state==='running'?Date.now():NaN
  node.textContent=Number.isFinite(start)&&Number.isFinite(end)?((Math.max(0,end-start)/1000).toFixed(1)+'s'):''
 }
 async function load(revision){
  const token={version:++version},id=c.selectedId,generation=current()?.generation??0
  loading=token
  try{
   let offset=items.findIndex(item=>!item||item.state!=='completed');if(offset<0)offset=items.length
   do{
    const page=await c.command('build.details',{id,view:'calls',offset})
    if(loading!==token||selection()!==selected||c.selectedId!==id)return
    if(page.generation!==generation||!Array.isArray(page.items))throw Error(t('工具日志暂不可用。'))
    for(const item of page.items)items[item.sequence]=item
    items.length=page.total
    if(page.next_offset!==null&&page.next_offset<=offset)throw Error(t('工具日志暂不可用。'))
    offset=page.next_offset
    changed()
   }while(offset!==null)
   loadedRevision=revision;failedRevision=-1;error=''
  }catch(cause){if(loading===token){error=cause.message;failedRevision=revision}}
  finally{if(loading===token){loading=null;changed();update()}}
 }
 function update(){
  const next=selection()
  if(next!==selected){selected=next;version++;loading=null;items=[];nodes.clear();groups.clear();shots.clear();loadedRevision=-1;failedRevision=-1;error=''}
  if(c.connected&&!connected)failedRevision=-1
  connected=c.connected
  const item=current(),revision=item?.build?.log_revision
  if(item&&c.connected&&Number.isSafeInteger(revision)&&revision!==loadedRevision&&revision!==failedRevision&&!loading)void load(revision)
  const active=item&&c.connected&&['running','awaiting_approval'].includes(item.build?.status)
  if(active&&!timer){timer=setInterval(()=>{for(const item of items)if(item?.state==='running'){const node=nodes.get(item.sequence);if(node)elapsed(item,node.time)}},1000);timer.unref?.()}
  else if(!active&&timer){clearInterval(timer);timer=null}
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
 function row(item){
  let node=nodes.get(item.sequence)
  if(!node){
   const element=el('article',undefined,'message tool-message'),details=el('details',undefined,'build-tool-call'),summary=el('summary')
   element.dataset.toolSequence=String(item.sequence)
   const mark=el('span',undefined,'build-tool-mark'),name=el('code'),target=el('span',undefined,'build-tool-target'),state=el('span',undefined,'build-tool-state'),time=el('span',undefined,'build-tool-time')
   summary.append(mark,name,target,state,time)
   const content=el('div',undefined,'build-tool-content'),input=el('pre'),output=el('pre'),inputNote=el('p',t('输入已省略。'),'hint'),outputNote=el('p',t('输出已省略；完整内容见执行记录。'),'hint')
   const image=el('img',undefined,'computer-shot'),shotTitle=el('h4',t('操作后的屏幕')),shotNote=el('p',t('截图暂不可用。'),'hint')
   image.hidden=true;image.alt=t('操作后的屏幕截图');shotTitle.hidden=true;shotNote.hidden=true
   image.addEventListener('click',()=>image.classList.toggle('expanded'))
   content.append(shotTitle,image,shotNote,el('h4',t('输入')),input,inputNote,el('h4',t('输出')),output,outputNote)
   details.append(summary,content);element.append(details)
   node={element,details,mark,name,target,state,time,input,output,inputNote,outputNote,image,shotTitle,shotNote,imageRef:null};nodes.set(item.sequence,node)
   details.addEventListener('toggle',()=>showShot(node))
  }
  node.element.dataset.toolStatus=item.status
  node.mark.textContent=item.status==='completed'?'✓':failed.has(item.status)?'!':item.status==='running'?'→':'·'
  const action=computerCallTarget(item)
  node.element.dataset.computer=String(action!==null)
  node.name.textContent=item.name;node.target.textContent=action??item.target;node.target.title=action??item.target
  node.imageRef=typeof item.image_ref==='string'?item.image_ref:null;node.shotTitle.hidden=!node.imageRef
  if(!node.imageRef){node.image.hidden=true;node.shotNote.hidden=true}else showShot(node)
  node.state.textContent=t(labels[item.status]??item.status)+(item.exit_code!==null?' · '+t('退出码 {0}',item.exit_code):'')
  node.input.textContent=item.input;node.output.textContent=item.output||(item.state==='completed'?t('无输出'):t('等待执行结果…'))
  node.inputNote.hidden=!item.input_truncated;node.outputNote.hidden=!item.output_truncated
  elapsed(item,node.time)
  return node.element
 }
 function group(key,items){
  let node=groups.get(key)
  if(!node){const element=el('article',undefined,'message tool-message-group'),details=el('details',undefined,'build-tool-group'),summary=el('summary'),rows=el('div',undefined,'build-tool-rows');details.open=true;element.append(details);details.append(summary,rows);node={element,details,summary,rows};groups.set(key,node)}
  const failedCount=items.filter(item=>failed.has(item.status)).length
  node.summary.textContent=t('工具调用 · {0}',items.length)+(failedCount?' · '+t('失败 {0}',failedCount):'')
  node.rows.replaceChildren(...items.map(row));return node.element
 }
 return {update,
  get key(){return JSON.stringify([selected,items,error])},
  forMessage:id=>{const matching=items.filter(item=>item?.message_id===id);return matching.length?[group('message:'+id,matching)]:[]},
  remaining:ids=>{const orphan=items.filter(item=>item&&!ids.has(item.message_id)),buckets=new Map();for(const item of orphan){const key=item.message_id??'unlinked';if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(item)}const rows=[...buckets].map(([key,groupItems])=>group('orphan:'+key,groupItems));if(error){errorText.textContent=t('工具日志暂不可用。')+' '+error;rows.push(notice)}return rows},
 }
}
