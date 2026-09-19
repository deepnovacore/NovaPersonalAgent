import {createHash} from 'node:crypto'
import {z} from 'zod'
import type {GraphDatabase} from '../workspace-graph/store.js'

export const sourceIdSchema=z.string().min(1).max(256)
export const revisionSchema=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const fenceSchema=z.object({connection_id:sourceIdSchema,generation:revisionSchema,epoch:revisionSchema,scope_revision:revisionSchema}).strict()
export type Fence=z.infer<typeof fenceSchema>
export const processingGrantSchema=z.object({revision:revisionSchema,scope_revision:revisionSchema,extraction_provider:sourceIdSchema.nullable(),embedding_provider:sourceIdSchema.nullable()}).strict()
export type ProcessingGrant=z.infer<typeof processingGrantSchema>
export const activationSchema=z.object({object_key:sourceIdSchema,revision:revisionSchema}).strict()
export type Activation=z.infer<typeof activationSchema>
export const extractionTicketSchema=z.object({evidence_id:z.string().min(1).max(512),activation:activationSchema.nullable(),consent_revision:revisionSchema,extraction_provider:sourceIdSchema,fence:fenceSchema.nullable()}).strict()
export type ExtractionTicket=z.infer<typeof extractionTicketSchema>
export type SourceChange={revision:number;phase:'invalidated'|'ready'}
export const sha256=(text:string):string=>createHash('sha256').update(text).digest('hex')
export function connectorSourceId(namespace:string,generation:number,objectKey:string):string{
 sourceIdSchema.parse(namespace);revisionSchema.parse(generation);z.string().min(1).max(16384).parse(objectKey)
 return `connector:${sha256(namespace)}:${generation}:${sha256(objectKey)}`
}

/** Called by the graph schema migration; also supports isolated in-memory memory tests. */
export function initializeSourceState(db:GraphDatabase):void{
 db.exec(`
 CREATE TABLE IF NOT EXISTS source_connections(id TEXT PRIMARY KEY,payload_json TEXT NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS source_objects(connection_id TEXT NOT NULL,generation INTEGER NOT NULL,object_key TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(connection_id,generation,object_key)) STRICT;
 CREATE TABLE IF NOT EXISTS source_pages(connection_id TEXT NOT NULL,batch_id TEXT NOT NULL,page_id TEXT NOT NULL,payload_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(connection_id,batch_id,page_id)) STRICT;
 CREATE TABLE IF NOT EXISTS source_grants(source_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS source_extractions(ticket_key TEXT PRIMARY KEY,payload_json TEXT NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS source_clock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL) STRICT;
 INSERT OR IGNORE INTO source_clock VALUES(1,0);
 CREATE INDEX IF NOT EXISTS source_objects_source ON source_objects(json_extract(payload_json,'$.source_id'));
 `)
}

export function assertSourceStateSchema(db:GraphDatabase):void{
 const shapes:Record<string,string[]>={source_connections:['id','payload_json'],source_objects:['connection_id','generation','object_key','payload_json'],source_pages:['connection_id','batch_id','page_id','payload_hash','result_json'],source_grants:['source_id','payload_json'],source_extractions:['ticket_key','payload_json'],source_clock:['id','revision']}
 for(const [table,columns] of Object.entries(shapes)){
  const actual=db.prepare(`PRAGMA table_info(${table})`).all()
  const keys=table==='source_objects'||table==='source_pages'?3:1
  if(actual.length!==columns.length||actual.some((c,i)=>c.name!==columns[i]||c.type!==(c.name==='generation'||table==='source_clock'?'INTEGER':'TEXT')||Number(c.pk)!==(i<keys?i+1:0)||Number(c.notnull)!==(table==='source_clock'&&i===0?0:1)))throw Error('STORE_SCHEMA_UNSUPPORTED')
  if(db.prepare('SELECT strict FROM pragma_table_list WHERE name=?').get(table)?.strict!==1)throw Error('STORE_SCHEMA_UNSUPPORTED')
 }
}
