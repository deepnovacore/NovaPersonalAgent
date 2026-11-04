const _kinds = {
  'event',
  'ongoing',
  'deadline',
  'scheduled',
  'synthesis',
  'background',
  'unknown',
};
const _roles = {'occurred', 'started', 'deadline', 'scheduled'};
final _datePattern = RegExp(r'^\d{4}-\d{2}-\d{2}$');
final _calendarPattern = RegExp(
  r'(?<!\d)(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})(?:日)?(?!\d)',
);
final _relativeDatePattern = RegExp(r'(?<!大)(?:大前天|大后天|前天|昨天|今天|今日|明天|后天)');
final _dateExpression = RegExp(r'(?:\d{1,4}[-/年月]\d{1,2}|前天|昨天|今天|今日|明天|后天)');

bool _validDate(Object? value) {
  if (value is! String || !_datePattern.hasMatch(value)) return false;
  final parsed = DateTime.tryParse('${value}T00:00:00Z');
  return parsed != null && parsed.toIso8601String().substring(0, 10) == value;
}

bool _supportsDate(String date, String quote, String? reported) {
  final dates = <String>{};
  for (final match in _calendarPattern.allMatches(quote)) {
    final year = match[1] ?? reported?.substring(0, 4);
    if (year != null) {
      dates.add(
        '$year-${match[2]!.padLeft(2, '0')}-${match[3]!.padLeft(2, '0')}',
      );
    }
  }
  if (reported != null) {
    const offsets = {
      '大前天': -3,
      '前天': -2,
      '昨天': -1,
      '今天': 0,
      '今日': 0,
      '明天': 1,
      '后天': 2,
      '大后天': 3,
    };
    for (final match in _relativeDatePattern.allMatches(quote)) {
      dates.add(
        DateTime.parse('${reported}T00:00:00Z')
            .add(Duration(days: offsets[match[0]]!))
            .toIso8601String()
            .substring(0, 10),
      );
    }
  }
  return dates.contains(date);
}

/// Legacy cards retain stable placement against their saved reference day.
Map<String, dynamic> effectiveTimelineAnchor(Map? time) {
  final anchor = time?['anchor_date'],
      basis = time?['anchor_basis'] ?? 'unknown';
  final asOf = time?['as_of'], reported = time?['last_reported_on'];
  if ((basis == 'deadline' || basis == 'scheduled') &&
      anchor is String &&
      asOf is String &&
      anchor.compareTo(asOf) > 0 &&
      reported is String &&
      reported.isNotEmpty) {
    return {'anchor_date': reported, 'anchor_basis': 'reported'};
  }
  return {'anchor_date': anchor, 'anchor_basis': basis};
}

/// Records must be the card's cited originals, with device-local local_date.
/// Mirrors desktop timeline-time; never infers occurrence from message metadata.
Map<String, dynamic>? resolveTimelineTime(
  Object? temporal,
  List<Map<String, dynamic>> records, {
  required String localDate,
}) {
  if (!_validDate(localDate) ||
      temporal is! Map ||
      temporal.length != 2 ||
      !temporal.containsKey('kind') ||
      !temporal.containsKey('dates') ||
      !_kinds.contains(temporal['kind'])) {
    return null;
  }
  final kind = temporal['kind'];
  final claims = temporal['dates'];
  if (claims is! List || claims.length > 3 || kind == 'background') return null;
  final originals = {
    for (final record in records) record['evidence_id']: record,
  };
  String? reportedDate(Map<String, dynamic> record) =>
      _validDate(record['local_date']) ? record['local_date'] as String : null;
  final roles = <String, String>{};
  for (final claim in claims) {
    if (claim is! Map ||
        claim.length != 4 ||
        !claim.keys.every({'role', 'date', 'ref', 'quote'}.contains) ||
        !_roles.contains(claim['role']) ||
        !_validDate(claim['date'])) {
      return null;
    }
    final ref = claim['ref'], quote = claim['quote'];
    if (ref is! String ||
        ref.isEmpty ||
        ref.length > 600 ||
        quote is! String ||
        quote.isEmpty ||
        quote.length > 600) {
      return null;
    }
    final record = originals[ref];
    if (record == null ||
        record['text'] is! String ||
        !(record['text'] as String).contains(quote)) {
      return null;
    }
    final role = claim['role'] as String, date = claim['date'] as String;
    final reported = reportedDate(record);
    // A redundant metadata date may ground a report, never an occurrence.
    if (role == 'occurred' &&
        date == reported &&
        !_dateExpression.hasMatch(quote)) {
      continue;
    }
    if (roles.containsKey(role) ||
        !_supportsDate(date, quote, reported) ||
        ((role == 'occurred' || role == 'started') &&
            date.compareTo(localDate) > 0)) {
      return null;
    }
    roles[role] = date;
  }
  final occurred = roles['occurred'], started = roles['started'];
  final due = roles['deadline'], scheduled = roles['scheduled'];
  final observed =
      records
          .map(reportedDate)
          .whereType<String>()
          .where((day) => day.compareTo(localDate) <= 0)
          .toList()
        ..sort();
  final last = observed.isEmpty ? null : observed.last;
  if (started != null &&
      ((occurred != null && started.compareTo(occurred) > 0) ||
          (last != null && started.compareTo(last) > 0))) {
    return null;
  }
  if ((kind == 'deadline' && due == null) ||
      (kind == 'scheduled' && scheduled == null)) {
    return null;
  }
  final basis = kind == 'unknown'
      ? 'unknown'
      : kind == 'deadline'
      ? 'deadline'
      : kind == 'scheduled'
      ? 'scheduled'
      : kind == 'event' && occurred != null
      ? 'occurred'
      : last != null
      ? 'reported'
      : occurred != null
      ? 'occurred'
      : 'unknown';
  final anchor = switch (basis) {
    'deadline' => due,
    'scheduled' => scheduled,
    'occurred' => occurred,
    'reported' => last,
    _ => null,
  };
  final time = <String, dynamic>{
    'kind': kind,
    'anchor_date': anchor,
    'anchor_basis': basis,
    'occurred_on': occurred,
    'started_on': started,
    'due_on': due,
    'scheduled_on': scheduled,
    'last_reported_on': last,
    'evidence_from': observed.isEmpty ? null : observed.first,
    'evidence_to': last,
    'as_of': localDate,
  };
  return {...time, ...effectiveTimelineAnchor(time)};
}

bool timelineTimeOutsideWindow(Map<String, dynamic> time, String recentSince) {
  final anchor = time['anchor_date'];
  if (anchor is! String || anchor.compareTo(recentSince) >= 0) return false;
  return ![
    time['due_on'],
    time['scheduled_on'],
  ].any((day) => day is String && day.compareTo(recentSince) >= 0);
}
