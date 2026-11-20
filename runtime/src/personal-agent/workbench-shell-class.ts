import {homedir} from 'node:os'
import {isAbsolute,join,relative,resolve,sep} from 'node:path'

interface Tok{text:string;dynamic:boolean;op?:boolean}

/** Quote-aware split into simple commands. `$(...)` and backticks come back as separate sub-commands. */
function scan(source:string):{segments:Tok[][];subs:string[]}{
  const segments:Tok[][]=[],subs:string[]=[]
  let seg:Tok[]=[],text='',has=false,dynamic=false
  const flush=()=>{if(has)seg.push({text,dynamic});text='';has=false;dynamic=false}
  const cut=()=>{flush();if(seg.length)segments.push(seg);seg=[]}
  const group=(from:number):number=>{let depth=1,j=from;for(;j<source.length;j++){const c=source[j];if(c==='\\'){j++;continue}if(c==='(')depth++;else if(c===')'&&--depth===0)break}return j}
  const substitution=(i:number):number=>{
    if(source[i]==='`'){const end=source.indexOf('`',i+1),stop=end<0?source.length:end;subs.push(source.slice(i+1,stop));return stop}
    const end=group(i+2);subs.push(source.slice(i+2,end));return end
  }
  for(let i=0;i<source.length;i++){
    const c=source[i]!
    if(c==='\\'){if(source[i+1]==='\n'){i++;continue}text+=source[++i]??'';has=true;continue}
    if(c==="'"){const end=source.indexOf("'",i+1),stop=end<0?source.length:end;text+=source.slice(i+1,stop);has=true;i=stop;continue}
    if(c==='"'){
      has=true
      for(i++;i<source.length&&source[i]!=='"';i++){
        const d=source[i]!
        if(d==='\\'){text+=source[++i]??'';continue}
        if(d==='`'||(d==='$'&&source[i+1]==='(')){i=substitution(i);dynamic=true;text+='$';continue}
        if(d==='$')dynamic=true
        text+=d
      }
      continue
    }
    if(c==='`'||(c==='$'&&source[i+1]==='(')){i=substitution(i);dynamic=true;has=true;text+='$';continue}
    if(c==='$'){dynamic=true;has=true;text+=c;continue}
    if(c==='#'&&!has){const nl=source.indexOf('\n',i);if(nl<0)break;i=nl-1;continue}
    if(c===' '||c==='\t'||c==='\r'){flush();continue}
    if(c===';'||c==='\n'||c==='('||c===')'||c==='|'){cut();continue}
    if(c==='&'){
      if(source[i+1]==='>'){flush();seg.push({text:'>',dynamic:false,op:true});i+=source[i+2]==='>'?2:1;continue}
      if(source[i-1]==='>'&&seg.at(-1)?.op){seg.at(-1)!.text='>&';continue}
      cut();continue
    }
    if(c==='>'||c==='<'){
      if(has&&!dynamic&&/^\d+$/u.test(text)){text='';has=false}else flush()
      let op=c as string
      if(source[i+1]===c){op+=c;i++;if(c==='<'&&source[i+1]==='<'){op='<<<';i++}}
      else if(c==='>'&&source[i+1]==='|'){op='>|';i++}
      seg.push({text:op,dynamic:false,op:true});continue
    }
    text+=c;has=true
  }
  cut()
  return {segments,subs}
}

const WRAPPERS=new Set(['sudo','env','time','nohup','command','exec','nice','builtin'])
const KEYWORDS=new Set(['if','then','else','elif','fi','do','done','while','until','{','}','!','esac'])
const SKIPPED=new Set(['for','case','select','function'])
const SHELLS=new Set(['sh','bash','zsh','dash','ksh','fish'])
const AMBIGUOUS=new Set(['eval','source','.','xargs'])
const TRIVIAL=new Set(['echo','printf','true','false',':','test','[','[[','sleep','pwd','export','set','unset','alias','read','wait','exit','return','type','which','date','umask'])
const SUBCOMMANDS=new Set(['git','npm','pnpm','yarn','docker','brew','pip','pip3','cargo','kubectl','gh','go','dotnet'])
const WRITE_ALL=new Set(['rm','rmdir','mv','touch','mkdir','ln','tee','truncate','chmod','chown','unlink','shred'])
const WRITE_LAST=new Set(['cp','install','rsync','scp'])
const SKIP_FIRST=new Set(['chmod','chown','truncate'])
const READERS=new Set(['cat','head','tail','less','more','grep','egrep','fgrep','rg','ag','ls','tree','wc','stat','file','du','diff','sort','uniq','awk','sed','cut','strings','xxd','od','hexdump','bat','tac','nl','realpath','readlink'])
const PATTERN_FIRST=new Set(['grep','egrep','fgrep','rg','ag','awk','sed'])

/**
 * Approval classes of one shell command: one per constituent plus the file effects it can be proven to have.
 * Anything that cannot be analysed statically yields `shell:*`, which conservatively matches any denied shell class.
 */
