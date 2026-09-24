import {execFile} from 'node:child_process'
import {lstat} from 'node:fs/promises'
import {join} from 'node:path'
import {promisify} from 'node:util'

export interface RootSignal {path:string; selected:boolean; currentWorkspace:boolean; lastGitCommitMs:number|null; mtimeMs:number}

const recentGit=(root:RootSignal,now:number)=>root.lastGitCommitMs!==null&&now-root.lastGitCommitMs<30*86_400_000
const recentMtime=(root:RootSignal,now:number)=>now-root.mtimeMs<7*86_400_000

export function orderComputerRoots<T extends RootSignal>(roots: readonly T[]): T[] {
  const now=Date.now()
  return [...roots].sort((a,b)=>Number(b.selected)-Number(a.selected)
    || Number(b.currentWorkspace)-Number(a.currentWorkspace)
    || Number(recentGit(b,now))-Number(recentGit(a,now))
    || (b.lastGitCommitMs??0)-(a.lastGitCommitMs??0)
    || Number(recentMtime(b,now))-Number(recentMtime(a,now))
    || (recentMtime(b,now)?b.mtimeMs-a.mtimeMs:0) || a.path.localeCompare(b.path))
}

/** Four selected/current, two recent-Git, one recent-mtime, then one other turn. */
export function nextComputerRoot<T extends RootSignal>(roots:readonly T[],turn:number,cursors:number[],skipped:ReadonlySet<string>=new Set()):T|undefined {
  const now=Date.now()
  const tiers=[
    roots.filter(root=>root.selected||root.currentWorkspace),
    roots.filter(root=>!root.selected&&!root.currentWorkspace&&recentGit(root,now)),
    roots.filter(root=>!root.selected&&!root.currentWorkspace&&!recentGit(root,now)&&recentMtime(root,now)),
    roots.filter(root=>!root.selected&&!root.currentWorkspace&&!recentGit(root,now)&&!recentMtime(root,now)),
  ]
  const preferred=[0,0,0,0,1,1,2,3][turn%8]!
  for(const tier of [preferred,(preferred+1)%4,(preferred+2)%4,(preferred+3)%4]){
    const available=tiers[tier]!.filter(root=>!skipped.has(root.path))
    if(!available.length)continue
    const cursor=cursors[tier]??0
    cursors[tier]=cursor+1
    return available[cursor%available.length]
  }
  return undefined
}

const run = promisify(execFile)
export async function rootActivity(path:string):Promise<{lastGitCommitMs:number|null;ownCommits:number;mtimeMs:number}> {
  const stat=await lstat(path).catch(()=>null)
  let lastGitCommitMs:number|null=null,ownCommits=0
  const marker=await lstat(join(path,'.git')).catch(()=>null)
  if(marker&&(marker.isDirectory()||marker.isFile())&&!marker.isSymbolicLink()){
    try{
      const ident=await run('git',['-C',path,'var','GIT_AUTHOR_IDENT'],{timeout:500,maxBuffer:512})
      const email=/<([^<>]+)>/u.exec(ident.stdout)?.[1]?.toLowerCase()
      if(email){
        const {stdout}=await run('git',['-C',path,'log','-50','--since=30.days','--format=%ae|%ct'],{timeout:500,maxBuffer:8192})
        for(const line of stdout.trim().split('\n')){
          const at=line.lastIndexOf('|'),seconds=Number(line.slice(at+1))
          if(at>0&&line.slice(0,at).toLowerCase()===email&&Number.isFinite(seconds)&&seconds>0)
            {lastGitCommitMs=Math.max(lastGitCommitMs??0,seconds*1000);ownCommits++}
        }
      }
    }catch{/* A missing or unavailable Git history is only an absent ranking clue. */}
  }
  return {lastGitCommitMs,ownCommits,mtimeMs:stat?.mtimeMs??0}
}
