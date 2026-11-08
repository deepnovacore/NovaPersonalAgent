import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../generic/shared_ideas.dart';
import 'components.dart';
import 'theme.dart';

class SharedIdeasScope extends InheritedNotifier<SharedIdeas> {
  const SharedIdeasScope({super.key, super.notifier, required super.child});

  static SharedIdeas? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<SharedIdeasScope>()?.notifier;
}

class SharedIdeaSuggestions extends StatefulWidget {
  const SharedIdeaSuggestions({
    super.key,
    required this.language,
    required this.onSend,
    this.compact = false,
  });

  final String language;
  final ValueChanged<String> onSend;
  final bool compact;

  @override
  State<SharedIdeaSuggestions> createState() => _SharedIdeaSuggestionsState();
}

class _SharedIdeaSuggestionsState extends State<SharedIdeaSuggestions> {
  SharedIdeas? _ideas;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final ideas = SharedIdeasScope.of(context);
    if (identical(_ideas, ideas)) return;
    _ideas = ideas;
    if (ideas != null) unawaited(ideas.load(widget.language));
  }

  @override
  void didUpdateWidget(SharedIdeaSuggestions oldWidget) {
    super.didUpdateWidget(oldWidget);
    final ideas = _ideas;
    if (ideas != null && oldWidget.language != widget.language) {
      unawaited(ideas.load(widget.language));
    }
  }

  @override
  Widget build(BuildContext context) {
    final topics = _ideas?.topics(widget.language) ?? const <SharedIdea>[];
    if (topics.isEmpty) return const SizedBox.shrink();
    final label = widget.language == 'zh' ? '聊点什么' : 'Something to talk about';
    if (!widget.compact) {
      return NovaSection(
        header: label,
        children: [
          for (final topic in topics)
            NovaTile(
              key: ValueKey('shared-idea:${topic.id}'),
              title: topic.text,
              trailing: const Icon(CupertinoIcons.arrow_up_right, size: 16),
              onTap: () => widget.onSend(topic.text),
            ),
        ],
      );
    }

    return Semantics(
      label: label,
      container: true,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight:
              ((MediaQuery.sizeOf(context).height -
                          MediaQuery.viewInsetsOf(context).bottom) *
                      0.4)
                  .clamp(48, 220)
                  .toDouble(),
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: Column(
            spacing: 6,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final topic in topics.take(3))
                OutlinedButton(
                  key: ValueKey('shared-idea-opening:${topic.id}'),
                  onPressed: () => widget.onSend(topic.text),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Nova.text,
                    backgroundColor: Nova.cell,
                    side: BorderSide(color: Nova.separator),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(14),
                    ),
                    minimumSize: const Size(0, 48),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 10,
                    ),
                  ),
                  child: Row(
                    spacing: 12,
                    children: [
                      Expanded(
                        child: Text(topic.text, textAlign: TextAlign.start),
                      ),
                      Icon(
                        CupertinoIcons.arrow_up_right,
                        size: 15,
                        color: Nova.secondary,
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
