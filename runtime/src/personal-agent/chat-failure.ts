import {z} from 'zod';

export const chatFailureSchema=z.enum(['authentication','quota','rate_limited','network','timeout','output_limit','configuration','unknown']);
export type ChatFailure=z.infer<typeof chatFailureSchema>;
/** Only runtime classifications may cross the client boundary, never provider messages. */
export function chatFailure(error:unknown):ChatFailure {
 if(!(error instanceof Error))return 'unknown';
 if(error.name==='TimeoutError')return 'timeout';
 const reason='reason' in error?error.reason:undefined;
 for(const code of [reason,error.message]){
  switch(code){
   case 'provider_http_auth':case 'model_http_auth':return 'authentication';
   case 'provider_http_quota':case 'model_http_quota':return 'quota';
   case 'provider_http_rate_limited':case 'model_http_rate_limited':return 'rate_limited';
   case 'provider_network':case 'model_network':return 'network';
   case 'provider_timeout':case 'model_timeout':return 'timeout';
   case 'provider_output_limit':case 'model_output_limit':case 'model_protocol_output_limit':case 'model_output_limit_tool_arguments':case 'model_output_limit_length':return 'output_limit';
   case 'processing_model_unavailable':case 'model_configuration':return 'configuration';
  }
 }
 if('code' in error&&(error.code==='invalid_configuration'||error.code==='configuration'))return 'configuration';
 if('classification' in error&&error.classification==='support_model_unconfigured')return 'configuration';
 return 'unknown';
}
