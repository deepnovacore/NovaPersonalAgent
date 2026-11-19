import React,{Component,useEffect,useState,type ReactNode} from 'react'
import {Theme,Button,Callout} from '@radix-ui/themes'
import {TriangleAlert,RotateCcw} from 'lucide-react'
import {currentLanguage} from '../locale.mjs'

export function DesktopTheme({children,transparent=false}:{children:ReactNode,transparent?:boolean}){
 useEffect(()=>{document.documentElement.lang=currentLanguage()},[])
 const [dark,setDark]=useState(()=>globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches??false)
 useEffect(()=>{const query=globalThis.matchMedia?.('(prefers-color-scheme: dark)');if(!query)return;const update=()=>setDark(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update)},[])
 return <Theme appearance={dark?'dark':'light'} accentColor="iris" grayColor="slate" radius="large" scaling="95%" hasBackground={!transparent} className={transparent?'nova-theme nova-transparent':'nova-theme'}>{children}</Theme>
}
export class ErrorBoundary extends Component<{children:ReactNode},{error:Error|null}>{
 state={error:null as Error|null}
 static getDerivedStateFromError(error:Error){return {error}}
 componentDidCatch(error:Error){console.error('Nova renderer failed',error)}
 render(){if(!this.state.error)return this.props.children;return <main className="renderer-failure"><Callout.Root color="red"><Callout.Icon><TriangleAlert/></Callout.Icon><Callout.Text>界面暂时无法显示，未发送的草稿和本地数据会保留。</Callout.Text></Callout.Root><p>{this.state.error.message}</p><Button onClick={()=>location.reload()}><RotateCcw size={16}/>重新加载界面</Button></main>}
}
