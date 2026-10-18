import 'dart:async';
import 'package:flutter/material.dart';
import '../personal/personal_store.dart';
import '../protocol/request_id.dart';
import 'strings.dart';

String scheduleErrorText(Object error) {
  final code = error is PersonalCommandError ? error.code : error.toString();
  return const {
        'stale_schedule': 'This schedule changed. Load its latest version.',
        'schedule_in_past': 'Choose a future time.',
        'invalid_params': 'Check the task details and time.',
        'schedule_running': 'The previous run is still active.',
        'context_authorization_changed':
            'Source data changed. Run again for a current result.',
      }[code] ??
      code;
}

class ScheduleEditor extends StatefulWidget {
  const ScheduleEditor({
    super.key,
    required this.store,
    this.value = const {},
    this.language = 'en',
    this.onSaved,
  });
  final PersonalStore store;
  final Map<String, dynamic> value;
  final String language;
  final ValueChanged<Map<String, dynamic>>? onSaved;
  @override
  State<ScheduleEditor> createState() => _ScheduleEditorState();
}

class _ScheduleEditorState extends State<ScheduleEditor> {
  final title = TextEditingController(),
      goal = TextEditingController(),
      criteria = TextEditingController(),
      zone = TextEditingController();
  late Map<String, dynamic> original;
  String kind = 'daily', time = '09:00', date = '';
  Set<int> days = {1};
  Map<String, bool> scopes = {};
  Map<String, dynamic>? next, pending;
  String? error;
  bool busy = false, conflict = false;
  bool shared = false;
  int sequence = 0;
  Timer? timer;
  String t(String text) => tr(widget.language, text);
  Map<String, dynamic> get rule => {
    'kind': kind,
    'time': time,
    'timezone': zone.text.trim(),
    if (kind == 'once') 'date': date,
    if (kind == 'weekly') 'weekdays': (days.toList()..sort()),
  };
  bool get locked => busy || pending != null;
  @override
  void initState() {
    super.initState();
    _load(widget.value);
    widget.store.addListener(_changed);
    zone.addListener(_calendarChanged);
    scheduleMicrotask(_preview);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  void _load(Map<String, dynamic> value) {
    original = Map.from(value);
    title.text = value['title'] as String? ?? '';
    goal.text = value['goal'] as String? ?? '';
    criteria.text =
        (value['acceptance'] as List? ??
                [t('Complete the task and explain evidence and uncertainty.')])
            .join('\n');
    final r = Map<String, dynamic>.from(value['rule'] as Map? ?? {});
    kind = r['kind'] as String? ?? 'daily';
    time = r['time'] as String? ?? '09:00';
    date =
        r['date'] as String? ??
        DateTime.now().toIso8601String().substring(0, 10);
    days = (r['weekdays'] as List? ?? [1]).cast<int>().toSet();
    zone.text =
        r['timezone'] as String? ??
        widget.store.snapshot?.object('settings')['timezone'] as String? ??
        'UTC';
    scopes = {
      for (final key in [
        'todos',
        'goals',
        'tasks',
        'memory',
        'knowledge',
        'search',
      ])
        key:
            (value['context'] as Map?)?[key] as bool? ??
            ['todos', 'goals', 'tasks'].contains(key),
    };
  }

  @override
  void dispose() {
    timer?.cancel();
    widget.store.removeListener(_changed);
    for (final field in [title, goal, criteria, zone]) {
      field.dispose();
    }
    super.dispose();
  }

  void _calendarChanged() {
    sequence++;
    next = null;
    timer?.cancel();
    timer = Timer(const Duration(milliseconds: 250), _preview);
    if (mounted) setState(() {});
  }

  Future<void> _preview() async {
    if (!widget.store.connected) return;
    final version = ++sequence;
    try {
      final result = await widget.store.command('schedules.preview', {
        'rule': rule,
      });
      if (mounted && version == sequence) {
        setState(() {
          next = result['next_slot'] == null
              ? null
              : Map<String, dynamic>.from(result['next_slot']);
          error = next == null ? t('Choose a future time.') : null;
        });
      }
    } catch (e) {
      if (mounted && version == sequence) {
        setState(() => error = t(scheduleErrorText(e)));
      }
    }
  }

  Future<void> _save() async {
    if (busy || conflict || !widget.store.connected) return;
    if (pending == null) {
      final acceptance = criteria.text
          .split('\n')
          .map((v) => v.trim())
          .where((v) => v.isNotEmpty)
          .toList();
      if (title.text.trim().isEmpty ||
          goal.text.trim().isEmpty ||
          acceptance.isEmpty ||
          acceptance.length > 64 ||
          acceptance.any((v) => v.length > 2000) ||
          zone.text.trim().isEmpty ||
          next == null ||
          kind == 'weekly' && days.isEmpty) {
        setState(() => error = t('Check the task details and time.'));
        return;
      }
      pending = {
        'method': original['id'] == null
            ? 'schedules.create'
            : 'schedules.update',
        'id': requestId(),
        'params': {
          if (original['id'] == null && shared) 'shared': true,
          'input': {
            'title': title.text.trim(),
            'goal': goal.text.trim(),
            'acceptance': acceptance,
            'rule': rule,
            'context': scopes,
          },
          if (original['id'] != null) ...{
            'id': original['id'],
            'expected_revision': original['revision'],
          },
        },
      };
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await widget.store.commandWithRequestId(
        pending!['method'],
        Map<String, dynamic>.from(pending!['params']),
        pending!['id'],
      );
      if (!mounted) return;
      pending = null;
      widget.onSaved?.call(Map<String, dynamic>.from(result as Map));
      if (widget.onSaved == null) await Navigator.maybePop(context);
    } catch (e) {
      if (!mounted) return;
      final code = e is PersonalCommandError ? e.code : '';
      if ([
        'stale_schedule',
        'invalid_params',
        'schedule_in_past',
        'context_not_authorized',
      ].contains(code)) {
        pending = null;
        conflict = code == 'stale_schedule';
        error = t(scheduleErrorText(e));
      } else {
        error = t(
          'Save is not confirmed. Your draft is kept; retry checks the same request.',
        );
        widget.store.refresh(force: true);
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _reload() async {
    try {
      final value = await widget.store.command('schedules.get', {
        'id': original['id'],
      });
      if (!mounted) return;
      setState(() {
        _load(Map<String, dynamic>.from(value));
        conflict = false;
        error = null;
      });
      _calendarChanged();
    } catch (e) {
      if (mounted) setState(() => error = t(scheduleErrorText(e)));
    }
  }

  Future<void> _pickTime() async {
    final parts = time.split(':');
    final selected = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(
        hour: int.tryParse(parts[0]) ?? 9,
        minute: int.tryParse(parts[1]) ?? 0,
      ),
    );
    if (selected != null && mounted) {
      setState(
        () => time =
            '${selected.hour.toString().padLeft(2, '0')}:${selected.minute.toString().padLeft(2, '0')}',
      );
      _calendarChanged();
    }
  }

  Future<void> _pickDate() async {
    final selected = await showDatePicker(
      context: context,
      initialDate: DateTime.tryParse(date) ?? DateTime.now(),
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
    );
    if (selected != null && mounted) {
      setState(() => date = selected.toIso8601String().substring(0, 10));
      _calendarChanged();
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          22,
          20,
          22,
          24 + MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    t(
                      original['id'] == null
                          ? 'Create schedule'
                          : 'Edit schedule',
                    ),
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
                IconButton(
                  tooltip: t('Close'),
                  onPressed: busy ? null : () => Navigator.maybePop(context),
                  icon: const Icon(Icons.close),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              t(
                'Each run is an independent Agent task, using current authorized data.',
              ),
              style: TextStyle(color: colors.onSurfaceVariant, height: 1.6),
            ),
            const SizedBox(height: 22),
            TextField(
              controller: title,
              enabled: !locked,
              maxLength: 200,
              decoration: InputDecoration(
                labelText: t('Task name'),
                counterText: '',
              ),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: goal,
              enabled: !locked,
              minLines: 3,
              maxLines: 6,
              maxLength: 16000,
              decoration: InputDecoration(
                labelText: t('What should Nova do?'),
                counterText: '',
              ),
            ),
            const SizedBox(height: 20),
            SegmentedButton<String>(
              segments: [
                for (final entry in {
                  'once': 'Once',
                  'daily': 'Daily',
                  'weekly': 'Weekly',
                }.entries)
                  ButtonSegment(value: entry.key, label: Text(t(entry.value))),
              ],
              selected: {kind},
              onSelectionChanged: locked
                  ? null
                  : (value) {
                      setState(() => kind = value.first);
                      _calendarChanged();
                    },
            ),
            const SizedBox(height: 14),
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: locked ? null : _pickTime,
                  icon: const Icon(Icons.schedule, size: 18),
                  label: Text(time),
                ),
                if (kind == 'once')
                  OutlinedButton.icon(
                    onPressed: locked ? null : _pickDate,
                    icon: const Icon(Icons.calendar_today, size: 18),
                    label: Text(date),
                  ),
              ],
            ),
            if (kind == 'weekly')
              Wrap(
                spacing: 6,
                children: [
                  for (final day in [1, 2, 3, 4, 5, 6, 7])
                    FilterChip(
                      label: Text(
                        t(
                          [
                            'Mon',
                            'Tue',
                            'Wed',
                            'Thu',
                            'Fri',
                            'Sat',
                            'Sun',
                          ][day - 1],
                        ),
                      ),
                      selected: days.contains(day),
                      onSelected: locked
                          ? null
                          : (selected) {
                              setState(
                                () =>
                                    selected ? days.add(day) : days.remove(day),
                              );
                              _calendarChanged();
                            },
                    ),
                ],
              ),
            const SizedBox(height: 12),
            TextField(
              controller: zone,
              enabled: !locked,
              decoration: InputDecoration(
                labelText: t('Timezone (IANA)'),
                hintText: 'Asia/Shanghai',
              ),
            ),
            const SizedBox(height: 14),
            Semantics(
              liveRegion: true,
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: colors.primary.withValues(alpha: .09),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  next == null
                      ? t('Calculating first run…')
                      : '${t('First run')}: ${next!['local_date'] ?? next!['scheduled_at']} ${next!['local_time'] ?? ''} · ${zone.text}',
                  style: TextStyle(color: colors.primary, height: 1.6),
                ),
              ),
            ),
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              title: Text(t('Success criteria and data access')),
              children: [
                TextField(
                  controller: criteria,
                  enabled: !locked,
                  minLines: 2,
                  maxLines: 6,
                  decoration: InputDecoration(
                    labelText: t('Success criteria (one per line)'),
                  ),
                ),
                const SizedBox(height: 12),
                for (final entry in {
                  'todos': 'Todos',
                  'goals': 'Goals',
                  'tasks': 'Agent tasks',
                  'memory': 'Memory',
                  'knowledge': 'Authorized sources',
                  'search': 'Web search',
                }.entries)
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(t(entry.value)),
                    value: scopes[entry.key],
                    onChanged: locked
                        ? null
                        : (value) => setState(() => scopes[entry.key] = value!),
                  ),
                Text(
                  t('Results become personal items only when you save them.'),
                  style: TextStyle(color: colors.onSurfaceVariant),
                ),
              ],
            ),
            if (original['id'] == null)
              CheckboxListTile(
                title: const Text('创建共享规则，由主电脑负责'),
                subtitle: const Text(
                  '需要主电脑已加入 Hub。已有本机规则不会迁移；共享规则的暂停和交接由负责人管理。',
                ),
                value: shared,
                onChanged: locked
                    ? null
                    : (value) => setState(() => shared = value!),
              ),
            if (error != null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Semantics(
                  liveRegion: true,
                  child: Text(error!, style: TextStyle(color: colors.error)),
                ),
              ),
            if (conflict)
              TextButton(
                onPressed: _reload,
                child: Text(t('Load latest version')),
              ),
            FilledButton(
              onPressed:
                  busy ||
                      conflict ||
                      !widget.store.connected ||
                      pending == null && next == null
                  ? null
                  : _save,
              child: Text(
                t(
                  busy
                      ? 'Saving…'
                      : pending != null
                      ? 'Retry save confirmation'
                      : 'Save schedule',
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
