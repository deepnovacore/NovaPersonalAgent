import 'dart:async';
import 'package:flutter/material.dart';
import '../connectors/feishu/host.dart';
import '../context/profile_corrections.dart';
import '../context/profile_repository.dart';
import '../context/secure_persistence.dart';
import '../device/space_authority.dart';

String _sourceTime(String value) {
  final date = DateTime.parse(value).toLocal();
  return '${date.year}年${date.month}月${date.day}日 ${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
}

/// Read-only local projection: never copied into Life/Hub or a model prompt.
class LocalProfileResults extends StatelessWidget {
  const LocalProfileResults({
    super.key,
    required this.host,
    required this.authority,
    required this.kind,
    this.repository,
    this.revision = 0,
    this.excludeAbout = false,
  });
  final FeishuHost host;
  final SpaceAuthorityRepository authority;
  final ProfileRepository? repository;
  final String kind;
  final int revision;
  final bool excludeAbout;

  @override
  Widget build(BuildContext context) => _ProfileScope(
    host: host,
    authority: authority,
    repository: repository,
    revision: revision,
    builder: (context, profile, value) {
      if (value == null) return const SizedBox.shrink();
      final entries = (value['entries'] as List)
          .cast<Map>()
          .where(
            (e) =>
                (kind == 'all' || (e['kind'] ?? 'profile') == kind) &&
                !(excludeAbout && e['key'] == 'about'),
          )
          .toList();
      if (entries.isEmpty) return const SizedBox.shrink();
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if ((value['incomplete_batches'] as int? ?? 0) > 0)
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('部分观察未通过原文核对，已排除；以下结果可能有遗漏。'),
            ),
          for (final section in ['timeline', 'profile'])
            if (entries.any((e) => (e['kind'] ?? 'profile') == section)) ...[
              ListTile(
                title: Text(section == 'timeline' ? '从飞书整理的进展' : '从飞书整理的画像'),
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
                ListTile(
                  title: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (section == 'profile') ...[
                        Text(
                          ProfileCorrections.categories[entry['key']] ?? '画像',
                          style: Theme.of(context).textTheme.labelLarge,
                        ),
                        const SizedBox(height: 8),
                      ],
                      Text(entry['text'] as String),
                    ],
                  ),
                  subtitle: Text(
                    entry['explicit'] == true
                        ? '你的明确表述'
                        : '${section == 'timeline' ? '${_sourceTime(entry['observed_at'])} · ' : ''}${(entry['evidence_ids'] as List).length} 条${section == 'profile' ? '本人发言' : ''}依据',
                  ),
                  onTap: entry['explicit'] == true
                      ? null
                      : () => showDialog<void>(
                          context: context,
                          builder: (_) => _ProfileScope(
                            host: host,
                            authority: authority,
                            repository: profile,
                            revision: revision,
                            builder: (dialogContext, _, current) {
                              final available =
                                  current != null &&
                                  (current['entries'] as List).any(
                                    (e) =>
                                        e['key'] == entry['key'] &&
                                        e['text'] == entry['text'],
                                  );
                              final refs = (entry['evidence_ids'] as List)
                                  .toSet();
                              final messages = available
                                  ? host.sources.sources
                                        .expand(host.sources.messages)
                                        .where(
                                          (m) =>
                                              refs.contains(m['evidence_id']),
                                        )
                                        .toList()
                                  : <Map<String, dynamic>>[];
                              return AlertDialog(
                                title: const Text('来源依据'),
                                content: SizedBox(
                                  width: 500,
                                  child: SingleChildScrollView(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        if (!available)
                                          const Text('来源已过期或授权已改变，当前依据不再可用。'),
                                        for (final m in messages) ...[
                                          Text(
                                            '${_sourceTime(DateTime.fromMillisecondsSinceEpoch(m['created_at']).toIso8601String())} · ${m['relation'] == 'self' ? '本人' : '其他参与者'}',
                                          ),
                                          SelectableText(
                                            m['text'] as String? ?? '正文不可用',
                                          ),
                                          const Divider(),
                                        ],
                                      ],
                                    ),
                                  ),
                                ),
                                actions: [
                                  TextButton(
                                    onPressed: () =>
                                        Navigator.pop(dialogContext),
                                    child: const Text('关闭'),
                                  ),
                                ],
                              );
                            },
                          ),
                        ),
                ),
            ],
        ],
      );
    },
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
  final Widget Function(BuildContext, ProfileRepository, Map<String, dynamic>?)
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
  @override
  void initState() {
    super.initState();
    widget.host.addListener(_changed);
    widget.authority.addListener(_changed);
    unawaited(_open());
  }

  Future<void> _open() async {
    try {
      await profile.open();
    } catch (_) {
      return;
    }
    if (mounted) setState(() => loaded = true);
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
    final value = loaded && widget.host.ready ? profile.value : null;
    expiry?.cancel();
    if (value != null) {
      final refs = (value['entries'] as List)
          .expand((e) => e['evidence_ids'] as List)
          .toSet();
      final dates =
          widget.host.sources.sources
              .expand(widget.host.sources.messages)
              .where((m) => refs.contains(m['evidence_id']))
              .map((m) => m['created_at'] as int)
              .toList()
            ..sort();
      if (dates.isNotEmpty) {
        final end = DateTime.fromMillisecondsSinceEpoch(
          dates.first,
        ).add(const Duration(days: 30, milliseconds: 1));
        expiry = Timer(end.difference(widget.host.sources.now()), _changed);
      }
    }
    return widget.builder(context, profile, value);
  }

  @override
  void dispose() {
    expiry?.cancel();
    widget.host.removeListener(_changed);
    widget.authority.removeListener(_changed);
    super.dispose();
  }
}
