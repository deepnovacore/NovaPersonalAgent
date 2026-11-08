import '../voice/audio_owner.dart';
import '../generic/shared_ideas.dart';
import '../ui/shared_idea_suggestions.dart';
import 'local_conversation_store.dart';
import 'dart:async';
import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/cupertino.dart';
import '../ui/theme.dart';
import '../ui/chat_activity.dart';
import '../ui/thinking_block.dart';
import '../ui/phone_tool_steps.dart';
import '../ui/tool_step.dart';
import '../ui/tool_timeline.dart';
import '../agent/phone_run.dart';
import 'phone_dictation.dart';
import 'package:nova_audio/nova_audio.dart';
import '../voice/voice_settings.dart';
import '../voice/voice_settings_sheet.dart';
import '../ui/assistant_text.dart';
import 'package:flutter/material.dart';
import '../ui/local_dialog.dart';
import '../agent_core/agent_core_host.dart';
import '../agent_core/model_settings.dart';
import '../ui/chatgpt_settings.dart';
import '../ui/provider_credentials_sheet.dart';
import '../ui/model_settings_editor.dart';
import '../settings/model_settings_backend.dart';
import '../agent_core/tool_registry.dart';
import 'dart:convert';

/// Also used by native task settings: one Dart source, projected to the host.
Future<void> showLocalModelSettings(
  BuildContext context,
  ModelSettings settings, {
  String language = 'zh',
  bool support = false,
  bool experienceDefault = false,
}) async {
  final clearSelection =
      !support && experienceDefault && await settings.hasConversationSelection()
      ? settings.clearConversationSelection
      : null;
  if (!support && await settings.chatGpt.active() != null) {
    if (context.mounted) {
      await showChatGptSettings(
        context,
        settings,
        onClearSelection: clearSelection,
      );
    }
    return;
  }
  if (!context.mounted) return;
  await showModelSettingsEditor(
    context,
    LocalModelSettingsBackend(settings, support: support),
    language: language,
    onClearSelection: clearSelection,
    onManageCredentials: (context) async {
      await showProviderCredentials(
        context,
        settings.credentials,
        modelSettings: settings,
        language: language,
        onChanged: settings.refreshApiKeyProjection,
      );
    },
    onChatGpt: support
        ? null
        : (context) async {
            await showChatGptSettings(context, settings);
            return await settings.chatGpt.active() != null;
          },
  );
}

class LocalChatPanel extends StatefulWidget {
  const LocalChatPanel({
    super.key,
    required this.host,
    required this.conversationId,
    this.language = 'zh',
    this.showProcess = true,
    this.onVoice,
    this.voiceBusy = false,
    this.active = true,
    this.onModelSettings,
    this.onChooseModel,
    this.onExperienceCode,
    this.modelRevision = 0,
    this.audioOwner,
    this.dictationAudio,
    this.requestMicrophone,
    this.voiceSettings,
    this.onVoiceText,
    this.externalTaskBusy = false,
    this.onCancelExternalTask,
    this.header,
    this.phoneRun,
    this.floating,
  });

  /// Steps of phone tasks (`nova/phone/events`). A task's steps replace its
  /// single `device_run_task` result and join the group it sits in.
  final PhoneRunTracker? phoneRun;

  /// Floats over the message list only, never over the header, the model row
  /// or the composer, whatever the text size.
  final Widget? floating;
  final Widget? header;
  final AgentCoreHost host;
  final VoidCallback? onExperienceCode;
  final AudioOwner? audioOwner;
  final AudioPort? dictationAudio;
  final Future<bool> Function()? requestMicrophone;
  final VoiceSettings? voiceSettings;
  final Future<void> Function(String)? onVoiceText;
  final bool externalTaskBusy;
  final VoidCallback? onCancelExternalTask;
  final String conversationId;
  final String language;
  final VoidCallback? onModelSettings, onVoice, onChooseModel;
  final int modelRevision;
  final bool voiceBusy, active, showProcess;
  @override
  State<LocalChatPanel> createState() => LocalChatPanelState();
}

