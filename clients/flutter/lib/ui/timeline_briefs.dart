import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'theme.dart';
import 'components.dart';
import 'timeline_page.dart';
import '../context/timeline_time.dart';

String timelineSourceTime(String value, String language) {
  final date = DateTime.parse(value).toLocal();
  final time =
      '${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
  return language == 'zh'
      ? '${date.year}年${date.month}月${date.day}日 $time'
      : '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')} $time';
}

/// The same dated brief cards for local publications and Host snapshots.
class TimelineBriefs extends StatefulWidget implements TimelineBriefSummary {
  const TimelineBriefs({
    super.key,
    required this.entries,
    this.language = 'zh',
    this.availableEvidenceIds = const [],
    this.onOpenSources,
    this.onAction,
  });
  final List<Map> entries;
  final String language;
  final List availableEvidenceIds;
  final void Function(Map entry)? onOpenSources;

  /// Called with the text to put in the chat composer; it is never sent automatically.
  final void Function(String draft)? onAction;
  @override
  int todayBriefCount(DateTime now) => entries.where((entry) {
    final date = DateTime.tryParse(
      '${effectiveTimelineAnchor(entry['time'] as Map?)['anchor_date'] ?? entry['observed_at'] ?? ''}',
    )?.toLocal();
    return entry['brief'] is Map &&
        date != null &&
        DateUtils.isSameDay(date, now);
  }).length;
  @override
  State<TimelineBriefs> createState() => _TimelineBriefsState();
}

