import '../voice/audio_owner.dart';
import 'dart:async';
import 'package:flutter/cupertino.dart';
import '../ui/theme.dart';
import '../ui/chat_activity.dart';
import 'phone_dictation.dart';
import 'package:nova_audio/nova_audio.dart';
import '../voice/voice_settings.dart';
import '../voice/voice_settings_sheet.dart';
import '../ui/assistant_text.dart';
import 'package:flutter/material.dart';
import '../ui/local_dialog.dart';
import '../agent_core/agent_core_host.dart';
import '../agent_core/model_client.dart';
import '../agent_core/model_settings.dart';
import '../agent_core/model_presets.dart';
import 'package:url_launcher/url_launcher.dart';
import '../ui/chatgpt_settings.dart';
import '../agent_core/tool_registry.dart';
import 'dart:convert';

/// Also used by native task settings: one Dart source, projected to the host.
Future<void> showLocalModelSettings(
  BuildContext context,
  ModelSettings settings, {
  String language = 'zh',
}) async {
  String t(String zh, String en) => language == 'zh' ? zh : en;
  if (await settings.chatGpt.active() != null) {
    if (context.mounted) await showChatGptSettings(context, settings);
    return;
  }
  if (!context.mounted) return;
  final current = await settings.read();
  if (!context.mounted) return;
  final endpoint = TextEditingController(
    text: current?.endpoint ?? ModelPreset.byId('openrouter')!.endpoint,
  );
  final model = TextEditingController(
    text: current?.model ?? 'openai/gpt-4.1-mini',
  );
  final key = TextEditingController();
  String? error, notice;
  var saving = false, verifying = false, noticeBad = false;
  var protocol = current?.protocol ?? ModelProtocol.chatCompletions;
  // New users start on the former default (OpenRouter); saved endpoints that
  // match no preset stay on the free-form "custom" form.
  var preset = current == null
      ? ModelPreset.byId('openrouter')
      : ModelPreset.forEndpoint(current.endpoint);
  var fetched = <String>[];
  try {
    await showLocalDialog<void>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setState) {
          void choose(String id) {
            final next = ModelPreset.byId(id);
            preset = next;
            fetched = [];
            notice = null;
            error = null;
            if (next == null) return;
            endpoint.text = next.endpoint;
            protocol = next.protocol;
            model.text = next.recommendedModels.isEmpty
                ? ''
                : next.recommendedModels.first;
          }

          Future<void> verify() async {
            // A blank key reuses the saved one only while the URL is unchanged.
            final usable = key.text.isNotEmpty
                ? key.text
                : (current != null && endpoint.text == current.endpoint
                      ? current.key
                      : '');
            setState(() {
              verifying = true;
              notice = null;
            });
            String? message;
            var bad = false;
            var ids = <String>[];
            try {
              ids = await listModels(endpoint: endpoint.text, key: usable);
              message = ids.isEmpty
                  ? t(
                      '密钥可用，但该厂商没有返回模型列表，请直接填写模型名。',
                      'Key accepted, but the provider returned no models. Enter a model name.',
                    )
                  : t(
                      '验证通过，共 ${ids.length} 个模型。',
                      'Verified. ${ids.length} models available.',
                    );
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
                  '请求被限流或额度不足，请稍后再验证。',
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
            if (!context.mounted) return;
            setState(() {
              verifying = false;
              fetched = ids;
              notice = message;
              noticeBad = bad;
            });
          }

          final keyField = TextField(
            controller: key,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            decoration: InputDecoration(
              labelText: t('API 密钥', 'API key'),
              helperText: current == null
                  ? null
                  : t(
                      '不修改接口地址时，留空可保留现有密钥',
                      'Leave blank to keep your current key if the API URL is unchanged',
                    ),
              helperMaxLines: 3,
            ),
          );
          final modelField = TextField(
            controller: model,
            autocorrect: false,
            decoration: InputDecoration(labelText: t('模型名称', 'Model name')),
          );
          final verifyButton = Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton(
              onPressed: saving || verifying ? null : verify,
              child: Text(
                verifying
                    ? t('正在验证…', 'Verifying…')
                    : t('验证并获取模型', 'Verify & load models'),
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
                  onChanged: saving
                      ? null
                      : (value) {
                          if (value != null) setState(() => model.text = value);
                        },
                );
          final note = preset == null
              ? null
              : (language == 'zh' ? preset!.noteZh : preset!.noteEn);
          return AlertDialog(
            title: Text(t('模型服务', 'Model provider')),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    t(
                      '对话和任务所需内容会发送给所选模型服务。API 密钥仅保存在这台设备，不会同步到 Hub。',
                      'Content needed for conversations and tasks is sent to the selected model provider. Your API key stays on this device and is not synced to Hub.',
                    ),
                  ),
                  TextButton(
                    onPressed: saving
                        ? null
                        : () async {
                            await showChatGptSettings(context, settings);
                            if (context.mounted &&
                                await settings.chatGpt.active() != null) {
                              if (context.mounted) Navigator.pop(context);
                            }
                          },
                    child: Text(t('使用 ChatGPT 登录', 'Continue with ChatGPT')),
                  ),
                  Text(
                    t('或使用 API', 'Or use an API'),
                    style: const TextStyle(color: Nova.secondary, fontSize: 13),
                  ),
                  const SizedBox(height: 16),
                  DropdownButtonFormField<String>(
                    initialValue: preset?.id ?? 'custom',
                    isExpanded: true,
                    decoration: InputDecoration(
                      labelText: t('模型厂商', 'Provider'),
                    ),
                    items: [
                      for (final p in modelPresets)
                        DropdownMenuItem(
                          value: p.id,
                          child: Text(p.name, overflow: TextOverflow.ellipsis),
                        ),
                      DropdownMenuItem(
                        value: 'custom',
                        child: Text(
                          t('自定义（OpenAI 兼容）', 'Custom (OpenAI-compatible)'),
                        ),
                      ),
                    ],
                    onChanged: saving || verifying
                        ? null
                        : (value) {
                            if (value != null) setState(() => choose(value));
                          },
                  ),
                  const SizedBox(height: 16),
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
                    keyField,
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
                    verifyButton,
                  ] else ...[
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
                      onChanged: saving
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
                    keyField,
                    const SizedBox(height: 8),
                    verifyButton,
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
                  if (preset != null) ...[
                    const SizedBox(height: 16),
                    modelField,
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
                onPressed: saving
                    ? null
                    : () async {
                        setState(() {
                          saving = true;
                          error = null;
                        });
                        try {
                          await settings.save(
                            endpoint: endpoint.text,
                            model: model.text,
                            key: key.text,
                            protocol: protocol,
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
                                  : t(
                                      '未能保存，请检查接口地址、模型名称和密钥后重试。',
                                      'Could not save. Check the API URL, model name and key, then retry.',
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

class LocalChatPanel extends StatefulWidget {
  const LocalChatPanel({
    super.key,
    required this.host,
    required this.conversationId,
    this.language = 'zh',
    this.onVoice,
    this.voiceBusy = false,
    this.active = true,
    this.onModelSettings,
    this.modelRevision = 0,
    this.audioOwner,
    this.dictationAudio,
    this.requestMicrophone,
    this.voiceSettings = const VoiceSettings(),
    this.onVoiceText,
    this.externalTaskBusy = false,
    this.onCancelExternalTask,
  });
  final AgentCoreHost host;
  final AudioOwner? audioOwner;
  final AudioPort? dictationAudio;
  final Future<bool> Function()? requestMicrophone;
  final VoiceSettings voiceSettings;
  final Future<void> Function(String)? onVoiceText;
  final bool externalTaskBusy;
  final VoidCallback? onCancelExternalTask;
  final String conversationId;
  final String language;
  final VoidCallback? onModelSettings, onVoice;
  final int modelRevision;
  final bool voiceBusy, active;
  @override
  State<LocalChatPanel> createState() => LocalChatPanelState();
}

class LocalChatPanelState extends State<LocalChatPanel> {
  final input = TextEditingController();
  final scroll = ScrollController();
  final drafts = <String, String>{};
  String? model;
  PhoneDictation? dictation;
  String _dictationBase = '';
  bool atBottom = true;
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;
  @override
  void initState() {
    super.initState();
    if (widget.dictationAudio != null &&
        widget.requestMicrophone != null &&
        widget.audioOwner != null) {
      dictation = PhoneDictation(
        audioOwner: widget.audioOwner!,
        audio: widget.dictationAudio!,
        requestMicrophone: widget.requestMicrophone!,
        readConfiguration: widget.voiceSettings.readForDictation,
        onText: (text) {
          input.text = _dictationBase.isEmpty ? text : '$_dictationBase\n$text';
        },
      )..addListener(_dictationChanged);
    }
    widget.host.addListener(_changed);
    scroll.addListener(() {
      atBottom = !scroll.hasClients || scroll.position.extentAfter < 100;
    });
    _readModel();
    _changed();
  }

  void _dictationChanged() {
    if (mounted) setState(() {});
  }

  void _beginDictation() {
    if (widget.voiceBusy || !widget.active || widget.host.busy) return;
    FocusManager.instance.primaryFocus?.unfocus();
    _dictationBase = input.text;
    unawaited(dictation?.begin(widget.language));
  }

  void prefill(String text) {
    unawaited(dictation?.cancel());
    input.text = text;
    if (mounted) setState(() {});
  }

  Future<void> _readModel() async {
    try {
      final value = await widget.host.settings.read();
      if (mounted) setState(() => model = value?.model);
    } catch (_) {
      /* The settings screen exposes configuration errors. */
    }
  }

  void _changed() {
    if (mounted && atBottom) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && scroll.hasClients) {
          scroll.jumpTo(scroll.position.maxScrollExtent);
        }
      });
    }
  }

  @override
  void didUpdateWidget(covariant LocalChatPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.active && oldWidget.active) unawaited(dictation?.cancel());
    if (oldWidget.host != widget.host) {
      unawaited(dictation?.cancel());
      oldWidget.host.removeListener(_changed);
      widget.host.addListener(_changed);
    }
    if (oldWidget.conversationId != widget.conversationId) {
      unawaited(dictation?.cancel());
      drafts[oldWidget.conversationId] = input.text;
      input.text = drafts[widget.conversationId] ?? '';
      atBottom = true;
      _changed();
    }
    if (oldWidget.modelRevision != widget.modelRevision) _readModel();
  }

  @override
  void dispose() {
    widget.host.removeListener(_changed);
    dictation?.removeListener(_dictationChanged);
    dictation?.dispose();
    input.dispose();
    scroll.dispose();
    super.dispose();
  }

  Future<bool> _approve(ApprovalOffer offer) async {
    if (!mounted) return false;
    return await showLocalDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: Text('允许 ${offer.tool}？'),
            content: SingleChildScrollView(
              child: Text(
                '${const JsonEncoder.withIndent('  ').convert(offer.arguments)}\n批准仅对此次参数有效，两分钟后过期。',
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('拒绝'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('允许一次'),
              ),
            ],
          ),
        ) ??
        false;
  }

  Future<void> _modelSettings() async {
    if (widget.onModelSettings != null) {
      widget.onModelSettings!();
      return;
    }
    try {
      await showLocalModelSettings(
        context,
        widget.host.settings,
        language: widget.language,
      );
      await _readModel();
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(t('无法读取模型设置', 'Could not read model settings')),
          ),
        );
      }
    }
  }

  Future<void> cancelDictation() async => dictation?.cancel();

  Future<void> _send() async {
    if (dictation?.busy == true) return;
    if (widget.externalTaskBusy && widget.onVoiceText == null) {
      widget.onCancelExternalTask?.call();
      return;
    }
    if (widget.onVoiceText != null) {
      final text = input.text.trim();
      if (text.isNotEmpty) {
        try {
          await widget.onVoiceText!(text);
          if (mounted && input.text.trim() == text) input.clear();
        } catch (_) {
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(
                content: Text(
                  t(
                    '暂未发送，语音回复仍在结束中。草稿已保留，请稍后重试。',
                    'Not sent. Wait for the voice response to finish, then retry. Your draft is preserved.',
                  ),
                ),
              ),
            );
          }
        }
      }
      return;
    }
    final host = widget.host;
    if (host.busy) {
      host.cancel();
      return;
    }
    final text = input.text.trim();
    if (text.isEmpty) return;
    atBottom = true;
    input.clear();
    await host.send(widget.conversationId, text, approve: _approve);
    // Preserve a message that could not reach the conversation store.
    final messages =
        host.store.conversation(widget.conversationId)['messages'] as List;
    if (mounted &&
        host.error != null &&
        input.text.isEmpty &&
        (messages.isEmpty || messages.last['content'] != text) &&
        host.error == 'model_settings_required') {
      input.text = text;
    }
  }

  String _error(String code) => switch (code) {
    'model_settings_required' => t(
      '先选择一个模型，就可以开始对话。',
      'Choose a model to start chatting.',
    ),
    'background_expired' => t(
      '系统已结束后台执行，已保存进度。回到这里可继续。',
      'iOS ended background execution. Progress was saved; continue here.',
    ),
    'process_interrupted' => t(
      '上次运行被系统中断，进度已恢复。已执行的操作不会自动重复。',
      'The previous run was interrupted. Saved progress was restored without replaying actions.',
    ),
    'tool_execution_incomplete' => t(
      '操作未完成，请查看操作结果。',
      'The operation did not complete. See its result.',
    ),
    'cancelled' => t('已停止生成', 'Response stopped'),
    'model_timeout' => t(
      '模型长时间没有新输出，本次已中断。可以继续让 Nova 完成。',
      'The model stopped sending output. You can ask Nova to continue.',
    ),
    'model_settings_unavailable' => t(
      '暂时无法读取模型设置。',
      'Model settings are unavailable.',
    ),
    'model_response_too_large' => t(
      '生成内容超出接收上限，本次没有保存成作品。',
      'The generated content exceeded the receive limit and was not saved as an artifact.',
    ),
    'network_unavailable' => t(
      '网络暂时不可用，进度已保存。',
      'The network is unavailable. Progress was saved.',
    ),
    'model_http_401' || 'model_http_403' => t(
      '模型服务拒绝访问，请检查密钥与服务权限。',
      'The model provider refused access. Check its key and permissions.',
    ),
    'model_http_429' => t(
      '模型服务暂时限流或额度不足，请稍后重试。',
      'The model provider is rate limited or out of quota. Try later.',
    ),
    'invalid_model_response' => t(
      '模型服务返回了无法处理的结果，未执行其中的操作。',
      'The model provider returned an invalid result. No actions from it were executed.',
    ),
    'model_request_failed' => t(
      '模型服务连接中断，本次未完成。',
      'The model provider connection was interrupted.',
    ),
    'model_output_limit' => t(
      '作品源码超出本次输出长度，请让 Nova 分步完成。',
      'The source exceeded this response limit. Ask Nova to build it in steps.',
    ),
    'tool_round_limit' => t(
      '已达到本轮操作上限，可以继续对话。',
      'This turn reached its action limit. You can continue chatting.',
    ),
    _ => t(
      '这次执行未完成，已保留当前进度。',
      'This run did not complete. Its progress was saved.',
    ),
  };

  Future<void> _openArtifact(String id) async {
    try {
      await widget.host.tools!.registry.artifacts!.openPreview(id);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              t('暂时无法打开作品，请重试', 'Could not open this artifact. Try again.'),
            ),
          ),
        );
      }
    }
  }

  Widget _message(Map message) {
    if (message['role'] == 'tool') {
      String status = '';
      Map? artifact;
      try {
        final result = jsonDecode(message['content'] as String) as Map;
        status = result['status'] as String? ?? '';
        if (result['data'] is Map && result['data']['artifact'] is Map) {
          artifact = result['data']['artifact'] as Map;
        }
      } catch (_) {}
      if (status == 'completed' &&
          artifact != null &&
          widget.host.tools?.registry.artifacts != null) {
        final item = artifact;
        return Padding(
          padding: const EdgeInsets.only(bottom: 16),
          child: Material(
            color: Nova.cell,
            borderRadius: BorderRadius.circular(18),
            child: ListTile(
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(18),
              ),
              leading: const Icon(
                CupertinoIcons.doc_richtext,
                color: Nova.mint,
              ),
              title: Text(
                item['title'] as String,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              subtitle: Text(t('已保存 · 点此打开', 'Saved · Tap to open')),
              trailing: const Icon(
                CupertinoIcons.arrow_up_right_square,
                size: 20,
              ),
              onTap: () => _openArtifact(item['id'] as String),
            ),
          ),
        );
      }
      final label = switch (status) {
        'completed' => switch (message['tool_name']) {
          'artifact_test' => t('作品运行检查已返回', 'Artifact check returned'),
          'calendar_list' => t('系统日历读取已返回', 'Calendar returned'),
          'reminders_list' => t('提醒事项读取已返回', 'Reminders returned'),
          _ => t('操作返回结果', 'Operation returned a result'),
        },
        'denied' => t('已拒绝，未执行', 'Declined, not executed'),
        'cancelled' => t('已取消', 'Cancelled'),
        'outcome_unknown' => t('执行结果待核实', 'Outcome needs verification'),
        'rejected' => t('操作未获准', 'Operation not allowed'),
        _ => t('操作详情', 'Operation details'),
      };
      return Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: ExpansionTile(
          tilePadding: EdgeInsets.zero,
          childrenPadding: const EdgeInsets.only(bottom: 12),
          dense: true,
          shape: const Border(),
          collapsedShape: const Border(),
          leading: const Icon(
            CupertinoIcons.doc_text,
            size: 16,
            color: Nova.secondary,
          ),
          title: Text(
            label,
            style: const TextStyle(color: Nova.secondary, fontSize: 13),
          ),
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: SelectableText(
                message['content'] as String,
                style: const TextStyle(
                  color: Nova.secondary,
                  fontSize: 12,
                  height: 1.5,
                ),
              ),
            ),
          ],
        ),
      );
    }
    final text = message['content'] as String;
    if (text.isEmpty) return const SizedBox.shrink();
    final user = message['role'] == 'user';
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Align(
        alignment: user ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          constraints: user ? const BoxConstraints(maxWidth: 300) : null,
          padding: user
              ? const EdgeInsets.symmetric(horizontal: 17, vertical: 13)
              : EdgeInsets.zero,
          decoration: user
              ? BoxDecoration(
                  color: Nova.cell,
                  borderRadius: BorderRadius.circular(22),
                )
              : null,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (user)
                SelectableText(
                  text,
                  style: const TextStyle(fontSize: 16, height: 1.5),
                )
              else
                DefaultTextStyle.merge(
                  style: const TextStyle(fontSize: 16, height: 1.6),
                  child: AssistantText(text, onArtifactLink: _openArtifact),
                ),
              if (user &&
                  (message['voice_transcript_final'] == false ||
                      message['voice_input_origin_verified'] == false))
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    t('转写未确认', 'Transcript unconfirmed'),
                    style: const TextStyle(color: Nova.secondary, fontSize: 12),
                  ),
                ),
              if (message['interrupted'] == true)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    message['error'] is String
                        ? _error(message['error'] as String)
                        : t('回复已中断', 'Response interrupted'),
                    style: const TextStyle(color: Nova.secondary, fontSize: 12),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.host,
    builder: (context, _) {
      final host = widget.host;
      final conversation = host.store.conversation(widget.conversationId);
      final messages = conversation['messages'] as List;
      return LayoutBuilder(
        builder: (context, constraints) {
          final compact = constraints.maxHeight < 260;
          return Column(
            children: [
              if (!compact)
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Flexible(
                      child: PopupMenuButton<String>(
                        tooltip: t('对话方式', 'Conversation mode'),
                        enabled: !host.busy,
                        onSelected: (_) => _modelSettings(),
                        itemBuilder: (_) => [
                          PopupMenuItem(
                            value: 'model',
                            child: Text(t('模型设置', 'Model settings')),
                          ),
                        ],
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Flexible(
                                child: Text(
                                  model ?? t('选择模型', 'Choose model'),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    color: Nova.secondary,
                                    fontSize: 13,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 5),
                              const Icon(
                                CupertinoIcons.chevron_down,
                                size: 10,
                                color: Nova.secondary,
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ...[
                Expanded(
                  child: messages.isEmpty && !host.busy
                      ? Center(
                          child: Padding(
                            padding: const EdgeInsets.all(30),
                            child: Text(
                              t('从这里开始。', 'Start here.'),
                              style: const TextStyle(
                                fontSize: 22,
                                color: Nova.tertiary,
                                fontWeight: FontWeight.w400,
                              ),
                            ),
                          ),
                        )
                      : ListView(
                          controller: scroll,
                          keyboardDismissBehavior:
                              ScrollViewKeyboardDismissBehavior.onDrag,
                          padding: const EdgeInsets.fromLTRB(24, 20, 24, 10),
                          children: [
                            for (final message in messages)
                              _message(message as Map),
                            if (host.draft.isNotEmpty &&
                                host.activeConversationId ==
                                    widget.conversationId)
                              _message({
                                'role': 'assistant',
                                'content': host.draft,
                              }),
                            if (host.busy &&
                                host.activeConversationId ==
                                    widget.conversationId)
                              ChatActivity(
                                label: switch (host.activeTool) {
                                  'artifact_write' => t(
                                    '正在编写作品',
                                    'Writing the artifact',
                                  ),
                                  'artifact_test' => t(
                                    '正在运行检查',
                                    'Running checks',
                                  ),
                                  'artifact_read' => t(
                                    '正在读取作品',
                                    'Reading the artifact',
                                  ),
                                  'calendar_list' => t(
                                    '正在读取系统日历',
                                    'Reading Calendar',
                                  ),
                                  'reminders_list' => t(
                                    '正在读取提醒事项',
                                    'Reading Reminders',
                                  ),
                                  'device_run_task' => t(
                                    '正在执行手机任务',
                                    'Working on your phone',
                                  ),
                                  null =>
                                    host.draft.isEmpty
                                        ? t('正在思考', 'Thinking')
                                        : t('正在回复', 'Writing the reply'),
                                  _ => t('正在处理', 'Working'),
                                },
                                startedAt: host.turnStartedAt ?? DateTime.now(),
                                language: widget.language,
                                details: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    if (host.activeTool != null)
                                      Text(
                                        host.activeTool!,
                                        style: const TextStyle(
                                          color: Nova.secondary,
                                          fontSize: 12,
                                        ),
                                      ),
                                    if (host.activeToolArguments.isNotEmpty)
                                      ConstrainedBox(
                                        constraints: const BoxConstraints(
                                          maxHeight: 220,
                                        ),
                                        child: SingleChildScrollView(
                                          child: SelectableText(
                                            host.activeToolArguments,
                                            style: const TextStyle(
                                              fontFamily: 'Menlo',
                                              fontSize: 12,
                                              height: 1.4,
                                            ),
                                          ),
                                        ),
                                      )
                                    else
                                      Text(
                                        t(
                                          '正在等待模型输出；收到内容后会显示在这里。',
                                          'Waiting for model output; received content will appear here.',
                                        ),
                                        style: const TextStyle(
                                          color: Nova.secondary,
                                          fontSize: 13,
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                          ],
                        ),
                ),
                if (host.error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 24,
                      vertical: 8,
                    ),
                    child: Text(
                      _error(host.error!),
                      style: const TextStyle(color: Nova.red, fontSize: 13),
                    ),
                  ),
                if (dictation?.busy == true ||
                    dictation?.notice.isNotEmpty == true)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 24,
                      vertical: 6,
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            dictation!.partial.isNotEmpty
                                ? dictation!.partial
                                : dictation!.notice.isNotEmpty
                                ? switch (dictation!.notice) {
                                    'microphone_denied' => t(
                                      '请在系统设置中允许麦克风访问',
                                      'Allow microphone access in Settings',
                                    ),
                                    'dictation_settings_required' => t(
                                      '请先配置语音识别服务',
                                      'Configure a speech recognition service first',
                                    ),
                                    'dictation_empty' => t(
                                      '没有识别到内容，草稿已保留',
                                      'No speech recognized. Draft preserved.',
                                    ),
                                    _ => t(
                                      '暂时无法识别语音，草稿已保留',
                                      'Speech recognition unavailable. Draft preserved.',
                                    ),
                                  }
                                : dictation!.transcribing
                                ? t('正在识别…', 'Transcribing…')
                                : t('松开后转为文字', 'Release to transcribe'),
                            style: const TextStyle(
                              color: Nova.secondary,
                              fontSize: 13,
                            ),
                          ),
                        ),
                        if (dictation!.notice == 'dictation_settings_required')
                          TextButton(
                            onPressed: () async {
                              try {
                                await showVoiceSettings(
                                  context,
                                  widget.voiceSettings,
                                  dictationOnly: true,
                                  language: widget.language,
                                );
                              } catch (_) {
                                if (context.mounted) {
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    SnackBar(
                                      content: Text(
                                        t(
                                          '无法读取语音设置，请稍后重试',
                                          'Unable to read speech settings. Try again later.',
                                        ),
                                      ),
                                    ),
                                  );
                                }
                              }
                            },
                            child: Text(t('设置', 'Settings')),
                          ),
                        if (dictation!.busy)
                          TextButton(
                            onPressed: dictation!.cancel,
                            child: Text(t('取消', 'Cancel')),
                          ),
                      ],
                    ),
                  ),
                SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 14),
                    child: Container(
                      decoration: BoxDecoration(
                        color: Nova.cell,
                        borderRadius: BorderRadius.circular(26),
                      ),
                      padding: const EdgeInsets.fromLTRB(18, 6, 8, 6),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Expanded(
                            child: ConstrainedBox(
                              constraints: BoxConstraints(
                                maxHeight: compact
                                    ? (constraints.maxHeight * .45)
                                          .clamp(36, 90)
                                          .toDouble()
                                    : 150,
                              ),
                              child: TextField(
                                controller: input,
                                enabled: dictation?.busy != true,
                                onTapOutside: (_) => FocusManager
                                    .instance
                                    .primaryFocus
                                    ?.unfocus(),
                                minLines: 1,
                                maxLines: 5,
                                textCapitalization:
                                    TextCapitalization.sentences,
                                style: const TextStyle(
                                  fontSize: 16,
                                  height: 1.4,
                                ),
                                decoration: InputDecoration(
                                  hintText: t('发消息给 Nova', 'Message Nova'),
                                  filled: false,
                                  border: InputBorder.none,
                                  enabledBorder: InputBorder.none,
                                  focusedBorder: InputBorder.none,
                                  contentPadding: const EdgeInsets.symmetric(
                                    vertical: 13,
                                  ),
                                ),
                              ),
                            ),
                          ),
                          if (dictation != null)
                            Tooltip(
                              message: t('按住说话', 'Hold to speak'),
                              triggerMode: TooltipTriggerMode.manual,
                              child: GestureDetector(
                                onTap: () =>
                                    ScaffoldMessenger.of(context).showSnackBar(
                                      SnackBar(
                                        content: Text(
                                          t(
                                            '按住麦克风说话，松开后转成文字',
                                            'Hold the microphone, then release to transcribe',
                                          ),
                                        ),
                                      ),
                                    ),
                                onLongPressStart: widget.voiceBusy
                                    ? null
                                    : (_) => _beginDictation(),
                                onLongPressEnd: (_) => dictation!.finish(),
                                onLongPressCancel: () => dictation!.cancel(),
                                child: Semantics(
                                  button: true,
                                  label: t('按住说话', 'Hold to speak'),
                                  child: SizedBox(
                                    width: 42,
                                    height: 48,
                                    child: Icon(
                                      CupertinoIcons.mic_fill,
                                      size: 22,
                                      color: dictation!.recording
                                          ? Nova.red
                                          : Nova.secondary,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          if (widget.onVoice != null)
                            IconButton(
                              tooltip: t('实时语音', 'Live voice'),
                              onPressed: () async {
                                await dictation?.cancel();
                                if (mounted) widget.onVoice?.call();
                              },
                              icon: const Icon(
                                CupertinoIcons.waveform,
                                size: 22,
                                color: Nova.secondary,
                              ),
                            ),
                          if (widget.externalTaskBusy &&
                              widget.onVoiceText != null)
                            IconButton(
                              tooltip: t('停止任务', 'Stop task'),
                              onPressed: widget.onCancelExternalTask,
                              icon: const Icon(CupertinoIcons.stop_fill),
                            ),
                          ValueListenableBuilder<TextEditingValue>(
                            valueListenable: input,
                            builder: (context, value, _) => IconButton.filled(
                              tooltip:
                                  host.busy ||
                                      (widget.externalTaskBusy &&
                                          widget.onVoiceText == null)
                                  ? t('停止', 'Stop')
                                  : t('发送', 'Send'),
                              style: IconButton.styleFrom(
                                backgroundColor: Nova.mint,
                                foregroundColor: Colors.white,
                                disabledBackgroundColor: Nova.separator,
                                disabledForegroundColor: Nova.tertiary,
                              ),
                              onPressed:
                                  dictation?.busy == true ||
                                      (!host.busy &&
                                          !(widget.externalTaskBusy &&
                                              widget.onVoiceText == null) &&
                                          value.text.trim().isEmpty)
                                  ? null
                                  : _send,
                              icon: Icon(
                                host.busy ||
                                        (widget.externalTaskBusy &&
                                            widget.onVoiceText == null)
                                    ? CupertinoIcons.stop_fill
                                    : CupertinoIcons.arrow_up,
                                size: 22,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ],
          );
        },
      );
    },
  );
}
