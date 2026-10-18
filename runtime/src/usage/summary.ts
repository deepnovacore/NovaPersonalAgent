import {z} from 'zod'
import {normalizeUsageReport,type UsageReport} from '../realtime/usage.js'
import {USAGE_FEATURES} from './context.js'
import {PRICE_DATE,priceUsage} from './pricing.js'
export const USAGE_METERS=['inputTokens','outputTokens','inputTextTokens','inputAudioTokens','outputTextTokens','outputAudioTokens','cachedTokens','reasoningTokens','audioDurationMs','characters','durationMs'] as const
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),money=z.number().finite().nonnegative()
const identity=z.string().max(256)
const rowSchema=z.object({provider:identity,service:identity,model:identity,pricingRegion:identity,feature:z.enum(USAGE_FEATURES),runId:identity.optional(),taskId:identity.optional(),
 requests:count,missingReports:count,unpricedReports:count,pricedReports:count,reportedCostReports:count,estimatedCostReports:count,failedRequests:count,cancelledRequests:count,costCny:money,costUsd:money,
 inputTokens:count.optional(),outputTokens:count.optional(),inputTextTokens:count.optional(),inputAudioTokens:count.optional(),outputTextTokens:count.optional(),outputAudioTokens:count.optional(),cachedTokens:count.optional(),reasoningTokens:count.optional(),audioDurationMs:count.optional(),characters:count.optional(),durationMs:count.optional(),source:identity.nullable(),
})
export type UsageRow=z.infer<typeof rowSchema>
const recentSchema=z.unknown().transform((value,ctx)=>{const report=normalizeUsageReport(value);if(!report){ctx.addIssue({code:'custom',message:'invalid usage'});return z.NEVER}return report})
const totalsSchema=rowSchema.omit({provider:true,service:true,model:true,pricingRegion:true,feature:true,runId:true,taskId:true,source:true})
const summarySchema=totalsSchema.extend({rows:z.array(rowSchema).max(10000),features:z.array(rowSchema).max(100),runs:z.array(rowSchema).max(1000),recent:z.array(recentSchema).max(500),startedAt:identity,truncated:z.boolean(),priceDate:identity})
export type UsageSummary=z.infer<typeof summarySchema>
const snapshotSchema=summarySchema.extend({history:summarySchema,persistenceError:z.enum(['storage_failed']).nullable(),coverage:z.array(z.string().max(160)).max(8)})
export type UsageSnapshot=z.infer<typeof snapshotSchema>
export function parseUsageSnapshot(value:unknown):UsageSnapshot|null {const parsed=snapshotSchema.safeParse(value);return parsed.success?parsed.data:null}
export function emptyRow(meta:Partial<UsageRow>={}):UsageRow{return {provider:'custom',service:'llm',model:'*',pricingRegion:'unknown',feature:'other',requests:0,missingReports:0,unpricedReports:0,pricedReports:0,reportedCostReports:0,estimatedCostReports:0,failedRequests:0,cancelledRequests:0,costCny:0,costUsd:0,source:null,...meta}}
export function addToRow(row:UsageRow,report:UsageReport):void {
 row.requests++
 for(const key of USAGE_METERS){const value=report[key];if(value!==undefined)row[key]=Math.min(Number.MAX_SAFE_INTEGER,(row[key]??0)+value)}
 if(report.outcome==='error')row.failedRequests++
 if(report.outcome==='cancelled')row.cancelledRequests++
 if(report.status==='missing')row.missingReports++
 const price=priceUsage(report)
 if(price.costUsd!==undefined){row.pricedReports++;row.reportedCostReports++;row.costUsd+=price.costUsd}
 else if(price.costCny!==null){row.pricedReports++;row.estimatedCostReports++;row.costCny+=price.costCny}
 else if(report.status!=='missing')row.unpricedReports++
 row.source=price.source
}
export function reportGroups(report:UsageReport):[string,Partial<UsageRow>][] {
 const feature=report.feature??'other'
 const model={provider:report.provider,service:report.service,model:report.model,pricingRegion:report.pricingRegion??'unknown'}
 const rows:[string,Partial<UsageRow>][]=[['all',{}],['model:'+JSON.stringify(Object.values(model)),model],['feature:'+feature,{feature}]]
 if(report.runId||report.taskId)rows.push(['run:'+(report.runId??report.taskId),{feature,...(report.runId?{runId:report.runId}:{}),...(report.taskId?{taskId:report.taskId}:{})}])
 return rows
}
export function accumulate(rows:Map<string,UsageRow>,report:UsageReport):void {
 for(const [key,meta] of reportGroups(report)){const row=rows.get(key)??emptyRow(meta);addToRow(row,report);rows.set(key,row)}
}
export function projectSummary(rows:Map<string,UsageRow>,recent:UsageReport[],startedAt:string):UsageSummary {
 const totals=totalsSchema.parse(rows.get('all')??emptyRow())
 const group=(prefix:string)=>[...rows].filter(([key])=>key.startsWith(prefix)).map(([,row])=>({...row}))
 return {...totals,rows:group('model:'),features:group('feature:'),runs:group('run:').slice(-100),recent:recent.map(r=>({...r})),startedAt,truncated:false,priceDate:PRICE_DATE}
}
