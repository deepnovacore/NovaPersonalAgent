// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: ModelSetupCopy / ModelsCopy
// wording reused with Nova's name and bilingual (zh/en) lookups.
import '../agent_core/model_catalog.dart';
import '../agent_core/model_probe.dart';

/// Wording for the provider setup and provider detail pages, in one place.
class ProviderSetupCopy {
  const ProviderSetupCopy(this.language);
  final String language;
  String t(String zh, String en) => language == 'zh' ? zh : en;

  // Pages and groups.
  String get setupTitle => t('配置模型', 'Set up a model');
  String get providers => t('服务商', 'Providers');
  String get addProvider => t('添加服务商', 'Add a provider');
  String get accountGroup => t('用账号登录 · 不用填 Key', 'Sign in · no key needed');
  String get keyGroup => t('填 API Key', 'Use an API key');
  String get chatGptRowSubtitle =>
      t('用 Plus / Pro 套餐的额度', 'Use your Plus / Pro plan allowance');
  String get keyNote =>
      t('API Key 只保存在这台手机上，加密存放。', 'API keys stay on this phone, encrypted.');
  String get inUse => t('正在使用', 'In use');
  String get manageCredentials => t('管理服务密钥', 'Manage provider credentials');

  // Form.
  String get apiKey => t('API 密钥', 'API key');
  String get keyHint => t('粘贴服务商给的 Key', 'Paste the key from the provider');
  String get keyOptional => t('本地服务可不填', 'Optional for local services');
  String get keySavedHint => t(
    '已保存的密钥不会回显；留空时使用此服务已保存的密钥',
    'Saved keys stay hidden. Leave blank to use the saved key.',
  );
  String get show => t('显示', 'Show');
  String get hide => t('隐藏', 'Hide');
  String get baseUrl => t('接口地址', 'API URL');
  String get baseUrlHelp =>
      t('支持 Base URL 或完整接口地址', 'Base URL or full endpoint URL');
  String get protocol => t('接口', 'API');
  String get modelName => t('模型名', 'Model name');
  String get custom => t('自定义（OpenAI 兼容）', 'Custom (OpenAI-compatible)');
  String get getKey => t('去获取 API 密钥', 'Get an API key');
  String get testAndSave => t('测试并保存', 'Test and save');
  String get testing => t('正在测试…', 'Testing…');
  String get testNote => t(
    '先列出这家的模型，再试着让其中一个调用一次工具，都成了才保存。',
    'Lists this provider’s models, then asks one to call a tool once. Saved only if both work.',
  );
  String get manualOn => t('手动填写模型名', 'Enter a model name');
  String get manualOff => t('不填模型名', 'Don’t enter a model name');
  String get manualNote => t(
    '填了模型名，「测试并保存」就只用它试调用：这家不提供模型列表、列表里没有它、列模型出错都不影响，试调用通了才保存。',
    'With a model name, Test and save only tries that model. A missing list, a list without it or a listing error do not matter; it is saved only if the call works.',
  );
  String get noListCustom => t(
    '这个地址列不出模型：可能这家不提供模型列表，也可能地址填错了。填一个模型名再点「测试并保存」，用它试调用一次就知道。',
    'This address lists no models: the provider may not offer a list, or the URL may be wrong. Enter a model name and tap Test and save to try it.',
  );
  String get noListPreset => t(
    '这家没有列出模型。填一个模型名再点「测试并保存」，用它试调用一次，通了才保存。',
    'This provider listed no models. Enter a model name and tap Test and save; it is saved only if the call works.',
  );
  String get selfHostedNote => t(
    '127.0.0.1 是这台手机自己。服务跑在电脑上时，需要用 https 地址（例如反向代理）才能连接，Nova 不会向不加密的局域网地址发送 Key。',
    '127.0.0.1 is this phone itself. For a service on a computer, use an https address (for example behind a reverse proxy); Nova does not send keys over plain-http network addresses.',
  );
  String get urlNeed => t('请填写接口地址', 'Enter the API URL');
  String get urlScheme => t(
    '接口地址要以 http:// 或 https:// 开头',
    'The API URL must start with http:// or https://',
  );
  String get urlUnencrypted => t(
    '这个地址不加密，API Key 和对话内容可能被同一网络里的人看到。Nova 只连接 https 地址或这台手机自己。',
    'This address is not encrypted, so the key and chat could be seen by others on the network. Nova only connects over https or to this phone itself.',
  );
  String presetMatch(String name) => t(
    '这是「$name」的官方地址，用它的预设更省事：地址和接口类型都已填好。',
    'This is the official address of “$name”. Using its preset is easier: the URL and API type are filled in.',
  );
  String usePreset(String name) => t('改用「$name」预设', 'Use the “$name” preset');
  String failed(String reason) => t('连接失败：$reason', 'Failed: $reason');
  String get saveFailed => t(
    '未能保存，请检查模型名称和密钥后重试。',
    'Could not save. Check the model name and key, then retry.',
  );
  String exampleModel(ProviderKind kind) => switch (kind) {
    ProviderKind.gemini => t(
      '例如 gemini-flash-latest',
      'e.g. gemini-flash-latest',
    ),
    ProviderKind.anthropic => t(
      '例如 claude-sonnet-4-5',
      'e.g. claude-sonnet-4-5',
    ),
    ProviderKind.openAiResponses => t('例如 gpt-5-mini', 'e.g. gpt-5-mini'),
    ProviderKind.openAiCompat => t('例如 deepseek-chat', 'e.g. deepseek-chat'),
  };

