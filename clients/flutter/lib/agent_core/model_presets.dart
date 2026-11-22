// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: preset catalogue and capability
// defaults ported from ProviderPresets.kt; Nova keeps its own ids, endpoints and
// OpenAI-compatible routes for Anthropic and Gemini.
import 'package:flutter/foundation.dart' show TargetPlatform;

import 'model_catalog.dart';
import 'model_client.dart';

/// What a preset assumes about its models until a listing says otherwise.
class ProviderCapabilities {
  const ProviderCapabilities({
    this.toolCalls = true,
    this.vision = false,
    this.contextTokens = 64000,
    this.reasoning = false,
  });
  final bool toolCalls, vision, reasoning;
  final int contextTokens;
}

/// Placeholder bearer for services that need no key (a custom loopback
/// address): Nova's client and credential store require a value.
const keylessServiceKey = 'not-needed';

/// A provider with a fixed endpoint: the user only pastes a key.
/// `recommendedModels` are offline fallbacks; `/models` is the source of truth.
///
/// [providerKind] is the provider's own API family. [protocol] is what Nova's
/// model client speaks to [endpoint]; Anthropic and Gemini stay on their
/// OpenAI-compatible routes because the client has no Messages or
/// generateContent adapter, and OpenAI stays on Chat Completions so saved
/// settings keep working.
class ModelPreset {
  const ModelPreset({
    required this.id,
    required this.name,
    required this.endpoint,
    required this.recommendedModels,
    required this.keyUrl,
    this.nameEn,
    this.protocol = ModelProtocol.chatCompletions,
    this.noteZh,
    this.noteEn,
    this.providerKind = ProviderKind.openAiCompat,
    this.capabilities = const ProviderCapabilities(),
    this.sessionHeader,
    this.familyTokens = const [],
  });
  final String id, name, endpoint, keyUrl;

  /// [name] for English readers, when [name] is written in Chinese.
  final String? nameEn;
  final List<String> recommendedModels;
  final ModelProtocol protocol;
  final String? noteZh, noteEn;
  final ProviderKind providerKind;
  final ProviderCapabilities capabilities;

  /// Request header the provider requires for the conversation session id.
  final String? sessionHeader;

  /// Lower-case words found in this provider's own model names; its own models
  /// are tried first when a key lists other vendors' models too.
  final List<String> familyTokens;

  /// The name in the reader's language (`zh` or `en`).
  String label(String language) => language == 'zh' ? name : nameEn ?? name;

  /// Whether Nova's chat on [platform] can use this provider. The session id
  /// header is sent only by the Dart model client; iOS chats through the native
  /// transfer (`IosModelClient`), which does not send it, so every request to a
  /// provider that requires one would be refused there.
  bool availableOn(TargetPlatform platform) =>
      sessionHeader == null || platform != TargetPlatform.iOS;

  /// Matches a saved endpoint whether it is a Base URL or a complete route.
  static ModelPreset? forEndpoint(String endpoint) {
    final wanted = _normalize(endpoint);
    for (final preset in modelPresets) {
      if (_normalize(preset.endpoint) == wanted) return preset;
    }
    return null;
  }

