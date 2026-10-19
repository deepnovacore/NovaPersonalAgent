import test from 'node:test'
import assert from 'node:assert/strict'
import {renderProfile} from '../src/renderer/life-view.mjs'
class Element{
 constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[]}
 append(...children){this.children.push(...children)}
 setAttribute(){}
 addEventListener(){}
}
test('a prior profile awaiting the current recipe is shown as needing an update, not as a first-time empty profile',()=>{
 const previous=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)}
 try{
  const panel=new Element('main'),buttons=[]
  const button=(text,_click,host)=>{const item=new Element('button',text);host.append(item);buttons.push(item);return item}
  renderProfile(panel,{state:{profile:{version:0,about:''}},news:{},warmup:{status:'idle',draft:null,needs_update:true},command(){},button,local:{},rerender(){}})
  const texts=node=>[node.textContent,...node.children.flatMap(texts)],all=texts(panel)
  assert.ok(all.includes('个人资料需要更新，原有资料仍保存在本机。'))
  assert.equal(all.some(text=>text.includes('我还不太了解你')),false)
  assert.ok(buttons.some(button=>button.textContent==='立即更新'&&!button.disabled))
 }finally{globalThis.document=previous}
})
