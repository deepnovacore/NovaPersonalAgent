import 'model_client.dart';

/// A provider with a fixed endpoint: the user only pastes a key.
/// `recommendedModels` are offline fallbacks; `/models` is the source of truth.
class ModelPreset {
  const ModelPreset({
    required this.id,
    required this.name,
    required this.endpoint,
    required this.recommendedModels,
    required this.keyUrl,
    this.protocol = ModelProtocol.chatCompletions,
    this.noteZh,
    this.noteEn,
  });
  final String id, name, endpoint, keyUrl;
  final List<String> recommendedModels;
  final ModelProtocol protocol;
  final String? noteZh, noteEn;

  /// Matches a saved endpoint whether it is a Base URL or a complete route.
  static ModelPreset? forEndpoint(String endpoint) {
    final wanted = _normalize(endpoint);
    for (final preset in modelPresets) {
      if (_normalize(preset.endpoint) == wanted) return preset;
    }
    return null;
  }

  static ModelPreset? byId(String id) {
    for (final preset in modelPresets) {
      if (preset.id == id) return preset;
    }
    return null;
  }

  static String _normalize(String endpoint) => endpoint
      .trim()
      .replaceFirst(RegExp(r'/(chat/completions|responses)/?$'), '')
      .replaceFirst(RegExp(r'/$'), '');
}

const modelPresets = <ModelPreset>[
  ModelPreset(
    id: 'openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    recommendedModels: ['gpt-4.1-mini', 'gpt-4.1'],
    keyUrl: 'https://platform.openai.com/api-keys',
  ),
  ModelPreset(
    id: 'openrouter',
    name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1',
    recommendedModels: ['openai/gpt-4.1-mini'],
    keyUrl: 'https://openrouter.ai/settings/keys',
  ),
  ModelPreset(
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    endpoint: 'https://api.anthropic.com/v1',
    recommendedModels: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    noteZh: '使用 Anthropic 的 OpenAI 兼容接口，部分高级功能不可用。',
    noteEn:
        'Uses Anthropic\'s OpenAI-compatible endpoint; some advanced features are unavailable.',
  ),
  ModelPreset(
    id: 'gemini',
    name: 'Google Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    recommendedModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    keyUrl: 'https://aistudio.google.com/apikey',
  ),
  ModelPreset(
    id: 'xai',
    name: 'xAI (Grok)',
    endpoint: 'https://api.x.ai/v1',
    recommendedModels: ['grok-4'],
    keyUrl: 'https://console.x.ai',
  ),
  ModelPreset(
    id: 'deepseek',
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com',
    recommendedModels: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  ),
  ModelPreset(
    id: 'qwen',
    name: '阿里云百炼 (Qwen)',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    recommendedModels: ['qwen-plus', 'qwen-flash'],
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  ),
  ModelPreset(
    id: 'moonshot-cn',
    name: 'Moonshot Kimi (国内站)',
    endpoint: 'https://api.moonshot.cn/v1',
    recommendedModels: ['kimi-k2-turbo-preview'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    noteZh: '国内站与国际站的密钥互不通用。',
    noteEn:
        'Keys from the China and international sites are not interchangeable.',
  ),
  ModelPreset(
    id: 'moonshot-global',
    name: 'Moonshot Kimi (International)',
    endpoint: 'https://api.moonshot.ai/v1',
    recommendedModels: ['kimi-k2-turbo-preview'],
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    noteZh: '国内站与国际站的密钥互不通用。',
    noteEn:
        'Keys from the China and international sites are not interchangeable.',
  ),
  ModelPreset(
    id: 'zhipu',
    name: '智谱 GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    recommendedModels: ['glm-4.5-air', 'glm-4.5'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
  ),
  ModelPreset(
    id: 'ark',
    name: '火山方舟 (豆包)',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
    recommendedModels: [],
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    noteZh: '模型名填写方舟控制台里的模型 ID 或推理接入点 ID（ep-…）。',
    noteEn:
        'Enter the model ID or inference endpoint ID (ep-…) from the Ark console.',
  ),
  ModelPreset(
    id: 'siliconflow',
    name: 'SiliconFlow',
    endpoint: 'https://api.siliconflow.cn/v1',
    recommendedModels: ['Qwen/Qwen3-235B-A22B-Instruct-2507'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  ),
  ModelPreset(
    id: 'stepfun',
    name: 'StepFun 阶跃星辰',
    endpoint: 'https://api.stepfun.com/v1',
    recommendedModels: ['step-2-mini'],
    keyUrl: 'https://platform.stepfun.com/interface-key',
  ),
];
