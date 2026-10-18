import {parentPort,workerData} from 'node:worker_threads'
import {DatabaseSync} from 'node:sqlite'
import {preparePrivateDatabasePath} from '../storage/private-database.js'
import {normalizeUsageReport,type UsageReport} from '../realtime/usage.js'
import {accumulate,addToRow,emptyRow,projectSummary,reportGroups,type UsageRow} from './summary.js'
const {path,recentLimit}=workerData as {path:string;recentLimit:number}
const session=new Map<string,UsageRow>(),recent:UsageReport[]=[],seen=new Set<string>(),startedAt=new Date().toISOString()
let db:DatabaseSync|undefined,persistenceError:'storage_failed'|null=null
try{
 db=new DatabaseSync(preparePrivateDatabasePath(path),{allowExtension:false})
 db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS usage_events (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, data TEXT); CREATE INDEX IF NOT EXISTS usage_recent ON usage_events(seq) WHERE data IS NOT NULL; CREATE TABLE IF NOT EXISTS usage_totals (key TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);')
 db.prepare('INSERT OR IGNORE INTO usage_meta VALUES (?,?)').run('startedAt',startedAt)
}catch{try{db?.close()}catch{/* best effort */}db=undefined;persistenceError='storage_failed'}
function add(report:UsageReport){
 if(seen.has(report.id))return
 if(db){
  try{
   db.exec('BEGIN IMMEDIATE')
   const inserted=db.prepare('INSERT OR IGNORE INTO usage_events(id,data) VALUES (?,?)').run(report.id,JSON.stringify(report))
   if(!inserted.changes){db.exec('COMMIT');return}
   for(const [key,meta] of reportGroups(report)){
    const old=db.prepare('SELECT data FROM usage_totals WHERE key=?').get(key)
    const row=old?JSON.parse(String(old.data)) as UsageRow:emptyRow(meta);addToRow(row,report)
    db.prepare('INSERT OR REPLACE INTO usage_totals VALUES (?,?)').run(key,JSON.stringify(row))
   }
   // Retain compact IDs for durable dedupe; only request detail is bounded.
   db.prepare('UPDATE usage_events SET data=NULL WHERE data IS NOT NULL AND seq <= (SELECT MAX(seq)-? FROM usage_events)').run(recentLimit)
   db.exec('COMMIT')
  }catch{try{db.exec('ROLLBACK')}catch{/* no active transaction */}persistenceError='storage_failed'}
 }
 seen.add(report.id);accumulate(session,report);recent.push(report);if(recent.length>recentLimit)recent.shift()
}
parentPort!.on('message',(message:{id:number;method:string;report?:unknown})=>{
 try{
  if(message.method==='add'){const report=normalizeUsageReport(message.report);if(report)add(report);return}
  if(message.method==='close'){db?.close();parentPort!.postMessage({id:message.id,result:true});parentPort!.close();return}
  const current=projectSummary(session,recent,startedAt)
  let history=current
  if(db){try{
   const rows=new Map(db.prepare("SELECT key,data FROM usage_totals WHERE key NOT LIKE 'run:%' OR rowid IN (SELECT rowid FROM usage_totals WHERE key LIKE 'run:%' ORDER BY rowid DESC LIMIT 100) ORDER BY rowid").all().map(row=>[String(row.key),JSON.parse(String(row.data)) as UsageRow]))
   const events=db.prepare('SELECT data FROM usage_events WHERE data IS NOT NULL ORDER BY seq DESC LIMIT ?').all(recentLimit).reverse().map(row=>JSON.parse(String(row.data)) as UsageReport)
   const start=db.prepare('SELECT value FROM usage_meta WHERE key=?').get('startedAt')
   history=projectSummary(rows,events,String(start?.value??startedAt))
  }catch{persistenceError='storage_failed'}}
  parentPort!.postMessage({id:message.id,result:{...current,history,persistenceError,coverage:['nova_models','external_agent_tokens_unavailable']}})
 }catch{parentPort!.postMessage({id:message.id,error:'storage_failed'})}
})