  // Probe results.
  String listFailure(ModelListFailed failure) => failure.message(language);

  /// Why a failure is not about one model; also the tail of [probeFailed].
  String _providerReason(ProbeFailure f) => switch (f.problem) {
    ProbeProblem.auth => ListFailure.auth.text(language),
    ProbeProblem.quota => ListFailure.quota.text(language),
    ProbeProblem.rateLimited => ListFailure.rateLimited.text(language),
    ProbeProblem.network => ListFailure.network.text(language),
    ProbeProblem.server => t(
      '服务暂时出错，请稍后再试（HTTP ${f.status ?? ''}）',
      'The service is having trouble. Try again later (HTTP ${f.status ?? ''}).',
    ),
    _ => f.detail,
  };

  /// A probe failure as one sentence for the user. [example] names a typical
  /// model id; [listMissing] means the list was empty too.
  String probeFailed(
    ProbeFailure f, {
    required String example,
    bool listMissing = false,
  }) => switch (f.problem) {
    ProbeProblem.timeout => t(
      '试着让 ${f.model} 调用一个工具，${probeTimeout.inSeconds} 秒没有回应',
      '${f.model} did not respond for ${probeTimeout.inSeconds} s when asked to call a tool',
    ),
    ProbeProblem.notFound =>
      listMissing
          ? t(
              '列不出模型，用「${f.model}」试调用也说找不到：地址可能填错了，也可能没有这个模型（模型名$example）。',
              'No model list, and “${f.model}” was not found either: the URL may be wrong or the model missing (model name $example).',
            )
          : t(
              '模型「${f.model}」不存在。要填服务商文档里完整的模型 ID（$example）。',
              'Model “${f.model}” does not exist. Enter the full model ID from the provider’s docs ($example).',
            ),
    ProbeProblem.notAvailable => t(
      '这个账号没开通「${f.model}」或没权限用（服务商说：${f.detail}）。换一个模型，或到服务商后台开通。',
      'This account has no access to “${f.model}” (provider said: ${f.detail}). Try another model or enable it in the provider console.',
    ),
    ProbeProblem.noTools => t(
      '${f.model} 没有调用工具，Nova 干活需要会调用工具的模型，换一个当主模型。',
      '${f.model} did not call a tool. Nova needs a model that can; pick another one.',
    ),
    ProbeProblem.wrongProtocol => t(
      '${f.model} 不走你选的接口类型，请求到不了它',
      '${f.model} does not use the selected API type',
    ),
    _ => t(
      '试着让 ${f.model} 调用一个工具没成功：${_providerReason(f)}',
      'Asking ${f.model} to call a tool failed: ${_providerReason(f)}',
    ),
  };

  /// Short reason a rejected model did not pass.
  String rejectionReason(ProbeRejection r) => switch (r.failure.problem) {
    ProbeProblem.noTools => t(
      '它不会调用工具，Nova 干活需要会调用工具的模型',
      'it cannot call tools, which Nova needs',
    ),
    ProbeProblem.notAvailable => t(
      '这个账号没开通或没权限用这个模型（服务商说：${r.failure.detail}）',
      'this account has no access to the model (provider said: ${r.failure.detail})',
    ),
    ProbeProblem.notFound => t('服务商那里没有这个模型', 'the provider has no such model'),
    ProbeProblem.server => t(
      '服务端出错（HTTP ${r.failure.status ?? ''}）',
      'server error (HTTP ${r.failure.status ?? ''})',
    ),
    ProbeProblem.wrongProtocol => t(
      '它不走你选的接口类型，请求到不了它',
      'it does not use the selected API type',
    ),
    _ => _providerReason(r.failure),
  };

