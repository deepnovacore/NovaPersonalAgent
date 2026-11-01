// Layout and collapse rules adapted from Mika (https://github.com/wangzan101/Mika,
// Apache-2.0, commit 5f630d9), Copyright 2026 wangzan101. Modified by Nova:
// reimplemented in Flutter on Nova tool messages (ChatViewModel.rows, StepLine,
// DoneLine; no Mika code or assets are copied).
import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'theme.dart';
import 'tool_step.dart';

/// Dot state of a timeline row. Only the last row of a run carries a live
/// state; every earlier row is [ok] (its own failure shows as the subtitle).
enum ToolStepState { ok, run, wait, dim }

/// While a run is going, only this many of its latest rows are listed.
const toolTimelineVisibleSteps = 5;

/// The model's per-step sentence is clipped to this many characters.
const toolNarrationMaxChars = 80;

const _observeTools = {
  'file_read',
  'web_fetch',
  'browser',
  'browser_open',
  'observe',
};

/// Read-only tools: consecutive calls on one target are one timeline row.
bool isObserveTool(String name) => _observeTools.contains(name);

/// Display-safe target of a tool call: a file name or a host, never the full
/// path, URL, query or any other argument. Null when unknown.
String? toolTargetLabel(String name, Object? arguments) {
  Object? decoded = arguments;
  if (decoded is String) {
    try {
      decoded = jsonDecode(decoded);
    } catch (_) {
      return null;
    }
  }
  if (decoded is! Map) return null;
  switch (name) {
    case 'file_read' || 'file_write' || 'file_edit':
      final path = decoded['path'];
      if (path is! String) return null;
      final parts = path.split('/').where((part) => part.isNotEmpty);
      return parts.isEmpty ? null : parts.last;
    case 'web_fetch' || 'browser' || 'browser_open':
      final url = decoded['url'];
      final host = url is String ? Uri.tryParse(url)?.host : null;
      return host == null || host.isEmpty ? null : host;
  }
  return null;
}

final _targetCache = Expando<Map<String, String>>('toolTargets');

Map<String, String> _targetsOf(Map message) {
  final targets = <String, String>{};
  for (final call in message['tool_calls'] as List) {
    if (call is! Map || call['id'] is! String || call['function'] is! Map) {
      continue;
    }
    final function = call['function'] as Map;
    final target = toolTargetLabel(
      function['name'] as String? ?? '',
      function['arguments'],
    );
    if (target != null) targets[call['id'] as String] = target;
  }
  return targets;
}

/// Display-safe targets of every tool call in [messages], by call id. Parsed
/// once per stored assistant message.
Map<String, String> toolTargetsByCallId(List messages) {
  final targets = <String, String>{};
  for (final message in messages) {
    if (message is! Map || message['role'] != 'assistant') continue;
    final calls = message['tool_calls'];
    if (calls is! List || calls.isEmpty) continue;
    targets.addAll(_targetCache[message] ??= _targetsOf(message));
  }
  return targets;
}

/// One-line, length-limited form of a model sentence for use as a row title.
String clipNarration(String text) {
  final line = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  final runes = line.runes.toList();
  return runes.length <= toolNarrationMaxChars
      ? line
      : '${String.fromCharCodes(runes.take(toolNarrationMaxChars - 1))}…';
}

/// "1 分 20 秒" / "1m 20s"; never shorter than one second.
String formatToolElapsed(Duration elapsed, String language) {
  final total = math.max(1, elapsed.inSeconds.clamp(0, 86400 * 7));
  final minutes = total ~/ 60, seconds = total % 60;
  if (language == 'zh') {
    if (minutes == 0) return '$seconds 秒';
    return seconds == 0 ? '$minutes 分' : '$minutes 分 $seconds 秒';
  }
  if (minutes == 0) return '${seconds}s';
  return seconds == 0 ? '${minutes}m' : '${minutes}m ${seconds}s';
}

/// The single line a finished run collapses to. Keeps Nova's established
/// wording: "查看了 N 个文件 · N 次工具调用 · 有未完成或待核实".
String toolTimelineSummary({
  required String language,
  required List<ToolStep> steps,
  bool incomplete = false,
}) {
  String t(String zh, String en) => language == 'zh' ? zh : en;
  final files = {
    for (final step in steps)
      if (step.name == 'file_read' &&
          step.completed &&
          step.completedReadPath != null)
        step.completedReadPath!,
  };
  return [
    if (files.isNotEmpty)
      t('查看了 ${files.length} 个文件', 'Read ${files.length} files'),
    t('${steps.length} 次工具调用', '${steps.length} tool calls'),
    if (incomplete) t('有未完成或待核实', 'Some incomplete or unverified'),
  ].join(' · ');
}

