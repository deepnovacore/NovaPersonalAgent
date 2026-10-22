import {t,setLanguage,localizeDocument} from './locale.mjs'
import {computerOverlayDetail} from './computer-overlay-view.mjs'
setLanguage(window.computerOverlay.language)
localizeDocument(document)
const bar=document.getElementById('bar'),detail=document.getElementById('detail'),stop=document.getElementById('stop')
function render(frame){
 bar.dataset.state=frame?.awaiting_approval?'approval':frame?.state??'idle'
 if(!bar.dataset.stopping)detail.textContent=computerOverlayDetail(frame)
 stop.disabled=!frame
}
stop.addEventListener('click',async()=>{
 stop.disabled=true;bar.dataset.stopping='true';detail.textContent=t('正在停止…')
 try{await window.computerOverlay.stop()}catch{detail.textContent=t('停止失败，请在工作台点击停止');stop.disabled=false;delete bar.dataset.stopping}
})
window.computerOverlay.onChanged(render)
window.computerOverlay.snapshot().then(render).catch(()=>{})
