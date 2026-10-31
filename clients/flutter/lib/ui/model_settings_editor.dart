import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../agent_core/model_client.dart';
import '../agent_core/model_presets.dart';
import '../settings/model_settings_backend.dart';
import 'local_dialog.dart';
import 'provider_credentials_sheet.dart';
import 'theme.dart';

/// One presentation for local secure storage and paired Host model settings.
Future<void> showModelSettingsEditor(
  BuildContext context,
  ModelSettingsBackend backend, {
  String language = 'zh',
  String? title,
  String? description,
  Future<void> Function(BuildContext)? onManageCredentials,
  Future<bool> Function(BuildContext)? onChatGpt,
}) async {
  String t(String zh, String en) => language == 'zh' ? zh : en;
  final view = await backend.load();
  if (!context.mounted) return;
  final endpoint = TextEditingController(text: view.endpoint);
  final model = TextEditingController(text: view.model);
  final key = TextEditingController();
  String? error, notice;
  var saving = false, loadingModels = false, noticeBad = false;
  var modelListRevision = 0;
  var protocol = view.protocol;
  ModelPreset? findProvider(String? id) {
    for (final provider in view.providers) {
      if (provider.id == id) return provider;
    }
    return null;
  }

  var preset = findProvider(view.providerId);
  var providerId = view.providerId;
  var fetched = <String>[];
  Future<bool> resolveSavedCredential() =>
      backend.hasCredential(providerId, endpoint.text);
  var savedCredential = resolveSavedCredential();
  try {
    await showLocalDialog<void>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setState) {
          void invalidateModels() {
            modelListRevision++;
            loadingModels = false;
            fetched = [];
            notice = null;
            error = null;
          }

          void choose(String id) {
            final next = findProvider(id);
            preset = next;
            providerId = id == 'custom' ? null : id;
            key.clear();
            invalidateModels();
            if (next == null) {
              savedCredential = resolveSavedCredential();
              return;
            }
            endpoint.text = next.endpoint;
            protocol = next.protocol;
            savedCredential = resolveSavedCredential();
            model.text = next.recommendedModels.isEmpty
                ? ''
                : next.recommendedModels.first;
          }

          Future<void> loadModels() async {
            final revision = ++modelListRevision;
            setState(() {
              loadingModels = true;
              notice = null;
            });
            String? message;
            var bad = false;
            var ids = <String>[];
            try {
              ids = await backend.listModels(
                ModelSettingsInput(
                  providerId: providerId,
                  endpoint: endpoint.text,
                  model: model.text,
                  protocol: protocol,
                  newKey: key.text,
                ),
              );
              message = ids.isEmpty
                  ? t(
                      '该厂商没有返回模型列表，请直接填写模型名。',
                      'The provider returned no models. Enter a model name.',
                    )
                  : t('已加载 ${ids.length} 个模型。', 'Loaded ${ids.length} models.');
            } on AgentFailure catch (failure) {
              bad =
                  failure.code != 'model_http_404' &&
                  failure.code != 'model_http_405' &&
                  failure.code != 'invalid_model_response';
              message = switch (failure.code) {
                'model_http_401' || 'model_http_403' => t(
                  '密钥被拒绝，请检查密钥是否正确、是否属于该厂商。',
                  'The key was rejected. Check that it is correct and belongs to this provider.',
                ),
                'model_http_404' ||
                'model_http_405' ||
                'invalid_model_response' => t(
                  '该厂商没有提供可识别的模型列表，直接填写模型名即可。',
                  'This provider has no usable model list. Enter the model name yourself.',
                ),
                'model_http_429' => t(
                  '请求被限流或额度不足，请稍后重试。',
                  'Rate limited or out of quota. Try again later.',
                ),
                'invalid_model_settings' => t(
                  '请先填写有效的接口地址和密钥。',
                  'Enter a valid API URL and key first.',
                ),
                _ => t(
                  '无法连接到该厂商，请检查网络和接口地址。',
                  'Could not reach the provider. Check the network and API URL.',
                ),
              };
            }
            if (!context.mounted || revision != modelListRevision) return;
            setState(() {
              loadingModels = false;
              fetched = ids;
              notice = message;
              noticeBad = bad;
            });
          }

          final keyField = TextField(
            controller: key,
            enabled: !view.readOnly && !saving,
            enableIMEPersonalizedLearning: false,
            onChanged: (_) => setState(invalidateModels),
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            decoration: InputDecoration(
              labelText: t('API 密钥', 'API key'),
              helperText: t(
                '已保存的密钥不会回显；留空时使用此服务已配置的密钥',
                'Saved keys stay hidden. Leave blank to use this provider’s configured key.',
              ),
              helperMaxLines: 3,
            ),
          );
          final modelField = TextField(
            controller: model,
            enabled: !view.readOnly && !saving,
            autocorrect: false,
            decoration: InputDecoration(labelText: t('模型名称', 'Model name')),
          );
          final loadModelsButton = Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton(
              onPressed: saving || view.readOnly || loadingModels
                  ? null
                  : loadModels,
              child: Text(
                loadingModels
                    ? t('正在获取模型…', 'Loading models…')
                    : t('获取模型列表', 'Load model list'),
              ),
            ),
          );
          final modelPicker = fetched.isEmpty
              ? null
              : DropdownButtonFormField<String>(
                  key: ValueKey(fetched.length),
                  initialValue: fetched.contains(model.text)
                      ? model.text
                      : null,
                  isExpanded: true,
                  decoration: InputDecoration(
                    labelText: t('从列表选择模型', 'Pick a model'),
                  ),
                  items: [
                    for (final id in fetched)
                      DropdownMenuItem(
                        value: id,
                        child: Text(id, overflow: TextOverflow.ellipsis),
                      ),
                  ],
                  onChanged: saving || view.readOnly
                      ? null
                      : (value) {
                          if (value != null) setState(() => model.text = value);
                        },
                );
          final note = preset == null
              ? null
              : (language == 'zh' ? preset!.noteZh : preset!.noteEn);
          return AlertDialog(
            title: Text(
              title ??
                  (view.canFollow
                      ? t('信息整理', 'Information processing')
                      : t('模型服务', 'Model provider')),
            ),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    view.securityText ??
                        t(
                          '对话和任务所需内容会发送给所选模型服务。API 密钥仅保存在这台设备，保存在当前 Space 的安全存储中。',
                          'Content needed for conversations and tasks is sent to the selected model provider. Your API key stays on this device and is stored in the current Space secure storage.',
                        ),
                  ),
                  if (onManageCredentials != null)
                    TextButton(
                      key: const ValueKey('model.credentials'),
                      onPressed: saving || view.readOnly
                          ? null
                          : () async {
                              try {
                                await onManageCredentials(context);
                                if (context.mounted) {
                                  setState(() {
                                    invalidateModels();
                                    savedCredential = resolveSavedCredential();
                                  });
                                }
                              } catch (_) {
                                if (context.mounted) {
                                  setState(
                                    () => error = t(
                                      '无法读取服务配置，请重试。',
                                      'Could not read provider settings. Try again.',
                                    ),
                                  );
                                }
                              }
                            },
                      child: Text(t('管理服务密钥', 'Manage provider credentials')),
                    ),
                  if (onChatGpt != null)
                    TextButton(
                      onPressed: saving || view.readOnly
                          ? null
                          : () async {
                              final close = await onChatGpt(context);
                              if (context.mounted && close) {
                                Navigator.pop(context);
                              }
                            },
                      child: Text(t('使用 ChatGPT 登录', 'Continue with ChatGPT')),
                    ),
                  if (view.canFollow) ...[
                    Text(
                      view.following
                          ? (view.followLabel ??
                                t('当前：跟随对话模型', 'Current: Follow chat model'))
                          : t(
                              '当前：独立配置 · ${view.model}',
                              'Current: Separate model · ${view.model}',
                            ),
                    ),
                    Text(
                      description ??
                          t(
                            '用于飞书整理和个人近况生成；默认跟随对话模型。',
                            'Used for Feishu processing and profile updates; follows the chat model by default.',
                          ),
                    ),
                    TextButton(
                      key: const ValueKey('support.follow'),
                      onPressed: saving || view.readOnly
                          ? null
                          : () async {
                              try {
                                await backend.follow();
                                if (context.mounted) Navigator.pop(context);
                              } catch (_) {
                                if (context.mounted) {
                                  setState(
                                    () => error = t(
                                      '无法保存，请重试。',
                                      'Could not save. Try again.',
                                    ),
                                  );
                                }
                              }
                            },
                      child: Text(
                        view.followLabel ?? t('跟随对话模型', 'Follow chat model'),
                      ),
                    ),
                  ],
                  if (view.notice != null) Text(view.notice!),
                  if (onChatGpt != null)
                    Text(
                      t('或使用 API', 'Or use an API'),
                      style: const TextStyle(
                        color: Nova.secondary,
                        fontSize: 13,
                      ),
                    ),
                  const SizedBox(height: 16),
                  DropdownButtonFormField<String>(
                    initialValue:
                        providerId ??
                        (view.customEndpoint ? 'custom' : 'unconfigured'),
                    isExpanded: true,
                    decoration: InputDecoration(
                      labelText: t('模型厂商', 'Provider'),
                    ),
                    items: [
                      for (final p in view.providers)
                        DropdownMenuItem(
                          value: p.id,
                          child: Text(p.name, overflow: TextOverflow.ellipsis),
                        ),
                      if (view.providerId != null &&
                          findProvider(view.providerId) == null)
                        DropdownMenuItem(
                          value: view.providerId,
                          child: Text(view.providerId!),
                        ),
                      if (!view.customEndpoint && providerId == null)
                        DropdownMenuItem(
                          value: 'unconfigured',
                          enabled: false,
                          child: Text(t('未配置', 'Not configured')),
                        ),
                      if (view.customEndpoint)
                        DropdownMenuItem(
                          value: 'custom',
                          child: Text(
                            t('自定义（OpenAI 兼容）', 'Custom (OpenAI-compatible)'),
                          ),
                        ),
                    ],
                    onChanged: saving || view.readOnly
                        ? null
                        : (value) {
                            if (value != null) setState(() => choose(value));
                          },
                  ),
                  const SizedBox(height: 16),
                  ProviderCredentialStatus(
                    configured: savedCredential,
                    language: language,
                  ),
                  const SizedBox(height: 8),
                  if (preset != null) ...[
                    if (note != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: Text(
                          note,
                          style: const TextStyle(
                            color: Nova.secondary,
                            fontSize: 13,
                          ),
                        ),
                      ),
                    if (view.allowKeyEntry) keyField,
                    if (preset!.keyUrl.isNotEmpty)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: TextButton(
                          onPressed: () => launchUrl(
                            Uri.parse(preset!.keyUrl),
                            mode: LaunchMode.externalApplication,
                          ),
                          child: Text(t('去获取 API 密钥', 'Get an API key')),
                        ),
                      ),
                    if (view.modelDiscovery) loadModelsButton,
                  ] else if (view.customEndpoint) ...[
                    DropdownButtonFormField<ModelProtocol>(
                      initialValue: protocol,
                      isExpanded: true,
                      decoration: InputDecoration(
                        labelText: t('API 协议', 'API protocol'),
                      ),
                      items: const [
                        DropdownMenuItem(
                          value: ModelProtocol.chatCompletions,
                          child: Text('Chat Completions'),
                        ),
                        DropdownMenuItem(
                          value: ModelProtocol.responses,
                          child: Text('Responses'),
                        ),
                      ],
                      onChanged: saving || view.readOnly
                          ? null
                          : (value) {
                              if (value != null) {
                                setState(() => protocol = value);
                              }
                            },
                    ),
                    const SizedBox(height: 16),
                    TextField(
                      controller: endpoint,
                      enabled: !view.readOnly && !saving,
                      onChanged: (_) => setState(() {
                        key.clear();
                        invalidateModels();
                        savedCredential = resolveSavedCredential();
                      }),
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      decoration: InputDecoration(
                        labelText: t('接口地址', 'API URL'),
                        helperText: t(
                          '支持 Base URL 或完整接口地址',
                          'Base URL or full endpoint URL',
                        ),
                        helperMaxLines: 3,
                      ),
                    ),
                    const SizedBox(height: 16),
                    modelField,
                    const SizedBox(height: 16),
                    if (view.allowKeyEntry) keyField,
                    const SizedBox(height: 8),
                    if (view.modelDiscovery) loadModelsButton,
                  ],
                  if (notice != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        notice!,
                        style: TextStyle(
                          color: noticeBad ? Nova.red : Nova.secondary,
                          fontSize: 13,
                        ),
                      ),
                    ),
                  if (modelPicker != null) ...[
                    const SizedBox(height: 16),
                    modelPicker,
                  ],
                  if (preset != null || !view.customEndpoint) ...[
                    const SizedBox(height: 16),
                    modelField,
                    if (preset == null && view.allowKeyEntry) keyField,
                  ],
                  if (error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 12),
                      child: Text(
                        error!,
                        style: const TextStyle(color: Nova.red),
                      ),
                    ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: saving ? null : () => Navigator.pop(context),
                child: Text(t('取消', 'Cancel')),
              ),
              FilledButton(
                onPressed: saving || view.readOnly
                    ? null
                    : () async {
                        setState(() {
                          saving = true;
                          error = null;
                        });
                        try {
                          await backend.save(
                            ModelSettingsInput(
                              providerId: providerId,
                              endpoint: endpoint.text,
                              model: model.text,
                              protocol: protocol,
                              newKey: key.text,
                            ),
                          );
                          if (context.mounted) Navigator.pop(context);
                        } catch (failure) {
                          if (context.mounted) {
                            setState(() {
                              error =
                                  failure is AgentFailure &&
                                      failure.code ==
                                          'model_settings_projection_failed'
                                  ? t(
                                      '设置未能生效，请重试。',
                                      'Could not apply these settings. Please retry.',
                                    )
                                  : view.customEndpoint
                                  ? t(
                                      '未能保存，请检查接口地址、模型名称和密钥后重试。',
                                      'Could not save. Check the API URL, model name and key, then retry.',
                                    )
                                  : t(
                                      '未能保存，请检查模型厂商、模型名称和密钥后重试。',
                                      'Could not save. Check the provider, model name and key, then retry.',
                                    );
                              saving = false;
                            });
                          }
                        }
                      },
                child: Text(saving ? t('正在保存…', 'Saving…') : t('保存', 'Save')),
              ),
            ],
          );
        },
      ),
    );
  } finally {
    endpoint.dispose();
    model.dispose();
    key.dispose();
  }
}
