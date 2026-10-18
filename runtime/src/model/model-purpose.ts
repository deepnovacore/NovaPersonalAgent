import {currentUsageContext,withUsageContext,type UsageFeature} from '../usage/context.js'
/** Shared attribution for diagnostics and billing. */
export type ModelPurpose=UsageFeature
export function withModelPurpose<T>(purpose:ModelPurpose,run:()=>T):T{return withUsageContext({feature:purpose},run)}
export function currentModelPurpose():ModelPurpose{return currentUsageContext().feature??'other'}
