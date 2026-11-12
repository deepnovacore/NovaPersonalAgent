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
  final section = args['section'] as String;
  final query = (args['query'] as String? ?? '').trim().toLowerCase();
  final offset = args['offset'] as int? ?? 0;
  final rows = [
    for (final entry in (value['entries'] as List).whereType<Map>())
      if ((entry['kind'] ?? 'profile') == section &&
          (entry['explicit'] == true
              ? corrections.contains(entry['key'])
              : _authorized(entry, available)))
        _project(entry),
  ];
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
    'historical': value['historical'] == true,
    'total': matched.length,
    'entries': page,
    if (index < matched.length) 'next_offset': index,
  };
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
  final observed = entry['observed_at'];
  if (date == null && observed is String && observed.length >= 10) {
    date = observed.substring(0, 10);
  }
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
