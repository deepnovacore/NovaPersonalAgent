/**
 * Explicit model-provider selection for the Space live acceptance script.
 *
 * A self-hosted run is requested only by configuring its dedicated pair. A half-configured pair
 * fails instead of borrowing the DashScope credential, and a DashScope run reads its own model URL.
 */
export function resolveSpaceLiveModelConfig(environment = process.env) {
  const value = name => environment[name]?.trim() ?? ''
  const selfHostedRequested = value('SELF_HOSTED_LLM_BASE_URL') !== ''
    || value('SELF_HOSTED_LLM_API_KEY') !== ''
  if (selfHostedRequested) {
    const baseUrl = value('SELF_HOSTED_LLM_BASE_URL')
    const apiKey = value('SELF_HOSTED_LLM_API_KEY')
    if (baseUrl === '' || apiKey === '') throw new Error('self_hosted_model_credentials_required')
    return Object.freeze({provider: 'self-hosted', baseUrl, apiKey, mode: 'self-hosted'})
  }
  const apiKey = value('DASHSCOPE_API_KEY')
  if (apiKey === '') throw new Error('dashscope_model_credential_required')
  return Object.freeze({
    provider: 'qwen',
    baseUrl: value('DASHSCOPE_MODEL_BASE_URL') || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey,
    mode: 'dashscope',
  })
}
