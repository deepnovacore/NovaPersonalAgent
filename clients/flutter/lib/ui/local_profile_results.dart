import 'dart:async';

import 'package:flutter/material.dart';

import 'timeline_page.dart';
import 'timeline_briefs.dart';
import 'profile_generation_status.dart';
import '../context/profile_generation_coordinator.dart';
import '../connectors/feishu/host.dart';
import '../context/profile_corrections.dart';
import '../context/profile_repository.dart';
import '../context/secure_persistence.dart';
import '../context/source_store.dart' show sourceAccessExpiry;
import '../context/local_publication.dart';
import '../context/timeline_time.dart';

/// Local projection; only individually confirmed candidates enter the Life path.
class LocalProfileResults extends StatelessWidget
    implements TimelineBriefSummary {
  const LocalProfileResults({
    super.key,
    required this.host,
    required this.publication,
    required this.kind,
    this.repository,
    this.generation,
    this.revision = 0,
    this.excludeAbout = false,
    this.compact = false,
    this.language = 'zh',
    this.onOpenConnectors,
    this.emptyHint,
    this.adoptTodo,
  });
  final ProfileGenerationCoordinator? generation;
  final FeishuHost host;
  final LocalPublicationContext publication;
  final ProfileRepository? repository;
  final String kind;
  final int revision;
  final bool excludeAbout;
  final bool compact;
  final String language;
  final VoidCallback? onOpenConnectors;

  /// The reason nothing can be shown right now, supplied by the shell so the
  /// empty state names the real cause instead of guessing.
  final String? emptyHint;
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

  /// Today's generated brief entries, for the Timeline page's Today header.
  ///
  /// The header must never invent counts: without a loaded repository value
  /// this reports zero and the page simply omits the brief count.
  @override
  int todayBriefCount(DateTime now) {
    // Before the host has opened local state, any stored value is not yet
    // trustworthy for this Space/device; report nothing rather than a guess.
    if (!host.restored) return 0;
    final value = repository?.value;
    final entries = value?['entries'];
    if (entries is! List) return 0;
    final day = DateTime(now.year, now.month, now.day);
    return entries.whereType<Map>().where((entry) {
      if ((entry['kind'] ?? 'profile') != 'timeline') return false;
      if (entry['brief'] is! Map) return false;
      final at = DateTime.tryParse(
        '${effectiveTimelineAnchor(entry['time'] as Map?)['anchor_date'] ?? entry['observed_at'] ?? ''}',
      )?.toLocal();
      return at != null &&
          at.year == day.year &&
          at.month == day.month &&
          at.day == day.day;
    }).length;
  }

  final Future<Map<String, dynamic>> Function(Map<String, dynamic>, String)?
  adoptTodo;

  @override
  Widget build(BuildContext context) => _ProfileScope(
    host: host,
    publication: publication,
    repository: repository,
    revision: revision,
    changes: generation,
    builder: (context, profile, value, loading, failed, retry) {
      if (compact) {
        final rows = (value?['entries'] as List? ?? [])
            .whereType<Map>()
            .where(
              (e) =>
                  (e['kind'] ?? 'profile') == 'profile' &&
                  '${e['text'] ?? ''}'.trim().isNotEmpty,
            )
            .toList();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (rows.isEmpty)
              Text(
                t('还没有个人介绍', 'No introduction yet'),
                style: TextStyle(
                  fontSize: 14,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            if (rows.isEmpty && emptyHint != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  emptyHint!,
                  style: TextStyle(
                    fontSize: 12,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                    height: 1.5,
                  ),
                ),
              ),
            if (rows.isEmpty && onOpenConnectors != null)
              TextButton(
                style: TextButton.styleFrom(padding: EdgeInsets.zero),
                onPressed: onOpenConnectors,
                child: Text(t('打开连接器', 'Open connectors')),
              ),
            for (final key in ProfileCorrections.categories.keys)
              for (final row in rows.where((e) => e['key'] == key).take(1))
                Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        language == 'zh'
                            ? ProfileCorrections.categories[key]!
                            : {
                                'about': 'About you',
                                'work': 'Work',
                                'interests': 'Interests',
                              }[key]!,
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: Theme.of(context).colorScheme.primary,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        row['text'] as String,
                        maxLines: key == 'about' ? 3 : 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 14, height: 1.65),
                      ),
                    ],
                  ),
                ),
            if (rows.isNotEmpty)
              Text(
                t(
                  'Nova 整理 · 来源与修正见完整资料',
                  'Organized by Nova · Sources and corrections in Profile',
                ),
                style: TextStyle(
                  fontSize: 11,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
          ],
        );
      }
      if (value == null) {
        // A failed local read is its own state; generation status must not hide
        // it, because retrying the read is the only useful action.
        if (failed) return _readFailure(context, retry);
        if (!host.restored) return _loadingState(context);
        if (profile.hasStoredResult) return _blockedNote(context);
        if (generation != null) {
          return ProfileGenerationStatus(
            generation: generation!,
            language: language,
            empty: true,
            emptyLabel: kind == 'profile'
                ? t('暂时没有可确认的个人信息', 'No confirmed personal information yet')
                : t('暂时没有可确认的近况', 'No confirmed updates yet'),
            waitingHint: emptyHint,
            onOpenConnectors: onOpenConnectors,
          );
        }
        if (kind == 'timeline') {
          return _timelineState(
            context,
            loading: loading,
            failed: failed,
            retry: retry,
            emptyHint: emptyHint,
          );
        }
        return _emptyHintState(context);
      }
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
            waitingHint: emptyHint,
            onOpenConnectors: onOpenConnectors,
          );
        }
        return kind == 'timeline'
            ? _timelineState(
                context,
                loading: false,
                failed: false,
                retry: retry,
                emptyHint: emptyHint,
              )
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
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
                if (value['historical'] == true)
                  Text(
                    t('历史结果', 'Saved'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                      fontSize: 12,
                    ),
                  ),
                if (value['partial'] == true ||
                    (value['incomplete_batches'] as int? ?? 0) > 0)
                  Text(
                    t('部分内容', 'Partial'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                      fontSize: 12,
                    ),
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
                TimelineBriefs(
                  entries: entries.where((e) => e['kind'] == section).toList(),
                  language: language,
                  availableEvidenceIds:
                      value['available_evidence_ids'] as List? ?? [],
                  onOpenSources: (entry) =>
                      _showSources(context, profile, entry),
                )
              else ...[
                ListTile(
                  title: Text(
                    section == 'timeline'
                        ? t('近况', 'Updates')
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
          _coverage(context, value),
        ],
      );
    },
  );

  Widget _readFailure(BuildContext context, VoidCallback retry) => Padding(
    padding: const EdgeInsets.only(bottom: 24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          t('无法读取此前生成的资料', 'Could not read your saved results'),
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            height: 1.5,
          ),
        ),
        TextButton(
          style: TextButton.styleFrom(padding: EdgeInsets.zero),
          onPressed: retry,
          child: Text(t('重试', 'Retry')),
        ),
      ],
    ),
  );

  // Deliberately static: some screens are built before the host is opened, and
  // an indeterminate indicator would animate forever if it never is.
  Widget _loadingState(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 24),
    child: Text(
      t('正在读取本机资料…', 'Opening local data…'),
      style: TextStyle(
        color: Theme.of(context).colorScheme.onSurfaceVariant,
        height: 1.5,
      ),
    ),
  );

  /// Stored data exists but was produced for another Space, device or identity.
  Widget _blockedNote(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 24),
    child: Text(
      t(
        '此设备此前生成的资料无法显示。它们属于其他账号或设备；重新连接或切回原 Space 后可能恢复。',
        'Saved results on this device cannot be shown here. They belong to another account or device; reconnect or switch back to the original Space to restore them.',
      ),
      style: TextStyle(
        color: Theme.of(context).colorScheme.onSurfaceVariant,
        height: 1.5,
      ),
    ),
  );

  Widget _emptyHintState(BuildContext context) {
    if (emptyHint == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            emptyHint!,
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              height: 1.5,
            ),
          ),
          if (onOpenConnectors != null)
            TextButton(
              style: TextButton.styleFrom(padding: EdgeInsets.zero),
              onPressed: onOpenConnectors,
              child: Text(t('打开连接器', 'Open connectors')),
            ),
        ],
      ),
    );
  }

  Widget _coverage(BuildContext context, Map<String, dynamic> value) {
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
        style: TextStyle(
          fontSize: 13,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      ),
      children: [
        for (final note in notes)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              note,
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 13,
                height: 1.5,
              ),
            ),
          ),
      ],
    );
  }

  Widget _timelineState(
    BuildContext context, {
    required bool loading,
    required bool failed,
    required VoidCallback retry,
    String? emptyHint,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          t('近况', 'Updates'),
          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 12),
        if (loading) ...[
          const LinearProgressIndicator(minHeight: 2),
          const SizedBox(height: 12),
          Text(
            t('正在加载近况…', 'Loading updates…'),
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ] else ...[
          Text(
            failed
                ? t('暂时无法加载近况', 'Could not load updates')
                : t('还没有近况', 'No updates yet'),
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              height: 1.5,
            ),
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
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 13,
                height: 1.5,
              ),
            ),
            if (emptyHint != null) ...[
              const SizedBox(height: 6),
              Text(
                emptyHint,
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                  fontSize: 13,
                  height: 1.5,
                ),
              ),
            ],
            if (onOpenConnectors != null)
              TextButton(
                onPressed: onOpenConnectors,
                child: Text(t('前往连接器', 'Open connectors')),
              ),
          ],
        ],
      ],
    ),
  );

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
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                        fontSize: 13,
                      ),
                    ),
                    Text(
                      t(
                        '查看 ${(entry['evidence_ids'] as List).length} 条原文 ›',
                        'View ${(entry['evidence_ids'] as List).length} source messages ›',
                      ),
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.primary,
                        fontSize: 12,
                      ),
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
      publication: publication,
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
                  ],
                  for (final m in messages) ...[
                    Text(
                      '${sourceTime(DateTime.fromMillisecondsSinceEpoch(m['created_at']).toIso8601String())} · ${switch (m['relation']) {
                        'self' => t('我', 'You'),
                        'addressed' => t('直接@你', 'Directly mentions you'),
                        'participant' => t('其他参与者', 'Another participant'),
                        'app' => t('应用或机器人', 'App or bot'),
                        _ => t('未知', 'Unknown'),
                      }}',
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
    required this.publication,
    required this.builder,
    this.repository,
    required this.revision,
    this.changes,
  });
  final FeishuHost host;
  final LocalPublicationContext publication;
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
        SecureContextPersistence('nova.profile.local.v1'),
        widget.publication,
        widget.host.sources,
        corrections: ProfileCorrections(),
      );
  Timer? expiry;
  bool loaded = false;
  bool failed = false;
  int readGeneration = 0;
  Object? _lastScope;
  Object get _scope => (
    profile.revision,
    widget.host.sources.revision,
    widget.host.sources.processingRevision,
    widget.host.sources.identity,
    widget.host.sources.generation,
    widget.host.restored,
    widget.host.ready,
    widget.publication.canPublish,
    widget.changes is ProfileGenerationCoordinator
        ? (widget.changes as ProfileGenerationCoordinator).phase
        : null,
  );
  @override
  void initState() {
    super.initState();
    widget.host.addListener(_changed);
    widget.publication.addListener(_changed);
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
    if (!mounted || _lastScope == _scope) return;
    setState(() => _lastScope = _scope);
  }

  void _expired() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    _lastScope = _scope;
    // Saved results are readable once local state is opened, even while the
    // Feishu connector itself is unconfigured or unauthorized.
    final value = widget.host.restored ? profile.value : null;
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
        expiry = Timer(end.difference(now), _expired);
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
    widget.publication.removeListener(_changed);
    widget.changes?.removeListener(_changed);
    super.dispose();
  }
}
