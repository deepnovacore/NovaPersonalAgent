// Assistant replies arrive as untrusted Markdown text. This renderer builds DOM
// nodes directly (never innerHTML) so the workbench CSP (`script-src 'self'`,
// `img-src 'none'`) stays meaningful: no element can carry a script, images are
// echoed as their literal source text, and links are buttons that hand the URL
// to the host's validated opener instead of navigating the webContents.
const LINK_PROTOCOLS=['http:','https:']
export function safeLinkUrl(value){try{const url=new URL(value);return LINK_PROTOCOLS.includes(url.protocol)?url.href:null}catch{return null}}

// Single left-to-right pass. Every delimiter is resolved by scanning forward
// once from the current position; an unmatched opener is emitted as literal
// text and the scan resumes after it, so adversarial runs of `[`, `*` or
// backticks stay linear instead of rescanning the suffix per character.
const WORD=/[\p{L}\p{N}_]/u
function inline(text,ctx,depth=0){
 const {document,openLink,el}=ctx,nodes=[];let buffer='',i=0,emScan=-1
 // Cache forward searches, including misses, across malformed link openers.
 const linkEnds=new Map()
 const findLinkEnd=(token,start)=>{let end=linkEnds.get(token);if(end===undefined||(end!==-1&&end<start)){end=text.indexOf(token,start);linkEnds.set(token,end)}return end}
 const linkButton=(label,url)=>{const link=el('button',label);link.type='button';link.className='md-link';link.title=url;link.dataset.url=url;link.addEventListener('click',()=>{void Promise.resolve(openLink(url)).catch(()=>{})});return link}
 const flushText=()=>{if(buffer){nodes.push(document.createTextNode(buffer));buffer=''}}
 const push=node=>{flushText();nodes.push(node)}
 while(i<text.length){
  const ch=text[i]
  if(ch==='`'){
   let run=i;while(run<text.length&&text[run]==='`')run++
   const fence='`'.repeat(run-i),close=text.indexOf(fence,run)
   if(close===-1){buffer+=fence;i=run;continue}
   const code=text.slice(run,close);push(el('code',code.trim()||code));i=close+fence.length;continue
  }
  if(text.startsWith('~~',i)&&depth<4){
   const close=findLinkEnd('~~',i+2)
   if(close>i+2){push(el('del',undefined,inline(text.slice(i+2,close),ctx,depth+1)));i=close+2;continue}
   buffer+='~~';i+=2;continue
  }
  if(ch==='*'&&depth<4){
   const strong=text.startsWith('**',i)
   if(strong){const close=text.indexOf('**',i+2);if(close>i+2){push(el('strong',undefined,inline(text.slice(i+2,close),ctx,depth+1)));i=close+2;continue}buffer+='**';i+=2;continue}
   const prev=text[i-1]??'',next=text[i+1]??''
   if(!WORD.test(prev)&&next&&!/\s/.test(next)&&next!=='*'){
    // Each '*' is inspected as a closer at most once per pass: the scan resumes from the last rejected position.
    let close=Math.max(text.indexOf('*',i+1),emScan)
    while(close!==-1&&close<text.length&&text[close]==='*'&&(text[close+1]==='*'||/\s/.test(text[close-1])||WORD.test(text[close+1]??'')))close=text.indexOf('*',close+1)
    if(close!==-1&&text[close]==='*'){push(el('em',undefined,inline(text.slice(i+1,close),ctx,depth+1)));i=close+1;continue}
    emScan=text.length
   }
   buffer+=ch;i++;continue
  }
  if(ch==='['||(ch==='!'&&text[i+1]==='[')){
   const open=ch==='!'?i+1:i,closeBracket=findLinkEnd(']',open+1)
   if(closeBracket!==-1&&text[closeBracket+1]==='('&&(findLinkEnd('[',open+1)===-1||findLinkEnd('[',open+1)>closeBracket)){
    const closeParen=findLinkEnd(')',closeBracket+2)
    if(closeParen!==-1&&!/\s/.test(text.slice(closeBracket+2,closeParen))){
     const raw=text.slice(i,closeParen+1),label=text.slice(open+1,closeBracket),target=text.slice(closeBracket+2,closeParen)
     if(ch==='!'){buffer+=raw;i=closeParen+1;continue} // image syntax stays literal text
     const url=safeLinkUrl(target)
     if(!url||!openLink){buffer+=url?label:raw;i=closeParen+1;continue}
     push(linkButton(label,url));i=closeParen+1;continue
    }
   }
   buffer+=ch;i++;continue
  }
  if((text.startsWith('http://',i)||text.startsWith('https://',i))&&!/[\p{L}\p{N}_]$/u.test(text.slice(Math.max(0,i-2),i))){
   let end=i,balance=0
   while(end<text.length&&!/[\s<>"']/.test(text[end])){if(text[end]==='(')balance++;else if(text[end]===')')balance--;end++}
   const scanned=end
   while(end>i&&(/[.,;:!?]/.test(text[end-1])||(text[end-1]===')'&&balance<0))){if(text[end-1]===')')balance++;end--}
   const raw=text.slice(i,end),url=safeLinkUrl(raw)
   if(url&&openLink)push(linkButton(raw,url));else buffer+=raw
   buffer+=text.slice(end,scanned);i=scanned;continue
  }
  buffer+=ch;i++
 }
 flushText();return nodes
}

const FENCE=/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/,HEADING=/^(#{1,6})\s+(.+?)\s*#*\s*$/,LIST=/^(\s*)([-*+]|\d+[.)])\s+(.*)$/,QUOTE=/^\s*>\s?(.*)$/
const RULE=/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/
function tableCells(line){
 if(!line.includes('|'))return null
 const cells=[];let cell=''
 for(let i=0;i<line.length;i++){
  if(line[i]==='\\'&&line[i+1]==='|'){cell+='|';i++}
  else if(line[i]==='|'){cells.push(cell.trim());cell=''}else cell+=line[i]
 }
 cells.push(cell.trim());if(!cells[0])cells.shift();if(!cells.at(-1))cells.pop()
 return cells
}
/** Unknown syntax stays text; tables and list depth are bounded for streamed replies. */
export function renderMarkdown(text,{document=globalThis.document,openLink}={}){
 const el=(tag,content,children)=>{const node=document.createElement(tag);if(content!==undefined)node.textContent=String(content);if(children)node.append(...children);return node}
 const ctx={document,openLink,el},root=el('div');root.className='md'
 const lines=String(text??'').replace(/\r\n?/g,'\n').split('\n')
 let paragraph=[]
 const flush=()=>{if(paragraph.length){root.append(el('p',undefined,inline(paragraph.join('\n'),ctx)));paragraph=[]}}
 for(let i=0;i<lines.length;i++){
  const line=lines[i],fence=line.match(FENCE)
  if(fence){
   flush();const close=new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`),body=[];let j=i+1
   while(j<lines.length&&!close.test(lines[j]))body.push(lines[j++])
   const code=el('code',body.join('\n'));if(fence[2])code.dataset.lang=fence[2]
   root.append(el('pre',undefined,[code]));i=j;continue
  }
  const heading=line.match(HEADING)
  if(heading){flush();root.append(el(`h${Math.min(heading[1].length,6)}`,undefined,inline(heading[2],ctx)));continue}
  if(RULE.test(line)){flush();root.append(el('hr'));continue}
  const headers=i+1<lines.length&&tableCells(line),dividers=headers&&tableCells(lines[i+1])
  if(headers&&headers.length>0&&headers.length<=12&&dividers?.length===headers.length&&dividers.every(cell=>/^:?-+:?$/.test(cell))){
   flush();const align=dividers.map(cell=>cell.startsWith(':')?(cell.endsWith(':')?'center':'left'):(cell.endsWith(':')?'right':null))
   const row=(cells,tag)=>el('tr',undefined,headers.map((_,col)=>{const cell=el(tag,undefined,inline(cells[col]??'',ctx));if(align[col])cell.dataset.align=align[col];return cell}))
   const body=el('tbody');root.append(el('table',undefined,[el('thead',undefined,[row(headers,'th')]),body]));i++
   for(let count=0;count<200&&i+1<lines.length;count++){const cells=tableCells(lines[i+1]);if(!cells)break;body.append(row(cells,'td'));i++}
   while(i+1<lines.length&&lines[i+1].includes('|'))paragraph.push(lines[++i])
   continue
  }
  const list=line.match(LIST)
  if(list){
   flush();const ordered=/\d/.test(list[2]),outer=el(ordered?'ol':'ul')
   const indent=value=>value.replace(/\t/g,'    ').length
   const stack=[{indent:indent(list[1]),node:outer,item:null}]
   while(i<lines.length){
    const m=lines[i].match(LIST);if(!m||RULE.test(lines[i]))break
    const spaces=indent(m[1]);while(stack.length>1&&spaces<stack.at(-1).indent)stack.pop()
    let level=stack.at(-1)
    if(spaces>=level.indent+2&&level.item&&stack.length<4){const node=el(/\d/.test(m[2])?'ol':'ul');level.item.append(node);level={indent:spaces,node,item:null};stack.push(level)}
    if(stack.length===1&&/\d/.test(m[2])!==ordered&&level.item)break
    const item=el('li'),task=m[3].match(/^\[([ xX])\] (.*)$/)
    if(task){const done=task[1]!==' ';item.dataset.task=done?'done':'open';const marker=el('span',done?'☑':'☐');marker.className='md-task';item.append(marker,...inline(task[2],ctx))}else item.append(...inline(m[3],ctx))
    level.node.append(item);level.item=item;i++
   }
   i--;root.append(outer);continue
  }
  const quote=line.match(QUOTE)
  if(quote){flush();const body=[quote[1]];while(i+1<lines.length&&QUOTE.test(lines[i+1]))body.push(lines[++i].match(QUOTE)[1]);root.append(el('blockquote',undefined,[el('p',undefined,inline(body.join('\n'),ctx))]));continue}
  if(!line.trim()){flush();continue}
  paragraph.push(line)
 }
 flush();return root
}
