import 'dart:async';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' show Tooltip;
import 'theme.dart';

/// Activity is driven by real stream/tool events; elapsed time is not a percent.
class ChatActivity extends StatefulWidget {
  const ChatActivity({
    super.key,
    required this.label,
    required this.startedAt,
    required this.language,
    this.details,
  });
  final String label, language;
  final Widget? details;
  final DateTime startedAt;
  @override
  State<ChatActivity> createState() => _ChatActivityState();
}

class _ChatActivityState extends State<ChatActivity>
    with SingleTickerProviderStateMixin {
  late final AnimationController shimmer = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1800),
  );
  Timer? timer;
  bool expanded = false;
  @override
  void initState() {
    super.initState();
    timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      shimmer.stop();
    } else {
      shimmer.repeat();
    }
  }

  @override
  void dispose() {
    timer?.cancel();
    shimmer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final seconds = DateTime.now()
        .difference(widget.startedAt)
        .inSeconds
        .clamp(0, 86400);
    final elapsed = seconds < 60
        ? '${seconds}s'
        : '${seconds ~/ 60}m ${seconds % 60}s';
    final label = Text(
      widget.label,
      style: const TextStyle(
        color: Nova.secondary,
        fontSize: 14,
        fontWeight: FontWeight.w500,
      ),
    );
    final animate = !MediaQuery.disableAnimationsOf(context);
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
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
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: widget.details == null
                    ? null
                    : () => setState(() => expanded = !expanded),
                child: Tooltip(
                  message: widget.language == 'zh'
                      ? (expanded ? '收起执行过程' : '查看执行过程')
                      : (expanded
                            ? 'Hide progress details'
                            : 'Show progress details'),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(
                        CupertinoIcons.sparkles,
                        size: 16,
                        color: Nova.mint,
                      ),
                      const SizedBox(width: 8),
                      Flexible(
                        child: animate
                            ? AnimatedBuilder(
                                animation: shimmer,
                                builder: (context, child) => ShaderMask(
                                  blendMode: BlendMode.srcIn,
                                  shaderCallback: (rect) => LinearGradient(
                                    begin: Alignment(-3 + 6 * shimmer.value, 0),
                                    end: Alignment(-1 + 6 * shimmer.value, 0),
                                    colors: const [
                                      Nova.secondary,
                                      Nova.mint,
                                      Nova.secondary,
                                    ],
                                    stops: const [0, .5, 1],
                                  ).createShader(rect),
                                  child: child,
                                ),
                                child: label,
                              )
                            : label,
                      ),
                      if (widget.details != null)
                        const Padding(
                          padding: EdgeInsets.only(left: 8),
                          child: Icon(
                            CupertinoIcons.chevron_down,
                            size: 12,
                            color: Nova.tertiary,
                          ),
                        ),
                      const SizedBox(width: 12),
                      Text(
                        elapsed,
                        style: const TextStyle(
                          color: Nova.tertiary,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              if (expanded && widget.details != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: widget.details,
                ),
            ],
          ),
        ),
      ),
    );
  }
}
