import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../ui/theme.dart';

/// Full-page entry shown only when the relay cannot be reached at all.
class SpaceReconnectPage extends StatelessWidget {
  const SpaceReconnectPage({
    super.key,
    required this.reconnecting,
    required this.lastOkAt,
    required this.onRetry,
    this.onSwitchSpace,
    this.language = 'zh',
  });
  final String language;
  String t(String zh, String en) => language == 'zh' ? zh : en;
  final bool reconnecting;
  final DateTime? lastOkAt;
  final VoidCallback onRetry;
  final VoidCallback? onSwitchSpace;

  String _lastSync() {
    final at = lastOkAt?.toLocal();
    if (at == null) return t('尚未成功连接', 'Not connected yet');
    String two(int v) => v.toString().padLeft(2, '0');
    return '${t('上次同步', 'Last synced')} ${two(at.hour)}:${two(at.minute)}';
  }

  @override
  Widget build(BuildContext context) => Center(
    key: const ValueKey('space-reconnect-page'),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 56,
            height: 56,
            child: reconnecting
                ? const CupertinoActivityIndicator(radius: 16)
                : const Icon(
                    CupertinoIcons.wifi_exclamationmark,
                    size: 44,
                    color: Nova.secondary,
                  ),
          ),
          const SizedBox(height: 20),
          Text(
            reconnecting
                ? t('正在重新连接…', 'Reconnecting…')
                : t('暂时连不上你的空间', 'Can’t reach your Space right now'),
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          Text(
            reconnecting
                ? t(
                    '请稍候，连上后会自动补齐内容',
                    'Please wait; content catches up once connected',
                  )
                : t(
                    '请检查网络，连上后会自动补齐内容',
                    'Check your network; content catches up once connected',
                  ),
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 14,
              height: 1.5,
              color: Nova.secondary,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            _lastSync(),
            style: const TextStyle(fontSize: 12, color: Nova.secondary),
          ),
          const SizedBox(height: 24),
          FilledButton(
            onPressed: reconnecting ? null : onRetry,
            child: Text(t('重新连接', 'Reconnect')),
          ),
          if (onSwitchSpace != null)
            TextButton(
              onPressed: onSwitchSpace,
              child: Text(t('切换空间', 'Switch Space')),
            ),
        ],
      ),
    ),
  );
}
