import test from 'node:test'
import assert from 'node:assert/strict'
import {iconNode,withIcon} from '../src/renderer/icons.mjs'

class Node{
 constructor(tag){this.tag=tag;this.attrs={};this.children=[];this.classes=new Set()}
 setAttribute(k,v){this.attrs[k]=v}
 append(...n){this.children.push(...n)}
 prepend(...n){this.children.unshift(...n)}
 get classList(){return {add:c=>this.classes.add(c)}}
}
const dom={createElementNS:(ns,tag)=>Object.assign(new Node(tag),{ns})}

test('without a DOM the helper yields nothing, so stub-based renderers keep working',()=>{
 assert.equal(iconNode('play',null),null)
 const button=new Node('button');assert.equal(withIcon(button,'play',null),button);assert.equal(button.children.length,0)
})
test('an icon is a decorative inline svg carrying one path from the shared set',()=>{
 const svg=iconNode('shield',dom)
 assert.equal(svg.ns,'http://www.w3.org/2000/svg');assert.equal(svg.attrs.viewBox,'0 0 24 24');assert.equal(svg.attrs['aria-hidden'],'true')
 assert.match(svg.children[0].attrs.d,/^M/);assert.equal(iconNode('nope',dom),null)
})
test('withIcon puts the icon before the label and marks the button',()=>{
 const button=new Node('button');button.append('label');withIcon(button,'list',dom)
 assert.equal(button.children[0].tag,'svg');assert.equal(button.children[1],'label');assert(button.classes.has('has-icon'))
})