/// The "N earlier steps" link shown while a run is going.
String earlierStepsLabel(String language, int count) => language == 'zh'
    ? '更早的 $count 步'
    : count == 1
    ? '1 earlier step'
    : '$count earlier steps';

/// How many leading rows are folded into the "earlier steps" link.
int hiddenEarlierSteps(
  int rowCount, {
  required bool running,
  bool showAll = false,
}) =>
    running && !showAll ? math.max(0, rowCount - toolTimelineVisibleSteps) : 0;

/// A displayable timeline row.
class ToolTimelineRow {
  const ToolTimelineRow({
    required this.step,
    required this.title,
    required this.text,
    this.narration,
    this.subtitle = '',
    this.state = ToolStepState.ok,
    this.count = 1,
    this.detail,
    this.refLabel,
    this.frame,
  });

  /// The agent's own step number when it supplies one, else list position.
  final int step;

  /// What the tool did: `label · target`.
  final String title;

  /// What the row says: the model's [narration] when present, else [title]
  /// (with the repeat count for merged reads).
  final String text;
  final String? narration;

  /// Why the step did not succeed; empty for completed steps.
  final String subtitle;
  final ToolStepState state;

  /// How many consecutive observe calls this row stands for.
  final int count;

  /// Longer model text shown when the row is tapped.
  final String? detail;
  final String? refLabel;
  final Future<Uint8List?> Function()? frame;
}

class _Draft {
  _Draft(this.index, this.first) : last = first;
  final int index;
  final ToolStep first;
  ToolStep last;
  int count = 1;
}

ToolStepState _liveState(String status, bool running) => switch (status) {
  'completed' => running ? ToolStepState.run : ToolStepState.ok,
  'failed' ||
  'error' ||
  'cancelled' ||
  'rejected' ||
  'denied' => ToolStepState.dim,
  _ => ToolStepState.wait,
};

String? _narrationOf(ToolStep step) {
  final text = clipNarration(step.narration ?? '');
  return text.isEmpty ? null : text;
}

/// Turns one run's chronological tool steps into timeline rows.
///
/// * Consecutive observe-like calls of the same tool, target, status and
///   narration merge into one row with a count.
/// * The model's narration wins over the tool label as the row text.
/// * Other tools read `label · target`.
/// * Only the last row carries a live [ToolStepState]; [running] says whether the
///   run is still going.
List<ToolTimelineRow> buildToolSteps(
  List<ToolStep> steps, {
  bool running = false,
}) {
  if (steps.isEmpty) return const [];
  String t(String zh, String en) => steps.first.language == 'zh' ? zh : en;
  final drafts = <_Draft>[];
  for (var i = 0; i < steps.length; i++) {
    final step = steps[i];
    final previous = drafts.isEmpty ? null : drafts.last;
    if (previous != null &&
        isObserveTool(step.name) &&
        step.name == previous.first.name &&
        step.target != null &&
        step.target == previous.first.target &&
        step.status == previous.last.status &&
        _narrationOf(step) == _narrationOf(previous.first)) {
      previous
        ..last = step
        ..count += 1;
    } else {
      drafts.add(_Draft(i, step));
    }
  }
  return [
    for (var i = 0; i < drafts.length; i++)
      () {
        final draft = drafts[i], first = draft.first, last = draft.last;
        final narration = _narrationOf(first);
        final target = first.target;
        final title = target == null ? first.label : '${first.label} · $target';
        final reasoning = first.reasoning?.trim();
        return ToolTimelineRow(
          step: first.stepIndex ?? draft.index + 1,
          title: title,
          narration: narration,
          text:
              narration ??
              (draft.count > 1
                  ? '$title · ${t('${draft.count} 次', '×${draft.count}')}'
                  : title),
          subtitle: last.completed ? '' : last.state,
          state: i == drafts.length - 1
              ? _liveState(last.status, running)
              : ToolStepState.ok,
          count: draft.count,
          detail: reasoning == null || reasoning.isEmpty ? null : reasoning,
          refLabel: last.refLabel ?? first.refLabel,
          frame: last.frame ?? first.frame,
        );
      }(),
  ];
}

