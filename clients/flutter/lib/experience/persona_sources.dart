import 'dart:convert';
import 'dart:io' show File, FileSystemException;

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../memory/local_memory_store.dart';
import '../personal/local_life.dart';
import 'persona.dart';

/// Packaged sources belong to the selected persona and are read only.
class ExperiencePersonaSources {
  ExperiencePersonaSources._(this.id, this.version, this.records, this.input);

  final String id, version;
  final Map<String, dynamic> input;
  final Map<String, Map<String, dynamic>> records;
  final snapshot = ValueNotifier<Map<String, dynamic>?>(null);

  Map<String, dynamic> validateSnapshot(Map<String, dynamic> data) {
    if (data.keys.any(
          (key) =>
              !const {'profile', 'timeline', 'source_version'}.contains(key),
        ) ||
        (data.containsKey('source_version') &&
            data['source_version'] != version)) {
      throw const FormatException('invalid_persona_snapshot');
    }
    for (final section in const ['profile', 'timeline']) {
      final rows = data[section];
      final body = section == 'profile' ? 'text' : 'summary';
      if (rows is! List ||
          rows.isEmpty ||
          rows.length > (section == 'profile' ? 40 : 200)) {
        throw const FormatException('invalid_persona_snapshot');
      }
      for (final row in rows) {
        if (row is! Map ||
            row.length !=
                (section == 'timeline' && row.containsKey('time') ? 4 : 3) ||
            (row.containsKey('time') &&
                (section != 'timeline' || !_validTime(row['time']))) ||
            !_bounded(row['title'], 120) ||
            !_bounded(row[body], 2600)) {
          throw const FormatException('invalid_persona_snapshot');
        }
        final refs = row['refs'];
        if (refs is! List ||
            refs.isEmpty ||
            refs.length > 64 ||
            refs.toSet().length != refs.length ||
            refs.any((ref) => !records.containsKey(ref))) {
          throw const FormatException('invalid_persona_reference');
        }
      }
    }
    return {...data, 'source_version': version};
  }

  static bool _validTime(Object? value) {
    const dates = {
      'anchor_date',
      'occurred_on',
      'started_on',
      'due_on',
      'scheduled_on',
      'last_reported_on',
      'evidence_from',
      'evidence_to',
      'as_of',
    };
    if (value is! Map ||
        value.length != 11 ||
        value.keys.any(
          (key) => !{...dates, 'kind', 'anchor_basis'}.contains(key),
        ) ||
        !const {
          'event',
          'ongoing',
          'deadline',
          'scheduled',
          'synthesis',
          'background',
          'unknown',
        }.contains(value['kind']) ||
        !const {
          'occurred',
          'deadline',
          'scheduled',
          'reported',
          'unknown',
        }.contains(value['anchor_basis'])) {
      return false;
    }
    return dates.every((key) {
      final day = value[key];
      if (day == null) return key != 'as_of';
      if (day is! String || !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(day)) {
        return false;
      }
      final parsed = DateTime.tryParse(day);
      return parsed != null && parsed.toIso8601String().substring(0, 10) == day;
    });
  }

  static String _shanghaiDay(String value) => DateTime.parse(
    value,
  ).toUtc().add(const Duration(hours: 8)).toIso8601String().substring(0, 10);

  String get sceneDate => records.values
      .map((row) => _shanghaiDay(row['observed_at'] as String))
      .reduce((a, b) => a.compareTo(b) >= 0 ? a : b);

  Map<String, String> timelineTime(List<String> refs) {
    final originals = refs.map((ref) => records[ref]!).toList();
    final schedules = originals.map((row) {
      final start = (row['metadata'] as Map?)?['start_at'];
      return row['kind'] == 'calendar' &&
              start is String &&
              DateTime.tryParse(start) != null
          ? _shanghaiDay(start)
          : null;
    }).toSet();
    final scheduled = schedules.length == 1 ? schedules.single : null;
    if (scheduled != null) {
      return {'anchor_date': scheduled, 'scheduled_on': scheduled};
    }
    final latest = originals
        .map((row) => _shanghaiDay(row['observed_at'] as String))
        .reduce((a, b) => a.compareTo(b) >= 0 ? a : b);
    return {'anchor_date': latest};
  }

  static bool _bounded(Object? value, int limit) =>
      value is String && value.trim().isNotEmpty && value.length <= limit;

