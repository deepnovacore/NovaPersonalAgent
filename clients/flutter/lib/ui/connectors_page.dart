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
  });
  final String language;
  final FeishuConnectorStatus feishuStatus;
  final VoidCallback onOpenFeishu;

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
                'Nova 只读取你授权的数据，用于近况、时间线和个人资料；不会修改、发送或代替你操作。',
                'Nova only reads the data you authorize for updates, timeline and personal info. It never edits, sends or acts on your behalf.',
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
                title: t('日历与提醒事项', 'Calendar & reminders'),
                subtitle: Text(
                  t(
                    '首次在聊天中用到时询问权限；Nova 只读取，不会修改。',
                    'Permission is requested the first time chat needs it. Nova only reads; it never edits.',
                  ),
                ),
                trailing: NovaStatusChip(t('只读', 'Read-only')),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
            child: Text(
              t(
                '所有连接均为只读授权，可随时关闭。更多连接器会逐步开放。',
                'All access is read-only and can be turned off at any time. More connectors are coming.',
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
