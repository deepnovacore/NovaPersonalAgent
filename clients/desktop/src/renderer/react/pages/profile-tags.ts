const BUDGET=24
const BREAK=/[，。、；：！？,.;:!?\n（）()—–]|\s[-–—]\s/
const wide=(ch:string)=>/[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch)?2:1
export const labelWeight=(text:string)=>[...text].reduce((sum,ch)=>sum+wide(ch),0)

function clip(text:string){
 if(labelWeight(text)<=BUDGET)return text
 const chars=[...text];let used=0,end=0
 while(end<chars.length&&used+wide(chars[end])<=BUDGET-1)used+=wide(chars[end++])
 let cut=chars.slice(0,end)
 if(/[\x21-\x7e]/.test(chars[end]??'')&&/[\x21-\x7e]/.test(chars[end-1]??'')){
  const space=cut.lastIndexOf(' ');if(space>0)cut=cut.slice(0,space)
 }
 return cut.join('').trim()+'…'
}

export function shortLabel(text:unknown):string{
 if(typeof text!=='string')return ''
 const clean=text.replace(/\s+/g,' ').trim()
 const hit=clean.search(BREAK)
 const head=(hit>0?clean.slice(0,hit):clean).trim()
 return clip(head||clean)
}

/** The writer's own keywords lead the row when present; otherwise labels are derived from interests and work titles. A keyword that also names an interest is shown once, in the top row. */
export function profileTopics(modelKeywords:readonly any[]|undefined,interests:readonly any[],work:readonly any[],max=8):{keywords:string[];interests:any[]}{
 const seen=new Set<string>(),own:string[]=[]
 for(const item of modelKeywords??[]){const text=typeof item?.text==='string'?item.text.replace(/\s+/g,' ').trim():'';const key=text.toLowerCase();if(!text||seen.has(key))continue;seen.add(key);own.push(text)}
 if(!own.length)return {keywords:profileKeywords(interests,work,max),interests:[...interests]}
 const same=(item:any)=>{const text=typeof item?.text==='string'?item.text.trim().toLowerCase():'';return seen.has(text)||seen.has(shortLabel(item?.text).toLowerCase())}
 return {keywords:own.slice(0,max),interests:interests.filter(item=>!same(item))}
}
export function profileKeywords(interests:readonly any[],work:readonly any[],max=8):string[]{
 const seen=new Set<string>(),pool:{label:string,order:number}[]=[]
 const add=(label:string)=>{const key=label.toLowerCase();if(!label||label.endsWith('…')||seen.has(key))return;seen.add(key);pool.push({label,order:pool.length})}
 for(const item of interests)add(shortLabel(item?.text))
 for(const item of work)add(shortLabel(item?.title))
 return pool.sort((a,b)=>labelWeight(a.label)-labelWeight(b.label)||a.order-b.order).slice(0,max).sort((a,b)=>a.order-b.order).map(item=>item.label)
}
