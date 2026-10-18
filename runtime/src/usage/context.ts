import {AsyncLocalStorage} from 'node:async_hooks'
export const USAGE_FEATURES = ['conversation','voice','profile','timeline','context','digest','embedding','recall','memory','compression','verification','proactivity','news','understanding','scheduled','source_processing','vision','agent','other','legacy'] as const
export type UsageFeature = typeof USAGE_FEATURES[number]
export interface UsageContext {
 readonly feature?: UsageFeature
 readonly operation?: string
 readonly taskId?: string
 readonly runId?: string
 readonly conversationId?: string
 readonly trigger?: 'manual' | 'scheduled' | 'automatic'
}
const scope = new AsyncLocalStorage<UsageContext>()
export function withUsageContext<T>(context:UsageContext,run:()=>T):T {return scope.run({...scope.getStore(),...context},run)}
export function currentUsageContext():UsageContext {return {...scope.getStore()}}
export function safeUsageContext(value:UsageContext):UsageContext {
 const result:Record<string,string>={}
 if(USAGE_FEATURES.includes(value.feature!))result.feature=value.feature!
 for(const key of ['operation','taskId','runId','conversationId'] as const){
  const v=value[key];if(typeof v==='string'&&/^[\w.:/-]{1,160}$/u.test(v))result[key]=v
 }
 if(['manual','scheduled','automatic'].includes(value.trigger!))result.trigger=value.trigger!
 return result
}
/** Each logical refresh gets one run ID; nested stages inherit it. */
export function observeOperation<A extends unknown[],R>(feature:UsageFeature,run:(...args:A)=>R):(...args:A)=>R {
 return (...args)=>withUsageContext({feature,runId:currentUsageContext().runId??crypto.randomUUID()},()=>run(...args))
}
