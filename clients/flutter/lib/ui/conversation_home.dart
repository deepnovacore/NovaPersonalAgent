import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../agent_core/agent_core_host.dart';
import '../agent_core/scheduled_agent_runner.dart';
import '../conversation/local_conversation_store.dart';
import 'components.dart';
import 'local_schedules_page.dart';
import 'theme.dart';

/// Conversation metadata is derived from saved messages; opening the home page
/// never creates an empty conversation or changes the user's stored content.
class ConversationHome extends StatefulWidget {
  const ConversationHome({
    super.key,
    required this.host,
    required this.onOpen,
    required this.onNew,
    this.language = 'zh',
    this.activeConversationId,
    this.schedules,
  });
  final AgentCoreHost host;
  final ValueChanged<String> onOpen;
  final VoidCallback onNew;
  final String language;
  final String? activeConversationId;

  /// The app-owned phone scheduler, shared with Settings → Phone schedules.
  /// It stays null until the agent core (and its scheduler) has opened.
  final ScheduledAgentRunner? schedules;
  @override
  State<ConversationHome> createState() => _ConversationHomeState();
}

class _ConversationHomeState extends State<ConversationHome> {
  bool searching = false;
  bool schedules = false;
  String query = '';
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;

  static String _latestTime(Map<String, dynamic> row) {
    final messages = row['messages'] as List;
    return messages.isEmpty ? '' : (messages.last['time'] as String? ?? '');
  }

  static String _title(Map<String, dynamic> row, String fallback) {
    final user = (row['messages'] as List)
        .where((m) => m['role'] == 'user')
        .firstOrNull;
    return row['title'] as String? ?? user?['content'] as String? ?? fallback;
  }

  static String _preview(Map<String, dynamic> row, String fallback) {
    final message = (row['messages'] as List)
        .where(
          (m) =>
              m['role'] != 'tool' && (m['content'] as String).trim().isNotEmpty,
        )
        .lastOrNull;
    return message?['content'] as String? ?? fallback;
  }

  static bool _isToday(String? iso) {
    final time = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
    return time != null && DateUtils.isSameDay(time, DateTime.now());
  }

  /// First user message to last message, as a compact session duration. Rows
  /// with a single message keep the older relative-time label.
  String _trailingLabel(Map<String, dynamic> row) {
    final messages = row['messages'] as List;
    final fallback = relativeTime(
      messages.isEmpty ? null : messages.last['time'] as String?,
      widget.language,
    );
    if (messages.length < 2) return fallback;
    final user = messages.where((m) => m['role'] == 'user').firstOrNull;
    final start = DateTime.tryParse(user?['time'] as String? ?? '');
    final end = DateTime.tryParse(messages.last['time'] as String? ?? '');
    if (start == null || end == null) return fallback;
    final span = end.difference(start);
    return span.isNegative
        ? fallback
        : formatSessionDuration(span, widget.language);
  }