/// A run's steps: the live rail while running, one expandable line when done.
class ToolTimeline extends StatefulWidget {
  const ToolTimeline({
    super.key,
    required this.steps,
    this.running = false,
    this.elapsed,
  });
  final List<ToolStep> steps;
  final bool running;
  final Duration? elapsed;

  @override
  State<ToolTimeline> createState() => _ToolTimelineState();
}

class _ToolTimelineState extends State<ToolTimeline> {
  bool open = false, showAll = false;

  @override
  Widget build(BuildContext context) {
    final language = widget.steps.first.language;
    String t(String zh, String en) => language == 'zh' ? zh : en;
    final rows = buildToolSteps(widget.steps, running: widget.running);
    final rail = StepRail(
      rows: rows,
      language: language,
      hiddenCount: hiddenEarlierSteps(
        rows.length,
        running: widget.running,
        showAll: showAll,
      ),
      onShowEarlier: () => setState(() => showAll = true),
    );
    if (widget.running) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(4, 2, 4, 2),
        child: rail,
      );
    }
    final incomplete = !widget.steps.every((step) => step.completed);
    final body = open
        ? Padding(padding: const EdgeInsets.fromLTRB(8, 0, 8, 6), child: rail)
        : const SizedBox(width: double.infinity);
    final bodySmall = Theme.of(context).textTheme.bodySmall;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          button: true,
          expanded: open,
          onTapHint: open ? t('收起步骤', 'Hide steps') : t('展开步骤', 'Show steps'),
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () => setState(() => open = !open),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 36),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      incomplete
                          ? Icons.info_outline
                          : Icons.check_circle_outline,
                      size: 15,
                    ),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Text(
                        toolTimelineSummary(
                          language: language,
                          steps: widget.steps,
                          incomplete: incomplete,
                        ),
                        style: bodySmall,
                      ),
                    ),
                    const SizedBox(width: 4),
                    Icon(
                      open ? Icons.expand_less : Icons.expand_more,
                      size: 16,
                      color: Nova.tertiary,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        // A zero-length AnimatedSize asserts when its size changes, so reduced
        // motion drops the animation instead of shortening it.
        if (MediaQuery.disableAnimationsOf(context))
          body
        else
          AnimatedSize(
            duration: const Duration(milliseconds: 200),
            alignment: Alignment.topLeft,
            child: body,
          ),
      ],
    );
  }
}

/// The vertical rail: a 1.5dp line through one dot per row, with the
/// "earlier steps" link on top when [hiddenCount] rows are folded away.
class StepRail extends StatelessWidget {
  const StepRail({
    super.key,
    required this.rows,
    this.hiddenCount = 0,
    this.onShowEarlier,
    this.language = 'zh',
  });
  final List<ToolTimelineRow> rows;
  final int hiddenCount;
  final VoidCallback? onShowEarlier;
  final String language;

  @override
  Widget build(BuildContext context) {
    final shown = rows.skip(hiddenCount).toList();
    final link = hiddenCount > 0 && onShowEarlier != null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (link)
          _RailRow(
            first: true,
            last: shown.isEmpty,
            state: ToolStepState.dim,
            onTap: onShowEarlier,
            semanticsLabel: earlierStepsLabel(language, hiddenCount),
            child: Text(
              earlierStepsLabel(language, hiddenCount),
              style: const TextStyle(color: Nova.mint, fontSize: 13),
            ),
          ),
        for (var i = 0; i < shown.length; i++)
          _StepTile(
            key: ValueKey('tool-step:${shown[i].step}:${i + hiddenCount}'),
            row: shown[i],
            first: i == 0 && !link,
            last: i == shown.length - 1,
            language: language,
          ),
      ],
    );
  }
}

class _StepTile extends StatefulWidget {
  const _StepTile({
    super.key,
    required this.row,
    required this.first,
    required this.last,
    required this.language,
  });
  final ToolTimelineRow row;
  final bool first, last;
  final String language;
  @override
  State<_StepTile> createState() => _StepTileState();
}

class _StepTileState extends State<_StepTile> {
  bool showDetail = false, showFrame = false;
  Future<Uint8List?>? frameBytes;

