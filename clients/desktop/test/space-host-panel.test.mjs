import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpaceHostPanel} from '../src/renderer/space-host-panel.mjs';
class Node {constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.textContent='';this.value=''}append(...n){this.children.push(...n)}replaceChildren(...n){this.children=n}setAttribute(k,v){this[k]=v}addEventListener(k,v){this.listeners[k]=v}}
const all=n=>[n,...n.children.flatMap(all)];
function harness(){const root=new Node('div'),calls=[];const document={querySelector:()=>root,createElement:t=>new Node(t)};const api={personalCommand:async(method,params)=>{calls.push([method,params]);if(method==='space.status')return {mode:'host',space:'safe-space',clients:['phone']};if(method==='space.pairings')return [{id:'p',device:'new',fingerprint:'fingerprint-from-phone'}];return {}}};return {root,calls,panel:createSpaceHostPanel({document,api}),button:label=>all(root).find(n=>n.tag==='button'&&n.textContent===label)}}
test('pairing requires matching manually supplied device fingerprint and revocation confirmation',async()=>{
 const h=harness();await h.panel.load();const confirm=h.button('确认绑定');assert(confirm);await confirm.listeners.click();assert(!h.calls.some(([m])=>m==='space.confirm_pairing'));
 const input=all(h.root).find(n=>n.tag==='input');input.value='fingerprint-from-phone';await confirm.listeners.click();assert(h.calls.some(([m,p])=>m==='space.confirm_pairing'&&p.fingerprint==='fingerprint-from-phone'));
 await h.button('撤销 phone').listeners.click();assert(!h.calls.some(([m])=>m==='space.revoke'));await h.button('确认撤销并轮换密钥').listeners.click();assert(h.calls.some(([m,p])=>m==='space.revoke'&&p.device==='phone'));
});
