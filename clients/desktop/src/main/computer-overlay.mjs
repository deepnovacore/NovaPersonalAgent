import {BrowserWindow,screen} from 'electron'
import {currentLanguage} from '../renderer/locale.mjs'
import {computerOverlayFrame} from '../renderer/computer-overlay-view.mjs'

const BAR={width:460,height:52,top:10}

/**
 * A click-through screen edge plus one interactive bar with Stop. Both stay out of screen capture
 * (setContentProtection) so the model sees the user's screen, not the indicator.
 */
export function createComputerOverlay({partition,preload,onStop,onError=console.error}){
 let edge=null,bar=null,current=null,disposed=false
 const alive=w=>w&&!w.isDestroyed()
 const display=()=>screen.getPrimaryDisplay()
 const send=()=>{
  const bounds=display().bounds,value=current?{...current,origin:{x:bounds.x,y:bounds.y}}:null
  for(const w of [edge,bar])if(alive(w))w.webContents.send('nova:computer-overlay:changed',value)
 }
 const layout=()=>{
  const {bounds,workArea}=display()
  if(alive(edge))edge.setBounds(bounds)
  if(alive(bar))bar.setBounds({x:Math.round(workArea.x+(workArea.width-BAR.width)/2),y:workArea.y+BAR.top,width:BAR.width,height:BAR.height})
 }
 const make=(page,interactive)=>{
  const w=new BrowserWindow({show:false,frame:false,transparent:true,backgroundColor:'#00000000',hasShadow:false,
   resizable:false,movable:false,minimizable:false,maximizable:false,fullscreenable:false,skipTaskbar:true,focusable:interactive,
   width:BAR.width,height:BAR.height,
   webPreferences:{preload,partition,additionalArguments:[`--nova-language=${currentLanguage()}`],contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false}})
  w.setAlwaysOnTop(true,'screen-saver')
  w.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true})
  w.setContentProtection(true)
  if(!interactive)w.setIgnoreMouseEvents(true)
  w.webContents.setWindowOpenHandler(()=>({action:'deny'}))
  w.webContents.on('will-navigate',event=>event.preventDefault())
  w.webContents.on('did-finish-load',()=>{if(current&&!disposed){send();w.showInactive()}})
  w.webContents.on('render-process-gone',()=>{destroy();onError('Computer Use overlay renderer stopped')})
  void w.loadURL(`nova://orb/${page}`).catch(()=>{destroy();onError('Computer Use overlay page could not load')})
  return w
 }
 const destroy=()=>{for(const w of [edge,bar])if(alive(w))w.destroy();edge=null;bar=null}
 const update=value=>{
  if(disposed)return
  const frame=computerOverlayFrame(value)
  if(!frame)return
  // Another conversation's idle never hides the indicator of the conversation that is acting.
  if(frame.state==='idle'){if(!current||current.conversation_id===frame.conversation_id){current=null;send();destroy()}return}
  current=frame
  if(!alive(edge)){edge=make('computer-edge.html',false);bar=make('computer-bar.html',true);layout()}
  else{send();for(const w of [edge,bar])if(alive(w)&&!w.isVisible())w.showInactive()}
 }
 screen.on('display-metrics-changed',layout);screen.on('display-added',layout);screen.on('display-removed',layout)
 return {
  update,
  /** Renderer reload, backend exit or disconnect: never leave a stale "being controlled" indicator. */
  clear:()=>{current=null;send();destroy()},
  owns:sender=>alive(bar)&&bar.webContents===sender||alive(edge)&&edge.webContents===sender,
  barOwns:sender=>alive(bar)&&bar.webContents===sender,
  snapshot:()=>{const bounds=display().bounds;return current?{...current,origin:{x:bounds.x,y:bounds.y}}:null},
  stop:()=>{if(current)onStop(current.conversation_id)},
  windows:()=>[edge,bar],
  dispose(){disposed=true;destroy();screen.removeListener('display-metrics-changed',layout);screen.removeListener('display-added',layout);screen.removeListener('display-removed',layout)},
 }
}
