import {createHash} from 'node:crypto'
import type {EntryRevision} from './store.js'
import {canonicalJson} from '../text/canonical-json.js'

export const MAX_MEMORY_DOCUMENT_BYTES=8*1024*1024
export const EMPTY_MEMORY_DOCUMENT='# Archived\n\nNo current records.\n'
export const semanticPath=/^(USER\.md|SOUL\.md|MEMORY\.md|(goals|todos|ideas|memory|entities)\/[a-f0-9]{64}\.md)$/u
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const fail=()=>new Error('MEMORY_MARKDOWN_FORMAT')
export function isUserMemory(row:EntryRevision):boolean{
 return row.origin==='stated'&&(row.content.memory_scope==='user'||row.content.memory_scope!=='general'&&(row.kind==='preference'||row.kind==='profile'&&row.content.section==='explicit'))
}
export const SOUL_BODY_MAX=1000
export function memoryDocumentPath(row:EntryRevision):string{
 if(row.kind==='soul')return 'SOUL.md'
 if(isUserMemory(row))return 'USER.md'
 const folder=row.kind==='goal'?'goals':row.kind==='todo'?'todos':row.kind==='idea'?'ideas':row.kind==='entity'?'entities':'memory'
 return `${folder}/${hash(row.entry_id)}.md`
}
function latest(revisions:readonly EntryRevision[]):EntryRevision[]{
 const rows=new Map<string,EntryRevision>()
 for(const row of revisions)if(!rows.has(row.entry_id)||rows.get(row.entry_id)!.revision<row.revision)rows.set(row.entry_id,row)
 return [...rows.values()].filter(row=>row.op!=='tombstone'&&row.kind!=='memory_summary'&&row.kind!=='diary').sort((a,b)=>a.entry_id.localeCompare(b.entry_id))
}
function heading(path:string):string{if(path==='SOUL.md')return '# Soul\n\n<!-- 角色设定请先在应用「我的样子」里保存一次，之后可在下面直接修改正文；名字、说话方式、联系方式在应用里设置。 -->\n\n';return path==='USER.md'?'# User\n\nStable user information. Edit record bodies; keep identity and source markers intact.\n\n':'# Memory document\n\nEdit record bodies; status and links are maintained through Nova.\n\n'}
function parts(row:EntryRevision):{before:string;text:string;after:string}{
 const life=row.content.life_data as Record<string,unknown>|undefined
 const state=life?Object.fromEntries(['status','due','goal_id','idea_id','success_criteria'].filter(key=>life[key]!==undefined).map(key=>[key,life[key]])):{}
 const metadata=canonicalJson({id:row.entry_id,version:row.revision,kind:row.kind,origin:row.origin,evidence_refs:row.evidence_refs,valid_until:row.valid_until}).replace(/-->/gu,'--\\u003e')
 const facts=Object.entries(state).map(([key,value])=>`${key}: ${JSON.stringify(value)}`).join('\n')
 return {before:`## ${row.kind}${typeof row.content.memory_slot==='string'?` (${row.content.memory_slot})`:''}\n\n${facts?facts+'\n\n':''}<!-- nova-record ${metadata} -->\n<!-- editable-current -->\n`,text:typeof row.content.text==='string'?row.content.text:JSON.stringify(row.content,null,2),after:`\n<!-- /nova-record:${hash(row.entry_id)} -->\n\n`}
}
/** Current reading/editing surface. History remains in revision storage and is never copied here. */
export function memoryDocuments(revisions:readonly EntryRevision[]):Map<string,string>{
 const result=new Map<string,string>([['USER.md',heading('USER.md')],['SOUL.md',heading('SOUL.md')]])
 const rows=latest(revisions)
 for(const row of rows){const path=memoryDocumentPath(row),part=parts(row);result.set(path,(result.get(path)??heading(path))+part.before+part.text+part.after)}
 let index='# Memory\n\nGenerated directory; edit the linked documents or use Nova. An omitted entry is not proof of absence.\n\n- [User](USER.md)\n'
 for(const row of rows){if(isUserMemory(row)||row.kind==='soul')continue;const title=(typeof row.content.text==='string'?row.content.text.split('\n')[0]:row.kind)!.replace(/[\[\]\\\r\n]/gu,' ').slice(0,160);const line=`- [${title||row.kind}](${memoryDocumentPath(row)}) — ${row.kind}\n`;if(index.length+line.length>14000)break;index+=line}
 result.set('MEMORY.md',index)
 for(const text of result.values())if(Buffer.byteLength(text)>MAX_MEMORY_DOCUMENT_BYTES)throw new Error('MEMORY_MARKDOWN_LIMIT')
 return result
}
export function memoryDocumentEdits(path:string,text:string,revisions:readonly EntryRevision[]):{entry:EntryRevision;content:EntryRevision['content']}[]{
 if(!semanticPath.test(path))throw fail()
 const expected=memoryDocuments(revisions).get(path)??EMPTY_MEMORY_DOCUMENT
 if(text===expected)return []
 // A SOUL.md that has no record yet is regenerated from the template; only the card or soul.set can create the first role.
 if(path==='SOUL.md'&&!latest(revisions).some(row=>row.kind==='soul'))return []
 if(path==='MEMORY.md'||expected===EMPTY_MEMORY_DOCUMENT)throw fail()
 let at=0
 const prefix=heading(path)
 if(!text.startsWith(prefix))throw fail()
 at=prefix.length
 const edits:{entry:EntryRevision;content:EntryRevision['content']}[]=[]
 for(const row of latest(revisions).filter(row=>memoryDocumentPath(row)===path)){
  const part=parts(row)
  if(!text.startsWith(part.before,at))throw fail()
  at+=part.before.length
  const end=text.indexOf(part.after,at)
  if(end<0)throw fail()
  const body=text.slice(at,end);at=end+part.after.length
  if(body!==part.text){
   const content=typeof row.content.text==='string'?{...row.content,text:body}:JSON.parse(body) as EntryRevision['content']
   edits.push({entry:row,content})
  }
 }
 if(at!==text.length)throw fail()
 return edits
}
