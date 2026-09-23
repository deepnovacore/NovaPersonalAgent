import {createHash} from 'node:crypto'
import {basename,extname} from 'node:path'
import {interleave} from './sampling.js'

interface Ref {entry_id:string;version:string|number}
export type ContextInput=
 | {kind:'file';id:string;version:string;content:string;source_id:string;file_id:string;root:string;rel_path:string;role:'document'|'code'|'config'|'cache';mtime_ms:number;priority:number;hidden_prefix_depth?:number}
 | {kind:'memory';id:string;version:string|number;content:string;origin:'stated'|'inferred'}
export interface ContextCandidate {candidate_id:string;id:string;version:string;content:string;tab:'todos'|'ideas';primaryFileId:string|null;refs:Ref[];excerpt:string;reason_code:'document_action'|'document_idea'|'stated_idea';root:string;priority:number;mtime_ms:number}

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const candidateId=(tab:string,primaryId:string,fingerprint:string)=>hash([tab,primaryId,fingerprint])
const excludedParts=new Set(['node_modules','vendor','dist','build','target','coverage','out','tmp','temp','.git','.claude','.codex','.agents','test-results','playwright-report'])
const excludedNames=/^(?:AGENTS|CLAUDE|SKILL|PROMPT|CONTRIBUTING|CHANGELOG|LICENSE|CODE_OF_CONDUCT)(?:\.[^/]*)?$/iu
const generatedNames=/(?:generated|template|fixture|sample|example|snapshot|report[-_]?\d|lockfile)/iu
export function eligibleDocument(path:string,role:string,hiddenPrefixDepth=0):boolean {
 if(role!=='document')return false
 const parts=path.split(/[\\/]/u)
 if(parts.some((part,index)=>excludedParts.has(part.toLowerCase())||(part.startsWith('.')&&index>=hiddenPrefixDepth)))return false
 if(excludedNames.test(basename(path))||generatedNames.test(basename(path)))return false
 return new Set(['.md','.markdown','.txt','.pdf','.docx']).has(extname(path).toLowerCase())
}
const actionLine=(text:string)=>text.split(/\r?\n/u).some(line=>/^\s*(?:[-*]\s*)?(?:next step|todo|待办|下一步|下一步行动|行动项)\s*[:：-]\s*\S/iu.test(line))
const ideaEvidence=(text:string)=>/\b(?:proposal|idea)\b|想法|提议|建议|可以考虑|计划|替代|改进方向|设计方案/iu.test(text)
const genericOverview=(path:string)=>/^readme(?:[._-][a-z]+)?\.(?:md|markdown|txt)$/iu.test(basename(path))

export function selectContextCandidates(inputs:readonly ContextInput[]):ContextCandidate[] {
 const groups=new Map<string,ContextCandidate[]>()
 const sorted=[...inputs].sort((a,b)=>(b.kind==='file'?b.priority:0)-(a.kind==='file'?a.priority:0)||(b.kind==='file'?b.mtime_ms:0)-(a.kind==='file'?a.mtime_ms:0)||a.id.localeCompare(b.id))
 for(const input of sorted){
  if(!input.content.trim())continue
  if(input.kind==='memory'&&input.origin!=='stated')continue
  if(input.kind==='file'&&!eligibleDocument(input.rel_path,input.role,input.hidden_prefix_depth))continue
  const root=input.kind==='file'?input.root:'stated-memory'
  const version=String(input.version),primaryId=input.kind==='file'?input.file_id:input.id
  const tabs:('todos'|'ideas')[]=input.kind==='file'?
   [...(input.priority>=2&&actionLine(input.content)?['todos' as const]:[]),...(!genericOverview(input.rel_path)&&ideaEvidence(input.content)?['ideas' as const]:[])]:['ideas']
  if(input.kind==='memory'&&!/\bidea\b|想法|可以考虑|建议/u.test(input.content))continue
  for(const tab of tabs){
   const candidate_id=candidateId(tab,primaryId,version)
   const item:ContextCandidate={candidate_id,id:candidate_id,version,content:input.content.slice(0,700),tab,primaryFileId:input.kind==='file'?input.file_id:null,refs:[{entry_id:input.id,version:input.version}],excerpt:input.content.slice(0,700),reason_code:input.kind==='memory'?'stated_idea':tab==='todos'?'document_action':'document_idea',root,priority:input.kind==='file'?input.priority:2,mtime_ms:input.kind==='file'?input.mtime_ms:0}
   const group=groups.get(root)??[]
   if(group.filter(c=>c.tab===tab).length>=2)continue
   group.push(item);groups.set(root,group)
  }
 }
 return interleave(groups.values(),12)
}
