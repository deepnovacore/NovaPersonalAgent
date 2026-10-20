import {randomUUID} from 'node:crypto'
import {mkdir, open, opendir, realpath, rename, stat, unlink} from 'node:fs/promises'
import {dirname, isAbsolute, join, posix, win32} from 'node:path'
import {z} from 'zod'
import type {CascadedLlmTool} from '../realtime/cascaded/llm.js'
import type {JsonValue} from '../core/events.js'
import {executeLocalShell, type LocalShellOptions} from './local-shell.js'

export const LOCAL_OUTPUT_BYTES = 64 * 1024
export const LOCAL_FILE_BYTES = 1024 * 1024
export {projectResourceKey} from '../executors/task-resources.js'
const pathArgument = z.string().min(1).max(32768).refine(path => !path.includes('\0'), 'invalid_path')
export const localToolArguments = {
 file_read: z.object({path:pathArgument,offset:z.number().int().min(1).default(1),limit:z.number().int().min(1).max(2000).default(2000)}).strict(),
 file_write: z.object({path:pathArgument,content:z.string().refine(text=>Buffer.byteLength(text)<=LOCAL_FILE_BYTES,'file_too_large')}).strict(),
 file_edit: z.object({path:pathArgument,old_string:z.string().min(1),new_string:z.string(),replace_all:z.boolean().default(false)}).strict(),
 shell_execute: z.object({command:z.string().min(1).max(LOCAL_FILE_BYTES).refine(text=>!text.includes('\0')),cwd:pathArgument.optional(),timeout:z.number().int().min(1).max(3600).default(60)}).strict(),
} as const
export type LocalToolName = keyof typeof localToolArguments
const descriptions:Record<LocalToolName,string> = {
 file_read:'Read a UTF-8 file or list a directory. Paths are relative to the selected project or absolute. offset is 1-based; limit is at most 2000. Text is limited to 64 KiB; binary files return metadata. Follow truncation and pagination before claiming complete coverage.',
 file_write:'Atomically create or replace a UTF-8 file, creating parent directories. Maximum content is 1 MiB. Read existing files first. The host may request user approval before writing.',
 file_edit:'Exactly replace old_string with new_string in a UTF-8 file (at most 1 MiB). Require one match unless replace_all=true. Preserve exact line endings. Read first; no match or ambiguous matches make no changes. The host may request approval.',
 shell_execute:'Execute a native shell command in the selected project or cwd. macOS uses zsh; Windows uses Windows PowerShell. timeout is 1–3600 seconds (default 60). Read stdout, stderr, exit_code and status; nonzero exit is failure. Output is limited to 64 KiB. A stopped or unknown operation must be checked before retrying.',
}
export const LOCAL_TOOLS:readonly CascadedLlmTool[] = Object.entries(localToolArguments).map(([name,schema])=>({name,description:descriptions[name as LocalToolName],parameters:JSON.parse(JSON.stringify(z.toJSONSchema(schema))) as CascadedLlmTool['parameters']}))
export function isLocalTool(name:string):name is LocalToolName{return Object.hasOwn(localToolArguments,name)}
export function localPath(project:string,path:string,platform:NodeJS.Platform=process.platform):string{
 if(!path||path.includes('\0'))throw Error('invalid_path')
 if(platform==='win32'){
  // C:foo and \foo depend on ambient drive state and are never accepted.
  if(/^[a-z]:[^\\/]/iu.test(path)||/^[a-z]:$/iu.test(path)||/^[\\/](?![\\/])/u.test(path))throw Error('ambiguous_windows_path')
  return win32.resolve(project,path)
 }
 return posix.resolve(project,path)
}
export async function canonicalProject(path:string):Promise<string>{
 if(!isAbsolute(path)||path.includes('\0'))throw Error('invalid_project_directory')
 const canonical=await realpath(localPath(dirname(path),path))
 if(!(await stat(canonical)).isDirectory())throw Error('invalid_project_directory')
 return canonical
}
function decode(bytes:Uint8Array):string{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)}
async function readText(path:string):Promise<{text:string;mode:number}>{
 const file=await open(path,'r')
 try{const info=await file.stat();if(!info.isFile())throw Error('not_a_file');if(info.size>LOCAL_FILE_BYTES)throw Error('file_too_large');const bytes=await file.readFile();if(bytes.length>LOCAL_FILE_BYTES||bytes.includes(0))throw Error('not_utf8_text');return {text:decode(bytes),mode:info.mode}}
 finally{await file.close()}
}
/** Same-directory rename, with a flushed temporary file. A failure never removes the old file. */
export async function atomicLocalWrite(path:string,content:string,signal:AbortSignal,mode?:number):Promise<void>{
 if(Buffer.byteLength(content)>LOCAL_FILE_BYTES)throw Error('file_too_large')
 signal.throwIfAborted();await mkdir(dirname(path),{recursive:true});signal.throwIfAborted()
 const temp=join(dirname(path),'.nova-'+randomUUID()+'.tmp'),file=await open(temp,'wx',mode===undefined?0o666:mode&0o777)
 try{await file.writeFile(content,'utf8');if(mode!==undefined)await file.chmod(mode&0o777);await file.sync();await file.close();signal.throwIfAborted();await rename(temp,path)}
 finally{await file.close().catch(()=>{ /* cleanup after a closed descriptor */ });await unlink(temp).catch(()=>{ /* rename already consumed the temporary */ })}
}
async function fileRead(path:string,offset:number,limit:number,signal:AbortSignal):Promise<JsonValue>{
 const info=await stat(path)
 if(info.isDirectory()){
  const entries:JsonValue[]=[];let index=0,bytes=0,truncated=false
  for await(const entry of await opendir(path)){
   signal.throwIfAborted();index++;if(index<offset)continue
   const item={name:entry.name,type:entry.isDirectory()?'directory':entry.isSymbolicLink()?'link':entry.isFile()?'file':'other'},size=Buffer.byteLength(JSON.stringify(item))
   if(entries.length===limit||bytes+size>LOCAL_OUTPUT_BYTES){truncated=true;break}entries.push(item);bytes+=size
  }
  return {path,type:'directory',entries,offset,next_offset:truncated?offset+entries.length:null,truncated}
 }
 if(!info.isFile())throw Error('not_a_regular_file')
 const file=await open(path,'r')
 try{
  const buffer=Buffer.alloc(8192),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let line=1,count=0,content='',partial='',bytes=0,truncated=false,binary=false
  outer:while(true){
   signal.throwIfAborted();const {bytesRead}=await file.read(buffer,0,buffer.length,null);let chunk:string
   try{const data=buffer.subarray(0,bytesRead);if(data.includes(0)){binary=true;break}chunk=decoder.decode(data,{stream:bytesRead!==0})}catch{binary=true;break}
   for(const char of chunk){
    if(line>=offset){const n=Buffer.byteLength(char);if(count>=limit||bytes+n>LOCAL_OUTPUT_BYTES){truncated=true;break outer}partial+=char;bytes+=n}
    if(char==='\n'){if(line>=offset){content+=partial;partial='';count++}line++}
   }
   if(bytesRead===0)break
  }
  content+=partial;if(partial)count++
  if(binary)return {path,type:'binary',size:info.size}
  return {path,type:'file',size:info.size,content,offset,lines:count,truncated,next_offset:truncated?offset+count:null}
 }finally{await file.close()}
}
export async function executeLocalTool(name:LocalToolName,args:unknown,project:string,signal:AbortSignal,shell:LocalShellOptions={}):Promise<JsonValue>{
 signal.throwIfAborted()
 if(name==='shell_execute'){const q=localToolArguments.shell_execute.parse(args);return executeLocalShell({...q,cwd:localPath(project,q.cwd??project)},signal,shell)}
 if(name==='file_read'){const q=localToolArguments.file_read.parse(args);return fileRead(localPath(project,q.path),q.offset,q.limit,signal)}
 if(name==='file_write'){
  const q=localToolArguments.file_write.parse(args),requested=localPath(project,q.path)
  // Follow an existing link instead of replacing the link itself.
  const path=await realpath(requested).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return requested;throw error})
  let old:{bom:boolean;mode:number}|undefined
  try {
   const file=await open(path,'r')
   try {
    const info=await file.stat();if(!info.isFile())throw Error('not_a_file')
    const header=Buffer.alloc(3);await file.read(header,0,3,0)
    old={mode:info.mode,bom:header.equals(Buffer.from([0xef,0xbb,0xbf]))}
   } finally {await file.close()}
  } catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  const content=old?.bom&&!q.content.startsWith('\ufeff')?'\ufeff'+q.content:q.content
  await atomicLocalWrite(path,content,signal,old?.mode);return {path,written_bytes:Buffer.byteLength(content),status:'completed'}
 }
 const q=localToolArguments.file_edit.parse(args),path=await realpath(localPath(project,q.path)),old=await readText(path)
 const matches=old.text.split(q.old_string).length-1
 if(matches===0)throw Error('no_match');if(matches>1&&!q.replace_all)throw Error('multiple_matches')
 const content=q.replace_all?old.text.split(q.old_string).join(q.new_string):old.text.replace(q.old_string,()=>q.new_string)
 await atomicLocalWrite(path,content,signal,old.mode);return {path,replacements:q.replace_all?matches:1,status:'completed'}
}
