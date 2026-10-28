import React,{useCallback,useRef,useState} from 'react'
import {PageContext,type PageProps} from './pages/shared'
import {LifePage} from './pages/life'
import {TimelinePage} from './pages/timeline'
import {FeedsPage} from './pages/feeds'
import {ProfilePage} from './pages/profile'
export function WorkspacePage(props:PageProps){
 const [pending,setPending]=useState(new Set<string>()),pendingRef=useRef(new Set<string>()),locals=useRef<any>({}),[,redraw]=useState(0)
 const local=locals.current
 const setLocal=(key:string,value:any)=>{if(value===undefined)delete local[key];else local[key]=value;redraw(v=>v+1)}
 const execute=async(key:any,action:any)=>{const token=key??Symbol();if(pendingRef.current.has(token))return;pendingRef.current.add(token);setPending(new Set(pendingRef.current));try{await props.run(async()=>{await action?.()})}finally{pendingRef.current.delete(token);setPending(new Set(pendingRef.current))}}
 const value={...props,snapshot:props.c.snapshot,connected:props.c.connected,command:(m:string,p?:any)=>props.c.command(m,p),local,setLocal,pending,execute,delegate:props.delegate??((text:string)=>props.discuss([],text)),continueChat:props.continueChat??((text:string)=>props.discuss([],text))}
 return <PageContext.Provider value={value}>{props.page==='timeline'?<TimelinePage/>:props.page==='ideas'||props.page==='goals'?<LifePage kind={props.page==='ideas'?'idea':'goal'}/>:props.page==='feeds'?<FeedsPage/>:props.page==='profile'?<ProfilePage/>:null}</PageContext.Provider>
}
export default WorkspacePage
