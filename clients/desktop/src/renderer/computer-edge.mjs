import {setLanguage,localizeDocument} from './locale.mjs'
import {computerOverlayMark} from './computer-overlay-view.mjs'
setLanguage(window.computerOverlay.language)
localizeDocument(document)
const edge=document.getElementById('edge'),marks=document.getElementById('marks')
const MAX_MARKS=4
let lastMark=''
function render(frame){
 edge.dataset.state=frame?.state??'idle'
 const mark=computerOverlayMark(frame),key=mark?JSON.stringify([frame.action,frame.point]):''
 if(!mark||key===lastMark){if(!mark)lastMark='';return}
 lastMark=key
 const node=document.createElement('div');node.className='computer-mark';node.dataset.kind=mark.kind
 node.style.left=mark.x+'px';node.style.top=mark.y+'px'
 const ring=document.createElement('i'),label=document.createElement('span');ring.className='computer-mark-ring';label.textContent=mark.label
 node.append(ring,document.createElement('b'),label);marks.append(node)
 while(marks.childElementCount>MAX_MARKS)marks.firstElementChild.remove()
 node.addEventListener('animationend',event=>{if(event.target===node)node.remove()})
}
window.computerOverlay.onChanged(render)
window.computerOverlay.snapshot().then(render).catch(()=>{})
