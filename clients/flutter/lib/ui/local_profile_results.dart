import 'dart:async';
import 'package:flutter/material.dart';
import 'theme.dart';
import 'profile_generation_status.dart';
import '../context/profile_generation_coordinator.dart';
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
    this.generation,
    this.revision = 0,
    this.excludeAbout = false,
    this.language = 'zh',
    this.onOpenFeishu,
    this.adoptTodo,
  });
  final ProfileGenerationCoordinator? generation;
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
    changes: generation,
    builder: (context, profile, value, loading, failed, retry) {
      if (generation != null && value == null) {
        return ProfileGenerationStatus(
          generation: generation!,
          language: language,
          empty: true,
          emptyLabel: kind == 'profile'
              ? t('暂时没有可确认的个人信息', 'No confirmed personal information yet')
              : t('暂时没有可确认的近况', 'No confirmed updates yet'),
        );
      }
      if (kind == 'timeline' && value == null) {
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
        if (generation != null) {
          return ProfileGenerationStatus(
            generation: generation!,
            language: language,
            empty: true,
            emptyLabel: kind == 'profile'
                ? t('暂时没有可确认的个人信息', 'No confirmed personal information yet')
                : t('暂时没有可确认的近况', 'No confirmed updates yet'),
          );
        }
        return kind == 'timeline'
            ? _timelineState(loading: false, failed: false, retry: retry)
            : const SizedBox.shrink();
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                Text(
                  value['generated_at'] is String
                      ? t(
                          '最近成功整理 · ${sourceTime(value['generated_at'])}',
                          'Updated · ${sourceTime(value['generated_at'])}',
                        )
                      : t('此前成功整理的内容', 'Saved results'),
                  style: const TextStyle(color: Nova.secondary, fontSize: 12),
                ),
                if (value['historical'] == true)
                  Text(
                    t('历史结果', 'Saved'),
                    style: const TextStyle(color: Nova.secondary, fontSize: 12),
                  ),
                if (value['partial'] == true ||
                    (value['incomplete_batches'] as int? ?? 0) > 0)
                  Text(
                    t('部分内容', 'Partial'),
                    style: const TextStyle(color: Nova.secondary, fontSize: 12),
                  ),
              ],
            ),
          ),
          if ((loading || failed) &&
              (generation == null ||
                  generation!.phase == ProfileGenerationPhase.ready))
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                t(
                  loading ? '正在检查更新，先显示上次结果。' : '更新暂时不可用，保留上次结果。',
                  loading
                      ? 'Checking for updates. Showing the last result.'
                      : 'Update unavailable. Showing the last result.',
                ),
              ),
            ),
          if (generation != null)
            ProfileGenerationStatus(
              generation: generation!,
              language: language,
            ),
          for (final section in ['timeline', 'profile', 'todo_candidate'])
            if (entries.any((e) => (e['kind'] ?? 'profile') == section)) ...[
              if (section == 'timeline')
                _timeline(
                  context,
                  profile,
                  entries.where((e) => e['kind'] == section).toList(),
                  value,
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
                  _entry(context, profile, entry, section, value),
              ],
            ],
          _coverage(value),
        ],
      );
    },
  );

  Widget _coverage(Map<String, dynamic> value) {
    final coverage = value['coverage'];
    final notes = <String>[
      if (value['historical'] == true)
        t(
          '这是上次整理的结果，可能尚未包含后续变化。',
          'These saved results may not include later changes.',
        ),
      if (value['partial'] == true)
        t(
          '还有部分内容待整理，后续进展可能尚未包含。',
          'Some content remains to be organized. Later developments may be missing.',
        ),
      if ((value['incomplete_batches'] as int? ?? 0) > 0)
        t(
          '部分内容无法与原文核对，未显示，近况可能不完整。',
          'Some content could not be checked against the original messages and is not shown. Updates may be incomplete.',
        ),
      if (coverage is Map)
        t(
          '已整理 ${coverage['validated_observation_records'] ?? '未知'} / ${coverage['eligible_records'] ?? '未知'} 条消息，最终参考 ${coverage['final_original_records'] ?? '未知'} 条原文。还有 ${coverage['unobserved_records'] ?? '未知'} 条待整理。',
          '${coverage['validated_observation_records'] ?? 'Unknown'} / ${coverage['eligible_records'] ?? 'unknown'} messages reviewed; ${coverage['final_original_records'] ?? 'unknown'} originals used in the result. ${coverage['unobserved_records'] ?? 'Unknown'} messages remain.',
        ),
    ];
    if (notes.isEmpty) return const SizedBox.shrink();
    return ExpansionTile(
      tilePadding: EdgeInsets.zero,
      childrenPadding: const EdgeInsets.only(bottom: 16),
      expandedCrossAxisAlignment: CrossAxisAlignment.start,
      title: Text(
        t('整理范围', 'Review coverage'),
        style: const TextStyle(fontSize: 13, color: Nova.secondary),
      ),
      children: [
        for (final note in notes)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              note,
              style: const TextStyle(
                color: Nova.secondary,
                fontSize: 13,
                height: 1.5,
              ),
            ),
          ),
      ],
    );
  }

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
              t(
                '消息同步并授权后，会自动整理到这里。',
                'Updates appear automatically after messages sync and access is allowed.',
              ),
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
    Map<String, dynamic> value,
  ) {
    entries.sort(
      (a, b) => DateTime.parse(
        b['observed_at'] as String,
      ).compareTo(DateTime.parse(a['observed_at'] as String)),
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            t('飞书近况', 'Feishu updates'),
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 16),
          for (final entry in entries)
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: DecoratedBox(
                key: ValueKey('timeline-card-${entry['key']}'),
                decoration: BoxDecoration(
                  border: Border.all(color: Nova.separator),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 6,
                  ),
                  child: entry['brief'] is Map
                      ? _briefCard(context, profile, entry, value)
                      : _entry(context, profile, entry, 'timeline', value),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _briefCard(
    BuildContext context,
    ProfileRepository profile,
    Map entry,
    Map<String, dynamic> value,
  ) {
    final brief = entry['brief'] as Map;
    final facts = (brief['facts'] as List? ?? []).whereType<Map>();
    final steps = (brief['next_steps'] as List? ?? [])
        .whereType<Map>()
        .toList();
    final status = brief['status_label'] as String? ?? '';
    final uncertainty = brief['uncertainty'] as String? ?? '';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (status.isNotEmpty) ...[
            Text(
              status,
              style: const TextStyle(
                color: Nova.secondary,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
          ],
          Text(
            brief['title'] as String,
            style: const TextStyle(
              fontSize: 18,
              height: 1.4,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 16),
          for (final fact in facts)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Text(
                fact['text'] as String,
                style: const TextStyle(fontSize: 15, height: 1.6),
              ),
            ),
          if ((brief['why_now'] as String? ?? '').isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              brief['why_now'] as String,
              style: const TextStyle(
                fontSize: 15,
                height: 1.6,
                fontWeight: FontWeight.w500,
              ),
            ),
          ],
          if (steps.isNotEmpty) ...[
            const SizedBox(height: 18),
            Text(
              t('下一步', 'Next steps'),
              style: const TextStyle(fontSize: 13, color: Nova.secondary),
            ),
            for (final step in steps) ...[
              const SizedBox(height: 8),
              Text(
                step['title'] as String,
                style: const TextStyle(
                  fontSize: 15,
                  height: 1.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
              Text(
                step['detail'] as String,
                style: const TextStyle(fontSize: 14, height: 1.6),
              ),
            ],
          ],
          if (uncertainty.isNotEmpty) ...[
            const SizedBox(height: 14),
            Text(
              uncertainty,
              style: const TextStyle(
                fontSize: 13,
                height: 1.5,
                color: Nova.secondary,
              ),
            ),
          ],
          const SizedBox(height: 16),
          if (!(entry['evidence_ids'] as List).every(
            ((value['available_evidence_ids'] as List?) ?? []).contains,
          ))
            Text(
              t(
                '原始来源已不可用 · 保留此前整理内容',
                'Original source unavailable · saved result retained',
              ),
              style: const TextStyle(color: Nova.secondary, fontSize: 12),
            ),
          Text(
            t(
              '更新依据 · ${sourceTime(entry['observed_at'])}',
              'Based on messages · ${sourceTime(entry['observed_at'])}',
            ),
            style: const TextStyle(
              color: Nova.secondary,
              fontSize: 12,
              height: 1.6,
            ),
          ),
          TextButton(
            onPressed: () => _showSources(context, profile, entry),
            child: Text(
              t(
                '查看 ${(entry['evidence_ids'] as List).length} 条原文 ›',
                'View ${(entry['evidence_ids'] as List).length} source messages ›',
              ),
            ),
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
    Map<String, dynamic> value,
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
        if (!(entry['evidence_ids'] as List).every(
          ((value['available_evidence_ids'] as List?) ?? []).contains,
        ))
          Text(
            t(
              '原始来源已不可用 · 保留此前整理内容',
              'Original source unavailable · saved result retained',
            ),
            style: const TextStyle(color: Nova.secondary, fontSize: 12),
          ),
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
                      t(
                        '更新依据 · ${sourceTime(entry['observed_at'])}',
                        'Based on messages · ${sourceTime(entry['observed_at'])}',
                      ),
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
            onPressed: value['historical'] == true
                ? null
                : () async {
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
                          SnackBar(
                            content: Text(t('已加入待办', 'Added to to-dos')),
                          ),
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
            child: Text(t('加入待办', 'Add to to-dos')),
          )
        : null,
    onTap: entry['explicit'] == true
        ? null
        : () => _showSources(context, profile, entry),
  );

  Future<void> _showSources(
    BuildContext context,
    ProfileRepository profile,
    Map entry,
  ) => showDialog<void>(
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
              (e) => e['key'] == entry['key'] && e['text'] == entry['text'],
            );
        final refs = (entry['evidence_ids'] as List).toSet().intersection(
          (current?['available_evidence_ids'] as List? ?? []).toSet(),
        );
        final messages = available
            ? host.sources.messagesByEvidenceIds(refs)
            : <Map<String, dynamic>>[];
        messages.sort(
          (a, b) => (a['created_at'] as int).compareTo(b['created_at'] as int),
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
                    TextButton(onPressed: retry, child: Text(t('重试', 'Retry'))),
                  ] else if (!available ||
                      refs.length != (entry['evidence_ids'] as List).length)
                    Text(
                      t(
                        '原始来源已不可用，仍保留此前整理的内容。',
                        'The original source is unavailable. The saved result is retained.',
                      ),
                    ),
                  for (final m in messages) ...[
                    Text(
                      '${sourceTime(DateTime.fromMillisecondsSinceEpoch(m['created_at']).toIso8601String())} · ${m['relation'] == 'self' ? t('我', 'You') : t('其他参与者', 'Another participant')}',
                    ),
                    SelectableText(
                      m['text'] as String? ?? t('正文不可用', 'Message unavailable'),
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
  );
}

class _ProfileScope extends StatefulWidget {
  const _ProfileScope({
    required this.host,
    required this.authority,
    required this.builder,
    this.repository,
    required this.revision,
    this.changes,
  });
  final FeishuHost host;
  final SpaceAuthorityRepository authority;
  final ProfileRepository? repository;
  final int revision;
  final Listenable? changes;
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
  late ProfileRepository profile = _repository();
  ProfileRepository _repository() =>
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
    widget.changes?.addListener(_changed);
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
    if (widget.changes != oldWidget.changes) {
      oldWidget.changes?.removeListener(_changed);
      widget.changes?.addListener(_changed);
    }
    if (widget.repository != oldWidget.repository) {
      profile = _repository();
      unawaited(_open());
    } else if (widget.revision != oldWidget.revision) {
      unawaited(_open());
    }
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final value = widget.host.ready ? profile.value : null;
    expiry?.cancel();
    if (value != null) {
      final now = widget.host.sources.now();
      final refs = (value['entries'] as List)
          .expand((e) => e['evidence_ids'] as List)
          .toSet();
      final dates =
          widget.host.sources
              .messagesByEvidenceIds(refs)
              .map((m) => sourceAccessExpiry(m).millisecondsSinceEpoch)
              .where((deadline) => deadline > now.millisecondsSinceEpoch)
              .toList()
            ..sort();
      if (dates.isNotEmpty) {
        final end = DateTime.fromMillisecondsSinceEpoch(
          dates.first,
        ).add(const Duration(milliseconds: 1));
        expiry = Timer(end.difference(now), _changed);
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
    widget.changes?.removeListener(_changed);
    super.dispose();
  }
}
