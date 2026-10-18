import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {realpath} from 'node:fs/promises'
import {basename,dirname,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {SensitiveContentPolicy} from '../memory/sensitivity.js'
const run=promisify(execFile)
const hash=(text:string)=>createHash('sha256').update(text).digest('hex').slice(0,24)
const git=async(root:string,args:string[])=>{const {stdout}=await run('git',['--no-optional-locks','-C',root,...args],{timeout:3000,maxBuffer:64000});return stdout.trim()}
export interface Commit {id:string;at:string;author:string;self:boolean;subject:string}
/** Paths are supplied by the authorized source registry, never by model arguments. No fetch, checkout or writes. */
export async function inspectProject(root:string){
 const path=await realpath(root).catch(()=>resolve(root)),fallback={id:hash(path),name:basename(path),worktree_alias:basename(path),git:false,head:null as string|null,commits:[] as Commit[],unmerged:[] as Commit[],comparison:null as string|null,dirty:false,history_available:false}
 try{
  const common=await realpath(resolve(path,await git(path,['rev-parse','--git-common-dir'])))
  const primary=basename(common)==='.git'?dirname(common):path,head=await git(path,['rev-parse','HEAD'])
  const identity=await git(path,['var','GIT_AUTHOR_IDENT']).catch(()=>'');const email=/<([^>]+)>/u.exec(identity)?.[1]?.toLowerCase()
  const parse=(text:string):Commit[]=>text.split('\n').filter(Boolean).map(line=>{const [id,at,author,mail,...subject]=line.split('\t');return {id:id!,at:at!,author:author!,self:!!email&&email===mail?.toLowerCase(),subject:subject.join(' ').slice(0,240)}})
  const args=['--format=%H%x09%aI%x09%an%x09%ae%x09%s','-30']
  const commits=parse(await git(path,['log',...args])),primaryHead=await git(primary,['rev-parse','HEAD']).catch(()=>head)
  const unmerged=primaryHead===head?[]:parse(await git(path,['log',...args,primaryHead+'..'+head]))
  return {...fallback,id:hash(common),name:basename(primary),git:true,head,commits,unmerged,comparison:primaryHead,dirty:!!await git(path,['status','--porcelain','--untracked-files=no']),history_available:true}
 }catch{return fallback}
}
export async function inspectProjectDiff(root:string,commit:string,files:readonly string[]=[]){
 if(!/^[a-f0-9]{40}$/u.test(commit))throw Error('invalid_project_commit')
 await git(root,['merge-base','--is-ancestor',commit,'HEAD'])
 const patch=await git(root,['show','--format=medium','--no-ext-diff','--no-textconv','--stat','--patch','--unified=2',commit,...(files.length?['--',...files]:[])])
 const safe=new SensitiveContentPolicy().scrub('profile',patch.slice(0,8000))
 return {commit,text:safe.kind==='clean'?patch.slice(0,8000):safe.kind==='redacted'?safe.value:'',truncated:patch.length>8000}
}
