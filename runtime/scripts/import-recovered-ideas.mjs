// Offline recovery only: quit Nova before using this script.
// --from <old workbench-daily.json> --target <current workbench-daily.json> [--dry-run]
// --runtime-dist <isolated runtime dist> selects an isolated build for schema validation.
// Imported source-backed ideas remain hidden until the Host revalidates their source access.
import {copyFile, lstat, readFile, rename, unlink, writeFile} from 'node:fs/promises'
import {constants} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {randomUUID} from 'node:crypto'

const {values}=parseArgs({options:{from:{type:'string'},target:{type:'string'},'runtime-dist':{type:'string'},'dry-run':{type:'boolean',default:false}}})
if(!values.from||!values.target)throw Error('Required: --from <snapshot> --target <live workbench state> [--dry-run]; quit Nova first')
const source=resolve(values.from),target=resolve(values.target)
if(source===target)throw Error('Source and target must be different files')
const dist=resolve(values['runtime-dist']??new URL('../dist',import.meta.url).pathname)
const {dailyWorkbenchStateSchema}=await import(pathToFileURL(resolve(dist,'src/personal-agent/daily-workbench.js')).href)
if(!dailyWorkbenchStateSchema)throw Error('Build the current runtime first; the selected build lacks the recovery schema')
for(const path of [source,target]){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw Error('Recovery requires regular, non-symlink files')}
const original=await readFile(target,'utf8'),snapshot=JSON.parse(await readFile(source,'utf8'))
const state=dailyWorkbenchStateSchema.parse(JSON.parse(original))
if(!Array.isArray(snapshot.cards))throw Error('Snapshot has no cards array')
const generatedAt=snapshot.updated_at
if(typeof generatedAt!=='string'||!Number.isFinite(Date.parse(generatedAt)))throw Error('Snapshot has no valid generation timestamp')
const ideas=snapshot.cards.filter(card=>card?.tab==='ideas')
const history=[...state.history]
const seen=new Set([...history,...state.cards].map(row=>row.id))
const titles=new Set(history.map(row=>row.title.trim()))
const pending=[]
for(const card of ideas){
 if(typeof card.id!=='string'||typeof card.title!=='string')throw Error('Malformed idea identity')
 if(seen.has(card.id)||titles.has(card.title.trim()))continue
 // Do not repair malformed evidence or coerce missing fields into valid-looking content.
 const row={id:card.id,tab:'ideas',title:card.title,body:card.body,why:card.why,next:card.next,refs:card.refs,sources:card.sources,generated_at:generatedAt,imported:true,...(card.scope===undefined?{}:{scope:card.scope})}
 pending.push(row);seen.add(card.id);titles.add(card.title.trim())
}
if(history.length+pending.length>200)throw Error('Import exceeds the history limit; existing ideas will not be evicted')
const merged=dailyWorkbenchStateSchema.parse({...state,history:[...history,...pending]})
console.log(`snapshot ideas: ${ideas.length} · already known: ${ideas.length-pending.length} · to import: ${pending.length}`)
if(values['dry-run']){console.log('dry run: validated; nothing written');process.exit(0)}
if(!pending.length)process.exit(0)
if(await readFile(target,'utf8')!==original)throw Error('Target changed; quit Nova before importing')
const backup=`${target}.before-idea-import-${randomUUID()}`
await copyFile(target,backup,constants.COPYFILE_EXCL)
const temporary=`${target}.${randomUUID()}.tmp`
try{
 await writeFile(temporary,JSON.stringify(merged)+'\n',{mode:0o600,flag:'wx'})
 if(await readFile(target,'utf8')!==original)throw Error('Target changed during import; original left intact')
 await rename(temporary,target)
}finally{await unlink(temporary).catch(()=>{})}
console.log(`imported ${pending.length} idea(s); backup: ${backup}`)
