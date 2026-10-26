import {test} from 'node:test'
import assert from 'node:assert/strict'
import {renderMarkdown,safeLinkUrl} from '../src/renderer/markdown.mjs'
class Node{constructor(tag,text){this.tag=tag;this.children=[];this.listeners={};this.dataset={};this.className='';if(text!==undefined)this.textContent=text}append(...c){this.children.push(...c)}addEventListener(k,v){this.listeners[k]=v}
 get innerHTML(){throw new Error('innerHTML read')}set innerHTML(_){throw new Error('innerHTML write')}
 get text(){return this.children.length?this.children.map(c=>c.text).join(''):(this.textContent??'')}}
const dom={createElement:tag=>new Node(tag),createTextNode:text=>new Node('#text',text)}
const cpuMs=start=>{const elapsed=process.cpuUsage(start);return (elapsed.user+elapsed.system)/1000}
const all=node=>[node,...node.children.flatMap(all)]
const render=(text,openLink)=>renderMarkdown(text,{document:dom,openLink})
test('headings, lists, code blocks and inline marks become structured nodes',()=>{
 const root=render('# 本周待办\n\n- 修复 `login`\n- 回复 **设计** 评审\n  - 子项\n\n1. one\n2. two\n\n```js\nconst a=1\n```\n\n> 引用\n\n收尾段落')
 assert.deepEqual(root.children.map(c=>c.tag),['h1','ul','ol','pre','blockquote','p'])
 const ul=root.children[1];assert.equal(ul.children.length,2);assert.equal(ul.children[0].children[1].tag,'code');assert.equal(ul.children[0].children[1].textContent,'login')
 assert.equal(ul.children[1].children[1].tag,'strong');assert.equal(ul.children[1].children.at(-1).tag,'ul');assert.equal(ul.children[1].children.at(-1).children[0].text,'子项')
 const code=root.children[3].children[0];assert.equal(code.tag,'code');assert.equal(code.dataset.lang,'js');assert.equal(code.textContent,'const a=1')
 assert.equal(root.children[4].children[0].text,'引用');assert.equal(root.children[5].text,'收尾段落')
})
test('paragraph line breaks survive and unknown syntax stays literal text',()=>{
 const root=render('第一行\n第二行 ![img](x) [^1]\n\n<b>tag</b>')
 assert.equal(root.children[0].text,'第一行\n第二行 ![img](x) [^1]');assert.equal(root.children[1].text,'<b>tag</b>')
 assert.ok(all(root).every(n=>n.tag!=='b'&&n.tag!=='img'&&n.tag!=='a'))
})
test('links are buttons routed through the opener and only for web urls',async()=>{
 const opened=[];const root=render('看 [文档](https://example.com/a?b=1) 与 [本地](file:///etc/passwd) 与 [脚本](javascript:alert(1))',url=>{opened.push(url)})
 const buttons=all(root).filter(n=>n.tag==='button');assert.equal(buttons.length,1)
 assert.equal(buttons[0].className,'md-link');assert.equal(buttons[0].textContent,'文档');assert.equal(buttons[0].dataset.url,'https://example.com/a?b=1')
 await buttons[0].listeners.click();assert.deepEqual(opened,['https://example.com/a?b=1'])
 const p=root.children[0];assert.equal(p.text,'看 文档 与 [本地](file:///etc/passwd) 与 [脚本](javascript:alert(1))')
 assert.equal(all(render('[x](https://e.com)')).filter(n=>n.tag==='button').length,0,'no opener means no link controls')
 assert.equal(safeLinkUrl('HTTP://E.com/x'),'http://e.com/x');assert.equal(safeLinkUrl('data:text/html,1'),null)
})
test('image syntax is echoed as text and never creates an img',()=>{
 const root=render('前 ![截图](https://x/y.png) 后')
 assert.equal(root.children[0].text,'前 ![截图](https://x/y.png) 后');assert.ok(all(root).every(n=>n.tag!=='img'))
})
test('unclosed fences, empty input and CRLF are bounded',()=>{
 assert.equal(render('').children.length,0)
 const root=render('```\r\nabc\r\ndef');assert.equal(root.children[0].tag,'pre');assert.equal(root.children[0].children[0].textContent,'abc\ndef');assert.equal(root.children[0].children[0].dataset.lang,undefined)
 const italic=render('a * b * c and *强调* and 2*3*4');assert.equal(all(italic).filter(n=>n.tag==='em').length,1)
})
test('adversarial delimiter runs parse in linear time and unmatched openers never drop characters',()=>{
 for(const ch of ['[','*','x`','![','**','](','[a](']){
  const text=ch.repeat(20000),t0=process.cpuUsage(),root=render(text);const spent=cpuMs(t0)
  assert.ok(spent<200,`${JSON.stringify(ch)} took ${spent.toFixed(0)}ms`)
  if(ch==='*'||ch==='**')assert.equal(root.children[0].tag,'hr');else if(ch!=='x`')assert.equal(root.children.map(c=>c.text).join(''),text,`${JSON.stringify(ch)} kept verbatim`)
 }
 assert.equal(all(render('x`'.repeat(200))).filter(n=>n.tag==='code').length,100,'paired backticks still form code spans')
 const fence='`'.repeat(20000),t0=process.cpuUsage(),block=render(fence);assert.ok(cpuMs(t0)<200);assert.equal(block.children[0].tag,'pre','a bare backtick run is an unclosed fence, kept as one code block')
 const nested='*'.repeat(50)+'x'+'*'.repeat(50);assert.equal(render(nested).children[0].text.replace(/\*/g,'').length,1)
})
test('invalid emphasis closers are scanned once, and valid emphasis still resolves afterwards',()=>{
 const text='x '+'*a '.repeat(16000),t0=process.cpuUsage(),root=render(text);const spent=cpuMs(t0)
 assert.ok(spent<200,`took ${spent.toFixed(0)}ms`);assert.equal(root.children[0].text,text)
 const mixed=render('*a *b *c* and *ok*');assert.equal(all(mixed).filter(n=>n.tag==='em').length,2)
 assert.equal(render('**unclosed strong').children[0].text,'**unclosed strong')
})

