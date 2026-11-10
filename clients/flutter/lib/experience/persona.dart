import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../personal/local_life.dart';
import '../space/space_storage.dart';
import '../ui/timeline_page.dart';
import '../ui/timeline_briefs.dart';
import 'persona_sources.dart';

class ExperiencePersona {
  const ExperiencePersona._(
    this.id,
    this.name,
    this.occupation,
    this.files,
    this.hashes,
  );

  static List<ExperiencePersona> choices = const [];
  final Map<String, String> files, hashes;

  static Future<List<ExperiencePersona>> loadManifest({
    AssetBundle? bundle,
  }) async {
    choices = const [];
    final assets = bundle ?? rootBundle;
    String raw;
    try {
      raw = await assets.loadString('assets/experience/manifest.json');
    } on FlutterError {
      return choices = const [];
    }
    final data = jsonDecode(raw);
    if (data is! Map || data['version'] != 1 || data['personas'] is! List) {
      throw const FormatException('invalid_experience_manifest');
    }
    final result = <ExperiencePersona>[];
    final ids = <String>{};
    for (final row in data['personas'] as List) {
      if (row is! Map ||
          row['id'] is! String ||
          !RegExp(r'^[a-z0-9][a-z0-9_-]{0,63}$').hasMatch(row['id']) ||
          !ids.add(row['id']) ||
          row['name'] is! String ||
          (row['name'] as String).trim().isEmpty ||
          row['occupation'] is! String ||
          row['sha256'] is! Map) {
        throw const FormatException('invalid_experience_persona');
      }
      final files = <String, String>{}, hashes = <String, String>{};
      for (final field in const [
        'profile',
        'sources',
        'memory',
        'snapshot',
        'avatar',
      ]) {
        final file = row[field], hash = row['sha256'][field];
        if (file is! String ||
            !RegExp(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$').hasMatch(file) ||
            file.contains('..') ||
            hash is! String ||
            !RegExp(r'^[a-f0-9]{64}$').hasMatch(hash)) {
          throw const FormatException('invalid_experience_asset');
        }
        files[field] = file;
        hashes[field] = hash;
        final bytes = Uint8List.sublistView(
          await assets.load('assets/experience/$file'),
        );
        if (bytes.length > 32 * 1024 * 1024 ||
            sha256.convert(bytes).toString() != hash) {
          throw const FormatException('experience_asset_hash_mismatch');
        }
      }
      result.add(
        ExperiencePersona._(
          row['id'],
          row['name'],
          row['occupation'],
          files,
          hashes,
        ),
      );
    }
    return choices = List.unmodifiable(result);
  }

  String asset(String field) => 'assets/experience/${files[field]!}';
  final String id, name, occupation;

  static ExperiencePersona byId(String id) =>
      choices.firstWhere((p) => p.id == id);

  static String spaceDisplayName(SpaceRecord space) {
    for (final persona in choices) {
      if (space.personaId == persona.id &&
          space.name == '${persona.name}的体验 Space') {
        return persona.name;
      }
    }
    return space.name;
  }

  static Future<Map<String, dynamic>> _load(String id) async {
    final persona = byId(id);
    final source = await rootBundle.loadString(persona.asset('profile'));
    return jsonDecode(source) as Map<String, dynamic>;
  }

  // UTC carries the original local calendar date, without a movable offset.
  static DateTime localDayAnchor([DateTime? now]) {
    final local = (now ?? DateTime.now()).toLocal();
    return DateTime.utc(local.year, local.month, local.day);
  }

  static String _day(DateTime anchor, int offset) {
    final date = anchor.toUtc();
    return DateTime.utc(
      date.year,
      date.month,
      date.day + offset,
    ).toIso8601String().substring(0, 10);
  }

  static List<Map<String, dynamic>> _dated(Object? rows, DateTime anchor) => [
    for (final row in (rows as List).cast<Map<String, dynamic>>())
      Map<String, dynamic>.of(row)
        ..['date'] = _day(anchor, row['days'] as int)
        ..remove('days'),
  ];

  static Future<String> context(String id, DateTime? anchor) async {
    final data = await _load(id);
    final day = anchor ?? localDayAnchor();
    return '以下是当前体验 Space 的虚构示例资料。以该角色为背景协助用户，'
        '涉及人物或记录时明确是示例。\n'
        '${jsonEncode({'name': data['name'], 'occupation': data['occupation'], 'todos': _dated(data['todos'], day)})}';
  }

  Widget avatar({double size = 46}) => ClipOval(
    child: Image.asset(
      asset('avatar'),
      width: size,
      height: size,
      fit: BoxFit.cover,
      excludeFromSemantics: true,
    ),
  );

  static Future<void> seed(SpaceRecord space) async {
    final id = space.personaId;
    if (id == null) return;
    final directory = await SpaceStorage.directory(space: space);
    final life = LocalLife(
      FileLifePersistence(File('${directory.path}/local-life-v2.json')),
    );
    try {
      await seedInto(life, id, space.experienceSeededAt!);
    } finally {
      life.dispose();
    }
  }

  static Future<void> seedInto(
    LocalLife life,
    String id,
    DateTime anchor,
  ) async {
    final data = await _load(id);
    await life.open();
    if (life.life['profile']['version'] == 0) {
      await life.mutate({
        'op': 'profile',
        'about': data['about'],
        'expected_version': 0,
      }, operationId: 'experience.$id.profile');
    }

    Future<void> create(String kind, List<Map<String, dynamic>> rows) async {
      for (final (index, row) in rows.indexed) {
        final operation = 'experience.$id.$kind.$index';
        if (life.operationReceipt(operation) != null) continue;
        await life.mutate({
          'op': 'create',
          'kind': kind,
          'title': row['title'],
          if (row['note'] != null) 'note': row['note'],
          if (row['date'] != null) 'due': row['date'],
        }, operationId: operation);
      }
    }

    await create('goal', (data['goals'] as List).cast<Map<String, dynamic>>());
    await create('idea', [
      for (final title in data['ideas'] as List) {'title': title},
    ]);
    await create('todo', _dated(data['todos'], anchor));
    for (final row in (data['source_todos'] as List).cast<Map>()) {
      final operation = 'experience.$id.source-todo.${row['key']}';
      final item =
          life.operationReceipt(operation) ??
          await life.mutate({
            'op': 'create',
            'kind': 'todo',
            'title': row['title'],
            'note': row['note'],
            'due': row['date'],
          }, operationId: operation);
      final current = (life.life['todos'] as List)
          .cast<Map>()
          .where((todo) => todo['id'] == item['id'])
          .firstOrNull;
      if (current?['version'] == 1 && row['state'] != 'open') {
        await life.mutate({
          'op': 'update',
          'kind': 'todo',
          'id': item['id'],
          'expected_version': 1,
          'status': row['state'],
        }, operationId: '$operation.state');
      }
    }
  }
}

class ExperiencePersonaProfile extends StatefulWidget {
  const ExperiencePersonaProfile({
    super.key,
    required this.personaId,
    this.sources,
    this.onRefresh,
    this.refreshing = false,
  });

