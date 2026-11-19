import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' show SelectableText, Tooltip;
import 'theme.dart';

/// Last non-empty line of a thinking stream; used for one-line summaries.
String thinkingSummary(String text) {
  final lines = text.split('\n');
  for (var i = lines.length - 1; i >= 0; i--) {
    final line = lines[i].trim();
    if (line.isNotEmpty) return line;
  }
  return '';
}

String _duration(Duration value) {
  final seconds = value.inSeconds.clamp(0, 86400);
  return seconds < 60 ? '${seconds}s' : '${seconds ~/ 60}m ${seconds % 60}s';
}

/// Collapsible, read-only view of the model's visible thinking process.
/// Collapsed by default: reasoning is useful context, never the answer.
class ThinkingBlock extends StatefulWidget {
  const ThinkingBlock({
    super.key,
    required this.text,
    this.language = 'zh',
    this.live = false,
    this.elapsed,
  });
  final String text, language;
  final bool live;
  final Duration? elapsed;
  @override
  State<ThinkingBlock> createState() => _ThinkingBlockState();
}

class _ThinkingBlockState extends State<ThinkingBlock> {
  bool expanded = false;

  void _toggle() => setState(() => expanded = !expanded);

  @override
  Widget build(BuildContext context) {
    final text = widget.text.trim();
    if (text.isEmpty) return const SizedBox.shrink();
    final zh = widget.language == 'zh';
    final summary = thinkingSummary(text);
    final title = widget.live
        ? (zh ? '正在思考' : 'Thinking')
        : (zh ? '思考' : 'Thought process');
    final hint = expanded
        ? (zh ? '收起思考过程' : 'Hide thinking')
        : (zh ? '查看思考过程' : 'Show thinking');
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        decoration: BoxDecoration(
          color: Nova.cell,
          borderRadius: BorderRadius.circular(20),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Semantics(
              button: true,
              expanded: expanded,
              tooltip: hint,
              onTap: _toggle,
              child: Tooltip(
                message: hint,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: _toggle,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(
                        CupertinoIcons.sparkles,
                        size: 16,
                        color: Nova.mint,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        title,
                        style: const TextStyle(
                          color: Nova.secondary,
                          fontSize: 14,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      if (summary.isNotEmpty) ...[
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            summary,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: Nova.tertiary,
                              fontSize: 12,
                            ),
                          ),
                        ),
                      ],
                      if (widget.elapsed != null) ...[
                        const SizedBox(width: 12),
                        Text(
                          _duration(widget.elapsed!),
                          style: const TextStyle(
                            color: Nova.tertiary,
                            fontSize: 12,
                          ),
                        ),
                      ],
                      const SizedBox(width: 8),
                      Icon(
                        expanded
                            ? CupertinoIcons.chevron_up
                            : CupertinoIcons.chevron_down,
                        size: 12,
                        color: Nova.tertiary,
                      ),
                    ],
                  ),
                ),
              ),
            ),
            if (expanded)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 320),
                  child: SingleChildScrollView(
                    child: SelectableText(
                      text,
                      style: const TextStyle(
                        color: Nova.secondary,
                        fontSize: 13,
                        height: 1.5,
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
