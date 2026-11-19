import 'dart:convert';

import 'profile_repository.dart';
import 'source_store.dart';

/// Character budget for one profile_read page, leaving room for the tool
/// envelope inside provider limits.
const profileReadCharBudget = 12000;
const _pageEntries = 20;

/// Projects the confirmed, currently valid profile for a model request.
///
/// [provider] is the `endpoint|model` the result will be sent to; it must hold
/// the same processing grant the profile writer needs, so a projection is
/// never forwarded to a model the user has not allowed to process the sources.
Future<Map<String, dynamic>> readProfileForModel({
  required ProfileRepository repository,
  required SourceStore sources,
  required String? provider,
  required Map<String, dynamic> args,
}) async {
  Map<String, dynamic> unavailable(String reason) => {
    'available': false,
    'reason': reason,
    'entries': const <Object>[],
  };
  if (provider == null || provider.isEmpty) {
    return unavailable('model_settings_required');
  }
  bool permitted() {
    try {
      sources.validateProcessing(
        provider,
        'profile',
        sources.processingRevision,
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  if (!permitted()) return unavailable('processing_consent_required');
  await repository.open();
  // Consent may be withdrawn while the projection loads.
  if (!permitted()) return unavailable('processing_consent_required');
  final value = repository.value;
  if (value == null) return unavailable('no_confirmed_profile');
  // A correction is granted to the model the user named when saving it.
  final corrections =
      repository.corrections
          ?.values(repository.correctionScope, provider: provider)
          .keys
          .toSet() ??
      const <String>{};
  // Retained history of removed or expired sources stays on this phone; a
  // derived entry is model-visible only while all its evidence is authorized.
  final available = Set<String>.from(
    value['available_evidence_ids'] as List? ?? const [],
  );
  available.retainAll(
    sources
        .readAuthorizedEvidence(provider, 'profile')
        .map((row) => row['evidence_id'] as String),
  );
  final section = args['section'] as String;
  final rows = [
    for (final entry in (value['entries'] as List).whereType<Map>())
      if ((entry['kind'] ?? 'profile') == section &&
          (entry['explicit'] == true
              ? corrections.contains(entry['key'])
              : _authorized(entry, available)))
        _project(entry),
  ];
  return {..._page(rows, args), 'historical': value['historical'] == true};
}

/// Projects a persona Space's fictional profile/timeline snapshot. It holds
/// only packaged example material, so no processing grant applies.
Map<String, dynamic> readPersonaProfileForModel(
  Map<String, dynamic>? snapshot,
  Map<String, dynamic> args,
) {
  final section = args['section'] as String;
  final source = snapshot?[section];
  if (source is! List) {
    return {
      'available': false,
      'reason': 'no_persona_profile',
      'entries': const <Object>[],
    };
  }
  final rows = <Map<String, dynamic>>[];
  for (final (index, row) in source.whereType<Map>().indexed) {
    final time = row['time'];
    final date = _date(time, null);
    final facts = row['facts'];
    rows.add({
      'key': '$section-$index',
      if (row['title'] is String) 'title': row['title'],
      'text': _clip(row[section == 'profile' ? 'text' : 'summary']),
      'date': ?date,
      if (time is Map && time['kind'] is String) 'time_kind': time['kind'],
      if (row['status_label'] is String) 'status': row['status_label'],
      if (facts is List)
        'facts': [
          for (final fact in facts)
            if (fact is String)
              _clip(fact)
            else if (fact is Map && fact['text'] is String)
              _clip(fact['text']),
        ],
    });
  }
  return {..._page(rows, args), 'fictional_example': true};
}

/// Filters, orders and pages projected rows within [profileReadCharBudget].
Map<String, dynamic> _page(
  List<Map<String, dynamic>> rows,
  Map<String, dynamic> args,
) {
  final section = args['section'] as String;
  final query = (args['query'] as String? ?? '').trim().toLowerCase();
  final offset = args['offset'] as int? ?? 0;
  if (section == 'timeline') {
    rows.sort((a, b) => '${b['date'] ?? ''}'.compareTo('${a['date'] ?? ''}'));
  }
  final matched = query.isEmpty
      ? rows
      : rows
            .where((row) => jsonEncode(row).toLowerCase().contains(query))
            .toList();
  final page = <Map<String, dynamic>>[];
  var used = 0;
  var index = offset;
  for (; index < matched.length && page.length < _pageEntries; index++) {
    final size = jsonEncode(matched[index]).length;
    if (page.isNotEmpty && used + size > profileReadCharBudget) break;
    page.add(matched[index]);
    used += size;
  }
  return {
    'available': true,
    'section': section,
    'total': matched.length,
    'entries': page,
    if (index < matched.length) 'next_offset': index,
  };
}

String? _date(Object? time, Object? observed) {
  String? date;
  if (time is Map) {
    date =
        (time['anchor_date'] ??
                time['occurred_on'] ??
                time['started_on'] ??
                time['last_reported_on'] ??
                time['as_of'] ??
                time['evidence_to'])
            as String?;
  }
  if (date == null && observed is String && observed.length >= 10) {
    date = observed.substring(0, 10);
  }
  return date;
}

bool _authorized(Map entry, Set<String> available) {
  final refs = entry['evidence_ids'];
  return refs is List &&
      refs.isNotEmpty &&
      refs.every((ref) => ref is String && available.contains(ref));
}

Map<String, dynamic> _project(Map entry) {
  final brief = entry['brief'];
  final time = entry['time'];
  final date = _date(time, entry['observed_at']);
  return {
    'key': entry['key'],
    if (brief is Map && brief['title'] is String) 'title': brief['title'],
    'text': _clip(entry['text']),
    'date': ?date,
    if (time is Map && time['kind'] is String) 'time_kind': time['kind'],
    if (brief is Map && brief['status_label'] is String)
      'status': brief['status_label'],
    if (brief is Map && brief['facts'] is List)
      'facts': [
        for (final fact in (brief['facts'] as List).whereType<Map>())
          if (fact['text'] is String) _clip(fact['text']),
      ],
    if (entry['explicit'] == true) 'user_corrected': true,
  };
}

String _clip(Object? text) {
  final value = text is String ? text : '';
  return value.length <= 2600 ? value : value.substring(0, 2600);
}