  /// What to tell the user after a provider was saved although some models
  /// did not pass; null when everything went smoothly.
  String? probeNote(ProviderTestDone done) {
    if (done.rejected.isEmpty) return null;
    final names = done.rejected.map((r) => r.model).join(t('、', ', '));
    final first = done.rejected.first;
    if (done.main != null) {
      return t(
        '先试的 $names 没测试通过：${rejectionReason(first)}。主模型用了测试通过的「${done.main}」。',
        '$names did not pass first: ${rejectionReason(first)}. Using “${done.main}”, which passed.',
      );
    }
    final head = t(
      '服务商已连上，但「${first.model}」没测试通过：${rejectionReason(first)}。从列表里选一个你开通了的模型。',
      'The provider is connected, but “${first.model}” did not pass: ${rejectionReason(first)}. Pick a model you have access to from the list.',
    );
    if (done.rejected.length == 1 || done.rejected.every((r) => r.skipped)) {
      return head;
    }
    final tried = done.rejected.every((r) => r.notAvailable)
        ? t('试了 $names，都没开通。', 'Tried $names; none is enabled.')
        : t('试了 $names，都没测试通过。', 'Tried $names; none passed.');
    return '$head\n$tried';
  }

  String noToolsKept(String model) => t(
    '$model 没有调用工具，Nova 干活需要会调用工具的模型。服务商已保存，但没有拿这个模型当主模型。',
    '$model did not call a tool, which Nova needs. The provider is saved, but this model is not used as the main model.',
  );

  // Provider detail.
  String get connection => t('连接', 'Connection');
  String get status => t('状态', 'Status');
  String get listing => t('正在列出模型…', 'Listing models…');
  String get connected => t('已连接', 'Connected');
  String get listFailedShort => t('列模型失败', 'Listing failed');
  String get api => t('接口', 'API');
  String get address => t('地址', 'Address');
  String get keySaved => t('已保存', 'Saved');
  String get keyNone => t('没有填', 'None');
  String get change => t('更换', 'Change');
  String get changeKey => t('更换 API Key', 'Change API key');
  String get newKeyHint => t('粘贴新的 Key', 'Paste the new key');
  String get save => t('保存', 'Save');
  String get cancel => t('取消', 'Cancel');
  String get models => t('模型', 'Models');
  String get refresh => t('刷新', 'Refresh');
  String viewAll(int n) => t('查看全部 $n 个', 'View all $n');
  String allModelsTitle(String name) => t('$name · 全部模型', '$name · all models');
  String get modelsNote => t(
    '标签是服务商给的信息，只作参考；点一个模型可以拿它当对话模型。',
    'Tags come from the provider and are for reference. Tap a model to use it for chat.',
  );
  String get noListNote => t(
    '这家不提供模型列表。要用它的模型，回到「添加服务商」手填模型名。',
    'This provider offers no model list. To use one of its models, add it again and enter the model name.',
  );
  String get useForChat => t('用作对话模型', 'Use as chat model');
  String get delete => t('删除这个服务商', 'Delete this provider');
  String get deleteInUse => t(
    '正在用它作对话模型，先换成别的服务商再删除。',
    'It is the chat provider in use. Switch to another provider before deleting it.',
  );
  String deleteTitle(String name) => t('删除「$name」？', 'Delete “$name”?');
  String get deleteBody => t(
    '这家的 API Key 会从这台手机删掉；语音等其他功能用到同一把 Key 时也会失效。',
    'This provider’s API key is removed from this phone; voice and other features using the same key stop working too.',
  );
  String get deleteConfirm => t('删除', 'Delete');
  String get actionFailed =>
      t('操作没有完成，请重试。', 'That did not complete. Try again.');

  // Capability tags.
  String get capTyped => t('手填', 'Typed');
  String get capTools => t('工具调用', 'Tools');
  String get capToolsUnconfirmed => t('工具调用 · 未确认', 'Tools · unconfirmed');
  String get capNoTools => t('不支持工具调用', 'No tool calls');
  String get capVision => t('看图', 'Vision');
  String get capReasoning => t('推理', 'Reasoning');

  /// Capability tags for a model: (label, strong). Capabilities the listing did
  /// not state are marked unconfirmed. Reference only; never blocks a choice.
  List<(String, bool)> tags(ModelOption o) => [
    if (o.typed) (capTyped, false),
    if (!o.capabilities.toolCalls)
      (capNoTools, false)
    else if (o.toolCallsKnown)
      (capTools, true)
    else
      (capToolsUnconfirmed, false),
    if (o.capabilities.vision && o.visionKnown) (capVision, false),
    if (o.capabilities.reasoning) (capReasoning, false),
    if (o.contextKnown) (contextLabel(o.capabilities.contextTokens), false),
  ];

  /// Context length in short form: 64K, 1M.
  static String contextLabel(int tokens) {
    if (tokens >= 1000000 && tokens % 1000000 < 50000) {
      return '${tokens ~/ 1000000}M';
    }
    if (tokens >= 1000000) return '${(tokens / 1000000).toStringAsFixed(1)}M';
    if (tokens >= 1000) {
      return tokens % 1024 == 0
          ? '${tokens ~/ 1024}K'
          : '${(tokens + 500) ~/ 1000}K';
    }
    return '$tokens';
  }
}
