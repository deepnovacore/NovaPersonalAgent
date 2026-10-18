import 'dart:async';
import 'package:flutter/material.dart';
import 'theme.dart';
import '../connectors/feishu/host.dart';
import '../context/profile_corrections.dart';
import '../context/profile_repository.dart';
import '../context/secure_persistence.dart';
import '../context/source_store.dart' show sourceAccessExpiry;
import '../device/space_authority.dart';

/// Local projection; only individually confirmed candidates enter the Life path.
class LocalProfileResults extends StatelessWidget {
  const LocalProfileResults({
    super.key,
    required this.host,
    required this.authority,
    required this.kind,
    this.repository,
    this.revision = 0,
    this.excludeAbout = false,
    this.language = 'zh',
    this.onOpenFeishu,
    this.adoptTodo,
  });
  final FeishuHost host;
  final SpaceAuthorityRepository authority;
  final ProfileRepository? repository;
  final String kind;
  final int revision;
  final bool excludeAbout;
  final String language;
  final VoidCallback? onOpenFeishu;
  String t(String zh, String en) => language == 'zh' ? zh : en;
  String sourceTime(String value) {
    final date = DateTime.parse(value).toLocal();
    final time =
        '${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
    return t(
      '${date.year}年${date.month}月${date.day}日 $time',
      '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')} $time',
    );
  }

  final Future<Map<String, dynamic>> Function(Map<String, dynamic>, String)?
  adoptTodo;

  @override
  Widget build(BuildContext context) => _ProfileScope(
    host: host,
    authority: authority,
    repository: repository,
    revision: revision,
    builder: (context, profile, value, loading, failed, retry) {
      if (kind == 'timeline' && (loading || failed || value == null)) {
        return _timelineState(loading: loading, failed: failed, retry: retry);
      }
      if (value == null) return const SizedBox.shrink();
      final entries = (value['entries'] as List)
          .cast<Map>()
          .where(
            (e) =>
                (kind == 'all' || (e['kind'] ?? 'profile') == kind) &&
                !(excludeAbout && e['key'] == 'about'),
          )
          .toList();
      if (entries.isEmpty) {
        return kind == 'timeline'
            ? _timelineState(loading: false, failed: false, retry: retry)
            : const SizedBox.shrink();
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (value['partial'] == true)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(
                t(
                  '部分近况 · 已整理 ${value['coverage']?['validated_observation_records'] ?? 0} / ${value['coverage']?['eligible_records'] ?? 0} 条消息，引用 ${value['coverage']?['final_original_records'] ?? 0} 条原文。还有 ${value['coverage']?['unobserved_records'] ?? 0} 条待整理，可能尚未包含最新进展。',
                  'Partial results · ${value['coverage']?['validated_observation_records'] ?? 0} / ${value['coverage']?['eligible_records'] ?? 0} messages verified; ${value['coverage']?['final_original_records'] ?? 0} originals used. ${value['coverage']?['unobserved_records'] ?? 0} messages remain; later messages may change these statuses.',
                ),
              ),
            ),
          if ((value['incomplete_batches'] as int? ?? 0) > 0)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(
                t(
                  '部分内容无法与原文核对，未显示，近况可能不完整。',
                  'Some content could not be checked against the original messages and is not shown. Updates may be incomplete.',
                ),
              ),
            ),
          for (final section in ['timeline', 'profile', 'todo_candidate'])
            if (entries.any((e) => (e['kind'] ?? 'profile') == section)) ...[
              if (section == 'timeline')
                _timeline(
                  context,
                  profile,
                  entries.where((e) => e['kind'] == section).toList(),
                )
              else ...[
                ListTile(
                  title: Text(
                    section == 'timeline'
                        ? t('飞书近况', 'Feishu updates')
                        : section == 'todo_candidate'
                        ? t('可能需要做的事', 'Suggested to-dos')
                        : t('个人信息', 'About you'),
                  ),
                ),
                for (final entry
                    in entries
                        .where((e) => (e['kind'] ?? 'profile') == section)
                        .toList()
                      ..sort(
                        (a, b) => '${a['observed_at'] ?? ''}'.compareTo(
                          '${b['observed_at'] ?? ''}',
                        ),
                      ))
                  _entry(context, profile, entry, section),
              ],
            ],
        ],
      );
    },
  );

  Widget _timelineState({
    required bool loading,
    required bool failed,
    required VoidCallback retry,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          t('飞书近况', 'Feishu updates'),
          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 12),
        if (loading) ...[
          const LinearProgressIndicator(minHeight: 2),
          const SizedBox(height: 12),
          Text(
            t('正在加载近况…', 'Loading updates…'),
            style: const TextStyle(color: Nova.secondary),
          ),
        ] else ...[
          Text(
            failed
                ? t('暂时无法加载近况', 'Could not load updates')
                : t('还没有飞书近况', 'No Feishu updates yet'),
            style: const TextStyle(color: Nova.secondary, height: 1.5),
          ),
          if (failed)
            TextButton(onPressed: retry, child: Text(t('重试', 'Retry')))
          else ...[
            const SizedBox(height: 6),
            Text(
              t('在设置中的「飞书」生成近况。', 'Generate updates in Settings → Feishu.'),
              style: const TextStyle(
                color: Nova.secondary,
                fontSize: 13,
                height: 1.5,
              ),
            ),
            if (onOpenFeishu != null)
              TextButton(
                onPressed: onOpenFeishu,
                child: Text(t('前往飞书设置', 'Open Feishu settings')),
              ),
          ],
        ],
      ],
    ),
  );

  Widget _timeline(
    BuildContext context,
    ProfileRepository profile,
    List<Map> entries,
  ) {
    entries.sort(
      (a, b) => DateTime.parse(
        b['observed_at'] as String,
      ).compareTo(DateTime.parse(a['observed_at'] as String)),
    );
    final days = <String, List<Map>>{};
    for (final entry in entries) {
      final date = DateTime.parse(entry['observed_at'] as String).toLocal();
      final day = t(
        '${date.year}年${date.month}月${date.day}日',
        '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}',
      );
      days.putIfAbsent(day, () => []).add(entry);
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            t('飞书近况', 'Feishu updates'),
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 6),
          Text(
            t(
              '按消息日期倒序显示，事情发生的时间以正文为准。',
              'Newest messages first. Event dates and status are described in each update.',
            ),
            style: const TextStyle(
              color: Nova.secondary,
              fontSize: 13,
              height: 1.5,
            ),
          ),
          const SizedBox(height: 20),
          Stack(
            children: [
              Positioned(
                left: 5,
                top: 10,
                bottom: 12,
                child: Container(width: 1, color: Nova.separator),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final day in days.entries)
                    Stack(
                      children: [
                        Positioned(
                          left: 1,
                          top: 6,
                          child: Container(
                            width: 9,
                            height: 9,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: Nova.ink,
                              border: Border.all(color: Nova.mint, width: 2),
                            ),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.only(left: 24, bottom: 16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Padding(
                                padding: const EdgeInsets.only(bottom: 10),
                                child: Text(
                                  t(
                                    '消息日期 · ${day.key}',
                                    'Message date · ${day.key}',
                                  ),
                                  key: ValueKey(
                                    'source-timeline-date-${day.key}',
                                  ),
                                  style: const TextStyle(
                                    color: Nova.secondary,
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600,
                                    height: 1.6,
                                  ),
                                ),
                              ),
                              for (final entry in day.value)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 10),
                                  child: Material(
                                    color: Nova.ink,
                                    clipBehavior: Clip.antiAlias,
                                    child: _entry(
                                      context,
                                      profile,
                                      entry,
                                      'timeline',
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

  Widget _entry(
    BuildContext context,
    ProfileRepository profile,
    Map entry,
    String section,
  ) => ListTile(
    contentPadding: section == 'timeline'
        ? const EdgeInsets.symmetric(vertical: 10)
        : null,
    title: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (section == 'profile') ...[
          Text(
            ProfileCorrections.categories[entry['key']] ??
                t('个人信息', 'About you'),
            style: Theme.of(context).textTheme.labelLarge,
          ),
          const SizedBox(height: 8),
        ],
        Text(
          entry['text'] as String,
          style: section == 'timeline'
              ? const TextStyle(fontSize: 16, height: 1.55)
              : null,
        ),
      ],
    ),
    subtitle: section == 'timeline'
        ? Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    Text(
                      sourceTime(entry['observed_at']).split(' ').last,
                      style: const TextStyle(
                        color: Nova.secondary,
                        fontSize: 13,
                      ),
                    ),
                    Text(
                      t(
                        '查看 ${(entry['evidence_ids'] as List).length} 条原文 ›',
                        'View ${(entry['evidence_ids'] as List).length} source messages ›',
                      ),
                      style: const TextStyle(color: Nova.mint, fontSize: 13),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                const Divider(height: 1),
              ],
            ),
          )
        : Text(
            entry['explicit'] == true
                ? t('你填写的信息', 'Added by you')
                : t(
                    '来自 ${(entry['evidence_ids'] as List).length} 条${section == 'profile' ? '你的' : ''}消息',
                    'From ${(entry['evidence_ids'] as List).length} messages',
                  ),
          ),
    trailing: section == 'todo_candidate' && adoptTodo != null
        ? TextButton(
            child: Text(t('加入待办', 'Add to to-dos')),
            onPressed: () async {
              final accepted = await showDialog<bool>(
                context: context,
                builder: (dialog) => AlertDialog(
                  scrollable: true,
                  title: Text(t('加入待办', 'Add to to-dos')),
                  content: Text(
                    t(
                      '${entry['text']}\n\n消息日期：${sourceTime(entry['observed_at'])}。请确认这件事仍需完成。加入后按当前待办设置同步。',
                      '${entry['text']}\n\nMessage date: ${sourceTime(entry['observed_at'])}. Confirm this still needs doing. It will follow your current to-do sync settings.',
                    ),
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(dialog, false),
                      child: Text(t('取消', 'Cancel')),
                    ),
                    FilledButton(
                      onPressed: () => Navigator.pop(dialog, true),
                      child: Text(t('加入', 'Add')),
                    ),
                  ],
                ),
              );
              if (accepted != true || !context.mounted) return;
              try {
                if (!host.ready) {
                  throw StateError('connector_unavailable');
                }
                await profile.adoptTodo(
                  entry['key'] as String,
                  expectedText: entry['text'] as String,
                  mutate: adoptTodo!,
                );
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text(t('已加入待办', 'Added to to-dos'))),
                  );
                }
              } catch (_) {
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(
                        t(
                          '未能加入待办，请确认原文仍可访问后重试。',
                          'Could not add to to-dos. Check that the source messages are still available and retry.',
                        ),
                      ),
                    ),
                  );
                }
              }
            },
          )
        : null,
    onTap: entry['explicit'] == true
        ? null
        : () => showDialog<void>(
            context: context,
            builder: (_) => _ProfileScope(
              host: host,
              authority: authority,
              repository: profile,
              revision: revision,
              builder: (dialogContext, _, current, loading, failed, retry) {
                final available =
                    current != null &&
                    (current['entries'] as List).any(
                      (e) =>
                          e['key'] == entry['key'] &&
                          e['text'] == entry['text'],
                    );
                final refs = (entry['evidence_ids'] as List).toSet();
                final messages = available
                    ? host.sources.sources
                          .expand(host.sources.messages)
                          .where((m) => refs.contains(m['evidence_id']))
                          .toList()
                    : <Map<String, dynamic>>[];
                messages.sort(
                  (a, b) => (a['created_at'] as int).compareTo(
                    b['created_at'] as int,
                  ),
                );
                return AlertDialog(
                  title: Text(t('聊天原文', 'Source messages')),
                  content: SizedBox(
                    width: 500,
                    child: SingleChildScrollView(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          if (loading)
                            Text(t('正在加载原文…', 'Loading source messages…'))
                          else if (failed) ...[
                            Text(
                              t(
                                '暂时无法加载原文，请重试。',
                                'Could not load source messages. Please retry.',
                              ),
                            ),
                            TextButton(
                              onPressed: retry,
                              child: Text(t('重试', 'Retry')),
                            ),
                          ] else if (!available)
                            Text(
                              t(
                                '原文已过期，或当前已无权访问。',
                                'The source messages have expired or access has changed.',
                              ),
                            ),
                          for (final m in messages) ...[
                            Text(
                              '${sourceTime(DateTime.fromMillisecondsSinceEpoch(m['created_at']).toIso8601String())} · ${m['relation'] == 'self' ? t('我', 'You') : t('其他参与者', 'Another participant')}',
                            ),
                            SelectableText(
                              m['text'] as String? ??
                                  t('正文不可用', 'Message unavailable'),
                            ),
                            const Divider(),
                          ],
                        ],
                      ),
                    ),
                  ),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(dialogContext),
                      child: Text(t('关闭', 'Close')),
                    ),
                  ],
                );
              },
            ),
          ),
  );
}

