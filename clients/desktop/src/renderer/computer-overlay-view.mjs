import {t} from './locale.mjs'

const STATES=new Set(['active','acting','delegated','idle'])
const ACTIONS=new Set(['computer_screenshot','computer_click','computer_type','computer_scroll','computer_key','computer_run'])

/** Only well-formed Build frames move the overlay; anything else is ignored rather than shown. */
export function computerOverlayFrame(value){
 if(!value||typeof value!=='object'||value.type!=='computer_use'||typeof value.conversation_id!=='string'||!value.conversation_id||value.conversation_id.length>256||!STATES.has(value.state))return null
 const frame={type:'computer_use',conversation_id:value.conversation_id,state:value.state}
 if(ACTIONS.has(value.action))frame.action=value.action
 const point=value.point
 if(point&&Number.isFinite(point.x)&&Number.isFinite(point.y)&&Math.abs(point.x)<1e5&&Math.abs(point.y)<1e5)frame.point={x:Math.round(point.x),y:Math.round(point.y)}
 if(typeof value.summary==='string'&&value.summary)frame.summary=value.summary.slice(0,120)
 if(value.awaiting_approval===true)frame.awaiting_approval=true
 return frame
}

const ACTION_LABELS={computer_screenshot:'正在查看屏幕',computer_click:'点击',computer_type:'输入文字',computer_scroll:'滚动',computer_key:'按快捷键',computer_run:'已交给电脑助手执行'}
const MARK_LABELS={computer_click:'点击',computer_type:'输入',computer_scroll:'滚动',computer_key:'快捷键'}

/** One status line for the bar. Approval wins: the user must know Nova is waiting for them, not acting. */
export function computerOverlayDetail(frame){
 if(!frame)return ''
 if(frame.awaiting_approval)return t('等待你在工作台批准下一步')
 if(frame.state==='delegated')return frame.summary?t('电脑助手 · {0}',frame.summary):t(ACTION_LABELS.computer_run)
 if(frame.state==='acting'&&frame.action){
  const label=t(ACTION_LABELS[frame.action]??'操作中')
  return frame.point&&['computer_click','computer_scroll'].includes(frame.action)?`${label} · ${frame.point.x}, ${frame.point.y}`:label
 }
 return frame.summary??t('观察屏幕中')
}

/** A point mark is drawn only for inputs sent to a location; screenshots never mark the screen. */
export function computerOverlayMark(frame){
 if(frame?.state!=='acting'||!frame.point||!frame.origin||!Object.hasOwn(MARK_LABELS,frame.action))return null
 return {x:frame.point.x-frame.origin.x,y:frame.point.y-frame.origin.y,kind:frame.action.slice('computer_'.length),label:t(MARK_LABELS[frame.action])}
}
