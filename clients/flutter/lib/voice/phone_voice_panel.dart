import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import '../ui/theme.dart';
import 'phone_voice_session.dart';
import 'voice_call_visual.dart';

class PhoneVoicePanel extends StatefulWidget {
  const PhoneVoicePanel({
    super.key,
    required this.session,
    required this.onSettings,
    required this.onStart,
    this.language = 'zh',
    this.compact = false,
    this.startupError,
    this.onMinimize,
    this.onExpand,
  });
  final PhoneVoiceSession session;
  final VoidCallback onSettings, onStart;
  final VoidCallback? onMinimize, onExpand;
  final String language;
  final String? startupError;
  final bool compact;
  @override
  State<PhoneVoicePanel> createState() => _PhoneVoicePanelState();
}

class _PhoneVoicePanelState extends State<PhoneVoicePanel> {
  bool _ending = false;
  String? _actionError;
  PhoneVoiceSession get session => widget.session;
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;
  String get _status => switch (session.status) {
    'connecting' => t('正在连接', 'Connecting'),
    'thinking' => t('正在思考', 'Thinking'),
    'speaking' => t('正在回应', 'Speaking'),
    'muted' => t('麦克风已静音', 'Microphone muted'),
    'error' => t('通话已停止', 'Call stopped'),
    'listening' =>
      session.muted
          ? t('麦克风已静音', 'Microphone muted')
          : session.isUserSpeaking
          ? t('正在听你说', 'Listening to you')
          : t('我在听', 'Listening'),
    _ => t('准备好聊聊', 'Ready to talk'),
  };
  Future<void> _action(Future<void> Function() action) async {
    try {
      await action();
      if (mounted && _actionError != null) setState(() => _actionError = null);
    } catch (_) {
      if (mounted) {
        setState(
          () => _actionError = t(
            '操作未完成，请重试。',
            'Could not complete that action. Try again.',
          ),
        );
      }
    }
  }

