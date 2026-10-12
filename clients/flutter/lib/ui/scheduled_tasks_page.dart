import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import '../personal/personal_store.dart';
import '../protocol/request_id.dart';
import 'schedule_editor.dart';
import 'strings.dart';

String scheduleRuleText(Map<String, dynamic> rule, String language) {
  final days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  final repeat = rule['kind'] == 'once'
      ? rule['date']
      : rule['kind'] == 'daily'
      ? tr(language, 'Daily')
      : (rule['weekdays'] as List? ?? [])
            .map((day) => tr(language, days[day as int]))
            .join(', ');
  return '$repeat · ${rule['time']} · ${rule['timezone']}';
}

class ScheduledTasksPage extends StatefulWidget {
  const ScheduledTasksPage({
    super.key,
    required this.store,
    this.language = 'en',
    this.embedded = false,
    this.initialId,
    this.onOpenTask,
    this.onOpenConversation,
  });
  final PersonalStore store;
  final String language;
  final bool embedded;
  final String? initialId;
  final Future<void> Function(String)? onOpenTask;
  final VoidCallback? onOpenConversation;
  @override
  State<ScheduledTasksPage> createState() => _ScheduledTasksPageState();
}

class _ScheduledTasksPageState extends State<ScheduledTasksPage> {
  List<Map<String, dynamic>> presets = [];
  Map<String, dynamic>? detail, history;
  String? selected, error, notice;
  bool busy = false, loaded = false;
  final requests = <String, Map<String, dynamic>>{};
  String t(String value) => tr(widget.language, value);
  List<Map<String, dynamic>> rows(Object? value) => (value as List? ?? [])
      .whereType<Map>()
      .map((row) => Map<String, dynamic>.from(row))
      .toList();
  @override
  void initState() {
    super.initState();
    widget.store.addListener(_changed);
    selected = widget.initialId;
    scheduleMicrotask(() => selected == null ? _presets() : _load(selected!));
  }

  @override
  void dispose() {
    widget.store.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
    if (!loaded && widget.store.connected && selected == null) {
      unawaited(_presets());
    }
  }

