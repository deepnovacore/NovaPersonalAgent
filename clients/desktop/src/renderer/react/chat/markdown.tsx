import React, {type ReactNode} from 'react'

export function safeLinkUrl(value:string){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:null}catch{return null}}
type Props={text?:unknown,openLink?:(url:string)=>unknown}
const WORD=/[\p{L}\p{N}_]/u
function inline(text:string,openLink:Props['openLink'],depth=0):ReactNode[]{
 const nodes:ReactNode[]=[];let buffer='',i=0,emScan=-1;const ends=new Map<string,number>()
 const find=(token:string,start:number)=>{let end=ends.get(token);if(end===undefined||(end!==-1&&end<start)){end=text.indexOf(token,start);ends.set(token,end)}return end}
 const flush=()=>{if(buffer){nodes.push(buffer);buffer=''}}
 const push=(tag:string,body:ReactNode,props:any={})=>{flush();nodes.push(React.createElement(tag,{...props,key:nodes.length},body))}
 const link=(label:string,url:string)=>push('button',label,{type:'button',className:'md-link',title:url,'data-url':url,onClick:()=>{void Promise.resolve(openLink?.(url)).catch(()=>{})}})
 while(i<text.length){
  const ch=text[i]
  if(ch==='`'){let run=i;while(text[run]==='`')run++;const fence='`'.repeat(run-i),close=text.indexOf(fence,run);if(close===-1){buffer+=fence;i=run;continue}const code=text.slice(run,close);push('code',code.trim()||code);i=close+fence.length;continue}
  if(text.startsWith('~~',i)&&depth<4){const close=find('~~',i+2);if(close>i+2){push('del',inline(text.slice(i+2,close),openLink,depth+1));i=close+2;continue}buffer+='~~';i+=2;continue}
  if(ch==='*'&&depth<4){if(text.startsWith('**',i)){const close=text.indexOf('**',i+2);if(close>i+2){push('strong',inline(text.slice(i+2,close),openLink,depth+1));i=close+2;continue}buffer+='**';i+=2;continue}const prev=text[i-1]??'',next=text[i+1]??'';if(!WORD.test(prev)&&next&&!/\s/.test(next)&&next!=='*'){let close=Math.max(text.indexOf('*',i+1),emScan);while(close!==-1&&close<text.length&&text[close]==='*'&&(text[close+1]==='*'||/\s/.test(text[close-1])||WORD.test(text[close+1]??'')))close=text.indexOf('*',close+1);if(close!==-1&&text[close]==='*'){push('em',inline(text.slice(i+1,close),openLink,depth+1));i=close+1;continue}emScan=text.length}buffer+=ch;i++;continue}
  if(ch==='['||(ch==='!'&&text[i+1]==='[')){const start=ch==='!'?i+1:i,close=find(']',start+1);if(close!==-1&&text[close+1]==='('&&(find('[',start+1)===-1||find('[',start+1)>close)){const end=find(')',close+2);if(end!==-1&&!/\s/.test(text.slice(close+2,end))){const raw=text.slice(i,end+1),label=text.slice(start+1,close),target=text.slice(close+2,end),url=safeLinkUrl(target);if(ch==='!')buffer+=raw;else if(url&&openLink)link(label,url);else buffer+=url?label:raw;i=end+1;continue}}buffer+=ch;i++;continue}
  if((text.startsWith('http://',i)||text.startsWith('https://',i))&&!/[A-Za-z0-9_]$/.test(text.slice(Math.max(0,i-1),i))){let end=i,balance=0;while(end<text.length&&!/[\s<>"'，。、；：！？（）「」『』《》【】“”‘’]|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text[end])){if(text[end]==='(')balance++;else if(text[end]===')')balance--;end++}const scanned=end;while(end>i&&(/[.,;:!?]/.test(text[end-1])||(text[end-1]===')'&&balance<0))){if(text[end-1]===')')balance++;end--}const raw=text.slice(i,end),url=safeLinkUrl(raw);if(url&&openLink)link(raw,url);else buffer+=raw;buffer+=text.slice(end,scanned);i=scanned;continue}
  buffer+=ch;i++
 }
 flush();return nodes
}
const FENCE=/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/,HEADING=/^(#{1,6})\s+(.+?)\s*#*\s*$/,LIST=/^(\s*)([-*+]|\d+[.)])\s+(.*)$/,QUOTE=/^\s*>\s?(.*)$/,RULE=/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/
function cells(line:string){if(!line.includes('|'))return null;const result:string[]=[];let cell='';for(let i=0;i<line.length;i++){if(line[i]==='\\'&&line[i+1]==='|'){cell+='|';i++}else if(line[i]==='|'){result.push(cell.trim());cell=''}else cell+=line[i]}result.push(cell.trim());if(!result[0])result.shift();if(!result.at(-1))result.pop();return result}
/** Untrusted text becomes React elements; images remain literal and links use the host opener. */
export function Markdown({text,openLink}:Props){
 const result:ReactNode[]=[],lines=String(text??'').replace(/\r\n?/g,'\n').split('\n');let paragraph:string[]=[]
 const add=(tag:string,body?:ReactNode,props:any={})=>result.push(React.createElement(tag,{...props,key:result.length},body))
 const flush=()=>{if(paragraph.length){add('p',inline(paragraph.join('\n'),openLink));paragraph=[]}}
 for(let i=0;i<lines.length;i++){
  const line=lines[i],fence=line.match(FENCE)
  if(fence){flush();const close=new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`),body:string[]=[];let j=i+1;while(j<lines.length&&!close.test(lines[j]))body.push(lines[j++]);add('pre',<code data-lang={fence[2]||undefined}>{body.join('\n')}</code>);i=j;continue}
  const heading=line.match(HEADING);if(heading){flush();add('h'+Math.min(heading[1].length,6),inline(heading[2],openLink));continue}if(RULE.test(line)){flush();add('hr');continue}
  const headers=i+1<lines.length?cells(line):null,dividers=headers?cells(lines[i+1]):null
  if(headers?.length&&headers.length<=12&&dividers?.length===headers.length&&dividers.every(cell=>/^:?-+:?$/.test(cell))){flush();const align=dividers.map(cell=>cell.startsWith(':')?(cell.endsWith(':')?'center':'left'):(cell.endsWith(':')?'right':undefined));const row=(values:string[],tag:string)=>headers.map((_,col)=>React.createElement(tag,{key:col,'data-align':align[col]},inline(values[col]??'',openLink)));const body:ReactNode[]=[];i++;for(let count=0;count<200&&i+1<lines.length;count++){const values=cells(lines[i+1]);if(!values)break;body.push(<tr key={count}>{row(values,'td')}</tr>);i++}add('table',<><thead><tr>{row(headers,'th')}</tr></thead><tbody>{body}</tbody></>);while(i+1<lines.length&&lines[i+1].includes('|'))paragraph.push(lines[++i]);continue}
  const list=line.match(LIST)
  if(list){flush();type Item={text:string,children:Level[],task?:string};type Level={indent:number,ordered:boolean,items:Item[]};const outer:Level={indent:list[1].replace(/\t/g,'    ').length,ordered:/\d/.test(list[2]),items:[]},stack=[outer];while(i<lines.length){const m=lines[i].match(LIST);if(!m||RULE.test(lines[i]))break;const spaces=m[1].replace(/\t/g,'    ').length;while(stack.length>1&&spaces<stack.at(-1)!.indent)stack.pop();let level=stack.at(-1)!;if(spaces>=level.indent+2&&level.items.length&&stack.length<4){const child:Level={indent:spaces,ordered:/\d/.test(m[2]),items:[]};level.items.at(-1)!.children.push(child);stack.push(child);level=child}if(stack.length===1&&/\d/.test(m[2])!==outer.ordered&&level.items.length)break;const task=m[3].match(/^\[([ xX])\] (.*)$/);level.items.push({text:task?task[2]:m[3],children:[],task:task?(task[1]===' '?'open':'done'):undefined});i++}i--;const render=(level:Level,key=0):ReactNode=>React.createElement(level.ordered?'ol':'ul',{key},level.items.map((item,index)=><li key={index} data-task={item.task}>{item.task&&<span className="md-task">{item.task==='done'?'☑':'☐'}</span>}{inline(item.text,openLink)}{item.children.map((child,k)=>render(child,k))}</li>));result.push(<React.Fragment key={result.length}>{render(outer)}</React.Fragment>);continue}
  const quote=line.match(QUOTE);if(quote){flush();const body=[quote[1]];while(i+1<lines.length&&QUOTE.test(lines[i+1]))body.push(lines[++i].match(QUOTE)![1]);add('blockquote',<p>{inline(body.join('\n'),openLink)}</p>);continue}
  if(!line.trim()){flush();continue}paragraph.push(line)
 }
 flush();return <div className="md">{result}</div>
}
