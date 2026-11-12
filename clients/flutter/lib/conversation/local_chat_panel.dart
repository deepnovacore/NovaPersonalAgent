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
import '../ui/reason_copy.dart';
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
import 'package:flutter/services.dart' show Clipboard, ClipboardData;

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

class _TurnActions {
  const _TurnActions({
    required this.copy,
    required this.feedback,
    required this.regenerate,
  });
  final String copy;
  // The message whose stored feedback the turn shows and toggles.
  final Map feedback;
  final bool regenerate;
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
    this.onTaskText,
    this.onOpenTask,
    this.externalTaskBusy = false,
    this.onCancelExternalTask,
    this.header,
    this.phoneRun,
    this.floating,
  });

  /// Steps of phone tasks (`nova/phone/events`). A task's steps replace its
  /// single `device_run_task` result and join the group it sits in.
  final PhoneRunTracker? phoneRun;

  /// Floats over the message list only, never over the header
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
  final Future<void> Function(String, ToolApproval)? onTaskText;
  final ValueChanged<String>? onOpenTask;
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
  bool? hasCustomModel;
  bool get _experienceDefault =>
      widget.host.experienceModel != null && hasCustomModel == false;
  PhoneDictation? dictation;
  String _dictationBase = '';
  bool _showDictationHint = false;
  late final VoiceSettings _voiceSettings =
      widget.voiceSettings ?? VoiceSettings();
  bool atBottom = true;
  String? _copiedKey;
  Timer? _copyTimer;
  Map<String, _TurnActions> _actions = const {};
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
    widget.host.store.addListener(_changed);
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
    bool? selected;
    try {
      final value = await host.settings.read();
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
      oldWidget.host.store.removeListener(_changed);
      widget.host.addListener(_changed);
      widget.host.store.addListener(_changed);
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
    _copyTimer?.cancel();
    widget.host.removeListener(_changed);
    widget.host.store.removeListener(_changed);
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
      widget.host.deviceHeldByOther?.call() != true &&
      widget.onVoiceText == null &&
      !pickingAttachment &&
      dictation?.busy != true;

  Future<void> sendSharedIdea(String text) async {
    if (!canSendSharedIdea) return;
    atBottom = true;
    await widget.host.send(ConversationStore.mainId, text, approve: _approve);
  }

  Future<void> _send() async {
    final host = widget.host;
    if (host.busy && host.activeConversationId == widget.conversationId) {
      host.cancel();
      return;
    }
    if (pickingAttachment) return;
    final origin = widget.conversationId;
    if (dictation?.busy == true) return;
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
    if (host.busy) {
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
    try {
      final sendTask = widget.onTaskText;
      if (sendTask == null) {
        await host.send(origin, text, approve: _approve);
      } else {
        await sendTask(text, _approve);
      }
    } catch (_) {
      if (!mounted) return;
      if (widget.conversationId == origin) {
        if (input.text.isEmpty) input.text = draft;
      } else if ((drafts[origin] ?? '').isEmpty) {
        drafts[origin] = draft;
      }
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              t(
                '暂未发送，草稿已保留，请稍后重试。',
                'Not sent. Your draft is preserved; try again shortly.',
              ),
            ),
          ),
        );
      }
      return;
    }
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
    'tool_denied' => t(
      '你拒绝了一步操作，这次就停在这里。要换种方式可以告诉我。',
      'You declined a step, so this stopped here. Tell me if you want to try another way.',
    ),
    'tool_outcome_unknown' when _lastTaskStopped => t(
      '任务停在了半路，已做的步骤都确认过；要重做请先在 App 里核对。',
      'The task stopped partway through. Dispatched steps are accounted for; check them in the app before running again.',
    ),
    'tool_outcome_unknown' => t(
      '这一步的结果没有确认，我没有重试。可以看下面的步骤核对。',
      'The result of this step was not confirmed, and I did not retry. Check the steps below.',
    ),
    'tool_failed' => t(
      '这一步没有完成，原因在下面的步骤里。',
      'This step did not complete. The reason is in the steps below.',
    ),
    'invalid_tool_arguments' => t(
      '任务参数不符合工具要求，这次调用没有执行。可以再说一次。',
      'The task arguments did not meet the tool requirements, so nothing was executed. You can ask again.',
    ),
    'tool_rejected' => t(
      '这一步没有执行，原因在下面的步骤里。',
      'This step was not executed. The reason is in the steps below.',
    ),
    'device_busy' => t(
      '手机正在执行另一个任务，等它结束后再试。',
      'The phone is running another task. Try again when it finishes.',
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
    Map? stepData;
    try {
      final result = jsonDecode(message['content'] as String) as Map;
      status = result['status'] as String? ?? '';
      final data = result['data'];
      // Blocked or refused calls carry their reason beside the status.
      stepData = data is Map ? data : result;
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
      data: stepData,
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

  bool get _lastTaskStopped {
    final messages =
        widget.host.store.conversation(widget.conversationId)['messages']
            as List;
    for (final message in messages.reversed) {
      if (message['role'] == 'user') break;
      if (message['tool_name'] != 'device_run_task') continue;
      try {
        final result = jsonDecode(message['content'] as String) as Map;
        return knownStepsStopped(
          result['data'] is Map ? result['data'] as Map : result,
        );
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  bool get _canRegenerate =>
      widget.active &&
      !widget.host.busy &&
      !widget.voiceBusy &&
      widget.onVoiceText == null &&
      !widget.externalTaskBusy &&
      widget.host.deviceHeldByOther?.call() != true;

  bool _latestReply(Map message) {
    final messages =
        widget.host.store.conversation(widget.conversationId)['messages']
            as List;
    final user = messages.lastIndexWhere((m) => m['role'] == 'user');
    final reply = messages.lastIndexWhere(
      (m) =>
          m['role'] == 'assistant' &&
          (m['content'] as String).isNotEmpty &&
          (m['tool_calls'] as List? ?? []).isEmpty,
    );
    return user >= 0 &&
        reply > user &&
        messages[reply]['time'] == message['time'];
  }

  Future<void> _regenerate(Map message) async {
    if (!_canRegenerate) return;
    final id = widget.conversationId;
    final messages = widget.host.store.conversation(id)['messages'] as List;
    final user = messages.lastIndexWhere((m) => m['role'] == 'user');
    final pendingDeviceCalls = <String>{};
    for (final m in messages.skip(user + 1)) {
      for (final call in m['tool_calls'] as List? ?? []) {
        if (call['function']?['name'] == 'device_run_task') {
          pendingDeviceCalls.add(call['id'] as String);
        }
      }
    }
    var device = false;
    for (final m in messages.skip(user + 1)) {
      if (m['tool_name'] != 'device_run_task') continue;
      pendingDeviceCalls.remove(m['tool_call_id']);
      device = true;
      try {
        final result = jsonDecode(m['content'] as String) as Map;
        final data = result['data'] is Map ? result['data'] as Map : result;
        if (result['status'] == 'failed' &&
            (data['effects'] == 'none' ||
                (data['dispatched_actions'] == 0 &&
                    data['unresolved_actions'] == 0 &&
                    data['action_in_flight'] == false))) {
          device = false;
          continue;
        }
      } catch (_) {}
      break;
    }
    if (device || pendingDeviceCalls.isNotEmpty) {
      final confirmed = await showLocalDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(t('重新生成？', 'Regenerate?')),
          content: Text(
            t(
              '重新生成会再执行一次手机操作，确定吗？',
              'Regenerating may execute the phone actions again. Continue?',
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: Text(t('取消', 'Cancel')),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(t('重新生成', 'Regenerate')),
            ),
          ],
        ),
      );
      if (confirmed != true) return;
    }
    if (!mounted ||
        id != widget.conversationId ||
        !_canRegenerate ||
        !_latestReply(message)) {
      return;
    }
    await widget.host.regenerate(
      id,
      message['time'] as String,
      approve: _approve,
      language: widget.language,
    );
  }

  Widget _action(
    IconData icon,
    String tooltip,
    VoidCallback? pressed, {
    bool selected = false,
  }) => SizedBox(
    width: 32,
    height: 32,
    child: IconButton(
      tooltip: tooltip,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints.tightFor(width: 32, height: 32),
      iconSize: 17,
      color: selected ? Nova.mint : Nova.tertiary,
      icon: Icon(icon),
      onPressed: pressed,
    ),
  );

  Future<void> _feedback(Map message, String value) async {
    await widget.host.store.setFeedback(
      widget.conversationId,
      message['time'] as String,
      message['feedback'] == value ? null : value,
    );
    if (mounted) setState(() {});
  }

  // One action row per turn, keyed by the time of the turn's last finished
  // assistant text. A late delegate result joins the turn that dispatched it.
  Map<String, _TurnActions> _turnActions(List messages, bool runningHere) {
    final turns = <List<Map>>[[]];
    final delegateTurns = <Object, int>{};
    for (final m in messages.cast<Map>()) {
      if (m['role'] == 'user') {
        turns.add([]);
        continue;
      }
      var turn = turns.length - 1;
      final delegate = m['delegate_id'];
      if (delegate != null && widget.showProcess) {
        if (m['delegate_status'] == 'dispatched') {
          delegateTurns.putIfAbsent(delegate, () => turn);
        } else {
          turn = delegateTurns[delegate] ?? turn;
        }
      }
      if (m['role'] == 'assistant' &&
          m['time'] is String &&
          (m['content'] as String? ?? '').trim().isNotEmpty &&
          (m['tool_calls'] as List? ?? []).isEmpty) {
        turns[turn].add(m);
      }
    }
    final latest = turns.length - 1;
    return {
      for (var i = 0; i < turns.length; i++)
        if (turns[i].isNotEmpty && !(i == latest && runningHere))
          turns[i].last['time'] as String: _TurnActions(
            copy: widget.showProcess
                ? turns[i].map((m) => m['content'] as String).join('\n\n')
                : turns[i].last['content'] as String,
            feedback: turns[i].lastWhere(
              (m) => m['feedback'] is String,
              orElse: () => turns[i].last,
            ),
            regenerate:
                widget.onTaskText == null &&
                i == latest &&
                turns[i].last['delegate_context'] == null &&
                _latestReply(turns[i].last),
          ),
    };
  }

  Widget _message(Map message) {
    final reasoning =
        widget.showProcess &&
            message['role'] == 'assistant' &&
            message['reasoning_content'] is String
        ? (message['reasoning_content'] as String).trim()
        : '';
    final rawText = message['content'] as String;
    final text =
        message['role'] == 'user' &&
            widget.host.store.conversation(
                  widget.conversationId,
                )['delegate_origin']
                is String
        ? delegateRequestLabel(rawText)
        : rawText;
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
    // Stored, finished text messages only: the streaming draft and the pending
    // user text carry no timestamp, and tool-call envelopes are process steps.
    final actions = user || process || text.isEmpty
        ? null
        : _actions[message['time']];
    final copyText = user
        ? (message['time'] is String
              ? text.split(localAttachmentHeader).first.trimRight()
              : '')
        : actions?.copy ?? '';
    final feedback = actions?.feedback['feedback'];
    final copyKey = '${message['time']}:${message['role']}';
    final copied = _copiedKey == copyKey;
    return Padding(
      padding: EdgeInsets.only(
        bottom: process
            ? 8
            : copyText.isEmpty
            ? 24
            : 0,
      ),
      child: Column(
        crossAxisAlignment: user
            ? CrossAxisAlignment.end
            : CrossAxisAlignment.stretch,
        children: [
          _messageBody(message, text, reasoning, user, process),
          if (copyText.isNotEmpty)
            Row(
              mainAxisSize: user ? MainAxisSize.min : MainAxisSize.max,
              children: [
                if (actions != null) ...[
                  if (actions.regenerate)
                    _action(
                      CupertinoIcons.arrow_clockwise,
                      t('重新生成', 'Regenerate'),
                      _canRegenerate
                          ? () => unawaited(_regenerate(message))
                          : null,
                    ),
                  _action(
                    feedback == 'like'
                        ? CupertinoIcons.hand_thumbsup_fill
                        : CupertinoIcons.hand_thumbsup,
                    t('赞', 'Like'),
                    () => unawaited(_feedback(actions.feedback, 'like')),
                    selected: feedback == 'like',
                  ),
                  _action(
                    feedback == 'dislike'
                        ? CupertinoIcons.hand_thumbsdown_fill
                        : CupertinoIcons.hand_thumbsdown,
                    t('踩', 'Dislike'),
                    () => unawaited(_feedback(actions.feedback, 'dislike')),
                    selected: feedback == 'dislike',
                  ),
                ],
                SizedBox(
                  width: 32,
                  height: 32,
                  child: IconButton(
                    key: ValueKey('copy:$copyKey'),
                    tooltip: copied ? t('已复制', 'Copied') : t('复制', 'Copy'),
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints.tightFor(
                      width: 32,
                      height: 32,
                    ),
                    iconSize: 17,
                    color: Nova.tertiary,
                    icon: Icon(
                      copied
                          ? CupertinoIcons.checkmark_alt
                          : CupertinoIcons.doc_on_doc,
                      color: copied ? Nova.mint : Nova.tertiary,
                    ),
                    onPressed: () => unawaited(_copyMessage(copyKey, copyText)),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }

  Future<void> _copyMessage(String key, String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    _copyTimer?.cancel();
    setState(() => _copiedKey = key);
    _copyTimer = Timer(const Duration(milliseconds: 1500), () {
      if (mounted) setState(() => _copiedKey = null);
    });
  }

  Widget _messageBody(
    Map message,
    String text,
    String reasoning,
    bool user,
    bool process,
  ) {
    return Align(
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
    listenable: Listenable.merge([
      widget.host,
      widget.host.store,
      ?widget.phoneRun,
    ]),
    builder: (context, _) {
      final host = widget.host;
      final runningHere =
          host.busy && host.activeConversationId == widget.conversationId;
      final conversation = host.store.conversation(widget.conversationId);
      final messages = conversation['messages'] as List;
      _actions = _turnActions(messages, runningHere);
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
            canConfirmChecked: (id) =>
                widget.host.tools?.journal.awaitsConfirmation(id) ?? false,
            onConfirmChecked: (id) async {
              await widget.host.tools?.journal.confirmDeviceTaskChecked(id);
              if (mounted) setState(() {});
            },
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
        final child = message['delegate_context'];
        if (child is String &&
            message['delegate_status'] is String &&
            widget.onOpenTask != null) {
          flushTools();
          messageWidgets.add(
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _message(message),
                TextButton.icon(
                  key: ValueKey(
                    'delegate.open:${message['delegate_id']}:${message['delegate_status']}',
                  ),
                  onPressed: () => widget.onOpenTask!(child),
                  icon: const Icon(
                    CupertinoIcons.arrow_up_right_square,
                    size: 17,
                  ),
                  label: Text(t('查看任务', 'View task')),
                ),
              ],
            ),
          );
          continue;
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
                if (host.error != null &&
                    (widget.onTaskText == null ||
                        _modelSetupError(host.error!) ||
                        host.error!.startsWith('experience_') ||
                        messages.lastOrNull?['interrupted'] != true ||
                        messages.lastOrNull?['error'] != host.error))
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
                          _error(
                            host.error == 'tool_rejected' &&
                                    host.errorDetail == 'invalid_tool_arguments'
                                ? host.errorDetail!
                                : host.error!,
                          ),
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
                          if (widget.externalTaskBusy)
                            IconButton(
                              tooltip: t('停止任务', 'Stop task'),
                              onPressed: widget.onCancelExternalTask,
                              icon: const Icon(CupertinoIcons.stop_fill),
                            ),
                          ValueListenableBuilder<TextEditingValue>(
                            valueListenable: input,
                            builder: (context, value, _) => IconButton.filled(
                              tooltip: runningHere
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
                                          value.text.trim().isEmpty &&
                                          attachments.isEmpty)
                                  ? null
                                  : _send,
                              icon: Icon(
                                runningHere
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
