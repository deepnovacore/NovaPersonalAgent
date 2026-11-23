import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../ui/theme.dart';
import 'space_call_controller.dart';

/// Human-readable reason for a call that ended or could not start (§7).
String spaceCallReason(String? code, String Function(String zh, String en) t) =>
    switch (code) {
      null || 'stopped' => t('通话已结束', 'Call ended'),
      'microphone_denied' => t(
        '没有麦克风权限，请在系统设置中允许',
        'Microphone access is off. Allow it in system settings',
      ),
      'host_offline' => t('Host 离线', 'Host is offline'),
      'audio_busy' => t('麦克风正被听写占用', 'The microphone is busy with dictation'),
      'start_timeout' ||
      'join_timeout' => t('Host 没有及时接通', 'The Host did not answer in time'),
      'relay_media_unavailable' => t(
        '中继不支持语音通话',
        'The relay does not support voice calls',
      ),
      'voice_disabled' || 'owner_required' || 'owner_unassigned' => t(
        '这台设备不能在此 Space 通话',
        'This device cannot call in this Space',
      ),
      'voice_active' || 'taken_over' => t(
        'Host 上已有其他语音通话',
        'Another voice session is active on the Host',
      ),
      'conversation_read_only' || 'voice_mode_unavailable' => t(
        '这个对话不支持语音',
        'This conversation does not support voice',
      ),
      'epoch_rotated' => t(
        'Space 密钥已更新，请重新开始通话',
        'Space keys changed. Start the call again',
      ),
      'suspended' || 'audio_interrupted' => t(
        '通话被系统中断',
        'The call was interrupted by the system',
      ),
      _ => t('通话已断开', 'Call disconnected'),
    };

/// Call status, mute and hang-up in the Client Space chat. After any end it
/// shows the reason and a Retry; the typed composer below stays usable.
class SpaceCallPanel extends StatelessWidget {
  const SpaceCallPanel({
    super.key,
    required this.call,
    required this.language,
    required this.canRetry,
    required this.onRetry,
    required this.onDismiss,
  });
  final SpaceCallController call;
  final String language;
  final bool canRetry;
  final VoidCallback onRetry, onDismiss;
  String t(String zh, String en) => language == 'zh' ? zh : en;

  @override
  Widget build(BuildContext context) {
    final phase = call.phase;
    final ended = phase == SpaceCallPhase.ended;
    final status = switch (phase) {
      SpaceCallPhase.starting => t('正在呼叫 Host…', 'Calling the Host…'),
      SpaceCallPhase.connecting => t('正在接通…', 'Connecting…'),
      SpaceCallPhase.active =>
        call.muted ? t('通话中 · 已静音', 'In call · muted') : t('通话中', 'In call'),
      _ => spaceCallReason(call.endReason, t),
    };
    return Container(
      key: const ValueKey('space.call.panel'),
      margin: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: Nova.cell,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Nova.separator),
      ),
      child: Row(
        children: [
          Icon(
            ended ? CupertinoIcons.phone_down : CupertinoIcons.phone_fill,
            size: 20,
            color: ended ? Nova.secondary : Nova.mint,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              status,
              key: const ValueKey('space.call.status'),
              style: const TextStyle(fontSize: 14),
            ),
          ),
          if (phase == SpaceCallPhase.active)
            IconButton(
              key: const ValueKey('space.call.mute'),
              tooltip: call.muted ? t('取消静音', 'Unmute') : t('静音', 'Mute'),
              onPressed: () => call.setMuted(!call.muted),
              icon: Icon(
                call.muted
                    ? CupertinoIcons.mic_slash_fill
                    : CupertinoIcons.mic_fill,
                size: 20,
              ),
            ),
          if (!ended)
            IconButton(
              key: const ValueKey('space.call.end'),
              tooltip: t('挂断', 'Hang up'),
              onPressed: call.stop,
              icon: const Icon(
                CupertinoIcons.phone_down_fill,
                size: 20,
                color: Nova.red,
              ),
            )
          else ...[
            TextButton(
              key: const ValueKey('space.call.retry'),
              onPressed: canRetry ? onRetry : null,
              child: Text(t('重试', 'Retry')),
            ),
            IconButton(
              key: const ValueKey('space.call.dismiss'),
              tooltip: t('关闭', 'Close'),
              onPressed: onDismiss,
              icon: const Icon(CupertinoIcons.xmark, size: 18),
            ),
          ],
        ],
      ),
    );
  }
}