  Future<void> restoreSnapshot(LifePersistence? storage) async {
    Map<String, dynamic> decode(String encoded) {
      final data = jsonDecode(encoded) as Map<String, dynamic>;
      if (data['source_version'] != version) {
        throw const FormatException('invalid_persona_version');
      }
      return validateSnapshot(data);
    }

    try {
      final saved = await storage?.read();
      if (saved != null) {
        snapshot.value = decode(saved);
        return;
      }
    } on FormatException {
      // A stale or invalid saved response leaves the bundled baseline visible.
    } on TypeError {
      // Old or unreadable format.
    } on FileSystemException {
      // The packaged snapshot remains usable if local storage is unreadable.
    }
    final raw = await rootBundle.loadString(
      ExperiencePersona.byId(id).asset('snapshot'),
    );
    snapshot.value = decode(raw);
  }

  Future<void> replaceSnapshot(
    Map<String, dynamic> result,
    LifePersistence storage,
    bool Function() isCurrent,
  ) async {
    final validated = validateSnapshot(result);
    if (!isCurrent()) return;
    await storage.write(jsonEncode(validated));
    if (isCurrent()) snapshot.value = validated;
  }

  static Future<ExperiencePersonaSources> load(String id) async {
    final asset = await rootBundle.load(
      ExperiencePersona.byId(id).asset('sources'),
    );
    final raw = Uint8List.sublistView(asset);
    final data = jsonDecode(utf8.decode(raw)) as Map<String, dynamic>;
    final rows = (data['records'] as List).cast<Map<String, dynamic>>();
    final indexed = {for (final row in rows) row['id'] as String: row};
    if (rows.isEmpty ||
        rows.length > 10000 ||
        indexed.length != rows.length ||
        rows.any(
          (row) =>
              !const {'im', 'mail', 'calendar', 'file'}.contains(row['kind']) ||
              !(row['locator'] as String).startsWith('synthetic://') ||
              DateTime.tryParse(row['observed_at'] as String) == null ||
              (row['text'] as String).trim().isEmpty,
        )) {
      throw const FormatException('invalid_persona_sources');
    }
    return ExperiencePersonaSources._(
      id,
      sha256.convert(raw).toString(),
      indexed,
      data,
    );
  }

  Future<void> seedMemory(LocalMemoryStore store) async {
    final raw = await rootBundle.loadString(
      ExperiencePersona.byId(id).asset('memory'),
    );
    final data = jsonDecode(raw) as Map<String, dynamic>;
    final anchor = DateTime.parse(data['as_of'] as String);
    final entries = <LocalMemoryEntry>[];
    for (final row in (data['entries'] as List).cast<Map<String, dynamic>>()) {
      final source = records[row['source']];
      final quote = row['quote'] as String;
      if (source == null || !(source['text'] as String).contains(quote)) {
        throw const FormatException('invalid_persona_quote');
      }
      entries.add(
        LocalMemoryEntry(
          id: 'persona:$id:${row['key']}',
          kind: row['kind'] as String,
          text: row['text'] as String,
          quote: quote,
          createdAt: anchor,
        ),
      );
    }
    await store.seedPersona(entries);
  }

  Map<String, dynamic> read(Map<String, dynamic> args) {
    final offset = args['offset'] as int;
    final query = (args['query'] as String? ?? '').trim().toLowerCase();
    final rows = records.values
        .where((row) => (row['text'] as String).toLowerCase().contains(query))
        .toList();
    final selected = rows.skip(offset).take(8);
    return {
      'records': [
        for (final row in selected)
          {
            'id': row['id'],
            'kind': row['kind'],
            if (row['kind'] == 'file')
              for (final key in const ['file_name', 'doc_type', 'version'])
                key: (row['metadata'] as Map?)?[key],
            'observed_at': row['observed_at'],
            'sender': (row['metadata'] as Map?)?['sender_name'],
            'text': row['text'],
          },
      ],
      if (offset + 8 < rows.length) 'next_offset': offset + 8,
    };
  }
}

class PersonaSnapshotPersistence extends FileLifePersistence {
  PersonaSnapshotPersistence(super.file, {required this.isCurrent});

  final bool Function() isCurrent;

  @override
  Future<void> replacePending(File temporary) {
    if (!isCurrent()) throw StateError('persona_space_changed');
    return super.replacePending(temporary);
  }
}