  final String personaId;
  final ExperiencePersonaSources? sources;
  final VoidCallback? onRefresh;
  final bool refreshing;

  @override
  State<ExperiencePersonaProfile> createState() =>
      _ExperiencePersonaProfileState();
}

class _ExperiencePersonaProfileState extends State<ExperiencePersonaProfile> {
  late Future<Map<String, dynamic>> _profile = ExperiencePersona._load(
    widget.personaId,
  );

  @override
  void didUpdateWidget(ExperiencePersonaProfile oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.personaId != widget.personaId) {
      _profile = ExperiencePersona._load(widget.personaId);
    }
  }

  @override
  Widget build(BuildContext context) => FutureBuilder(
    future: _profile,
    builder: (context, snapshot) {
      final data = snapshot.data;
      if (data == null) {
        return Text(snapshot.hasError ? '示例资料暂不可用' : '正在打开示例资料…');
      }
      final persona = ExperiencePersona.byId(widget.personaId);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              persona.avatar(),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  '${persona.name} · ${persona.occupation}',
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(data['about'] as String, style: const TextStyle(height: 1.5)),
          const SizedBox(height: 8),
          Text(
            '兴趣 · ${(data['interests'] as List).join('、')}',
            style: TextStyle(
              fontSize: 12,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          if (widget.sources case final sources?) ...[
            TextButton(
              onPressed: () =>
                  _showSources(context, sources, sources.records.keys),
              child: Text('查看示例来源 · ${sources.records.length} 条'),
            ),
            if (widget.onRefresh != null || widget.refreshing)
              TextButton(
                onPressed: widget.refreshing ? null : widget.onRefresh,
                child: Text(widget.refreshing ? '正在提取…' : '重新提取画像和时间线'),
              ),
            ValueListenableBuilder(
              valueListenable: sources.snapshot,
              builder: (context, snapshot, _) => Material(
                type: MaterialType.transparency,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final row in (snapshot?['profile'] as List? ?? []))
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(row['title'] as String),
                        subtitle: Text(row['text'] as String),
                        trailing: const Icon(Icons.source_outlined),
                        onTap: () =>
                            _showSources(context, sources, row['refs'] as List),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ],
      );
    },
  );
}

class ExperiencePersonaTimeline extends StatefulWidget
    implements TimelineBriefSummary {
  const ExperiencePersonaTimeline({
    super.key,
    required this.personaId,
    this.anchor,
    this.sources,
  });

  final String personaId;
  final DateTime? anchor;
  final ExperiencePersonaSources? sources;

  TimelineBriefs _generated(
    ExperiencePersonaSources sources,
    List rows, {
    BuildContext? context,
  }) => TimelineBriefs(
    entries: [
      for (final (index, row) in rows.indexed)
        {
          'key': 'persona-timeline-$index',
          'observed_at': (row['refs'] as List)
              .map((ref) => sources.records[ref]!['observed_at'] as String)
              .reduce((a, b) => a.compareTo(b) >= 0 ? a : b),
          'evidence_ids': row['refs'],
          'time':
              row['time'] ??
              sources.timelineTime((row['refs'] as List).cast<String>()),
          'brief': {
            'title': row['title'],
            'facts': [
              {'text': row['summary']},
            ],
          },
        },
    ],
    availableEvidenceIds: sources.records.keys.toList(),
    onOpenSources: context == null
        ? null
        : (entry) =>
              _showSources(context, sources, entry['evidence_ids'] as List),
  );

  @override
  int todayBriefCount(DateTime now) {
    if (sources?.snapshot.value?['timeline'] case final List rows) {
      return _generated(sources!, rows).todayBriefCount(now);
    }
    final today = ExperiencePersona.localDayAnchor(now);
    return ExperiencePersona._day(anchor ?? today, 0) ==
            ExperiencePersona._day(today, 0)
        ? 1
        : 0;
  }

  @override
  State<ExperiencePersonaTimeline> createState() =>
      _ExperiencePersonaTimelineState();
}

class _ExperiencePersonaTimelineState extends State<ExperiencePersonaTimeline> {
  late Future<Map<String, dynamic>> _timeline = ExperiencePersona._load(
    widget.personaId,
  );
  final DateTime _openedAt = ExperiencePersona.localDayAnchor();

  @override
  void didUpdateWidget(ExperiencePersonaTimeline oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.personaId != widget.personaId) {
      _timeline = ExperiencePersona._load(widget.personaId);
    }
  }

  @override
  Widget build(BuildContext context) {
    final sources = widget.sources;
    if (sources == null) return _fallback();
    return ValueListenableBuilder(
      valueListenable: sources.snapshot,
      builder: (context, snapshot, _) => snapshot == null
          ? _fallback()
          : widget._generated(
              sources,
              snapshot['timeline'] as List,
              context: context,
            ),
    );
  }

  Widget _fallback() => FutureBuilder(
    future: _timeline,
    builder: (context, snapshot) {
      final data = snapshot.data;
      if (data == null) {
        return Text(snapshot.hasError ? '示例简报暂不可用' : '正在打开示例简报…');
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final row in ExperiencePersona._dated(
            data['timeline'],
            widget.anchor ?? _openedAt,
          ))
            Card(
              color: Theme.of(context).colorScheme.surface,
              margin: const EdgeInsets.only(bottom: 8),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${row['date']} · 示例简报',
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      row['title'] as String,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 4),
                    Text(row['summary'] as String),
                  ],
                ),
              ),
            ),
        ],
      );
    },
  );
}

Future<void> _showSources(
  BuildContext context,
  ExperiencePersonaSources sources,
  Iterable refs,
) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  builder: (context) {
    final rows = refs
        .map((ref) => sources.records[ref])
        .whereType<Map>()
        .toList();
    return SizedBox(
      height: MediaQuery.sizeOf(context).height * .75,
      child: Column(
        children: [
          const ListTile(title: Text('合成来源')),
          Expanded(
            child: ListView.separated(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              itemCount: rows.length,
              separatorBuilder: (_, _) => const Divider(),
              itemBuilder: (context, index) {
                final row = rows[index];
                final sender = (row['metadata'] as Map?)?['sender_name'];
                final kind = switch (row['kind']) {
                  'im' => '聊天',
                  'mail' => '邮件',
                  'file' => '文件',
                  _ => '日历',
                };
                return ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text('$kind · ${sender ?? '示例角色'}'),
                  subtitle: SelectableText(
                    '${timelineSourceTime(row['observed_at'] as String, 'zh')}\n${row['text']}',
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  },
);