class _TimelineBriefsState extends State<TimelineBriefs> {
  int visible = 8;
  List<Map> get entries => widget.entries;
  String get language => widget.language;
  List get availableEvidenceIds => widget.availableEvidenceIds;
  void Function(Map entry)? get onOpenSources => widget.onOpenSources;
  void Function(String draft)? get onAction => widget.onAction;
  String _signature(TimelineBriefs value) => value.entries
      .map((e) => '${e['key']}|${e['observed_at']}|${e['time']}')
      .join('\n');
  @override
  void didUpdateWidget(covariant TimelineBriefs oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_signature(oldWidget) != _signature(widget)) visible = 8;
  }

  String t(String zh, String en) => language == 'zh' ? zh : en;
  bool _sourceAvailable(Map entry) =>
      onOpenSources != null &&
      (entry['evidence_ids'] as List? ?? []).every(
        availableEvidenceIds.contains,
      );
  @override
  Widget build(BuildContext context) {
    if (entries.isEmpty) {
      return EmptyNote(
        t('还没有近况', 'No updates yet'),
        icon: CupertinoIcons.clock,
      );
    }
    final sorted = List<Map>.of(entries)
      ..sort(
        (a, b) =>
            DateTime.parse(
              '${effectiveTimelineAnchor(b['time'] as Map?)['anchor_date'] ?? b['observed_at']}',
            ).compareTo(
              DateTime.parse(
                '${effectiveTimelineAnchor(a['time'] as Map?)['anchor_date'] ?? a['observed_at']}',
              ),
            ),
      );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _timeline(context, sorted.take(visible).toList()),
        if (sorted.length > visible)
          TextButton(
            onPressed: () => setState(() => visible += 8),
            child: Text(t('继续查看进展', 'Show more updates')),
          ),
      ],
    );
  }

  String sourceTime(String value) => timelineSourceTime(value, language);

  String _clockLabel(String value) {
    final date = DateTime.tryParse(value)?.toLocal();
    if (date == null) return '';
    return '${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
  }

  Widget _timeline(BuildContext context, List<Map> entries) {
    entries.sort(
      (a, b) =>
          DateTime.parse(
            effectiveTimelineAnchor(b['time'] as Map?)['anchor_date']
                    as String? ??
                b['observed_at'] as String,
          ).compareTo(
            DateTime.parse(
              effectiveTimelineAnchor(a['time'] as Map?)['anchor_date']
                      as String? ??
                  a['observed_at'] as String,
            ),
          ),
    );
    final days = <DateTime, List<Map>>{};
    for (final entry in entries) {
      final date = DateTime.parse(
        effectiveTimelineAnchor(entry['time'] as Map?)['anchor_date']
                as String? ??
            entry['observed_at'] as String,
      ).toLocal();
      days
          .putIfAbsent(DateTime(date.year, date.month, date.day), () => [])
          .add(entry);
    }
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            t('近况', 'Updates'),
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 16),
          Stack(
            children: [
              Positioned(
                left: 5,
                top: 10,
                bottom: 0,
                child: Container(
                  key: const ValueKey('brief-timeline-line'),
                  width: 1,
                  color: Nova.separator,
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final day in days.entries)
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
                            key: ValueKey(
                              'brief-timeline-marker-${day.key.toIso8601String()}',
                            ),
                            width: 9,
                            height: 9,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: day.key == today
                                  ? novaTimelineAccent
                                  : Colors.white,
                              border: Border.all(
                                color: day.key == today
                                    ? novaTimelineAccent
                                    : Nova.separator,
                                width: 2,
                              ),
                            ),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.only(left: 26, bottom: 8),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Padding(
                                padding: const EdgeInsets.only(bottom: 10),
                                child: Row(
                                  children: [
                                    Flexible(
                                      child: Container(
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 11,
                                          vertical: 5,
                                        ),
                                        decoration: BoxDecoration(
                                          color: Colors.white,
                                          borderRadius: BorderRadius.circular(
                                            999,
                                          ),
                                          border: Border.all(
                                            color: day.key == today
                                                ? novaTimelineAccent.withValues(
                                                    alpha: .4,
                                                  )
                                                : Nova.separator,
                                          ),
                                        ),
                                        child: Text(
                                          '${day.key == today ? t('今天 · ', 'Today · ') : ''}'
                                          '${t('${day.key.year}年${day.key.month}月${day.key.day}日', '${day.key.year}-${day.key.month.toString().padLeft(2, '0')}-${day.key.day.toString().padLeft(2, '0')}')}',
                                          key: ValueKey(
                                            'brief-timeline-date-${day.key.toIso8601String()}',
                                          ),
                                          style: TextStyle(
                                            color: day.key == today
                                                ? novaTimelineAccent
                                                : Nova.text,
                                            fontSize: 15,
                                            fontWeight: FontWeight.w600,
                                            height: 1.35,
                                          ),
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              for (final entry in day.value)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 16),
                                  child: Material(
                                    key: ValueKey(
                                      'timeline-card-${entry['key']}',
                                    ),
                                    color: Colors.white,
                                    elevation: 1,
                                    shadowColor: const Color(0x18203248),
                                    borderRadius: BorderRadius.circular(16),
                                    clipBehavior: Clip.antiAlias,
                                    child: Padding(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 16,
                                        vertical: 8,
                                      ),
                                      child: entry['brief'] is Map
                                          ? _briefCard(context, entry)
                                          : TimelineSourceEntry(
                                              entry: entry,
                                              language: language,
                                              sourceAvailable: _sourceAvailable(
                                                entry,
                                              ),
                                              onOpenSources:
                                                  onOpenSources == null
                                                  ? null
                                                  : () => onOpenSources!(entry),
                                            ),
                                    ),
                                  ),
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
        ],
      ),
    );
  }

  List<String> _timeLabels(Map? time) {
    final labels = <String>[];
    String dateLabel(String value) {
      final date = DateTime.parse(value);
      return t('${date.month}月${date.day}日', value);
    }

    final scheduled = time?['scheduled_on'], due = time?['due_on'];
    if (scheduled is String) {
      labels.add(
        t(
          '安排于 ${dateLabel(scheduled)}',
          'Scheduled for ${dateLabel(scheduled)}',
        ),
      );
    }
    if (due is String) {
      labels.add(t('截止 ${dateLabel(due)}', 'Due ${dateLabel(due)}'));
      final now = DateTime.now();
      final days = DateTime.parse(
        '${due}T00:00:00Z',
      ).difference(DateTime.utc(now.year, now.month, now.day)).inDays;
      labels.add(
        days > 0
            ? t('距截止 $days 天', 'Due in $days days')
            : days == 0
            ? t('今天截止', 'Due today')
            : t(
                '原截止已过 ${-days} 天，结果以最新记录为准',
                '${-days} days past the original deadline; check the latest record',
              ),
      );
    }
    final reported = time?['last_reported_on'];
    if ((scheduled is String || due is String) && reported is String) {
      labels.add(
        t(
          '最近记录 ${dateLabel(reported)}',
          'Last recorded ${dateLabel(reported)}',
        ),
      );
    }
    return labels;
  }

  Widget _briefCard(BuildContext context, Map entry) {
    final brief = entry['brief'] as Map;
    final facts = (brief['facts'] as List? ?? []).whereType<Map>();
    final steps = (brief['next_steps'] as List? ?? [])
        .whereType<Map>()
        .toList();
    final timeLabels = _timeLabels(entry['time'] as Map?);
    final status = brief['status_label'] as String? ?? '';
    final uncertainty = brief['uncertainty'] as String? ?? '';
    final actions = (brief['actions'] as List? ?? [])
        .whereType<Map>()
        .where((a) => a['label'] is String && (a['label'] as String).isNotEmpty)
        .take(2)
        .toList();
    final clock = entry['observed_at'] is String
        ? _clockLabel(entry['observed_at'] as String)
        : '';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (status.isNotEmpty || clock.isNotEmpty) ...[
            Wrap(
              spacing: 8,
              runSpacing: 6,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                if (status.isNotEmpty)
                  const Text(
                    '◇',
                    style: TextStyle(color: novaTimelineAccent, fontSize: 20),
                  ),
                if (status.isNotEmpty)
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 7,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: novaTimelineAccent.withValues(alpha: .05),
                      border: Border.all(
                        color: novaTimelineAccent.withValues(alpha: .15),
                      ),
                      borderRadius: BorderRadius.circular(5),
                    ),
                    child: Text(
                      status,
                      style: const TextStyle(
                        color: novaTimelineAccent,
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                if (clock.isNotEmpty)
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(color: Nova.separator),
                    ),
                    child: Text(
                      clock,
                      style: const TextStyle(
                        color: Nova.secondary,
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 12),
          ],
          Text(
            brief['title'] as String,
            style: const TextStyle(
              fontSize: 18,
              height: 1.35,
              fontWeight: FontWeight.w600,
            ),
          ),
          if (timeLabels.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 10,
              runSpacing: 4,
              children: [
                for (final label in timeLabels)
                  Text(
                    label,
                    style: const TextStyle(fontSize: 11, color: Nova.secondary),
                  ),
              ],
            ),
          ],
          const SizedBox(height: 12),
          for (final fact in facts)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                fact['text'] as String,
                style: const TextStyle(
                  fontSize: 13,
                  height: 1.6,
                  color: Nova.secondary,
                ),
              ),
            ),
          if ((brief['why_now'] as String? ?? '').isNotEmpty) ...[
            const SizedBox(height: 4),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: novaTimelineAccent.withValues(alpha: .07),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    t('判断', 'Assessment'),
                    style: const TextStyle(
                      fontSize: 11,
                      color: novaTimelineAccent,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    brief['why_now'] as String,
                    style: const TextStyle(fontSize: 13, height: 1.6),
                  ),
                ],
              ),
            ),
          ],
          if (steps.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text(
              t('下一步', 'Next steps'),
              style: const TextStyle(fontSize: 11, color: Nova.secondary),
            ),
            for (final (index, step) in steps.indexed)
              Container(
                margin: const EdgeInsets.only(top: 8),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: const Color(0xfff2f5f9),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      (index + 1).toString().padLeft(2, '0'),
                      style: const TextStyle(
                        fontSize: 11,
                        height: 1.8,
                        color: novaTimelineAccent,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            step['title'] as String,
                            style: const TextStyle(
                              fontSize: 13,
                              height: 1.5,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            step['detail'] as String,
                            style: const TextStyle(
                              fontSize: 12,
                              height: 1.6,
                              color: Nova.secondary,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
          ],
          if (onAction != null && actions.isNotEmpty) ...[
            const SizedBox(height: 14),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final action in actions)
                  OutlinedButton(
                    key: ValueKey(
                      'timeline-action-${entry['key']}-${action['label']}',
                    ),
                    onPressed: () => onAction!(_actionDraft(action, brief)),
                    child: Text(action['label'] as String),
                  ),
              ],
            ),
          ],
          if (uncertainty.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(
              uncertainty,
              style: const TextStyle(
                fontSize: 12,
                height: 1.5,
                color: Nova.secondary,
              ),
            ),
          ],
          const SizedBox(height: 12),
          if (onOpenSources == null)
            Text(
              t('原文请在电脑上查看', 'View source messages on your computer'),
              style: const TextStyle(
                color: Nova.secondary,
                fontSize: 11,
                height: 1.5,
              ),
            ),
          Text(
            t(
              '更新依据 · ${sourceTime(entry['observed_at'])}',
              'Based on messages · ${sourceTime(entry['observed_at'])}',
            ),
            style: const TextStyle(
              color: Nova.secondary,
              fontSize: 11,
              height: 1.6,
            ),
          ),
          const SizedBox(height: 10),
          if (onOpenSources != null)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                style: TextButton.styleFrom(
                  foregroundColor: novaTimelineAccent,
                  backgroundColor: novaTimelineWash,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 8,
                  ),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(9),
                  ),
                  textStyle: const TextStyle(
                    fontFamily: 'CupertinoSystemText',
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                onPressed: onOpenSources == null
                    ? null
                    : () => onOpenSources!(entry),
                child: Text(
                  t(
                    '查看 ${(entry['evidence_ids'] as List).length} 条原文 ›',
                    'View ${(entry['evidence_ids'] as List).length} source messages ›',
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class TimelineSourceEntry extends StatelessWidget {
  const TimelineSourceEntry({
    super.key,
    required this.entry,
    this.language = 'zh',
    this.sourceAvailable = false,
    this.onOpenSources,
  });
  final Map entry;
  final String language;
  final bool sourceAvailable;
  final VoidCallback? onOpenSources;
  @override
  Widget build(BuildContext context) => ListTile(
    contentPadding: const EdgeInsets.symmetric(vertical: 10),
    title: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (onOpenSources == null)
          Text(
            language == 'zh'
                ? '原文请在电脑上查看'
                : 'View source messages on your computer',
            style: const TextStyle(color: Nova.secondary, fontSize: 12),
          ),
        Text(
          '${entry['text'] ?? ''}',
          style: const TextStyle(fontSize: 16, height: 1.55),
        ),
      ],
    ),
    subtitle: Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 4,
        children: [
          Text(
            language == 'zh'
                ? '更新依据 · ${timelineSourceTime(entry['observed_at'] as String, language)}'
                : 'Based on messages · ${timelineSourceTime(entry['observed_at'] as String, language)}',
            style: const TextStyle(color: Nova.secondary, fontSize: 13),
          ),
          if (onOpenSources != null)
            Text(
              language == 'zh'
                  ? '查看 ${(entry['evidence_ids'] as List).length} 条原文 ›'
                  : 'View ${(entry['evidence_ids'] as List).length} source messages ›',
              style: const TextStyle(color: novaTimelineAccent, fontSize: 12),
            ),
        ],
      ),
    ),
    onTap: onOpenSources,
  );
}

/// The text a quick action puts in the composer. It only asks to discuss or draft; the user sends it.
String _actionDraft(Map action, Map brief) {
  final title = '${brief['title'] ?? ''}';
  return action['kind'] == 'draft'
      ? '请根据「$title」帮我写一份草稿，并标明事实缺口。'
      : '一起看看这件事：$title';
}
