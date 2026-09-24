import {basename} from 'node:path'
import {eligibleDocument,type ContextInput} from './context-candidates.js'
import type {ProfileInput} from './profile-warmup.js'
import type {ContextEntry} from './workbench-context.js'

/** A small, varied set of active work material for the profile draft. */
export function selectProfileSources(entries:readonly ContextEntry[]):ProfileInput[]{
  const groups=new Map<string,ContextInput[]>()
  for(const entry of entries){
    if(!('kind' in entry)||entry.kind!=='file'||entry.priority<1||!entry.content.trim()||!eligibleDocument(entry.rel_path,entry.role,entry.hidden_prefix_depth))continue
    const group=groups.get(entry.root)??[]
    group.push(entry);groups.set(entry.root,group)
  }
  const ranked=[...groups.entries()].map(([root,files])=>({
    root,priority:Math.max(...files.map(file=>file.kind==='file'?file.priority:0)),
    recent:Math.max(...files.map(file=>file.kind==='file'?file.mtime_ms:0)),
    files:files.sort((a,b)=>(b.kind==='file'?b.mtime_ms:0)-(a.kind==='file'?a.mtime_ms:0)).slice(0,2),
  })).sort((a,b)=>b.priority-a.priority||b.recent-a.recent||a.root.localeCompare(b.root)).slice(0,12)
  return ranked.flatMap(group=>group.files.map(entry=>{
    if(entry.kind!=='file')throw Error('profile_source_kind')
    return {id:entry.id,version:entry.version,content:entry.content,origin:'inferred' as const,
      source:{project:basename(entry.root),document:basename(entry.rel_path)}}
  }))
}
