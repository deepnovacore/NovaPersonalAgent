import {execFile} from 'node:child_process'
import {lstat} from 'node:fs/promises'
import {join} from 'node:path'
import {promisify} from 'node:util'

export type RootSignal = {path:string; selected:boolean; currentWorkspace:boolean; lastGitCommitMs:number|null; mtimeMs:number}

export function orderComputerRoots<T extends RootSignal>(roots: readonly T[]): T[] {
  return [...roots].sort((a,b)=>Number(b.selected)-Number(a.selected)
    || Number(b.currentWorkspace)-Number(a.currentWorkspace)
    || (b.lastGitCommitMs??0)-(a.lastGitCommitMs??0)
    || b.mtimeMs-a.mtimeMs || a.path.localeCompare(b.path))
}

const run = promisify(execFile)
export async function rootActivity(path:string):Promise<{lastGitCommitMs:number|null;mtimeMs:number}> {
  const stat=await lstat(path).catch(()=>null)
  let lastGitCommitMs:number|null=null
  const marker=await lstat(join(path,'.git')).catch(()=>null)
  if(marker&&(marker.isDirectory()||marker.isFile())&&!marker.isSymbolicLink()){
    try{
      const {stdout}=await run('git',['-C',path,'log','-1','--format=%ct'],{timeout:500,maxBuffer:256})
      const seconds=Number(stdout.trim())
      if(Number.isFinite(seconds)&&seconds>0)lastGitCommitMs=seconds*1000
    }catch{/* A missing or unavailable Git history is only an absent ranking clue. */}
  }
  return {lastGitCommitMs,mtimeMs:stat?.mtimeMs??0}
}
