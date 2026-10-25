import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'theme.dart';

class MyOverview extends StatelessWidget {
  const MyOverview({
    super.key,
    required this.life,
    required this.draft,
    required this.onOpen,
    required this.onSettings,
    this.generatedProfile,
    this.language = 'zh',
  });
  final Map<String, dynamic> life, draft;
  final void Function(int) onOpen;
  final VoidCallback onSettings;
  final Widget? generatedProfile;
  final String language;
  String t(String zh, String en) => language == 'zh' ? zh : en;

  @override
  Widget build(BuildContext context) {
    final profile = life['profile'] as Map? ?? {};
    final confirmed = profile['about'] as String? ?? '';
    final edited = (profile['version'] as int? ?? 0) > 0;
    final about = confirmed.isNotEmpty
        ? confirmed
        : edited
        ? ''
        : draft['about'] as String? ?? '';
    List<Map> rows(String key) =>
        (life[key] as List? ?? [])
            .whereType<Map>()
            .where((r) => r['status'] == 'active')
            .toList()
          ..sort(
            (a, b) => '${b['updated_at'] ?? ''}'.compareTo(
              '${a['updated_at'] ?? ''}',
            ),
          );
    final goals = rows('goals'), ideas = rows('ideas');
    return DecoratedBox(
      decoration: const BoxDecoration(color: Color(0xfff5f6f8)),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
        children: [
          Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Nova.separator),
            ),
            padding: const EdgeInsets.fromLTRB(18, 8, 18, 18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Container(width: 3, height: 17, color: novaTimelineAccent),
                    const SizedBox(width: 8),
                    Expanded(
                      child: TextButton(
                        style: TextButton.styleFrom(
                          alignment: Alignment.centerLeft,
                          foregroundColor: Nova.text,
                          padding: EdgeInsets.zero,
                        ),
                        onPressed: () => onOpen(5),
                        child: Text(
                          t('个人资料', 'Profile'),
                          style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: onSettings,
                      style: TextButton.styleFrom(
                        foregroundColor: Nova.secondary,
                      ),
                      child: Text(t('设置', 'Settings')),
                    ),
                  ],
                ),
                const Divider(height: 12),
                const SizedBox(height: 10),
                if (about.isNotEmpty) ...[
                  Text(
                    about,
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 14, height: 1.7),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    confirmed.isNotEmpty
                        ? t('由你填写', 'Written by you')
                        : t('Nova 整理 · 待确认', 'Drafted by Nova · For review'),
                    style: const TextStyle(fontSize: 11, color: Nova.secondary),
                  ),
                ] else if (!edited && generatedProfile != null)
                  generatedProfile!
                else
                  Text(
                    t('还没有个人介绍', 'No introduction yet'),
                    style: const TextStyle(fontSize: 14, color: Nova.secondary),
                  ),
                const SizedBox(height: 12),
                InkWell(
                  onTap: () => onOpen(5),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            t('查看与编辑', 'View and edit'),
                            style: const TextStyle(
                              fontSize: 12,
                              color: novaTimelineAccent,
                            ),
                          ),
                        ),
                        const Icon(
                          CupertinoIcons.arrow_right,
                          size: 15,
                          color: novaTimelineAccent,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Nova.separator),
            ),
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 4),
            child: Column(
              children: [
                _section(
                  t('目标', 'Goals'),
                  t('暂无进行中的目标', 'No active goals'),
                  4,
                  goals,
                  CupertinoIcons.flag,
                  novaTimelineAccent,
                ),
                const Divider(height: 1),
                _section(
                  t('想法', 'Ideas'),
                  t('暂无记录', 'Nothing saved yet'),
                  3,
                  ideas,
                  CupertinoIcons.lightbulb,
                  Nova.amber,
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              TextButton.icon(
                onPressed: () => onOpen(2),
                style: TextButton.styleFrom(foregroundColor: Nova.secondary),
                icon: const Icon(CupertinoIcons.check_mark_circled, size: 17),
                label: Text(t('全部待办', 'To-dos')),
              ),
              TextButton.icon(
                onPressed: () => onOpen(1),
                style: TextButton.styleFrom(foregroundColor: Nova.secondary),
                icon: const Icon(CupertinoIcons.news, size: 17),
                label: Text(t('资讯', 'Feeds')),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _section(
    String label,
    String empty,
    int destination,
    List<Map> rows,
    IconData icon,
    Color accent,
  ) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      InkWell(
        onTap: () => onOpen(destination),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Row(
            children: [
              Icon(icon, color: accent, size: 19),
              const SizedBox(width: 10),
              Text(
                label,
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(
                  rows.isEmpty
                      ? empty
                      : t('${rows.length} 项', '${rows.length} items'),
                  textAlign: TextAlign.right,
                  style: const TextStyle(fontSize: 12, color: Nova.secondary),
                ),
              ),
              const SizedBox(width: 8),
              const Icon(
                CupertinoIcons.chevron_right,
                size: 12,
                color: Nova.tertiary,
              ),
            ],
          ),
        ),
      ),
      for (final row in rows.take(2))
        InkWell(
          onTap: () => onOpen(destination),
          child: Padding(
            padding: const EdgeInsets.only(left: 29, bottom: 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${row['title'] ?? ''}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 14, height: 1.55),
                ),
                if ('${row['note'] ?? ''}'.trim().isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    '${row['note']}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: Nova.secondary),
                  ),
                ],
              ],
            ),
          ),
        ),
    ],
  );
}
