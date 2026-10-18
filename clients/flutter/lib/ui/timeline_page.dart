import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../personal/personal_store.dart';
import 'components.dart';
import 'theme.dart';

/// The same complete due-date grouping as Nova's desktop Timeline.
List<Map<String, dynamic>> timelineGroups(
  Map<String, dynamic> life, {
  DateTime? now,
}) {
  final date = (now ?? DateTime.now()).toLocal();
  String day(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
  final today = day(date),
      week = day(DateTime(date.year, date.month, date.day + 7));
  final groups = {
    for (final id in [
      'overdue',
      'current',
      'soon',
      'later',
      'waiting',
      'unscheduled',
      'completed',
    ])
      id: <Map<String, dynamic>>[],
  };
  for (final value in life['todos'] as List? ?? []) {
    final row = Map<String, dynamic>.from(value as Map);
    if (row['status'] == 'cancelled') continue;
    final due = row['due'] as String?;
    final id = row['status'] == 'done'
        ? 'completed'
        : due != null
        ? (due.compareTo(today) < 0
              ? 'overdue'
              : due == today
              ? 'current'
              : due.compareTo(week) <= 0
              ? 'soon'
              : 'later')
        : row['status'] == 'waiting'
        ? 'waiting'
        : 'unscheduled';
    groups[id]!.add(row);
  }
  return [
    for (final entry in groups.entries)
      if (entry.value.isNotEmpty)
        {
          'id': entry.key,
          'items': entry.value
            ..sort(
              (a, b) => '${a['due'] ?? ''}'.compareTo('${b['due'] ?? ''}'),
            ),
        },
  ];
}

class TimelinePage extends StatelessWidget {
  const TimelinePage({
    super.key,
    required this.store,
    required this.language,
    this.onDiscuss,
    this.sourceTimeline,
  });
  final PersonalStore store;
  final String language;
  final ValueChanged<String>? onDiscuss;
  final Widget? sourceTimeline;
  String t(String zh, String en) => language == 'zh' ? zh : en;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: store,
    builder: (context, _) {
      final groups = timelineGroups(store.snapshot?.object('life') ?? {});
      return ListView(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
        children: [
          ?sourceTimeline,
          Padding(
            padding: const EdgeInsets.only(bottom: 22),
            child: Text(
              t('安排与进展', 'Plans and progress'),
              style: const TextStyle(color: Nova.secondary, fontSize: 15),
            ),
          ),
          if (groups.isEmpty)
            EmptyNote(t('还没有安排', 'No plans yet'), icon: CupertinoIcons.clock),
          for (final group in groups) ...[
            Padding(
              padding: const EdgeInsets.only(top: 12, bottom: 10),
              child: Text(
                switch (group['id']) {
                  'overdue' => t('已过截止', 'Past due'),
                  'current' => t('今天', 'Today'),
                  'soon' => t('接下来 7 天', 'Next 7 days'),
                  'later' => t('之后', 'Later'),
                  'waiting' => t('等待中', 'Waiting'),
                  'completed' => t('已完成', 'Completed'),
                  _ => t('尚未安排', 'Unscheduled'),
                },
                style: const TextStyle(
                  color: Nova.secondary,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            _group(context, group),
          ],
        ],
      );
    },
  );

  Widget _group(BuildContext context, Map<String, dynamic> group) {
    final rows = group['items'] as List<Map<String, dynamic>>;
    final dates = <String, List<Map<String, dynamic>>>{};
    for (final row in rows) {
      final due = row['due'] as String?;
      if (due != null) dates.putIfAbsent(due, () => []).add(row);
    }
    final id = group['id'] as String;
    final color = id == 'current'
        ? Nova.mint
        : id == 'overdue'
        ? Nova.amber
        : Nova.tertiary;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (dates.isNotEmpty)
          Stack(
            key: ValueKey('timeline-axis-$id'),
            children: [
              Positioned(
                left: 5,
                top: 10,
                bottom: 0,
                child: Container(
                  key: ValueKey('timeline-line-$id'),
                  width: 1,
                  color: Nova.separator,
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final entry in dates.entries)
                    Stack(
                      children: [
                        Positioned(
                          left: 5,
                          top: 10,
                          child: Container(
                            width: 21,
                            height: 1,
                            color: Nova.separator,
                          ),
                        ),
                        Positioned(
                          left: 1,
                          top: 6,
                          child: Container(
                            key: ValueKey('timeline-marker-$id-${entry.key}'),
                            width: 9,
                            height: 9,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: id == 'current' ? Nova.mint : Nova.ink,
                              border: Border.all(color: color, width: 2),
                            ),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.only(left: 26, bottom: 16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Padding(
                                padding: const EdgeInsets.only(bottom: 10),
                                child: Text(
                                  _dateLabel(entry.key),
                                  key: ValueKey(
                                    'timeline-date-$id-${entry.key}',
                                  ),
                                  style: TextStyle(
                                    color: color,
                                    fontSize: 12,
                                    fontWeight: FontWeight.w600,
                                    height: 1.6,
                                  ),
                                ),
                              ),
                              for (final row in entry.value)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 12),
                                  child: _card(context, row, showDate: false),
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            ],
          ),
        for (final row in rows.where((row) => row['due'] == null))
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: _card(context, row),
          ),
      ],
    );
  }

  String _dateLabel(String value) {
    final date = DateTime.tryParse(value);
    if (date == null) return value;
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const weekdaysZh = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const weekdaysEn = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return t(
      '${date.year}年${date.month}月${date.day}日 · ${weekdaysZh[date.weekday - 1]}',
      '${months[date.month - 1]} ${date.day}, ${date.year} · ${weekdaysEn[date.weekday - 1]}',
    );
  }

  Widget _card(
    BuildContext context,
    Map<String, dynamic> row, {
    bool showDate = true,
  }) => Material(
    color: Nova.cell,
    borderRadius: BorderRadius.circular(18),
    child: ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      leading: Icon(
        row['status'] == 'done'
            ? CupertinoIcons.checkmark_circle_fill
            : CupertinoIcons.circle,
        color: row['status'] == 'done' ? Nova.mint : Nova.tertiary,
        size: 20,
      ),
      title: Text(
        row['title'] as String? ?? '',
        style: const TextStyle(fontSize: 16),
      ),
      subtitle: !showDate || row['due'] == null
          ? null
          : Text(
              row['due'] as String,
              style: const TextStyle(color: Nova.secondary, fontSize: 12),
            ),
      onTap: () => showModalBottomSheet<void>(
        context: context,
        useSafeArea: true,
        isScrollControlled: true,
        builder: (sheet) => Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                row['title'] as String? ?? '',
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 12),
              if ((row['note'] as String? ?? '').isNotEmpty)
                SelectableText(row['note'] as String),
              if (onDiscuss != null)
                Padding(
                  padding: const EdgeInsets.only(top: 20),
                  child: TextButton(
                    onPressed: () {
                      Navigator.pop(sheet);
                      onDiscuss!(
                        t('一起看看这个安排：', 'Let’s discuss this plan: ') +
                            (row['title'] as String? ?? ''),
                      );
                    },
                    child: Text(t('在对话中讨论', 'Discuss in chat')),
                  ),
                ),
            ],
          ),
        ),
      ),
    ),
  );
}