  /// A preset whose host equals the host of [url], whatever the path: someone
  /// who typed a vendor's official address is offered that preset.
  static ModelPreset? forHost(String url) {
    final host = Uri.tryParse(url.trim())?.host.toLowerCase();
    if (host == null || host.isEmpty) return null;
    for (final preset in modelPresets) {
      if (preset.endpoint.isEmpty) continue;
      if (Uri.parse(preset.endpoint).host.toLowerCase() == host) return preset;
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
    providerKind: ProviderKind.openAiResponses,
    capabilities: ProviderCapabilities(vision: true, contextTokens: 400000),
    familyTokens: ['gpt'],
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
    providerKind: ProviderKind.anthropic,
    capabilities: ProviderCapabilities(vision: true, contextTokens: 200000),
    familyTokens: ['claude'],
  ),
  ModelPreset(
    id: 'gemini',
    name: 'Google Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    recommendedModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    keyUrl: 'https://aistudio.google.com/apikey',
    providerKind: ProviderKind.gemini,
    capabilities: ProviderCapabilities(vision: true, contextTokens: 128000),
    familyTokens: ['gemini'],
  ),
  ModelPreset(
    id: 'xai',
    name: 'xAI (Grok)',
    endpoint: 'https://api.x.ai/v1',
    recommendedModels: ['grok-4'],
    keyUrl: 'https://console.x.ai',
    capabilities: ProviderCapabilities(vision: true, contextTokens: 256000),
    familyTokens: ['grok'],
  ),
  ModelPreset(
    id: 'deepseek',
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com',
    recommendedModels: ['deepseek-flash'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    familyTokens: ['deepseek'],
  ),
  ModelPreset(
    id: 'qwen',
    name: '阿里云百炼 (Qwen)',
    nameEn: 'Alibaba Bailian (Qwen)',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    recommendedModels: ['qwen-plus', 'qwen-flash'],
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    familyTokens: ['qwen'],
  ),
  ModelPreset(
    id: 'moonshot-cn',
    name: 'Moonshot Kimi (国内站)',
    nameEn: 'Moonshot Kimi (China)',
    endpoint: 'https://api.moonshot.cn/v1',
    recommendedModels: ['kimi-k2-turbo-preview'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    noteZh: '国内站与国际站的密钥互不通用。',
    noteEn:
        'Keys from the China and international sites are not interchangeable.',
    familyTokens: ['kimi', 'moonshot'],
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
    familyTokens: ['kimi', 'moonshot'],
  ),
  ModelPreset(
    id: 'zhipu',
    name: '智谱 GLM',
    nameEn: 'Zhipu GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    recommendedModels: ['glm-4.5-air', 'glm-4.5'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
    familyTokens: ['glm'],
  ),
  ModelPreset(
    id: 'ark',
    name: '火山方舟 (豆包)',
    nameEn: 'Volcano Ark (Doubao)',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
    recommendedModels: [],
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    noteZh: '模型名填写方舟控制台里的模型 ID 或推理接入点 ID（ep-…）。',
    noteEn:
        'Enter the model ID or inference endpoint ID (ep-…) from the Ark console.',
    capabilities: ProviderCapabilities(vision: true, contextTokens: 128000),
    familyTokens: ['doubao'],
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
    nameEn: 'StepFun',
    endpoint: 'https://api.stepfun.com/v1',
    recommendedModels: ['step-2-mini'],
    keyUrl: 'https://platform.stepfun.com/interface-key',
    familyTokens: ['step'],
  ),
  ModelPreset(
    id: 'minimax',
    name: 'MiniMax',
    endpoint: 'https://api.minimax.cn/v1',
    recommendedModels: [],
    // TODO: link the API-key page once its address is confirmed; the console
    // home stays until then rather than a guessed path.
    keyUrl: 'https://platform.minimaxi.com/',
    noteZh: '国内站；思考内容默认写在回复正文的 <think> 里。',
    noteEn:
        'China site; reasoning is written inside <think> tags in the reply by default.',
    capabilities: ProviderCapabilities(vision: true, contextTokens: 200000),
    familyTokens: ['minimax'],
  ),
  ModelPreset(
    id: 'hunyuan',
    name: '腾讯混元',
    nameEn: 'Tencent Hunyuan',
    endpoint: 'https://tokenhub.tencentmaas.com/v1',
    recommendedModels: [],
    // TODO: link the TokenHub API-key page once its address is confirmed; the
    // console home stays until then rather than a guessed path.
    keyUrl: 'https://console.cloud.tencent.com/',
    noteZh: '混元的新模型在 TokenHub 上，旧的 api.hunyuan.cloud.tencent.com 不再上新模型。',
    noteEn:
        'New Hunyuan models are served from TokenHub; the older api.hunyuan.cloud.tencent.com no longer gets new models.',
    capabilities: ProviderCapabilities(contextTokens: 256000),
    familyTokens: ['hunyuan'],
  ),
  ModelPreset(
    id: 'qianfan',
    name: '百度千帆',
    nameEn: 'Baidu Qianfan',
    endpoint: 'https://qianfan.baidubce.com/v2',
    recommendedModels: [],
    keyUrl: 'https://console.bce.baidu.com/qianfan/ais/console/apiKey',
    noteZh: 'Key 是控制台生成的 bce-v3/… 那一串，按 Bearer 发送。',
    noteEn:
        'The key is the bce-v3/… string generated in the console, sent as a Bearer token.',
    familyTokens: ['ernie'],
  ),
  ModelPreset(
    id: 'opencode-go',
    name: 'OpenCode Go',
    endpoint: 'https://opencode.ai/zen/go/v1',
    recommendedModels: [],
    keyUrl: 'https://opencode.ai/auth',
    noteZh: '订阅制，一个 Key 用多家模型；每个请求都要带对话的会话号。',
    noteEn:
        'Subscription: one key for models from several vendors; every request carries a session id.',
    sessionHeader: 'x-opencode-session',
  ),
  ModelPreset(
    id: 'mistral',
    name: 'Mistral',
    endpoint: 'https://api.mistral.ai/v1',
    recommendedModels: ['mistral-small-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    capabilities: ProviderCapabilities(vision: true, contextTokens: 128000),
    familyTokens: ['mistral'],
  ),
  ModelPreset(
    id: 'groq',
    name: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1',
    recommendedModels: [],
    keyUrl: 'https://console.groq.com/keys',
    capabilities: ProviderCapabilities(contextTokens: 128000),
  ),
];
