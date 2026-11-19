import React,{useEffect,useRef,useState} from 'react'
import {computerOverlayDetail,computerOverlayMark} from '../../computer-overlay-view.mjs'
import {setLanguage,t} from '../../locale.mjs'
function useHostSnapshot(api:any) {
 const [frame,setFrame]=useState<any>(null)
 useEffect(()=>{let current=true,revision=0;setLanguage(api.language);const stop=api.onChanged((next:any)=>{revision++;if(current)setFrame(next)});const requested=revision;Promise.resolve(api.snapshot()).then(next=>{if(current&&requested===revision)setFrame(next)}).catch(()=>{});return()=>{current=false;stop?.()}},[api])
 return frame
}
export function ComputerBarApp({api=(window as any).computerOverlay}:any={}) {
 const frame=useHostSnapshot(api),[stopping,setStopping]=useState(false),[error,setError]=useState(''),alive=useRef(true)
 useEffect(()=>()=>{alive.current=false},[])
 return <section id="bar" className="computer-bar" data-state={frame?.awaiting_approval?'approval':frame?.state??'idle'} data-stopping={stopping?'true':undefined} aria-label={t('Nova 正在操作电脑')}><span className="computer-pulse" aria-hidden="true"><i/></span><span className="computer-copy"><strong>{t('Nova 正在操作电脑')}</strong><span id="detail" role="status" aria-live="polite">{error||t(stopping?'正在停止…':computerOverlayDetail(frame))}</span></span><button id="stop" type="button" title={t('停止 Build 并收回电脑控制')} disabled={!frame||stopping} onClick={async()=>{if(stopping||!frame)return;setStopping(true);setError('');try{await api.stop()}catch{if(alive.current){setStopping(false);setError(t('停止失败，请在工作台点击停止'))}}}}><span aria-hidden="true" className="computer-stop-icon"/><span>{t('停止')}</span></button></section>
}
export function ComputerEdgeApp({api=(window as any).computerOverlay}:any={}) {
 const frame=useHostSnapshot(api),[marks,setMarks]=useState<any[]>([]),last=useRef(''),sequence=useRef(0)
 useEffect(()=>{const mark=computerOverlayMark(frame),key=mark?JSON.stringify([frame.action,frame.point]):'';if(!mark){last.current='';return}if(key===last.current)return;last.current=key;setMarks(previous=>[...previous,{...mark,key:++sequence.current}].slice(-4))},[frame])
 return <><div id="edge" className="computer-edge" data-state={frame?.state??'idle'} aria-hidden="true">{['tl','tr','bl','br'].map(c=><i key={c} className={`corner ${c}`}/>)}</div><div id="marks" className="computer-marks" aria-hidden="true">{marks.map(mark=><div key={mark.key} className="computer-mark" data-kind={mark.kind} style={{left:`${mark.x}px`,top:`${mark.y}px`}} onAnimationEnd={e=>{if(e.target===e.currentTarget)setMarks(items=>items.filter(item=>item.key!==mark.key))}}><i className="computer-mark-ring"/><b/><span>{mark.label}</span></div>)}</div></>
}
export function VisorControlsApp({api=(window as any).visor}:any={}) {
 const frame=useHostSnapshot(api),[error,setError]=useState('')
 const run=async(fn:()=>Promise<any>)=>{setError('');try{await fn()}catch{setError(t('操作失败'))}}
 return <nav aria-label="Nova Visor" style={{color:"#acf2ff",font:"11px -apple-system,sans-serif"}}><button id="orb" title={t('显示原有 Nova 语音球')} onClick={()=>void run(()=>api.orb())}>◉ NOVA</button>{['focus','showcase'].map(mode=><button id={mode} key={mode} aria-pressed={frame?.preferences?.mode===mode} onClick={()=>void run(()=>api.configure({mode}))}>{t(mode==='focus'?'专注':'展示')}</button>)}<button id="hide" title={t('收起 HUD；⌘ / Ctrl + Shift + J 重新打开')} onClick={()=>void run(()=>api.configure({enabled:false}))}>{t('收起 ↘')}</button><span id="status" role="status">{error}</span></nav>
}
