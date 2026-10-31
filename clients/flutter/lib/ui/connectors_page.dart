import 'package:flutter/cupertino.dart';

import 'components.dart';
import 'theme.dart';

/// Projected state of the Feishu connector, resolved by the caller from the
/// `FeishuHost` so this page stays purely presentational and cheap to test.
typedef FeishuConnectorStatus = ({
  String label,
  String subtitle,
  NovaTone tone,
});

/// Settings surface listing everything Nova can read from the phone and apps.
/// Today that is Feishu (chat messages) and the phone calendar. Every connector
/// is read-only and the copy here is what users see before granting access.
class ConnectorsPage extends StatelessWidget {
  const ConnectorsPage({
    super.key,
    required this.language,
    required this.feishuStatus,
    required this.onOpenFeishu,
    this.onOpenSystem,
    this.systemTitle,
    this.systemSubtitle,
  });
  final String language;
  final FeishuConnectorStatus feishuStatus;
  final VoidCallback? onOpenFeishu;
  final VoidCallback? onOpenSystem;
  final String? systemTitle, systemSubtitle;

  String t(String zh, String en) => language == 'zh' ? zh : en;

  @override
  Widget build(BuildContext context) => NovaPage(
    title: t('连接器', 'Connectors'),
    body: SafeArea(
      child: ListView(
        padding: const EdgeInsets.only(top: 12, bottom: 24),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 18),
            child: Text(
              t(
                '飞书连接仅读取你授权的数据，用于近况、时间线和个人资料。',
                'The Feishu connector only reads authorized data for updates, timeline and personal info.',
              ),
              style: const TextStyle(
                color: Nova.secondary,
                fontSize: 13,
                height: 1.45,
              ),
            ),
          ),
          NovaSection(
            header: t('聊天与资料', 'CHAT & DOCUMENTS'),
            children: [
              NovaTile(
                leading: const NovaIconTile(CupertinoIcons.chat_bubble_2),
                title: t('飞书', 'Feishu'),
                subtitle: Text(feishuStatus.subtitle),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    NovaStatusChip(feishuStatus.label, tone: feishuStatus.tone),
                    const SizedBox(width: 6),
                    const CupertinoListTileChevron(),
                  ],
                ),
                onTap: onOpenFeishu,
              ),
            ],
          ),
          NovaSection(
            header: t('手机系统', 'SYSTEM'),
            children: [
              NovaTile(
                leading: const NovaIconTile(CupertinoIcons.calendar),
                title: systemTitle ?? t('日历与提醒事项', 'Calendar & reminders'),
                subtitle: Text(
                  systemSubtitle ??
                      t(
                        '授权后可读取，并按你的请求创建或更新日历与提醒事项。系统权限可在手机设置中管理。',
                        'With permission, Nova can read, create and update events and reminders at your request. Manage permissions in your phone settings.',
                      ),
                ),
                trailing: onOpenSystem == null
                    ? NovaStatusChip(t('系统授权', 'System permission'))
                    : const CupertinoListTileChevron(),
                onTap: onOpenSystem,
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
            child: Text(
              t(
                '你可以随时在相应服务或系统设置中关闭授权。更多连接器会逐步开放。',
                'You can revoke access in the service or system settings at any time. More connectors are coming.',
              ),
              style: const TextStyle(
                color: Nova.tertiary,
                fontSize: 12.5,
                height: 1.45,
              ),
            ),
          ),
        ],
      ),
    ),
  );
}
