import {execFile} from 'node:child_process'
import {lstat} from 'node:fs/promises'
import {join} from 'node:path'
import {promisify} from 'node:util'

export interface RootSignal {path:string; selected:boolean; currentWorkspace:boolean; lastGitCommitMs:number|null; mtimeMs:number}

export function orderComputerRoots<T extends RootSignal>(roots: readonly T[]): T[] {
  return [...roots].sort((a,b)=>Number(b.selected)-Number(a.selected)
    || Number(b.currentWorkspace)-Number(a.currentWorkspace)
    || (b.lastGitCommitMs??0)-(a.lastGitCommitMs??0)
    || b.mtimeMs-a.mtimeMs || a.path.localeCompare(b.path))
}

/** Four high-priority, two active, then one other turn; cursors rotate within tiers. */
export function nextComputerRoot<T extends RootSignal>(roots:readonly T[],turn:number,cursors:number[],skipped:ReadonlySet<string>=new Set()):T|undefined {
  const now=Date.now()
  const tiers=[roots.filter(root=>root.selected||root.currentWorkspace),roots.filter(root=>!root.selected&&!root.currentWorkspace&&root.lastGitCommitMs!==null&&now-root.lastGitCommitMs<30*86_400_000),roots.filter(root=>!root.selected&&!root.currentWorkspace&&(root.lastGitCommitMs===null||now-root.lastGitCommitMs>=30*86_400_000))]
  const preferred=[0,0,0,0,1,1,2][turn%7]!
  for(const tier of [preferred,0,1,2]){
    const available=tiers[tier]!.filter(root=>!skipped.has(root.path))
    if(!available.length)continue
    const cursor=cursors[tier]??0
    cursors[tier]=cursor+1
    return available[cursor%available.length]
  }
  return undefined
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
