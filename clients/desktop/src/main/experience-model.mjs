import {capabilityEnvironment,textModelEnvironment} from './backend.mjs'

export async function completeConfiguredExperience({settings,secrets,environment={},onUsage},messages,signal){
 const runtime=await import('@nova-personal-agent/runtime')
 const routes=Object.fromEntries(Object.entries(settings.modelRoutes??{}).filter(([,route])=>route))
 const env={...capabilityEnvironment(settings,secrets,environment),...textModelEnvironment(settings),...(environment.MODEL_ROUTES?{}:{MODEL_ROUTES:JSON.stringify(routes)})}
 const config=runtime.loadSettings(env,true)
 const route=runtime.resolveModelRoute(config,'conversationText')??{...runtime.resolveSelectedModelConnection(config),model:config.cascade_llm_model}
 if(!route.provider||route.missing)return null
 const gateway=runtime.buildModelRouteGateway(route,{clock:new runtime.RealClock(),protocol:config.openai_compatible_protocol,...(onUsage?{onUsage}:{})})
 const response=await gateway.complete({model:route.model,system:messages[0]?.role==='system'?messages[0].content:'',prompt:JSON.stringify(messages.filter(message=>message.role!=='system')),reasoning:'disabled',signal,usage:{feature:'conversation',operation:'experience'}})
 return response.text
}
