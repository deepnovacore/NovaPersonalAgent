import 'package:flutter/material.dart';
import '../personal/personal_store.dart';
import 'strings.dart';
import 'reason_copy.dart';

/// Reads task activity; extra instructions stay in the authorized conversation.
class TaskDetails extends StatefulWidget {
  const TaskDetails({
    super.key,
    required this.store,
    required this.task,
    required this.onDiscuss,
    this.language = 'en',
  });
  final String language;
  final PersonalStore store;
  final Map<String, dynamic> task;
  final Future<void> Function() onDiscuss;
  @override
  State<TaskDetails> createState() => _TaskDetailsState();
}

class _TaskDetailsState extends State<TaskDetails> {
  late Map<String, dynamic> task = widget.task;
  final events = <int, Map<String, dynamic>>{};
  int cursor = 0;
  late int snapshotRevision = widget.store.snapshot?.revision ?? -1;

  void _syncTask() {
    final snapshot = widget.store.snapshot;
    if (snapshot == null || snapshot.revision <= snapshotRevision) return;
    snapshotRevision = snapshot.revision;
    final latest = snapshot
        .rows('tasks')
        .where((row) => row['id'] == task['id'])
        .firstOrNull;
    if (latest != null) task = {...task, ...latest};
  }

  bool busy = false;
  String? error;
  bool incomplete = false;
  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    if (busy || !widget.store.connected) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final result = await widget.store.command('tasks.get', {
        'task_id': task['id'],
        'after': cursor,
      });
      if (!mounted || result is! Map) return;
      final activity = result['events'] as Map? ?? {};
      setState(() {
        task = Map<String, dynamic>.from(result);
        snapshotRevision = widget.store.snapshot?.revision ?? snapshotRevision;
        for (final event in activity['items'] as List? ?? []) {
          events[event['seq'] as int] = Map<String, dynamic>.from(event as Map);
        }
        cursor = activity['next'] as int? ?? cursor;
        incomplete =
            incomplete ||
            activity['truncated'] == true ||
            activity['incomplete'] == true;
      });
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _act(String method) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    _syncTask();
    try {
      final result = await widget.store.command(method, {
        'task_id': task['id'],
        'control_revision': task['control_revision'],
        'goal_revision': task['goal_revision'],
      });
      if (mounted && result is Map) {
        setState(() {
          task = Map<String, dynamic>.from(result);
          snapshotRevision =
              widget.store.snapshot?.revision ?? snapshotRevision;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  bool get _zh => widget.language == 'zh';
  String t(String zh, String en) => _zh ? zh : en;

  /// Unknown phases never leak internal keys in either language.
  String _phase(Object? phase) {
    final key = 'phase:$phase', label = tr(widget.language, key);
    return label == key ? t('处理中', 'Processing') : label;
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.store,
    builder: (context, _) {
      _syncTask();
      final current = task;
      return SizedBox(
        height: MediaQuery.sizeOf(context).height * .8,
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text(
              '${current['goal'] ?? t('任务', 'Task')}',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            Text(
              [
                _phase(current['phase']),
                if (current['waiting_reason'] != null)
                  reasonCopy(
                    current['waiting_reason'],
                    language: widget.language,
                  ),
              ].join(' · '),
            ),
            if (!widget.store.connected)
              Text(t('离线 · 显示缓存的任务', 'Offline · cached task')),
            if (error != null) Text(error!),
            if (busy) const LinearProgressIndicator(),
            Wrap(
              spacing: 8,
              children: [
                TextButton(
                  onPressed: !busy && widget.store.connected ? _refresh : null,
                  child: Text(t('加载动态', 'Load activity')),
                ),
                TextButton(
                  onPressed:
                      !busy &&
                          widget.store.connected &&
                          (!(current['trigger'] is Map &&
                                  current['trigger']['kind'] == 'schedule') ||
                              current['phase'] == 'completed')
                      ? () async {
                          try {
                            await widget.onDiscuss();
                          } catch (e) {
                            if (mounted) setState(() => error = e.toString());
                          }
                        }
                      : null,
                  child: Text(
                    t('在 Nova 中讨论或补充', 'Discuss / add input in Nova'),
                  ),
                ),
                if (!['completed', 'cancelled'].contains(current['phase']))
                  TextButton(
                    onPressed: !busy && widget.store.connected
                        ? () => _act('tasks.cancel')
                        : null,
                    child: Text(t('取消任务', 'Cancel task')),
                  ),
              ],
            ),
            if (incomplete)
              Text(t('部分较早的动态已无法查看。', 'Some earlier activity is unavailable.')),
            for (final event in events.values)
              ListTile(
                title: Text('${event['text'] ?? ''}'),
                subtitle: _zh ? null : Text('${event['kind'] ?? ''}'),
              ),
            if (!busy && events.isEmpty)
              Text(t('还没有加载动态', 'No task activity loaded')),
          ],
        ),
      );
    },
  );
}