  Future<void> _end() async {
    if (_ending) return;
    setState(() => _ending = true);
    try {
      await session.stop();
      if (mounted) widget.onMinimize?.call();
    } catch (_) {
      if (mounted) {
        setState(
          () => _actionError = t(
            '结束通话失败，请重试。',
            'Could not end the call. Try again.',
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _ending = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: session,
    builder: (context, _) => widget.compact ? _compact() : _full(),
  );

  Widget _compact() => Material(
    key: const ValueKey('voice-compact-bar'),
    color: const Color(0xffedf5f0),
    borderRadius: BorderRadius.circular(18),
    child: InkWell(
      borderRadius: BorderRadius.circular(18),
      onTap: widget.onExpand,
      child: Padding(
        padding: const EdgeInsets.only(left: 16, right: 4),
        child: Row(
          children: [
            const Icon(Icons.call_outlined, color: Nova.mint, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  'Nova · $_status',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Nova.text, fontSize: 13),
                ),
              ),
            ),
            IconButton(
              tooltip: t('结束通话', 'End call'),
              onPressed: _ending ? null : () => unawaited(_end()),
              icon: const Icon(Icons.call_end, color: Nova.red),
            ),
          ],
        ),
      ),
    ),
  );

  Widget _full() => AnnotatedRegion<SystemUiOverlayStyle>(
    value: SystemUiOverlayStyle.dark.copyWith(
      statusBarColor: Colors.transparent,
      systemNavigationBarColor: const Color(0xfffaf9f6),
      systemNavigationBarIconBrightness: Brightness.dark,
    ),
    child: _fullSurface(),
  );

  Widget _fullSurface() => Material(
    key: const ValueKey('voice-fullscreen'),
    color: const Color(0xfffaf9f6),
    child: SafeArea(
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(
              children: [
                IconButton(
                  tooltip: t('收起通话', 'Minimize call'),
                  onPressed: widget.onMinimize,
                  icon: const Icon(
                    Icons.keyboard_arrow_down,
                    color: Nova.secondary,
                  ),
                ),
                if (defaultTargetPlatform == TargetPlatform.android &&
                    session.active)
                  IconButton(
                    tooltip: t('悬浮通话', 'Float call'),
                    icon: const Icon(Icons.picture_in_picture_alt),
                    onPressed: () => _action(() async {
                      final shown = await session.minimizeToFloating();
                      if (!shown && mounted) {
                        setState(
                          () => _actionError = t(
                            '请允许 Nova 显示在其他应用上层，然后返回点击悬浮通话。',
                            'Allow Nova to display over other apps, then return and tap Float call.',
                          ),
                        );
                      }
                    }),
                  ),
                const Expanded(
                  child: Text(
                    'Nova',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: Nova.text,
                      fontSize: 17,
                      fontWeight: FontWeight.w400,
                    ),
                  ),
                ),
                IconButton(
                  tooltip: t('语音设置', 'Voice settings'),
                  onPressed: session.active || session.connecting
                      ? null
                      : widget.onSettings,
                  icon: const Icon(Icons.tune, size: 21),
                ),
              ],
            ),
          ),
          Expanded(
            child: LayoutBuilder(
              builder: (context, constraints) {
                final short = constraints.maxHeight < 360;
                return SingleChildScrollView(
                  key: const ValueKey('voice-call-content'),
                  padding: const EdgeInsets.symmetric(horizontal: 32),
                  child: Column(
                    children: [
                      SizedBox(height: short ? 0 : constraints.maxHeight * .10),
                      SizedBox(
                        height: short
                            ? 112
                            : (constraints.maxHeight * .43).clamp(190.0, 270.0),
                        width: double.infinity,
                        child: ValueListenableBuilder<double>(
                          valueListenable: session.audioLevel,
                          builder: (context, level, _) => VoiceCallVisual(
                            status: session.status,
                            inputLevel: session.muted ? 0 : level,
                            isUserSpeaking: session.isUserSpeaking,
                            isPlaying: session.isPlaying,
                          ),
                        ),
                      ),
                      Semantics(
                        liveRegion: true,
                        child: Text(
                          _status,
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            color: Nova.secondary,
                            fontSize: 13,
                            fontWeight: FontWeight.w400,
                            letterSpacing: .6,
                          ),
                        ),
                      ),
                      const SizedBox(height: 28),
                      SizedBox(
                        key: const ValueKey('voice-captions'),
                        height: short ? 116 : 164,
                        width: double.infinity,
                        child: SingleChildScrollView(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.center,
                            children: [
                              Text(
                                session.captionText.isEmpty
                                    ? t('实时字幕', 'Live captions')
                                    : session.captionIsUser
                                    ? t('你', 'You')
                                    : 'Nova',
                                style: const TextStyle(
                                  color: Nova.secondary,
                                  fontSize: 12,
                                  fontWeight: FontWeight.w400,
                                ),
                              ),
                              const SizedBox(height: 8),
                              Text(
                                session.captionText.isEmpty
                                    ? t(
                                        '说话后，文字会显示在这里。',
                                        'Your conversation will appear here.',
                                      )
                                    : session.captionText,
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                  fontSize: 20,
                                  fontWeight: FontWeight.w400,
                                  height: 1.65,
                                  color: session.captionText.isEmpty
                                      ? Nova.tertiary
                                      : Nova.text,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      if (session.error != null ||
                          _actionError != null ||
                          widget.startupError != null)
                        _notice(
                          _actionError ??
                              widget.startupError ??
                              t(
                                '请检查语音设置或网络，再重新通话。',
                                'Check voice settings or your connection, then try again.',
                              ),
                        ),
                      if (session.active && !session.supportsVoiceDelegation)
                        _notice(
                          t(
                            '本次通话无法发起任务，可在对话中继续。',
                            'Tasks are unavailable in this call. Continue in chat.',
                          ),
                        ),
                      if (session.delegates != null)
                        ListenableBuilder(
                          listenable: session.delegates!,
                          builder: (context, _) => _task(),
                        ),
                      const SizedBox(height: 12),
                    ],
                  ),
                );
              },
            ),
          ),
          _controls(),
        ],
      ),
    ),
  );