  Future<void> _presets() async {
    if (loaded || !widget.store.connected) return;
    loaded = true;
    try {
      final result = await widget.store.command('schedules.presets');
      if (mounted) setState(() => presets = rows(result['items']));
    } catch (e) {
      if (mounted) setState(() => error = t(scheduleErrorText(e)));
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    if (busy || !widget.store.connected) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => error = t(scheduleErrorText(e)));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<dynamic> _mutation(
    String operation,
    Map<String, dynamic> params,
  ) async {
    final key = '$operation:${params['id'] ?? params['run_id']}';
    final pending = requests.putIfAbsent(
      key,
      () => {'id': requestId(), 'params': jsonDecode(jsonEncode(params))},
    );
    try {
      final result = await widget.store.commandWithRequestId(
        'schedules.$operation',
        Map<String, dynamic>.from(pending['params']),
        pending['id'],
      );
      requests.remove(key);
      return result;
    } catch (e) {
      if (e is PersonalCommandError &&
          [
            'stale_schedule',
            'schedule_running',
            'invalid_params',
            'context_authorization_changed',
            'version_conflict',
          ].contains(e.code)) {
        requests.remove(key);
      } else {
        widget.store.refresh(force: true);
      }
      rethrow;
    }
  }

  Future<void> _load(String id) async {
    if (!widget.store.connected) return;
    selected = id;
    try {
      final value = await widget.store.command('schedules.get', {'id': id}),
          runs = await widget.store.command('schedules.history', {'id': id});
      if (mounted && selected == id) {
        setState(() {
          detail = Map<String, dynamic>.from(value);
          history = Map<String, dynamic>.from(runs);
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = t(scheduleErrorText(e)));
    }
  }

  Future<void> _editor([Map<String, dynamic>? value]) async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (sheet) => SizedBox(
        height: MediaQuery.sizeOf(sheet).height * .91,
        child: ScheduleEditor(
          store: widget.store,
          value: value ?? {},
          language: widget.language,
          onSaved: (saved) {
            Navigator.pop(sheet);
            unawaited(_load(saved['id'] as String));
          },
        ),
      ),
    );
  }

  Future<void> _history({bool more = false}) async {
    final result = await widget.store.command('schedules.history', {
      'id': selected,
      if (more) 'cursor': history?['next_cursor'],
    });
    if (mounted) {
      setState(
        () => history = {
          ...Map<String, dynamic>.from(result),
          'items': [
            if (more) ...rows(history?['items']),
            ...rows(result['items']),
          ],
        },
      );
    }
  }

  Widget _button(
    String text,
    Future<void> Function() action, {
    IconData? icon,
    bool enabled = true,
    bool requiresConnection = true,
  }) => OutlinedButton.icon(
    onPressed:
        busy || (requiresConnection && !widget.store.connected) || !enabled
        ? null
        : () => _run(action),
    icon: Icon(icon ?? Icons.chevron_right, size: 18),
    label: Text(t(text)),
  );
  Widget _card(Widget child, {Color? accent}) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: colors.outlineVariant.withValues(alpha: .5)),
        gradient: accent == null
            ? null
            : LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [
                  accent.withValues(alpha: .12),
                  colors.surfaceContainerLow,
                ],
              ),
        color: accent == null ? colors.surfaceContainerLow : null,
      ),
      child: child,
    );
  }

  Widget _list() {
    final colors = Theme.of(context).colorScheme,
        items = rows(widget.store.snapshot?.object('schedules')['items']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          t('Let Nova take it from here'),
          style: Theme.of(
            context,
          ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 8),
        Text(
          t('Set a regular time for reviews and follow-ups.'),
          style: TextStyle(color: colors.onSurfaceVariant, height: 1.6),
        ),
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: widget.store.connected ? () => _editor() : null,
          icon: const Icon(Icons.add),
          label: Text(t('Create schedule')),
        ),
        const SizedBox(height: 22),
        if (items.isEmpty)
          _card(
            Column(
              children: [
                Icon(Icons.schedule, size: 34, color: colors.primary),
                const SizedBox(height: 12),
                Text(t('Choose a suggested task, or create your own schedule.')),
              ],
            ),
          ),
        for (final item in items)
          _card(
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      Icons.schedule,
                      color: item['enabled'] == true
                          ? colors.primary
                          : colors.onSurfaceVariant,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        item['title'] as String,
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Text(
                  scheduleRuleText(
                    Map<String, dynamic>.from(item['rule']),
                    widget.language,
                  ),
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  item['enabled'] == true
                      ? '${t('Next run')}: ${item['next_slot']?['local_date'] ?? '—'} ${item['next_slot']?['local_time'] ?? ''}'
                      : t('Paused'),
                ),
                _button('View', () => _load(item['id'] as String)),
              ],
            ),
          ),
        const SizedBox(height: 10),
        Text(
          t('Suggested tasks'),
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 14),
        for (final (index, preset) in presets.indexed)
          _card(
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  index == 0
                      ? Icons.format_list_bulleted
                      : Icons.view_week_outlined,
                  color: index == 0 ? colors.primary : const Color(0xffad99dd),
                ),
                const SizedBox(height: 12),
                Text(
                  widget.language == 'zh'
                      ? preset['input']['title']
                      : t(preset['input']['title']),
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                Text(
                  widget.language == 'zh'
                      ? preset['description']
                      : t(preset['description']),
                  style: TextStyle(color: colors.onSurfaceVariant, height: 1.7),
                ),
                const SizedBox(height: 12),
                Text(
                  scheduleRuleText(
                    Map<String, dynamic>.from(preset['input']['rule']),
                    widget.language,
                  ),
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 10),
                _button(
                  'Set up task',
                  () => _editor(Map<String, dynamic>.from(preset['input'])),
                  icon: Icons.add,
                ),
              ],
            ),
            accent: index == 0 ? colors.primary : const Color(0xffad99dd),
          ),
        Text(
          t('Runs while the Runtime is online. Your phone can be closed.'),
          style: TextStyle(
            color: colors.onSurfaceVariant,
            fontSize: 12,
            height: 1.7,
          ),
        ),
      ],
    );
  }

  Widget _detail() {
    final item = detail;
    if (item == null) {
      return Column(
        children: [
          _button('All schedules', () async {
            setState(() => selected = null);
            if (widget.store.connected) await _presets();
          }, requiresConnection: false),
          if (error == null) const CircularProgressIndicator(),
        ],
      );
    }
    final snapshot = widget.store.snapshot,
        colors = Theme.of(context).colorScheme;
    final current =
        rows(
          snapshot?.object('schedules')['items'],
        ).where((row) => row['id'] == selected).firstOrNull ??
        item;
    final run = rows(
      snapshot?.object('schedules')['active_runs'],
    ).where((row) => row['schedule_id'] == selected).firstOrNull;
    final task = snapshot
        ?.rows('tasks')
        .where((row) => row['id'] == run?['task_id'])
        .firstOrNull;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: _button(
            'All schedules',
            () async {
              setState(() {
                selected = null;
                detail = null;
                history = null;
                notice = null;
              });
              if (widget.store.connected) await _presets();
            },
            icon: Icons.arrow_back,
            requiresConnection: false,
          ),
        ),
        const SizedBox(height: 14),
        Text(
          item['title'] as String,
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: 10),
        Text(
          scheduleRuleText(
            Map<String, dynamic>.from(item['rule']),
            widget.language,
          ),
          style: TextStyle(color: colors.onSurfaceVariant),
        ),
        const SizedBox(height: 14),
        Text(item['goal'] as String, style: const TextStyle(height: 1.7)),
        const SizedBox(height: 14),
        Text(
          current['enabled'] == true
              ? '${t('Next run')}: ${current['next_slot']?['local_date'] ?? '—'} ${current['next_slot']?['local_time'] ?? ''}'
              : t('Paused · Active runs continue'),
        ),
        Wrap(
          spacing: 8,
          children: [
            _button('Edit', () async {
              final fresh = await widget.store.command('schedules.get', {
                'id': selected,
              });
              await _editor(Map<String, dynamic>.from(fresh));
            }, icon: Icons.edit_outlined),
            _button(
              current['enabled'] == true ? 'Pause schedule' : 'Resume schedule',
              () async {
                await _mutation(
                  current['enabled'] == true ? 'pause' : 'resume',
                  {'id': selected, 'expected_revision': current['revision']},
                );
                await _load(selected!);
              },
              icon: current['enabled'] == true ? Icons.pause : Icons.play_arrow,
            ),
            _button(
              'Run now',
              () async {
                await _mutation('run_now', {
                  'id': selected,
                  'expected_revision': current['revision'],
                });
                await _history();
              },
              enabled: run == null,
              icon: Icons.play_circle_outline,
            ),
            if (run?['task_id'] != null)
              _button('View active task', () async {
                await widget.onOpenTask?.call(run!['task_id']);
              }),
            if (task != null)
              _button('Stop active task', () async {
                await widget.store.command('tasks.cancel', {
                  'task_id': task['id'],
                  'control_revision': task['control_revision'],
                  'goal_revision': task['goal_revision'],
                });
              }, icon: Icons.stop_circle_outlined),
          ],
        ),
        ExpansionTile(
          title: Text(t('Success criteria')),
          children: [
            for (final text in item['acceptance'] as List)
              ListTile(title: Text(text as String)),
          ],
        ),
        const SizedBox(height: 14),
        Row(
          children: [
            Expanded(
              child: Text(
                t('Run history'),
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            IconButton(
              tooltip: t('Refresh history'),
              onPressed: busy || !widget.store.connected
                  ? null
                  : () => _run(_history),
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        if (rows(history?['items']).isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 20),
            child: Text(
              t('No results yet. Try running this task now.'),
              style: TextStyle(color: colors.onSurfaceVariant),
            ),
          ),
        for (final entry in rows(history?['items']))
          _card(
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${entry['slot']?['local_date'] ?? entry['claimed_at']} · ${t('phase:${entry['summary']?['outcome'] ?? 'running'}')}',
                  style: TextStyle(
                    color: colors.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
                const SizedBox(height: 10),
                SelectableText(
                  entry['summary']?['text'] as String? ??
                      t('Preparing result…'),
                  style: const TextStyle(height: 1.7),
                ),
                Wrap(
                  spacing: 8,
                  children: [
                    if (entry['task_id'] != null)
                      _button('View task', () async {
                        await widget.onOpenTask?.call(entry['task_id']);
                      }),
                    if (entry['summary']?['outcome'] == 'completed') ...[
                      _button('Discuss result', () async {
                        await widget.store.command('schedules.open_result', {
                          'run_id': entry['run_id'],
                        });
                        widget.onOpenConversation?.call();
                      }),
                      _button('Save as an item', () => _adopt(entry)),
                    ],
                  ],
                ),
              ],
            ),
          ),
        if (history?['next_cursor'] != null)
          _button('More runs', () => _history(more: true)),
        if (notice != null)
          Semantics(liveRegion: true, child: Text(t(notice!))),
        const SizedBox(height: 20),
        ExpansionTile(
          title: Text(
            t('Delete schedule'),
            style: TextStyle(color: colors.error),
          ),
          children: [
            Text(t('Existing tasks and results are kept.')),
            _button('Confirm deletion', () async {
              await _mutation('delete', {
                'id': selected,
                'expected_revision': current['revision'],
              });
              if (mounted) setState(() => selected = null);
            }, icon: Icons.delete_outline),
          ],
        ),
      ],
    );
  }

  Future<void> _adopt(Map<String, dynamic> run) async {
    final title = TextEditingController(text: detail!['title']),
        note = TextEditingController(
          text: (run['summary']['text'] as String).substring(
            0,
            (run['summary']['text'] as String).length.clamp(0, 4000),
          ),
        );
    String kind = 'todo';
    String? goal, issue;
    bool saving = false;
    final goals = widget.store.snapshot?.object('life')['goals'] as List? ?? [];
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (sheet) => StatefulBuilder(
        builder: (sheet, setSheet) => SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(
            22,
            22,
            22,
            MediaQuery.viewInsetsOf(sheet).bottom + 22,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                t('Save as a personal item'),
                style: Theme.of(sheet).textTheme.titleLarge,
              ),
              const SizedBox(height: 18),
              DropdownButtonFormField<String>(
                initialValue: kind,
                items: [
                  DropdownMenuItem(value: 'todo', child: Text(t('Todo'))),
                  DropdownMenuItem(value: 'idea', child: Text(t('Idea'))),
                ],
                onChanged: saving ? null : (v) => setSheet(() => kind = v!),
                decoration: InputDecoration(labelText: t('Item type')),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: title,
                enabled: !saving,
                maxLength: 200,
                decoration: InputDecoration(labelText: t('Title')),
              ),
              TextField(
                controller: note,
                enabled: !saving,
                maxLength: 4000,
                minLines: 3,
                maxLines: 5,
                decoration: InputDecoration(labelText: t('Note')),
              ),
              DropdownButtonFormField<String>(
                initialValue: goal,
                items: [
                  DropdownMenuItem(
                    value: null,
                    child: Text(t('No linked goal')),
                  ),
                  for (final row in goals)
                    DropdownMenuItem(
                      value: row['id'] as String,
                      child: Text(row['title'] as String),
                    ),
                ],
                onChanged: saving ? null : (v) => setSheet(() => goal = v),
                decoration: InputDecoration(labelText: t('Link a goal')),
              ),
              if (issue != null)
                Text(
                  issue!,
                  style: TextStyle(color: Theme.of(sheet).colorScheme.error),
                ),
              FilledButton(
                onPressed: saving || !widget.store.connected
                    ? null
                    : () async {
                        setSheet(() => saving = true);
                        try {
                          final linked = goals
                              .where((row) => row['id'] == goal)
                              .firstOrNull;
                          await _mutation('adopt_result', {
                            'run_id': run['run_id'],
                            'kind': kind,
                            'title': title.text,
                            'note': note.text,
                            if (linked != null) ...{
                              'goal_id': linked['id'],
                              'goal_version': linked['version'],
                            },
                          });
                          if (sheet.mounted) Navigator.pop(sheet);
                          if (mounted) {
                            setState(() => notice = 'Saved to personal items');
                          }
                        } catch (e) {
                          if (sheet.mounted) {
                            setSheet(() => issue = t(scheduleErrorText(e)));
                          }
                        } finally {
                          if (sheet.mounted) setSheet(() => saving = false);
                        }
                      },
                child: Text(t('Save item')),
              ),
            ],
          ),
        ),
      ),
    );
    title.dispose();
    note.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Semantics(
              liveRegion: true,
              child: Text(
                error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          ),
        selected == null ? _list() : _detail(),
      ],
    );
    if (widget.embedded) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: body,
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(t('Scheduled tasks'))),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: body,
      ),
    );
  }
}
