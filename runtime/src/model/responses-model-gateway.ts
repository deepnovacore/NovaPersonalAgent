import {createFetchArkResponsesGateway,ArkResponsesFailure} from '../realtime/volcengine/ark.js'
import {responsesToolSchema} from '../realtime/cascaded/ark-llm.js'
import {bindUsageReporter,type UsageReporter} from '../realtime/usage.js'
import {GatewayError,type ModelGateway,type StreamRequest,type CompleteRequest,type GatewayDelta,type GatewayCompletion} from './model-gateway.js'
import type {JsonObject} from '../realtime/protocol.js'

/** Auxiliary model calls use the same protocol as the selected conversation provider. */
export class ResponsesModelGateway implements ModelGateway {
  constructor(private readonly options:{baseUrl:string;apiKey:string;onUsage?:UsageReporter;fetch?:typeof fetch}){}

  async *stream(request:StreamRequest):AsyncIterable<GatewayDelta> {
    yield* this.#run(request)
  }

  async complete(request:CompleteRequest):Promise<GatewayCompletion> {
    let text=''
    for await(const event of this.#run(request,request))if(event.kind==='text')text+=event.text
    return {text}
  }

  async *#run(request:StreamRequest,complete?:CompleteRequest):AsyncIterable<GatewayDelta> {
    const reporter=bindUsageReporter(this.options.onUsage,request.usage??{})
    const gateway=createFetchArkResponsesGateway({baseUrl:this.options.baseUrl,apiKey:this.options.apiKey,
      model:request.model,instructions:request.system,protocol:'openai-compatible',
      ...(reporter?{onUsage:reporter}:{}),...(this.options.fetch?{fetchImpl:this.options.fetch}:{})})
    // Responses JSON mode requires the word JSON in input, not only in instructions.
    const content:JsonObject[]=[{type:'input_text',text:complete?.jsonSchema?`Return a JSON object.\n${request.prompt}`:request.prompt}]
    for(const image of request.images??[])content.push({type:'input_text',text:`[${image.ref}]`},{type:'input_image',image_url:`data:${image.media_type};base64,${Buffer.from(image.payload).toString('base64')}`})
    let completed=false,index=0
    try {
      for await(const event of gateway.stream({inputItems:[{role:'user',content}],
        tools:(request.tools??[]).map(responsesToolSchema),previousResponseId:null,
        ...(complete?.jsonSchema?{textFormat:{type:'json_object'}}:{}),
        ...(complete?.maxTokens===undefined?{}:{maxOutputTokens:complete.maxTokens}),
        ...(request.signal?{signal:request.signal}:{})})) {
        if(event.kind==='text_delta')yield {kind:'text',text:event.text}
        if(event.kind==='tool_call')yield {kind:'tool_call',index:index++,name:event.name,arguments:JSON.stringify(event.arguments)}
        if(event.kind==='response_completed')completed=true
        if(event.kind==='response_failed')throw new GatewayError(event.code)
      }
      if(!completed)throw new GatewayError('protocol')
    } catch(error) {
      if(error instanceof GatewayError)throw error
      throw new GatewayError(error instanceof ArkResponsesFailure?error.code:request.signal?.aborted?'aborted':'network')
    } finally {await gateway.close()}
  }
}
