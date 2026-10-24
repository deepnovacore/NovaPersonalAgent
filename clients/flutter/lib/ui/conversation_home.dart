import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../agent_core/agent_core_host.dart';
import '../conversation/local_conversation_store.dart';
import 'components.dart';
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
  });
  final AgentCoreHost host;
  final ValueChanged<String> onOpen;
  final VoidCallback onNew;
  final String language;
  final String? activeConversationId;
  @override
  State<ConversationHome> createState() => _ConversationHomeState();
}

class _ConversationHomeState extends State<ConversationHome> {
  bool searching = false;
  String query = '';
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;
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
      String latest(Map<String, dynamic> row) {
        final messages = row['messages'] as List;
        return messages.isEmpty ? '' : messages.last['time'] as String;
      }

      rows.sort((a, b) => latest(b).compareTo(latest(a)));
      String title(Map<String, dynamic> row) {
        final user = (row['messages'] as List)
            .where((m) => m['role'] == 'user')
            .firstOrNull;
        return row['title'] as String? ??
            user?['content'] as String? ??
            t('新任务', 'New task');
      }

      String preview(Map<String, dynamic> row) {
        final message = (row['messages'] as List)
            .where(
              (m) =>
                  m['role'] != 'tool' &&
                  (m['content'] as String).trim().isNotEmpty,
            )
            .lastOrNull;
        return message?['content'] as String? ??
            t('从一句话开始', 'Start with a message');
      }

      final visible = rows
          .where(
            (row) => '${title(row)} ${preview(row)}'.toLowerCase().contains(
              query.toLowerCase(),
            ),
          )
          .toList();
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
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
                    itemCount: visible.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 8),
                    itemBuilder: (context, index) {
                      final row = visible[index];
                      final messages = row['messages'] as List;
                      return ListTile(
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 4,
                          vertical: 8,
                        ),
                        leading: Container(
                          width: 44,
                          height: 44,
                          decoration: BoxDecoration(
                            color: Nova.mint.withValues(alpha: .08),
                            borderRadius: BorderRadius.circular(16),
                          ),
                          child: const Icon(
                            CupertinoIcons.bubble_left,
                            color: Nova.mint,
                            size: 22,
                          ),
                        ),
                        title: Text(
                          title(row),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        subtitle: Padding(
                          padding: const EdgeInsets.only(top: 5),
                          child: Text(
                            preview(row),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 14,
                              color: Nova.secondary,
                            ),
                          ),
                        ),
                        trailing: messages.isEmpty
                            ? null
                            : Text(
                                relativeTime(
                                  messages.last['time'] as String?,
                                  widget.language,
                                ),
                                style: const TextStyle(
                                  fontSize: 11,
                                  color: Nova.secondary,
                                ),
                              ),
                        onTap:
                            widget.host.busy &&
                                row['id'] != widget.activeConversationId
                            ? null
                            : () => widget.onOpen(row['id'] as String),
                      );
                    },
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
    },
  );
}
