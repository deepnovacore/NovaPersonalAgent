import '../protocol/wire.dart';

final class PersonalSnapshot {
  PersonalSnapshot(Map<String, dynamic> value)
    : revision = Wire.integer(value['revision']),
      data = Map.unmodifiable(value) {
    for (final key in [
      'life',
      'conversations',
      'memory',
      'capabilities',
      'news',
      'schedules',
    ]) {
      if (value[key] != null && value[key] is! Map) {
        throw FormatException('Invalid $key');
      }
    }
    for (final key in [
      'tasks',
      'feed',
      'pending_approvals',
      'pending_confirmations',
    ]) {
      if (value[key] != null && value[key] is! List) {
        throw FormatException('Invalid $key');
      }
    }
    final schedules = value['schedules'];
    if (schedules is Map) {
      for (final key in ['items', 'active_runs']) {
        if (schedules[key] != null && schedules[key] is! List) {
          throw FormatException('Invalid schedules.$key');
        }
      }
    }
    final conversations = value['conversations'];
    if (conversations is Map && conversations['messages'] is List) {
      for (final row in conversations['messages']) {
        if (row is Map) parseScheduleReference(row['schedule_ref']);
      }
    }
  }
  final int revision;
  final Map<String, dynamic> data;
  Map<String, dynamic> object(String key) =>
      Map<String, dynamic>.from(data[key] as Map? ?? {});
  List<Map<String, dynamic>> rows(String key) => (data[key] as List? ?? [])
      .map((v) => Map<String, dynamic>.from(v as Map))
      .toList();
  String? get selectedId => object('conversations')['selected_id'] as String?;
}

Map<String, dynamic>? parseScheduleReference(Object? value) {
  if (value == null) return null;
  if (value is! Map ||
      value.keys.any(
        (key) =>
            !['schedule_id', 'revision', 'run_id', 'task_id'].contains(key),
      )) {
    throw const FormatException('Invalid schedule reference');
  }
  final result = Map<String, dynamic>.from(value);
  if (result['schedule_id'] is! String ||
      (result['schedule_id'] as String).isEmpty ||
      result['revision'] is! int ||
      result['revision'] < 1) {
    throw const FormatException('Invalid schedule reference');
  }
  for (final key in ['schedule_id', 'run_id', 'task_id']) {
    if (result[key] != null &&
        (result[key] is! String ||
            (result[key] as String).isEmpty ||
            (result[key] as String).length > 512)) {
      throw const FormatException('Invalid schedule reference');
    }
  }
  return Map.unmodifiable(result);
}
