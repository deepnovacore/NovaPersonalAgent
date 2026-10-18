import 'package:flutter/services.dart';

/// Calendar interpretation is delegated to the OS IANA timezone database.
/// UTC remains available to fixtures and hosts without the native bridge.
class ScheduleClock {
  static const channel = MethodChannel('nova/schedule/v1');
  Future<String> localDay(String zone, DateTime instant) async {
    if (zone == 'UTC') {
      return instant.toUtc().toIso8601String().substring(0, 10);
    }
    final value = await channel.invokeMethod<String>('localDay', {
      'timezone': zone,
      'instant': instant.millisecondsSinceEpoch,
    });
    if (value == null) throw StateError('timezone_unavailable');
    return value;
  }

  Future<({DateTime? instant, DateTime? gapAt})> resolve(
    String zone,
    String day,
    String time,
  ) async {
    if (zone == 'UTC') {
      return (instant: DateTime.parse('${day}T$time:00Z'), gapAt: null);
    }
    final value = await channel.invokeMapMethod<String, dynamic>('resolve', {
      'timezone': zone,
      'date': day,
      'time': time,
    });
    if (value == null) throw StateError('timezone_unavailable');
    return (
      instant: value['instant'] == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch(
              value['instant'] as int,
              isUtc: true,
            ),
      gapAt: value['gap_at'] == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch(
              value['gap_at'] as int,
              isUtc: true,
            ),
    );
  }

  Future<void> validate(Map<String, dynamic> rule) async {
    final kind = rule['kind'];
    if (!['once', 'daily', 'weekly'].contains(kind) ||
        rule['timezone'] is! String ||
        (rule['timezone'] as String).length > 100 ||
        rule['time'] is! String ||
        !RegExp(r'^(?:[01]\d|2[0-3]):[0-5]\d$').hasMatch(rule['time'])) {
      throw StateError('invalid_rule');
    }
    final fields = {
      'kind',
      'timezone',
      'time',
      if (kind == 'once') 'date',
      if (kind == 'weekly') 'weekdays',
    };
    if (rule.keys.toSet().difference(fields).isNotEmpty ||
        fields.difference(rule.keys.toSet()).isNotEmpty) {
      throw StateError('invalid_rule');
    }
    await localDay(rule['timezone'], DateTime.utc(2026));
    if (kind == 'weekly') {
      final days = rule['weekdays'];
      if (days is! List ||
          days.isEmpty ||
          days.toSet().length != days.length ||
          !days.every((n) => n is int && n >= 1 && n <= 7)) {
        throw StateError('invalid_weekdays');
      }
    }
    if (kind == 'once') {
      final day = rule['date'];
      final parsed = day is String
          ? DateTime.tryParse('${day}T00:00:00Z')
          : null;
      if (parsed == null ||
          parsed.toIso8601String().substring(0, 10) != day ||
          (await resolve(rule['timezone'], day, rule['time'])).instant == null) {
        throw StateError('nonexistent_local_time');
      }
    }
  }

  bool _matches(Map<String, dynamic> rule, String day) => rule['kind'] == 'once'
      ? day == rule['date']
      : rule['kind'] == 'daily' ||
            (rule['weekdays'] as List).contains(
              DateTime.parse('${day}T00:00:00Z').weekday,
            );
  String _addDay(String day, int offset) => DateTime.parse(
    '${day}T00:00:00Z',
  ).add(Duration(days: offset)).toIso8601String().substring(0, 10);
  Map<String, dynamic> _slot(
    Map<String, dynamic> rule,
    String day,
    DateTime instant,
  ) => {
    'scheduled_at': instant.toUtc().toIso8601String(),
    'local_date': day,
    'local_time': rule['time'],
    'slot_key': '${rule['timezone']}:$day:${rule['time']}',
  };
  Future<Map<String, dynamic>?> next(
    Map<String, dynamic> rule,
    DateTime after,
  ) async {
    await validate(rule);
    final first = rule['kind'] == 'once'
        ? rule['date'] as String
        : await localDay(rule['timezone'], after);
    for (var i = 0; i < (rule['kind'] == 'once' ? 1 : 370); i++) {
      final day = _addDay(first, i);
      if (!_matches(rule, day)) continue;
      final resolved = await resolve(rule['timezone'], day, rule['time']);
      if (resolved.instant != null && resolved.instant!.isAfter(after)) {
        return _slot(rule, day, resolved.instant!);
      }
    }
    return null;
  }

  Future<({Map<String, dynamic>? latest, int missed, List<String> gaps})> due(
    Map<String, dynamic> rule,
    DateTime after,
    DateTime now,
  ) async {
    await validate(rule);
    if (!now.isAfter(after)) return (latest: null, missed: 0, gaps: <String>[]);
    final first = rule['kind'] == 'once'
        ? rule['date'] as String
        : await localDay(rule['timezone'], after);
    final last = rule['kind'] == 'once'
        ? rule['date'] as String
        : await localDay(rule['timezone'], now);
    Map<String, dynamic>? latest;
    var missed = 0;
    final gaps = <String>[];
    for (var day = first; day.compareTo(last) <= 0; day = _addDay(day, 1)) {
      if (!_matches(rule, day)) continue;
      final resolved = await resolve(rule['timezone'], day, rule['time']),
          instant = resolved.instant;
      if (instant == null) {
        if (resolved.gapAt != null &&
            resolved.gapAt!.isAfter(after) &&
            !resolved.gapAt!.isAfter(now)) {
          gaps.add(day);
        }
        continue;
      }
      if (!instant.isAfter(after) || instant.isAfter(now)) continue;
      if (instant.isBefore(now.subtract(const Duration(hours: 2)))) {
        missed++;
        continue;
      }
      if (latest != null) missed++;
      latest = _slot(rule, day, instant);
    }
    return (latest: latest, missed: missed, gaps: gaps);
  }
}