test('large unmatched link delimiters do not repeatedly scan the remaining reply',()=>{
 for(const text of ['['.repeat(320000),'[a]( '.repeat(60000)+')']){
  const start=process.cpuUsage(),root=render(text)
  assert.equal(root.children[0].text,text)
  assert.ok(cpuMs(start)<500,'malformed link parsing exceeded 500ms')
 }
 assert.equal(all(render('[[bad [ok](https://example.com)',()=>{})).filter(n=>n.tag==='button').length,1)
})

test('tables interrupt paragraphs, align cells and normalize escaped and missing cells',()=>{
 const root=render('intro\n| Left | Mid | Right | Plain |\n| :--- | :---: | ---: | --- |\n| **a** | b\\|c | d | e | extra |\n| short |')
 assert.deepEqual(root.children.map(n=>n.tag),['p','table'])
 const table=root.children[1],heads=table.children[0].children[0].children,rows=table.children[1].children
 assert.deepEqual(heads.map(n=>n.dataset.align),['left','center','right',undefined])
 assert.deepEqual(rows[0].children.map(n=>n.text),['a','b|c','d','e'])
 assert.equal(rows[0].children[0].children[0].tag,'strong')
 assert.deepEqual(rows[1].children.map(n=>n.text),['short','','',''])
 assert.equal(render('a | b\n--- | ---\nx | y').children[0].tag,'table')
 for(const text of ['a | b','a | b\n--- |','a | b\n-- | ---'])assert.equal(render(text).children[0].text,text)
 const many=render('a | b\n--- | ---\n'+Array(202).fill('x | y').join('\n'))
 assert.equal(render('a | b\n--- | ---\n'+Array(200).fill('x | y').join('\n')+'\n# extra | row\n--- | ---').children[1].text,'# extra | row\n--- | ---')
 assert.equal(many.children[0].children[1].children.length,200);assert.equal(many.children[1].text,'x | y\nx | y')
 const wide=Array(13).fill('a').join('|')+'\n'+Array(13).fill('---').join('|');assert.equal(render(wide).children[0].text,wide)
})
test('horizontal rules precede list parsing and malformed rules remain literal',()=>{
 assert.deepEqual(render('---\n* * *\n_ _ _ _').children.map(n=>n.tag),['hr','hr','hr'])
 for(const text of ['--','__','--x','--_'])assert.equal(render(text).children[0].text,text)
})
test('strikethrough supports inline marks and incomplete delimiters retain text',()=>{
 const root=render('~~old **bold**~~ ~~open')
 const del=all(root).find(n=>n.tag==='del');assert.equal(del.text,'old bold');assert.equal(del.children[1].tag,'strong')
 assert.equal(root.children[0].text,'old bold ~~open');assert.equal(render('~~~~').children[0].tag,'pre')
 assert.equal(render('a ~~').children[0].text,'a ~~')
})
test('task lists expose state and keep malformed markers literal',()=>{
 const items=render('- [ ] open\n- [x] **done**\n- [X] yes\n- [x]\n- [y] no').children[0].children
 assert.deepEqual(items.map(n=>n.dataset.task),['open','done','done',undefined,undefined])
 assert.equal(items[0].children[0].className,'md-task');assert.equal(items[0].text,'☐open');assert.equal(items[1].text,'☑done')
 assert.equal(items[3].text,'[x]');assert.equal(items[4].text,'[y] no')
})
test('bare URLs use safe opener buttons, retain balanced parentheses and respect word boundaries',async()=>{
 const opened=[],root=render('https://e.com/a., http://e.com/b! (https://e.com/wiki_(x)). 文https://e.com/no 𐐀https://e.com/no _https://e.com/no https:// [ok](https://e.com/ok)',url=>opened.push(url))
 const buttons=all(root).filter(n=>n.tag==='button')
 assert.deepEqual(buttons.map(n=>n.text),['https://e.com/a','http://e.com/b','https://e.com/wiki_(x)','ok'])
 await buttons[0].listeners.click();assert.deepEqual(opened,['https://e.com/a'])
 const text='https://e.com/path. https:// javascript:alert(1)';assert.equal(render(text).children[0].text,text)
})
test('nested lists use indentation stack with tabs, return to parents and cap at four levels',()=>{
 const root=render('- a\n  1. b\n    - c\n      - d\n        - e\n  - f\n- g\n1. h')
 assert.deepEqual(root.children.map(n=>n.tag),['ul','ol'])
 const outer=root.children[0],second=outer.children[0].children.at(-1)
 assert.equal(second.tag,'ol');assert.equal(second.children.length,2);assert.equal(second.children[1].text,'f')
 const fourth=second.children[0].children.at(-1).children[0].children.at(-1)
 assert.equal(fourth.tag,'ul');assert.deepEqual(fourth.children.map(n=>n.text),['d','e']);assert.equal(outer.children[1].text,'g')
 assert.equal(render('- a\n\t- b').children[0].children[0].children.at(-1).tag,'ul')
 assert.equal(render('- a\n - b').children[0].children.length,2)
 assert.equal(render('- a\n  -').children[1].text,'  -')
})
test('mixed markdown keeps top-level order and untrusted content safe',()=>{
 const root=render('# Title\ntext ~~old~~ https://e.com\n---\na | b\n--- | ---\nx | y\n\n- [ ] task\n  - nested\n\n> quote\n\n```\ncode\n```',()=>{})
 assert.deepEqual(root.children.map(n=>n.tag),['h1','p','hr','table','ul','blockquote','pre'])
 assert.ok(all(root).every(n=>!['a','img','script','style'].includes(n.tag)))
})
test('large pipe and tilde inputs stay bounded without dropping unmatched characters',()=>{
 for(const text of ['|'.repeat(50000),'a '+'~'.repeat(50000),'x ~~open '.repeat(10000)]){
  const start=process.cpuUsage(),root=render(text);assert.ok(cpuMs(start)<500)
  if(!text.includes('open'))assert.equal(root.children[0].text,text)
 }
})
