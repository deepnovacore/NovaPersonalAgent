import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../personal/personal_store.dart';
import 'components.dart';
import 'theme.dart';

/// Optional summary surface for the Today header.
///
/// The generated brief list implements this so the page can report how many
/// brief entries belong to today without reading profile storage itself.
abstract interface class TimelineBriefSummary {
  /// Number of generated brief entries dated today (local day).
  int todayBriefCount(DateTime now);
}

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

const _monthsEn = [
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
const _weekdaysZh = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const _weekdaysEn = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _weekdayNamesZh = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
const _weekdayNamesEn = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

class TimelinePage extends StatelessWidget {
  const TimelinePage({
    super.key,
    required this.store,
    required this.language,
    this.onDiscuss,
    this.onStartTask,
    this.sourceTimeline,
    this.now,
  });
  final PersonalStore store;
  final String language;
  final ValueChanged<String>? onDiscuss;
  final ValueChanged<Map<String, dynamic>>? onStartTask;
  final Widget? sourceTimeline;

  /// Overrides "today" for deterministic rendering; defaults to the clock.
  final DateTime? now;
  String t(String zh, String en) => language == 'zh' ? zh : en;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: store,
    builder: (context, _) {
      final current = (now ?? DateTime.now()).toLocal();
      final life = store.snapshot?.object('life') ?? <String, dynamic>{};
      final groups = timelineGroups(life, now: current);
      final briefs = sourceTimeline is TimelineBriefSummary
          ? (sourceTimeline! as TimelineBriefSummary).todayBriefCount(current)
          : 0;
      return DecoratedBox(
        decoration: novaTimelineBackground,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
          children: [
            _todayHeader(current, life, briefs),
            if (sourceTimeline != null) ...[
              _sectionLabel(
                t('晨间简报', 'Morning brief'),
                labelKey: const ValueKey('timeline-morning-brief-label'),
                color: novaTimelineAccent,
              ),
              Padding(
                padding: const EdgeInsets.only(bottom: 26),
                child: sourceTimeline,
              ),
            ],
            _sectionLabel(
              t('我的安排', 'My plans'),
              labelKey: const ValueKey('timeline-plans-label'),
            ),
            ..._groupSection(context, groups),
          ],
        ),
      );
    },
  );

  String _dayKey(DateTime date) =>
      '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';

  int _todayPlans(Map<String, dynamic> life, DateTime now) {
    final today = _dayKey(now);
    var count = 0;
    for (final value in life['todos'] as List? ?? []) {
      if (value is! Map) continue;
      if (value['status'] == 'done' || value['status'] == 'cancelled') {
        continue;
      }
      if (value['due'] == today) count++;
    }
    return count;
  }

  String _todayDateLabel(DateTime date) => t(
    '${date.month}月${date.day}日 · ${_weekdayNamesZh[date.weekday - 1]}',
    '${_monthsEn[date.month - 1]} ${date.day} · ${_weekdayNamesEn[date.weekday - 1]}',
  );

  String _todaySummary(Map<String, dynamic> life, DateTime now, int briefs) {
    final plans = _todayPlans(life, now);
    final parts = <String>[
      if (plans > 0) t('$plans 个安排', '$plans ${plans == 1 ? 'plan' : 'plans'}'),
      if (briefs > 0)
        t(
          '$briefs 条晨间简报',
          '$briefs ${briefs == 1 ? 'morning brief' : 'morning briefs'}',
        ),
    ];
    if (parts.isEmpty) return t('今天暂无安排', 'No plans today');
    return parts.join(' · ');
  }

  Widget _todayHeader(
    DateTime current,
    Map<String, dynamic> life,
    int briefs,
  ) => Padding(
    key: const ValueKey('timeline-today-header'),
    padding: const EdgeInsets.only(top: 6, bottom: 22),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          t('今天', 'Today'),
          style: const TextStyle(
            color: Nova.mint,
            fontSize: 12,
            fontWeight: FontWeight.w700,
            letterSpacing: .4,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          _todayDateLabel(current),
          key: const ValueKey('timeline-today-date'),
          style: const TextStyle(
            color: Nova.text,
            fontSize: 26,
            height: 1.25,
            fontWeight: FontWeight.w600,
            letterSpacing: -.2,
          ),
        ),
        const SizedBox(height: 7),
        Text(
          _todaySummary(life, current, briefs),
          key: const ValueKey('timeline-today-summary'),
          style: const TextStyle(
            color: Nova.secondary,
            fontSize: 13,
            height: 1.45,
          ),
        ),
      ],
    ),
  );

  /// Small section heading shared by the generated brief and the local plans.
  Widget _sectionLabel(
    String label, {
    required Key labelKey,
    Color color = Nova.secondary,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Row(
      children: [
        Container(
          width: 3,
          height: 12,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            label,
            key: labelKey,
            style: const TextStyle(
              color: Nova.secondary,
              fontSize: 13,
              fontWeight: FontWeight.w600,
              letterSpacing: .2,
            ),
          ),
        ),
      ],
    ),
  );

  List<Widget> _groupSection(
    BuildContext context,
    List<Map<String, dynamic>> groups,
  ) => [
    if (groups.isEmpty)
      EmptyNote(t('还没有安排', 'No plans yet'), icon: CupertinoIcons.clock)
    else
      for (final group in groups) ...[
        _groupHeading(group),
        Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: _group(context, group),
        ),
      ],
  ];

  Widget _groupHeading(Map<String, dynamic> group) {
    final id = group['id'] as String;
    final color = id == 'current'
        ? Nova.mint
        : id == 'overdue'
        ? Nova.amber
        : Nova.tertiary;
    return Padding(
      padding: const EdgeInsets.only(top: 10, bottom: 10),
      child: Row(
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              switch (id) {
                'overdue' => t('已逾期', 'Past due'),
                'current' => t('今天', 'Today'),
                'soon' => t('接下来 7 天', 'Next 7 days'),
                'later' => t('之后', 'Later'),
                'waiting' => t('等待中', 'Waiting'),
                'completed' => t('已完成', 'Completed'),
                _ => t('未定日期', 'Unscheduled'),
              },
              style: const TextStyle(
                color: Nova.secondary,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }

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
                          padding: const EdgeInsets.only(left: 26, bottom: 14),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Padding(
                                padding: const EdgeInsets.only(bottom: 8),
                                child: Row(
                                  children: [
                                    Flexible(
                                      child: Container(
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 10,
                                          vertical: 4,
                                        ),
                                        decoration: BoxDecoration(
                                          color: Nova.ink,
                                          borderRadius: BorderRadius.circular(
                                            999,
                                          ),
                                          border: Border.all(
                                            color: Nova.separator,
                                          ),
                                        ),
                                        child: Text(
                                          _dateLabel(entry.key),
                                          key: ValueKey(
                                            'timeline-date-$id-${entry.key}',
                                          ),
                                          style: TextStyle(
                                            color: color,
                                            fontSize: 13,
                                            fontWeight: FontWeight.w600,
                                            height: 1.35,
                                          ),
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              for (final row in entry.value)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 10),
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
            padding: const EdgeInsets.only(bottom: 10),
            child: _card(context, row),
          ),
      ],
    );
  }

  String _dateLabel(String value) {
    final date = DateTime.tryParse(value);
    if (date == null) return value;
    return t(
      '${date.year}年${date.month}月${date.day}日 · ${_weekdaysZh[date.weekday - 1]}',
      '${_monthsEn[date.month - 1]} ${date.day}, ${date.year} · ${_weekdaysEn[date.weekday - 1]}',
    );
  }

  Widget _card(
    BuildContext context,
    Map<String, dynamic> row, {
    bool showDate = true,
  }) {
    final done = row['status'] == 'done';
    final note = (row['note'] as String? ?? '').trim();
    final due = row['due'] as String?;
    final Widget? subtitle = note.isNotEmpty
        ? Text(
            note,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: Nova.secondary,
              fontSize: 12.5,
              height: 1.4,
            ),
          )
        : !showDate || due == null
        ? null
        : Text(
            due,
            style: const TextStyle(color: Nova.secondary, fontSize: 12),
          );
    return Material(
      color: Nova.ink,
      elevation: 1,
      shadowColor: const Color(0x18203248),
      borderRadius: BorderRadius.circular(18),
      clipBehavior: Clip.antiAlias,
      child: ListTile(
        contentPadding: const EdgeInsets.fromLTRB(12, 6, 8, 6),
        minVerticalPadding: 8,
        leading: Icon(
          done ? CupertinoIcons.checkmark_circle_fill : CupertinoIcons.circle,
          color: done ? Nova.mint : Nova.tertiary,
          size: 20,
        ),
        title: Text(
          row['title'] as String? ?? '',
          style: const TextStyle(
            fontSize: 16,
            height: 1.3,
            fontWeight: FontWeight.w500,
          ),
        ),
        subtitle: subtitle,
        trailing:
            onStartTask != null &&
                !['done', 'cancelled'].contains(row['status'])
            ? IconButton(
                tooltip: t('处理此事', 'Work on this'),
                onPressed: () => onStartTask!(row),
                icon: const Icon(
                  CupertinoIcons.arrow_up_right_square,
                  color: Nova.mint,
                ),
              )
            : null,
        onTap: () => showModalBottomSheet<void>(
          context: context,
          useSafeArea: true,
          isScrollControlled: true,
          builder: (sheet) => ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(sheet).height * .85,
            ),
            child: SingleChildScrollView(
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
                  if (onStartTask != null &&
                      !['done', 'cancelled'].contains(row['status']))
                    Padding(
                      padding: const EdgeInsets.only(top: 20),
                      child: FilledButton(
                        onPressed: () {
                          Navigator.pop(sheet);
                          onStartTask!(row);
                        },
                        child: Text(t('处理此事', 'Work on this')),
                      ),
                    ),
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
      ),
    );
  }
}