class _ProfileScope extends StatefulWidget {
  const _ProfileScope({
    required this.host,
    required this.authority,
    required this.builder,
    this.repository,
    required this.revision,
  });
  final FeishuHost host;
  final SpaceAuthorityRepository authority;
  final ProfileRepository? repository;
  final int revision;
  final Widget Function(
    BuildContext,
    ProfileRepository,
    Map<String, dynamic>?,
    bool,
    bool,
    VoidCallback,
  )
  builder;
  @override
  State<_ProfileScope> createState() => _ProfileScopeState();
}

class _ProfileScopeState extends State<_ProfileScope> {
  late final profile =
      widget.repository ??
      ProfileRepository(
        const SecureContextPersistence('nova.profile.local.v1'),
        widget.authority,
        widget.host.sources,
        corrections: ProfileCorrections(),
      );
  Timer? expiry;
  bool loaded = false;
  bool failed = false;
  int readGeneration = 0;
  @override
  void initState() {
    super.initState();
    widget.host.addListener(_changed);
    widget.authority.addListener(_changed);
    unawaited(_open());
  }

  Future<void> _open() async {
    final generation = ++readGeneration;
    if (mounted) {
      setState(() {
        loaded = false;
        failed = false;
      });
    }
    try {
      await profile.open();
    } catch (_) {
      if (mounted && generation == readGeneration) {
        setState(() {
          loaded = true;
          failed = true;
        });
      }
      return;
    }
    if (mounted && generation == readGeneration) {
      setState(() => loaded = true);
    }
  }

  @override
  void didUpdateWidget(covariant _ProfileScope oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.revision != oldWidget.revision) unawaited(_open());
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final value = loaded && !failed && widget.host.ready ? profile.value : null;
    expiry?.cancel();
    if (value != null) {
      final refs = (value['entries'] as List)
          .expand((e) => e['evidence_ids'] as List)
          .toSet();
      final dates =
          widget.host.sources.sources
              .expand(widget.host.sources.messages)
              .where((m) => refs.contains(m['evidence_id']))
              .map((m) => sourceAccessExpiry(m).millisecondsSinceEpoch)
              .toList()
            ..sort();
      if (dates.isNotEmpty) {
        final end = DateTime.fromMillisecondsSinceEpoch(
          dates.first,
        ).add(const Duration(milliseconds: 1));
        expiry = Timer(end.difference(widget.host.sources.now()), _changed);
      }
    }
    return widget.builder(
      context,
      profile,
      value,
      !loaded,
      failed,
      () => unawaited(_open()),
    );
  }

  @override
  void dispose() {
    expiry?.cancel();
    widget.host.removeListener(_changed);
    widget.authority.removeListener(_changed);
    super.dispose();
  }
}