  Widget _notice(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: const TextStyle(color: Nova.secondary, fontSize: 12, height: 1.4),
    ),
  );

  Widget _control({
    required String label,
    required IconData icon,
    required VoidCallback? onPressed,
    bool selected = false,
    bool end = false,
  }) => Expanded(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton.filled(
          tooltip: label,
          onPressed: onPressed,
          style: IconButton.styleFrom(
            minimumSize: const Size(50, 50),
            side: end
                ? BorderSide.none
                : const BorderSide(color: Color(0xffe5e5de)),
            backgroundColor: end
                ? const Color(0xffb94f4c)
                : selected
                ? const Color(0xffdceee4)
                : const Color(0xfffdfcf9),
            foregroundColor: end ? Colors.white : Nova.text,
          ),
          icon: Icon(icon, size: 22),
        ),
        const SizedBox(height: 6),
        Text(
          label,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 11, color: Nova.secondary),
        ),
      ],
    ),
  );

  Widget _controls() => Padding(
    padding: const EdgeInsets.fromLTRB(36, 12, 36, 18),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _control(
              label: session.muted ? t('取消静音', 'Unmute') : t('静音', 'Mute'),
              icon: session.muted ? Icons.mic_off_outlined : Icons.mic_none,
              selected: session.muted,
              onPressed: session.active
                  ? () => unawaited(_action(session.toggleMute))
                  : null,
            ),
            _control(
              label: t('扬声器', 'Speaker'),
              icon: session.speaker
                  ? Icons.volume_up_outlined
                  : Icons.hearing_outlined,
              selected: session.speaker,
              onPressed: session.active
                  ? () => unawaited(_action(session.toggleSpeaker))
                  : null,
            ),
            _control(
              label: session.active || session.connecting
                  ? t('结束通话', 'End call')
                  : t('开始通话', 'Start call'),
              icon: session.active || session.connecting
                  ? Icons.call_end
                  : Icons.call_outlined,
              end: session.active || session.connecting,
              onPressed: _ending
                  ? null
                  : session.active || session.connecting
                  ? () => unawaited(_end())
                  : widget.onStart,
            ),
          ],
        ),
        const SizedBox(height: 4),
        TextButton(
          onPressed: session.active && session.isPlaying
              ? () => unawaited(_action(session.interruptPlayback))
              : null,
          child: AnimatedOpacity(
            opacity: session.active && session.isPlaying ? 1 : 0,
            duration: const Duration(milliseconds: 180),
            child: Text(t('打断播放', 'Interrupt playback')),
          ),
        ),
      ],
    ),
  );

  String _taskLabel(String? tool) => switch (tool) {
    'artifact_write' => t('正在生成作品', 'Creating your work'),
    'artifact_test' => t('正在检查作品', 'Checking your work'),
    'artifact_read' => t('正在读取作品', 'Reading your work'),
    'web_search' || 'web_fetch' => t('正在查找资料', 'Finding information'),
    'life_create' || 'life_update' => t('正在整理事项', 'Organizing your items'),
    _ => t('任务进行中', 'Task in progress'),
  };
  Widget _task() {
    final delegate = session.delegates!;
    if (!delegate.busy) return const SizedBox.shrink();
    return Material(
      color: const Color(0xffeef2ed),
      borderRadius: BorderRadius.circular(16),
      child: ExpansionTile(
        key: const ValueKey('voice-task'),
        shape: const Border(),
        collapsedShape: const Border(),
        leading: const Icon(
          Icons.auto_awesome_outlined,
          color: Nova.mint,
          size: 19,
        ),
        title: Text(
          _taskLabel(delegate.activeTool),
          style: const TextStyle(fontSize: 13),
        ),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        children: [
          if (delegate.activeTool != null)
            Text(
              '${t('工具', 'Tool')}: ${delegate.activeTool}',
              style: const TextStyle(fontSize: 12, color: Nova.secondary),
            ),
          if (delegate.draft.isNotEmpty)
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 120),
              child: SingleChildScrollView(
                child: Text(
                  delegate.draft,
                  style: const TextStyle(fontSize: 13),
                ),
              ),
            ),
          TextButton(
            onPressed: session.cancelDelegate,
            child: Text(t('停止任务', 'Stop task')),
          ),
        ],
      ),
    );
  }
}