class LocalChatPanelState extends State<LocalChatPanel> {
  final input = TextEditingController();
  final scroll = ScrollController();
  final drafts = <String, String>{};
  final attachmentDrafts = <String, List<Map<String, dynamic>>>{};
  bool pickingAttachment = false;
  List<Map<String, dynamic>> get attachments =>
      attachmentDrafts.putIfAbsent(widget.conversationId, () => []);
  String? model;
  bool? hasCustomModel;
  bool get _experienceDefault =>
      widget.host.experienceModel != null && hasCustomModel == false;
  PhoneDictation? dictation;
  String _dictationBase = '';
  bool _showDictationHint = false;
  late final VoiceSettings _voiceSettings =
      widget.voiceSettings ?? VoiceSettings();
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
        readConfiguration: _voiceSettings.readForDictation,
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
    setState(() => _showDictationHint = false);
    _dictationBase = input.text;
    unawaited(dictation?.begin(widget.language));
  }

  void appendDraft(String text, {required String conversationId}) {
    final current = conversationId == widget.conversationId;
    final previous = current ? input.text : drafts[conversationId] ?? '';
    final next = [
      previous,
      text,
    ].where((part) => part.trim().isNotEmpty).join('\n\n');
    if (current) {
      prefill(next);
    } else {
      drafts[conversationId] = next;
    }
  }

  void prefillIfEmpty(String text) {
    if (input.text.isEmpty) prefill(text);
  }

  void prefill(String text) {
    unawaited(dictation?.cancel());
    input.text = text;
    if (mounted) setState(() {});
  }

  Future<void> _readModel() async {
    final host = widget.host;
    String? name;
    bool? selected;
    try {
      final value = await host.settings.read();
      name = value?.model;
      selected = value != null;
    } catch (_) {
      if (host.experienceModel != null) {
        try {
          selected = await host.settings.hasConversationSelection();
        } catch (_) {
          // An unreadable selection must not be shown as the default route.
        }
      }
    }
    if (mounted && identical(widget.host, host)) {
      setState(() {
        model = name;
        hasCustomModel = selected;
      });
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
    if (oldWidget.host != widget.host ||
        oldWidget.modelRevision != widget.modelRevision) {
      _readModel();
    }
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
        experienceDefault: widget.host.experienceModel != null,
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

  Future<void> _pickAttachment() async {
    final workspace = widget.host.tools?.registry.workspace;
    if (workspace == null || pickingAttachment) return;
    final origin = widget.conversationId;
    setState(() => pickingAttachment = true);
    try {
      final file = await FilePicker.pickFile(
        type: FileType.custom,
        allowedExtensions: ['pdf', 'xlsx', 'csv', 'txt', 'md', 'json'],
      );
      if (file == null) return;
      if (file.path == null || (file.lengthSync() ?? 0) > 25 * 1024 * 1024) {
        throw const FileSystemException('Document must be at most 25 MiB');
      }
      final saved = await workspace.importDocument(File(file.path!), file.name);
      attachmentDrafts.putIfAbsent(origin, () => []).add(saved);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              t(
                '无法导入文件。仅支持 PDF、XLSX、CSV、TXT、MD、JSON，每个不超过 25 MiB；不接受符号链接。',
                'Could not import. Use PDF, XLSX, CSV, TXT, MD or JSON, at most 25 MiB each; no symlinks.',
              ),
            ),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => pickingAttachment = false);
    }
  }

  bool get canSendSharedIdea =>
      mounted &&
      widget.active &&
      widget.conversationId == ConversationStore.mainId &&
      !widget.host.busy &&
      !widget.voiceBusy &&
      !widget.externalTaskBusy &&
      widget.onVoiceText == null &&
      !pickingAttachment &&
      dictation?.busy != true;

  Future<void> sendSharedIdea(String text) async {
    if (!canSendSharedIdea) return;
    atBottom = true;
    await widget.host.send(ConversationStore.mainId, text, approve: _approve);
  }

  Future<void> _send() async {
    if (pickingAttachment) return;
    final origin = widget.conversationId;
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
          if (mounted) {
            if (widget.conversationId == origin) {
              if (input.text.trim() == text) input.clear();
            } else if (drafts[origin]?.trim() == text) {
              drafts[origin] = '';
            }
          }
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
      if (host.activeConversationId == widget.conversationId) {
        host.cancel();
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              t(
                '另一项任务正在处理，草稿已保留，请稍后发送。',
                'Another task is running. Your draft is kept; send it when that task finishes.',
              ),
            ),
          ),
        );
      }
      return;
    }
    final draft = input.text.trim();
    final files = List<Map<String, dynamic>>.of(attachments);
    if (draft.isEmpty && files.isEmpty) return;
    final text = [
      if (draft.isNotEmpty) draft,
      if (files.isNotEmpty)
        '$localAttachmentHeader${files.map((file) => file['path']).join('\n')}',
    ].join('\n\n');
    atBottom = true;
    final before = (host.store.conversation(origin)['messages'] as List).length;
    input.clear();
    await host.send(origin, text, approve: _approve);
    // Preserve a message that could not reach the conversation store.
    final messages = host.store.conversation(origin)['messages'] as List;
    final stored = messages
        .skip(before)
        .any((m) => m['role'] == 'user' && m['content'] == text);
    if (stored) {
      attachmentDrafts[origin]?.removeWhere(files.contains);
      if (mounted) setState(() {});
    } else if (mounted && host.error != null) {
      if (widget.conversationId == origin) {
        if (input.text.isEmpty) input.text = draft;
      } else if ((drafts[origin] ?? '').isEmpty) {
        drafts[origin] = draft;
      }
    }
  }

  bool _experienceCodeError(String code) => const {
    'experience_enrollment_required',
    'experience_enrollment_inactive',
    'experience_invalid_token',
  }.contains(code);

  bool _modelSetupError(String code) =>
      _experienceCodeError(code) ||
      const {
        'model_settings_required',
        'provider_credential_missing',
        'invalid_model_settings',
        'model_http_401',
        'model_http_403',
        'experience_attachments_unsupported',
        'experience_quota_exceeded',
      }.contains(code);

  String _error(String code) => switch (code) {
    'experience_enrollment_required' => t(
      '兑换体验码或配置自己的模型，即可开始对话。',
      'Redeem an experience code or set up your own model to start chatting.',
    ),
    'experience_enrollment_inactive' || 'experience_invalid_token' => t(
      '体验资格已失效，可以重新兑换或配置自己的模型。',
      'Experience access has expired. Redeem a code or set up your own model.',
    ),
    'experience_attachments_unsupported' => t(
      '体验服务仅支持文字。请移除附件，或配置自己的模型。',
      'Experience chat is text only. Remove attachments or set up your own model.',
    ),
    'experience_quota_exceeded' => t(
      '体验额度已用完。',
      'The experience quota has been exhausted.',
    ),
    'experience_request_too_large' => t(
      '文字太长，请缩短后重试。',
      'Shorten the message and try again.',
    ),
    'experience_text_busy' => t(
      '体验服务正在处理另一条消息，请稍后重试。',
      'The experience service is processing another message. Try again shortly.',
    ),
    'experience_text_upstream_unavailable' ||
    'experience_gateway_unavailable' ||
    'experience_unavailable' => t(
      '体验服务暂时不可用，请稍后重试。',
      'The experience service is temporarily unavailable. Try again shortly.',
    ),
    'experience_rate_limited' => t(
      '体验服务暂时受限，请稍后重试。',
      'The experience service is temporarily rate limited. Try again shortly.',
    ),
    'provider_credential_missing' || 'invalid_model_settings' => t(
      '自配模型缺少有效密钥，请检查模型设置。',
      'Your model needs a valid key. Check the model settings.',
    ),
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
      '这次生成达到模型输出上限，请让 Nova 分步完成。',
      'This generation reached the model output limit. Ask Nova to build it in steps.',
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

  Future<void> _openArtifact(String pathOrId) async {
    try {
      await widget.host.tools!.registry.workspace!.openFile(pathOrId);
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

  /// A tool result as a timeline step, plus the card that opens the page or
  /// artifact it saved (shown after the run, never inside it).
  ({ToolStep step, Widget? card, String? taskId}) _toolResult(
    Map message, {
    Set<String>? seenPreviews,
    ToolTarget? target,
  }) {
    String status = '';
    String? preview, title, previewKey, completedReadPath, taskId;
    try {
      final result = jsonDecode(message['content'] as String) as Map;
      status = result['status'] as String? ?? '';
      final data = result['data'];
      if (message['tool_name'] == 'device_run_task') {
        final id = data is Map ? data['task_id'] : result['task_id'];
        if (id is String && id.isNotEmpty) taskId = id;
      }
      if (status == 'completed' &&
          message['tool_name'] == 'file_read' &&
          data is Map &&
          data['type'] != 'directory' &&
          data['path'] is String) {
        completedReadPath = data['path'] as String;
      }
      if (data is Map && message['tool_name'] != 'file_read') {
        if (data['artifact'] is Map) {
          final artifact = data['artifact'] as Map;
          preview = artifact['id'] as String?;
          previewKey = preview;
          title = artifact['title'] as String?;
        } else if (data['path'] is String &&
            RegExp(
              r'\.html?$',
              caseSensitive: false,
            ).hasMatch(data['path'] as String)) {
          preview = data['url'] as String? ?? data['path'] as String;
          previewKey = data['path'] as String;
          title = pathBaseName(data['path'] as String);
        }
      }
    } catch (_) {}
    final step = ToolStep(
      name: message['tool_name'] as String? ?? '',
      status: status,
      completedReadPath: completedReadPath,
      language: widget.language,
      target: target?.label,
      targetKey: target?.key,
    );
    if (status != 'completed' ||
        preview == null ||
        widget.host.tools?.registry.workspace == null ||
        (seenPreviews != null && !seenPreviews.add(previewKey!))) {
      return (step: step, card: null, taskId: taskId);
    }
    final openTarget = preview;
    return (
      step: step,
      taskId: taskId,
      card: Padding(
        padding: const EdgeInsets.only(bottom: 16),
        child: Material(
          color: Nova.cell,
          borderRadius: BorderRadius.circular(18),
          child: ListTile(
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(18),
            ),
            leading: const Icon(CupertinoIcons.doc_richtext, color: Nova.mint),
            title: Text(
              title ?? t('打开页面', 'Open page'),
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            subtitle: Text(t('已保存 · 点此打开', 'Saved · Tap to open')),
            trailing: const Icon(
              CupertinoIcons.arrow_up_right_square,
              size: 20,
            ),
            onTap: () => _openArtifact(openTarget),
          ),
        ),
      ),
    );
  }

  Widget _message(Map message) {
    final reasoning =
        widget.showProcess &&
            message['role'] == 'assistant' &&
            message['reasoning_content'] is String
        ? (message['reasoning_content'] as String).trim()
        : '';
    final text = message['content'] as String;
    if (text.isEmpty && reasoning.isEmpty && message['interrupted'] != true) {
      return const SizedBox.shrink();
    }
    final user = message['role'] == 'user';
    final process =
        !user &&
        message['interrupted'] != true &&
        (text.isEmpty ||
            message['tool_calls'] is List &&
                (message['tool_calls'] as List).isNotEmpty);
    return Padding(
      padding: EdgeInsets.only(bottom: process ? 8 : 24),
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
              if (reasoning.isNotEmpty)
                Padding(
                  padding: EdgeInsets.only(
                    bottom: text.isEmpty
                        ? 0
                        : process
                        ? 8
                        : 10,
                  ),
                  child: ThinkingBlock(
                    key: ValueKey('thinking:${message['time']}'),
                    text: reasoning,
                    language: widget.language,
                  ),
                ),
              if (text.isNotEmpty)
                user
                    ? SelectableText(
                        text,
                        style: const TextStyle(fontSize: 16, height: 1.5),
                      )
                    : DefaultTextStyle.merge(
                        style: const TextStyle(fontSize: 16, height: 1.6),
                        child: AssistantText(
                          text,
                          onArtifactLink: _openArtifact,
                        ),
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

  static Widget _floatOver(Widget? floating, Widget child) => floating == null
      ? child
      : Stack(
          fit: StackFit.expand,
          children: [
            child,
            Positioned.fill(child: floating),
          ],
        );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.host, ?widget.phoneRun]),
    builder: (context, _) {
      final host = widget.host;
      final runningHere =
          host.busy && host.activeConversationId == widget.conversationId;
      final conversation = host.store.conversation(widget.conversationId);
      final messages = conversation['messages'] as List;
      final messageWidgets = <Widget>[];
      final seenPreviews = <String>{};
      final toolSteps = <ToolStep>[];
      final targets = widget.showProcess
          ? toolTargetsByCallId(messages)
          : const <String, ToolTarget>{};
      // Call id of each entry of [toolSteps] (null when the result has none).
      final toolStepCallIds = <String?>[];
      // Phone task id of each entry of [toolSteps] (null for other tools).
      final toolStepTaskIds = <String?>[];
      var firstToolIndex = 0;
      // First [toolSteps] entry after the assistant message walked last: the
      // results of the round now being reached.
      var roundStart = 0;
      var finalReplyShown = false;
      // Widgets stored after the newest group that belong to the same run.
      var runInternalWidgets = 0;
      void flushTools() {
        if (toolSteps.isEmpty) return;
        final ordered = toolSteps.reversed.toList();
        final taskIds = toolStepTaskIds.reversed.toList();
        // A phone task is one group member per step it took, not one line.
        final steps = <ToolStep>[
          for (var i = 0; i < ordered.length; i++)
            ...(() {
              final run = taskIds[i] == null
                  ? null
                  : widget.phoneRun?.run(taskIds[i]!);
              final phoneSteps = run == null
                  ? null
                  : phoneRunToolSteps(run, widget.language);
              if (phoneSteps == null || phoneSteps.isEmpty) return [ordered[i]];
              // A task that did not complete keeps its own row after its
              // steps, so green steps never hide how it ended.
              return ordered[i].status == 'completed'
                  ? phoneSteps
                  : [...phoneSteps, ordered[i]];
            })(),
        ];
        messageWidgets.add(
          ToolStepGroup(
            key: ValueKey('tools:$firstToolIndex'),
            steps: steps,
            // While the run goes on, only its own plan messages follow it.
            running: runningHere && messageWidgets.length == runInternalWidgets,
          ),
        );
        toolSteps.clear();
        toolStepCallIds.clear();
        toolStepTaskIds.clear();
        roundStart = 0;
      }

      // The task still running has no stored result yet: its live steps close
      // the turn as one group. It stays until that result is stored, even after
      // the run's own `done` event, so the group does not blink out.
      final phone = widget.phoneRun;
      final liveRun = phone?.latest;
      if (runningHere &&
          host.activeTool == 'device_run_task' &&
          liveRun != null &&
          widget.showProcess &&
          liveRun.stepEvents.isNotEmpty &&
          !messages.any(
            (m) =>
                m is Map &&
                m['role'] == 'tool' &&
                m['tool_name'] == 'device_run_task' &&
                (m['content'] as String? ?? '').contains(liveRun.taskId),
          )) {
        messageWidgets.add(
          ToolStepGroup(
            key: ValueKey('phone-run:${liveRun.taskId}'),
            steps: phoneRunToolSteps(liveRun, widget.language),
            running: liveRun.active,
          ),
        );
        runInternalWidgets++;
      }

      // Walk backwards so each user turn keeps its last successful preview.
      for (var index = messages.length - 1; index >= 0; index--) {
        var message = messages[index] as Map;
        if (message['role'] == 'user') {
          seenPreviews.clear();
          finalReplyShown = false;
        }
        if (!widget.showProcess) {
          if (message['role'] == 'tool') continue;
          if (message['role'] == 'assistant') {
            final reply =
                !finalReplyShown &&
                (message['tool_calls'] is! List ||
                    (message['tool_calls'] as List).isEmpty) &&
                (message['content'] as String? ?? '').trim().isNotEmpty;
            if (reply) {
              finalReplyShown = true;
            } else if (message['interrupted'] == true) {
              message = {...message, 'content': '', 'reasoning_content': ''};
            } else {
              continue;
            }
          }
        }
        // Empty tool-call envelopes have no displayed boundary of their own.
        if (message['role'] == 'assistant' &&
            (message['content'] as String? ?? '').isEmpty &&
            (message['reasoning_content'] as String? ?? '').trim().isEmpty &&
            message['interrupted'] != true) {
          roundStart = toolSteps.length;
          continue;
        }
        // Reasoning that only introduces tool calls is the narration of
        // exactly those calls' steps, not a boundary of the run.
        final reasoning = message['reasoning_content'];
        if (toolSteps.isNotEmpty &&
            message['role'] == 'assistant' &&
            message['interrupted'] != true &&
            (message['content'] as String? ?? '').trim().isEmpty &&
            reasoning is String &&
            reasoning.trim().isNotEmpty) {
          final calls = message['tool_calls'];
          final ids = {
            if (calls is List)
              for (final call in calls)
                if (call is Map && call['id'] is String) call['id'] as String,
          };
          // Without call ids the message introduces the steps of its round.
          final introduced = [
            for (var i = 0; i < toolSteps.length; i++)
              if (ids.isEmpty
                  ? i >= roundStart
                  : toolStepCallIds[i] != null &&
                        ids.contains(toolStepCallIds[i]))
                i,
          ];
          if (introduced.isNotEmpty) {
            final narration = clipNarration(thinkingSummary(reasoning));
            for (final i in introduced) {
              if (toolSteps[i].narration == null) {
                toolSteps[i] = toolSteps[i].withNarration(
                  narration: narration,
                  reasoning: reasoning.trim(),
                );
              }
            }
            firstToolIndex = index;
            roundStart = toolSteps.length;
            continue;
          }
        }
        if (message['role'] == 'tool') {
          final callId = message['tool_call_id'];
          final result = _toolResult(
            message,
            seenPreviews: seenPreviews,
            target: callId is String ? targets[callId] : null,
          );
          toolSteps.add(result.step);
          toolStepCallIds.add(callId is String ? callId : null);
          toolStepTaskIds.add(result.taskId);
          firstToolIndex = index;
          if (result.card != null) {
            runInternalWidgets++;
            messageWidgets.add(result.card!);
          }
        } else {
          flushTools();
          roundStart = 0;
          if (message['role'] == 'assistant' &&
              message['interrupted'] != true &&
              (message['tool_calls'] is List &&
                      (message['tool_calls'] as List).isNotEmpty ||
                  (message['content'] as String? ?? '').isEmpty)) {
            runInternalWidgets++;
          }
          messageWidgets.add(_message(message));
        }
      }
      flushTools();
      final liveReasoning = host.reasoning.trim();
      return LayoutBuilder(
        builder: (context, constraints) {
          final compact = constraints.maxHeight < 260;
          return Column(
            children: [
              ?widget.header,
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
                                  _experienceDefault
                                      ? t('体验服务', 'Experience service')
                                      : model ??
                                            (hasCustomModel == true
                                                ? t('自配模型', 'Your model')
                                                : t('选择模型', 'Choose model')),
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
                  child: _floatOver(
                    widget.floating,
                    messages.isEmpty && !host.busy
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
                              ...messageWidgets.reversed,
                              if (host.pendingUserText.isNotEmpty &&
                                  host.activeConversationId ==
                                      widget.conversationId)
                                _message({
                                  'role': 'user',
                                  'content': host.pendingUserText,
                                }),
                              if (widget.showProcess &&
                                  host.draft.isNotEmpty &&
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
                                  label: !widget.showProcess
                                      ? t('正在回复', 'Waiting for reply')
                                      : switch (host.activeTool) {
                                          'file_write' || 'file_edit' => t(
                                            '正在编写文件',
                                            'Writing files',
                                          ),
                                          'shell_execute' => t(
                                            '正在执行命令',
                                            'Running a command',
                                          ),
                                          'file_read' => t(
                                            '正在读取文件',
                                            'Reading files',
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
                                                : t(
                                                    '正在回复',
                                                    'Writing the reply',
                                                  ),
                                          _ => t('正在处理', 'Working'),
                                        },
                                  summary:
                                      widget.showProcess && host.draft.isEmpty
                                      ? thinkingSummary(liveReasoning)
                                      : null,
                                  startedAt:
                                      host.turnStartedAt ?? DateTime.now(),
                                  language: widget.language,
                                  details: !widget.showProcess
                                      ? null
                                      : Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            if (liveReasoning.isNotEmpty)
                                              Padding(
                                                padding: const EdgeInsets.only(
                                                  bottom: 10,
                                                ),
                                                child: ConstrainedBox(
                                                  constraints:
                                                      const BoxConstraints(
                                                        maxHeight: 320,
                                                      ),
                                                  child: SingleChildScrollView(
                                                    child: SelectableText(
                                                      liveReasoning,
                                                      style: const TextStyle(
                                                        color: Nova.secondary,
                                                        fontSize: 13,
                                                        height: 1.5,
                                                      ),
                                                    ),
                                                  ),
                                                ),
                                              ),
                                            if (host.activeTool != null)
                                              Text(
                                                host.activeTool!,
                                                style: const TextStyle(
                                                  color: Nova.secondary,
                                                  fontSize: 12,
                                                ),
                                              ),
                                            if (host
                                                .activeToolArguments
                                                .isNotEmpty)
                                              ConstrainedBox(
                                                constraints:
                                                    const BoxConstraints(
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
                                            else if (liveReasoning.isEmpty)
                                              Text(
                                                host.draft.isEmpty
                                                    ? t(
                                                        '正在等待模型输出；收到内容后会显示在这里。',
                                                        'Waiting for model output; received content will appear here.',
                                                      )
                                                    : t(
                                                        '正在接收回复…',
                                                        'Receiving the reply…',
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
                ),
                if (host.error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 24,
                      vertical: 8,
                    ),
                    child: Wrap(
                      alignment: WrapAlignment.center,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          _error(host.error!),
                          style: const TextStyle(color: Nova.red, fontSize: 13),
                        ),
                        if (_experienceCodeError(host.error!) &&
                            widget.onExperienceCode != null)
                          TextButton(
                            onPressed: widget.onExperienceCode,
                            child: Text(t('兑换体验码', 'Redeem experience code')),
                          ),
                        if (widget.onChooseModel != null &&
                            _modelSetupError(host.error!))
                          TextButton(
                            onPressed: widget.onChooseModel,
                            child: Text(
                              host.experienceModel != null
                                  ? t('配置自己的模型', 'Set up your own model')
                                  : t('选择模型', 'Choose model'),
                            ),
                          ),
                      ],
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
                                  _voiceSettings,
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
                if (_showDictationHint && dictation?.busy != true)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 24,
                      vertical: 6,
                    ),
                    child: Text(
                      t(
                        '按住麦克风说话，松开后转成文字',
                        'Hold the microphone, then release to transcribe',
                      ),
                      style: const TextStyle(
                        color: Nova.secondary,
                        fontSize: 13,
                      ),
                    ),
                  ),
                if (attachments.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 20),
                    child: Wrap(
                      spacing: 8,
                      children: [
                        for (final file in attachments)
                          InputChip(
                            avatar: const Icon(Icons.attach_file, size: 16),
                            label: Text(
                              pathBaseName(file['path'] as String) ?? 'File',
                            ),
                            onDeleted: () =>
                                setState(() => attachments.remove(file)),
                          ),
                      ],
                    ),
                  ),
                if (canSendSharedIdea &&
                    attachments.isEmpty &&
                    emptyIdeaOpening(messages))
                  ValueListenableBuilder<TextEditingValue>(
                    valueListenable: input,
                    builder: (_, value, _) => value.text.isEmpty
                        ? SharedIdeaSuggestions(
                            language: widget.language,
                            compact: true,
                            onSend: (text) => unawaited(sendSharedIdea(text)),
                          )
                        : const SizedBox.shrink(),
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
                          if ((!_experienceDefault || host.experiencePersona) &&
                              widget.onVoiceText == null &&
                              host.tools?.registry.workspace != null)
                            IconButton(
                              tooltip: t(
                                '添加文件（最多 25 MiB）',
                                'Attach file (up to 25 MiB)',
                              ),
                              onPressed:
                                  pickingAttachment ||
                                      host.busy ||
                                      attachments.length >= 4
                                  ? null
                                  : _pickAttachment,
                              icon: const Icon(Icons.attach_file, size: 22),
                            ),
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
                                    setState(() => _showDictationHint = true),
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
                                  runningHere ||
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
                                      pickingAttachment ||
                                      (!runningHere &&
                                          !(widget.externalTaskBusy &&
                                              widget.onVoiceText == null) &&
                                          value.text.trim().isEmpty &&
                                          attachments.isEmpty)
                                  ? null
                                  : _send,
                              icon: Icon(
                                runningHere ||
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