export function shellClasses(command:string,cwd:string|undefined,project:string):string[]{
  const out=new Set<string>(),trivial:string[]=[],home=homedir()
  let ambiguous=false
  const abs=(path:string,base:string)=>resolve(base,path==='~'?home:path.startsWith('~/')?join(home,path.slice(2)):path)
  const inside=(path:string)=>{const rel=relative(project,path);return !rel.startsWith('..')&&!isAbsolute(rel)}
  const root=(path:string)=>inside(path)?'rel:'+(relative(project,path).split(sep).slice(0,2).join('/')||'.'):'abs:'+path.split(sep).filter(Boolean).slice(0,2).join('/')
  const write=(path:string)=>{out.add((inside(path)?'file-write:':'file-write-outside:')+path)}
  const read=(path:string)=>{if(!inside(path))out.add('file-read-outside:'+path)}
  const analyze=(text:string,start:string,depth:number)=>{
    if(depth>3){ambiguous=true;return}
    let dir=start
    const {segments,subs}=scan(text)
    for(const sub of subs)analyze(sub,dir,depth+1)
    for(const segment of segments){
      let words:Tok[]=[]
      for(let k=0;k<segment.length;k++){
        const token=segment[k]!
        if(!token.op){words.push(token);continue}
        const target=segment[++k]
        if(!target||token.text==='<<'||token.text==='<<<')continue
        if(token.text==='>&'&&(/^\d+$/u.test(target.text)||target.text==='-'))continue
        if(target.dynamic){ambiguous=true;continue}
        const path=abs(target.text,dir)
        if(token.text==='<')read(path);else if(target.text!=='/dev/null')write(path)
      }
      while(words.length){
        const word=words[0]!,base=word.text.replace(/^.*[\\/]/u,'').toLowerCase()
        if(!word.dynamic&&/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word.text)||KEYWORDS.has(word.text))words.shift()
        else if(SKIPPED.has(base)){words=[];break}
        else if(WRAPPERS.has(base)){words.shift();while(words[0]?.text.startsWith('-'))words.shift()}
        else break
      }
      const name=words[0]
      if(!name)continue
      if(name.dynamic){ambiguous=true;continue}
      const base=name.text.replace(/^.*[\\/]/u,'').toLowerCase(),args=words.slice(1)
      if(base==='cd'||base==='pushd'){
        const target=args.find(arg=>!arg.text.startsWith('-')||arg.text==='-')
        if(!target)dir=home;else if(target.dynamic||target.text==='-')ambiguous=true;else dir=abs(target.text,dir)
        continue
      }
      if(base==='popd')continue
      if(AMBIGUOUS.has(base)){ambiguous=true;continue}
      if(SHELLS.has(base)){
        const index=args.findIndex(arg=>/^-[a-z]*c[a-z]*$/u.test(arg.text))
        if(index>=0){
          const inner=args[index+1]
          if(!inner||inner.dynamic||/[$`]/u.test(inner.text))ambiguous=true;else analyze(inner.text,dir,depth+1)
          continue
        }
      }
      const positional=args.filter(arg=>!arg.text.startsWith('-')),statics=positional.filter(arg=>!arg.dynamic)
      const sub=SUBCOMMANDS.has(base)&&args[0]&&!args[0].text.startsWith('-')?' '+args[0].text.toLowerCase():''
      let operands=positional
      if(SKIP_FIRST.has(base))operands=operands.slice(1)
      if(base==='find'){
        const paths=args.slice(0,Math.max(0,args.findIndex(arg=>/^[-!(]/u.test(arg.text))<0?args.length:args.findIndex(arg=>/^[-!(]/u.test(arg.text))))
        const flags=args.map(arg=>arg.text)
        if(flags.some(flag=>['-exec','-execdir','-ok','-okdir'].includes(flag)))ambiguous=true
        for(const path of paths.filter(arg=>!arg.dynamic)){read(abs(path.text,dir));if(flags.includes('-delete'))write(abs(path.text,dir))}
        if(flags.includes('-delete')&&paths.some(arg=>arg.dynamic))ambiguous=true
      }else if(WRITE_ALL.has(base)||WRITE_LAST.has(base)||(base==='sed'&&args.some(arg=>/^(-[a-z]*i|--in-place)/u.test(arg.text)))){
        if(base==='sed')operands=operands.slice(1)
        const targets=WRITE_LAST.has(base)?operands.slice(-1):operands
        for(const target of targets){if(target.dynamic||/[*?[{]/u.test(target.text))ambiguous=true;else write(abs(target.text,dir))}
        if(WRITE_LAST.has(base)||base==='mv')for(const source of operands.slice(0,WRITE_LAST.has(base)?-1:undefined)){if(!source.dynamic)read(abs(source.text,dir))}
      }else if(READERS.has(base)){
        for(const target of (PATTERN_FIRST.has(base)?operands.slice(1):operands).filter(arg=>!arg.dynamic))read(abs(target.text,dir))
      }
      const pathy=WRITE_ALL.has(base)||WRITE_LAST.has(base)||READERS.has(base),roots=(pathy?operands.filter(arg=>!arg.dynamic):statics.filter(arg=>/^[./~]/u.test(arg.text)||arg.text.includes('/'))).map(arg=>root(abs(arg.text,dir)))
      if(!inside(dir))roots.push(root(dir))
      const klass='shell:'+base+sub+(roots.length?'@'+[...new Set(roots)].sort().slice(0,3).join('+'):'')
      if(TRIVIAL.has(base))trivial.push(klass);else out.add(klass)
    }
  }
  analyze(command,cwd?abs(cwd,project):project,0)
  if(ambiguous)out.add('shell:*')
  if(![...out].some(klass=>klass.startsWith('shell:')))out.add(trivial[0]??'shell:')
  return [...out].slice(0,64)
}