  @override
  Widget build(BuildContext context) {
    final row = widget.row;
    String t(String zh, String en) => widget.language == 'zh' ? zh : en;
    final current =
        row.state == ToolStepState.run || row.state == ToolStepState.wait;
    final detail = showDetail ? row.detail : null;
    return _RailRow(
      first: widget.first,
      last: widget.last,
      state: row.state,
      onTap: row.detail == null
          ? null
          : () => setState(() => showDetail = !showDetail),
      semanticsLabel: row.text,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            row.text,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 13,
              height: 1.35,
              fontWeight: current ? FontWeight.w600 : FontWeight.w400,
              color: current ? Nova.text : Nova.secondary,
            ),
          ),
          if (row.subtitle.isNotEmpty || row.refLabel != null)
            Text(
              [
                if (row.subtitle.isNotEmpty) row.subtitle,
                ?row.refLabel,
              ].join(' · '),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12, color: Nova.tertiary),
            ),
          if (detail != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                detail,
                style: const TextStyle(
                  fontSize: 12,
                  height: 1.4,
                  color: Nova.tertiary,
                ),
              ),
            ),
          if (row.frame != null)
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => setState(() {
                showFrame = !showFrame;
                frameBytes ??= row.frame!();
              }),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Text(
                  showFrame
                      ? t('收起当时的画面', 'Hide that screen')
                      : t('查看当时的画面', 'View that screen'),
                  style: const TextStyle(
                    fontSize: 12,
                    color: Nova.mint,
                    decoration: TextDecoration.underline,
                  ),
                ),
              ),
            ),
          if (showFrame && frameBytes != null)
            _FramePreview(bytes: frameBytes!, language: widget.language),
        ],
      ),
    );
  }
}

class _FramePreview extends StatelessWidget {
  const _FramePreview({required this.bytes, required this.language});
  final Future<Uint8List?> bytes;
  final String language;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: FutureBuilder<Uint8List?>(
      future: bytes,
      builder: (context, snapshot) {
        final data = snapshot.data;
        if (snapshot.connectionState != ConnectionState.done) {
          return const SizedBox(
            height: 24,
            width: 24,
            child: CircularProgressIndicator(strokeWidth: 2),
          );
        }
        if (data == null || data.isEmpty) {
          return Text(
            language == 'zh' ? '画面已不可用' : 'Screen no longer available',
            style: const TextStyle(fontSize: 12, color: Nova.tertiary),
          );
        }
        return ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 220),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: Image.memory(
              data,
              fit: BoxFit.contain,
              gaplessPlayback: true,
            ),
          ),
        );
      },
    ),
  );
}

const _railLeading = 14.0;

class _RailRow extends StatelessWidget {
  const _RailRow({
    required this.first,
    required this.last,
    required this.state,
    required this.child,
    required this.semanticsLabel,
    this.onTap,
  });
  final bool first, last;
  final ToolStepState state;
  final Widget child;
  final String semanticsLabel;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    Widget row = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 28),
      child: IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              width: _railLeading,
              child: CustomPaint(
                painter: StepRailPainter(
                  state: state,
                  first: first,
                  last: last,
                ),
              ),
            ),
            const SizedBox(width: 9),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 3),
                child: Align(alignment: Alignment.centerLeft, child: child),
              ),
            ),
          ],
        ),
      ),
    );
    if (onTap != null) {
      row = Semantics(
        button: true,
        label: semanticsLabel,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: row,
        ),
      );
    }
    return row;
  }
}

/// Paints one row's slice of the rail (1.5dp line) and its dot: 8dp solid,
/// with a 7dp-radius halo for the live states.
class StepRailPainter extends CustomPainter {
  const StepRailPainter({
    required this.state,
    required this.first,
    required this.last,
  });
  final ToolStepState state;
  final bool first, last;

  static Color dotColor(ToolStepState state) => switch (state) {
    ToolStepState.run => Nova.mint,
    ToolStepState.wait => Nova.amber,
    ToolStepState.ok => Nova.secondary,
    ToolStepState.dim => Nova.tertiary.withValues(alpha: .5),
  };

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final line = Paint()
      ..color = Nova.separator
      ..strokeWidth = 1.5;
    if (!first) canvas.drawLine(Offset(center.dx, 0), center, line);
    if (!last) canvas.drawLine(center, Offset(center.dx, size.height), line);
    final color = dotColor(state);
    if (state == ToolStepState.run || state == ToolStepState.wait) {
      // Cover the line first so the translucent halo stays clean.
      canvas.drawCircle(center, 7, Paint()..color = Nova.ink);
      canvas.drawCircle(
        center,
        7,
        Paint()..color = color.withValues(alpha: .18),
      );
    }
    canvas.drawCircle(center, 4, Paint()..color = color);
  }

  @override
  bool shouldRepaint(StepRailPainter old) =>
      old.state != state || old.first != first || old.last != last;
}