  void _selectSegment(bool value) {
    FocusManager.instance.primaryFocus?.unfocus();
    setState(() => schedules = value);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.host,
    builder: (context, _) {
      // Opening a composer is not yet a conversation in the history.
      // Keep empty records intact, including any active in-memory draft.
      final rows = widget.host.store.conversations
          .where(
            (row) =>
                row['id'] != ConversationStore.mainId &&
                ((row['messages'] as List).isNotEmpty ||
                    row['source_todo'] != null ||
                    row['id'] == widget.activeConversationId),
          )
          .toList();
      rows.sort((a, b) => _latestTime(b).compareTo(_latestTime(a)));

      final fallbackTitle = t('新任务', 'New task');
      final fallbackPreview = t('从一句话开始', 'Start with a message');
      final visible = rows
          .where(
            (row) =>
                '${_title(row, fallbackTitle)} ${_preview(row, fallbackPreview)}'
                    .toLowerCase()
                    .contains(query.toLowerCase()),
          )
          .toList();
      return Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 6, 20, 2),
            child: CupertinoSlidingSegmentedControl<bool>(
              groupValue: schedules,
              backgroundColor: Nova.cell,
              thumbColor: Nova.sheetCell,
              children: {
                false: Text(
                  t('任务', 'Tasks'),
                  style: const TextStyle(color: Nova.text, fontSize: 13),
                ),
                true: Text(
                  t('定时', 'Schedules'),
                  style: const TextStyle(color: Nova.text, fontSize: 13),
                ),
              },
              onValueChanged: (value) => _selectSegment(value ?? false),
            ),
          ),
          Expanded(
            child: schedules ? _schedulesBody() : _tasksBody(rows, visible),
          ),
        ],
      );
    },
  );

  Widget _schedulesBody() {
    final runner = widget.schedules;
    if (runner == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(36),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(CupertinoIcons.clock, size: 30, color: Nova.tertiary),
              const SizedBox(height: 10),
              Text(
                t('定时任务尚未就绪', 'Schedules are not ready yet'),
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 15, color: Nova.secondary),
              ),
            ],
          ),
        ),
      );
    }
    return SafeArea(
      top: false,
      child: LocalSchedulesPage(runner: runner, embedded: true),
    );
  }

  Widget _tasksBody(
    List<Map<String, dynamic>> rows,
    List<Map<String, dynamic>> visible,
  ) {
    final today = <Map<String, dynamic>>[], earlier = <Map<String, dynamic>>[];
    for (final row in visible) {
      // An active draft has no last message yet; it belongs to today's work.
      final latest = _latestTime(row);
      (latest.isEmpty || _isToday(latest) ? today : earlier).add(row);
    }
    return Column(
      children: [
        if (searching)
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 8, 22, 12),
            child: TextField(
              autofocus: true,
              onChanged: (value) => setState(() => query = value),
              decoration: InputDecoration(
                hintText: t('搜索任务', 'Search tasks'),
                prefixIcon: const Icon(CupertinoIcons.search, size: 19),
              ),
            ),
          ),
        Expanded(
          child: rows.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(36),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          t('独立的事，在这里处理', 'A place for focused tasks'),
                          style: const TextStyle(
                            fontSize: 25,
                            fontWeight: FontWeight.w500,
                            letterSpacing: -.5,
                          ),
                        ),
                        const SizedBox(height: 12),
                        Text(
                          t(
                            '从时间线中的待办开始，或新建一个任务。',
                            'Start from a timeline to-do, or create a task.',
                          ),
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                            fontSize: 15,
                            color: Nova.secondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                )
              : visible.isEmpty
              ? Center(
                  child: Text(
                    t('没有找到任务', 'No tasks found'),
                    style: const TextStyle(color: Nova.secondary),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.fromLTRB(0, 8, 0, 24),
                  children: [
                    if (today.isNotEmpty) _taskGroup(t('今天', 'Today'), today),
                    if (earlier.isNotEmpty)
                      _taskGroup(t('更早', 'Earlier'), earlier),
                  ],
                ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
            child: Row(
              children: [
                IconButton(
                  tooltip: t('搜索任务', 'Search tasks'),
                  onPressed: () => setState(() {
                    searching = !searching;
                    query = '';
                  }),
                  icon: Icon(
                    searching ? CupertinoIcons.xmark : CupertinoIcons.search,
                  ),
                ),
                const Spacer(),
                FilledButton.icon(
                  onPressed: widget.onNew,
                  icon: const Icon(CupertinoIcons.square_pencil, size: 19),
                  label: Text(t('新建任务', 'New task')),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _taskGroup(String label, List<Map<String, dynamic>> rows) =>
      NovaSection(
        header: label,
        surface: Nova.cell,
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        children: [for (final row in rows) _taskRow(row)],
      );

  Widget _taskRow(Map<String, dynamic> row) {
    final messages = row['messages'] as List;
    return NovaTile(
      title: _title(row, t('新任务', 'New task')),
      titleLines: 1,
      subtitle: Text(
        _preview(row, t('从一句话开始', 'Start with a message')),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      leading: Container(
        width: 38,
        height: 38,
        decoration: BoxDecoration(
          color: Nova.mint.withValues(alpha: .08),
          borderRadius: BorderRadius.circular(13),
        ),
        child: const Icon(
          CupertinoIcons.bubble_left,
          color: Nova.mint,
          size: 19,
        ),
      ),
      trailing: messages.isEmpty
          ? null
          : Text(
              _trailingLabel(row),
              style: const TextStyle(fontSize: 12, color: Nova.secondary),
            ),
      onTap: widget.host.busy && row['id'] != widget.activeConversationId
          ? null
          : () => widget.onOpen(row['id'] as String),
    );
  }
}

/// `3分20秒` below an hour, `1小时5分` above it, and plain seconds under a
/// minute. English mirrors the shape.
String formatSessionDuration(Duration span, String language) {
  final zh = language == 'zh';
  if (span.inHours >= 1) {
    final hours = span.inHours, minutes = span.inMinutes % 60;
    return zh ? '$hours小时$minutes分' : '${hours}h ${minutes}m';
  }
  final minutes = span.inMinutes, seconds = span.inSeconds % 60;
  if (minutes == 0) return zh ? '$seconds秒' : '${seconds}s';
  return zh ? '$minutes分$seconds秒' : '${minutes}m ${seconds}s';
}
