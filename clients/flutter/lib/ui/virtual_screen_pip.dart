// Layout and interaction rules adapted from Mika (https://github.com/wangzan101/Mika,
// Apache-2.0, commit 5f630d9), Copyright 2026 wangzan101. Modified by Nova:
// reimplemented in Flutter on the nova/phone/frames JPEG stream (AgentPip.kt:
// 96/220 widths, drag-and-snap to corners, state shown by border glow only,
// auto-expand on takeover, reduced motion); no Mika code or assets are copied.
import 'dart:math' as math;
import 'dart:typed_data';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../agent/phone_run.dart';
import 'theme.dart';

/// Width of the small picture and of the expanded one.
const pipCollapsedWidth = 96.0;
const pipExpandedWidth = 220.0;
const _controlsHeight = 48.0;
const _pipRadius = 14.0;
const pipWorkingColor = Nova.mint;
const pipNeedsYouColor = Color(0xffe8913a);

enum PipCorner { topLeft, topRight, bottomLeft, bottomRight }

/// Holds [PhonePreview] open while something on screen wants the frames and
/// the app is in the foreground; otherwise frames and `setPreview` stop.
class PreviewLease with WidgetsBindingObserver {
  PreviewLease(this.preview) {
    WidgetsBinding.instance.addObserver(this);
  }
  final PhonePreview preview;
  bool _wanted = false, _foreground = true, _held = false;

  bool get held => _held;

  set wanted(bool value) {
    _wanted = value;
    _apply();
  }

  void _apply() {
    final next = _wanted && _foreground;
    if (next == _held) return;
    _held = next;
    if (next) {
      preview.retain();
    } else {
      preview.release();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _apply();
  }

  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _wanted = false;
    _apply();
  }
}

/// Floating picture of the virtual screen while a phone task runs on it.
///
/// Put it in a [Stack] that fills the area it may float over; it takes no
/// space and absorbs touches only on its own bounds. [topInset] and
/// [bottomInset] keep it off the top bar and the composer. Frames flow (and
/// `setPreview` is on) only while it is on screen: the run is active, [visible]
/// is true and the app is in the foreground.
class VirtualScreenPip extends StatefulWidget {
  const VirtualScreenPip({
    super.key,
    required this.tracker,
    this.language = 'zh',
    this.visible = true,
    this.onStop,
    this.topInset = 8,
    this.bottomInset = 8,
    this.sideInset = 8,
  });
  final PhoneRunTracker tracker;
  final String language;
  final bool visible;

  /// Stops the whole task.
  final VoidCallback? onStop;
  final double topInset, bottomInset, sideInset;

  @override
  State<VirtualScreenPip> createState() => _VirtualScreenPipState();
}

class _VirtualScreenPipState extends State<VirtualScreenPip>
    with SingleTickerProviderStateMixin {
  late final AnimationController _breath = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  );
  PipCorner corner = PipCorner.bottomRight;
  Offset? dragTopLeft;
  bool expanded = false, dragging = false;
  late PreviewLease _lease = PreviewLease(tracker.preview);
  bool _needsUser = false, _reduced = false, _started = false;
  String? _taskId;

  String t(String zh, String en) => widget.language == 'zh' ? zh : en;
  PhoneRunTracker get tracker => widget.tracker;

  @override
  void initState() {
    super.initState();
    tracker.addListener(_sync);
    _sync();
    _started = true;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduced = MediaQuery.disableAnimationsOf(context);
    _syncBreath();
  }

  @override
  void didUpdateWidget(covariant VirtualScreenPip old) {
    super.didUpdateWidget(old);
    if (old.tracker != tracker) {
      old.tracker.removeListener(_sync);
      _lease.dispose();
      _lease = PreviewLease(tracker.preview);
      tracker.addListener(_sync);
    }
    _sync();
  }

  /// Keeps the preview lease, auto-expansion and breathing in step with the
  /// run. Called outside of build.
  void _sync() {
    final run = tracker.activeVirtual;
    _lease.wanted = run != null && widget.visible;
    final needs = run?.needsUser ?? false;
    if (run?.taskId != _taskId) {
      _taskId = run?.taskId;
      _needsUser = false;
    }
    if (needs && !_needsUser) {
      // The task needs the user: show the big picture and the buttons.
      if (_started && mounted) {
        setState(() => expanded = true);
      } else {
        expanded = true;
      }
    }
    _needsUser = needs;
    _syncBreath();
  }

  void _syncBreath() {
    if (_needsUser && !_reduced && !_breath.isAnimating) {
      _breath.repeat(reverse: true);
    } else if ((!_needsUser || _reduced) && _breath.isAnimating) {
      _breath.stop();
      _breath.value = 0;
    }
  }

  @override
  void dispose() {
    tracker.removeListener(_sync);
    _lease.dispose();
    _breath.dispose();
    super.dispose();
  }

  double _aspect(BuildContext context) {
    final measured = tracker.preview.aspect.value;
    if (measured != null && measured.isFinite && measured > 0) {
      return measured.clamp(.3, 3.0);
    }
    final size = MediaQuery.sizeOf(context);
    return size.height > 0 ? (size.width / size.height).clamp(.3, 3.0) : .5;
  }

  /// Outer size: picture at the wanted width, plus the button row when open.
  Size _size(BuildContext context, Rect area, double aspect) {
    final controls = expanded ? _controlsHeight : 0.0;
    var width = math.min(
      expanded ? pipExpandedWidth : pipCollapsedWidth,
      area.width,
    );
    final maxPicture = math.max(40.0, area.height - controls);
    var picture = width / aspect;
    if (picture > maxPicture) {
      picture = maxPicture;
      width = picture * aspect;
    }
    return Size(width, picture + controls);
  }

  Offset _cornerTopLeft(PipCorner c, Rect area, Size size) => Offset(
    c == PipCorner.topLeft || c == PipCorner.bottomLeft
        ? area.left
        : area.right - size.width,
    c == PipCorner.topLeft || c == PipCorner.topRight
        ? area.top
        : area.bottom - size.height,
  );

  void _dragEnd(DragEndDetails details, Rect area, Size size) {
    final start = dragTopLeft ?? _cornerTopLeft(corner, area, size);
    // Follow the finger 1:1, then let the release velocity decide the corner.
    final end = start + details.velocity.pixelsPerSecond * .12;
    final center = end + Offset(size.width / 2, size.height / 2);
    final right = center.dx > area.center.dx;
    final bottom = center.dy > area.center.dy;
    setState(() {
      corner = bottom
          ? (right ? PipCorner.bottomRight : PipCorner.bottomLeft)
          : (right ? PipCorner.topRight : PipCorner.topLeft);
      dragging = false;
      dragTopLeft = null;
    });
  }

  Future<void> _command(Future<void> Function() command) async {
    await command();
    if (!mounted || !tracker.actionFailed) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(content: Text(t('操作没有成功，请重试。', 'That didn’t work. Try again.'))),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: tracker,
    builder: (context, _) {
      final run = tracker.activeVirtual;
      if (run == null || !widget.visible) return const SizedBox.shrink();
      return LayoutBuilder(
        builder: (context, constraints) {
          final area = Rect.fromLTRB(
            widget.sideInset,
            widget.topInset,
            math.max(
              widget.sideInset + 40,
              constraints.maxWidth - widget.sideInset,
            ),
            math.max(
              widget.topInset + 40,
              constraints.maxHeight - widget.bottomInset,
            ),
          );
          final size = _size(context, area, _aspect(context));
          final topLeft = dragTopLeft ?? _cornerTopLeft(corner, area, size);
          final instant = dragging || _reduced;
          return Stack(
            children: [
              AnimatedPositioned(
                duration: instant
                    ? Duration.zero
                    : const Duration(milliseconds: 220),
                curve: Curves.easeOutCubic,
                left: topLeft.dx,
                top: topLeft.dy,
                width: size.width,
                height: size.height,
                child: _body(context, run, size, area),
              ),
            ],
          );
        },
      );
    },
  );

  String _stateLabel(PhoneRun run) => run.takeoverActive
      ? t('你正在手机上操作', 'You are using the app')
      : run.needsUser
      ? t('需要你处理', 'Needs you')
      : t('正在手机上操作', 'Working on your phone');

  Widget _body(BuildContext context, PhoneRun run, Size size, Rect area) {
    final needs = run.needsUser;
    final color = needs ? pipNeedsYouColor : pipWorkingColor;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: expanded ? null : () => setState(() => expanded = true),
      onPanStart: (_) => setState(() {
        dragging = true;
        dragTopLeft = _cornerTopLeft(corner, area, size);
      }),
      onPanUpdate: (details) => setState(() {
        final next = (dragTopLeft ?? Offset.zero) + details.delta;
        dragTopLeft = Offset(
          next.dx.clamp(
            area.left,
            math.max(area.left, area.right - size.width),
          ),
          next.dy.clamp(
            area.top,
            math.max(area.top, area.bottom - size.height),
          ),
        );
      }),
      onPanEnd: (details) => _dragEnd(details, area, size),
      onPanCancel: () => setState(() {
        dragging = false;
        dragTopLeft = null;
      }),
      child: Semantics(
        container: true,
        label: _stateLabel(run),
        hint: expanded
            ? null
            : t('点按放大虚拟屏', 'Tap to enlarge the virtual screen'),
        button: !expanded,
        onTap: expanded ? null : () => setState(() => expanded = true),
        child: AnimatedBuilder(
          animation: _breath,
          builder: (context, child) {
            final pulse = needs && !_reduced ? _breath.value : 0.0;
            return DecoratedBox(
              key: ValueKey(needs ? 'pip-needs-you' : 'pip-working'),
              decoration: BoxDecoration(
                color: Nova.ink,
                borderRadius: BorderRadius.circular(_pipRadius),
                border: Border.all(
                  color: color.withValues(alpha: needs ? .55 + pulse * .45 : 1),
                  width: needs ? 2 : 1.5,
                ),
                boxShadow: [
                  BoxShadow(
                    color: color.withValues(
                      alpha: needs ? .25 + pulse * .35 : .22,
                    ),
                    blurRadius: needs ? 10 + pulse * 8 : 8,
                  ),
                ],
              ),
              child: child,
            );
          },
          child: ClipRRect(
            borderRadius: BorderRadius.circular(_pipRadius - 1.5),
            child: Column(
              children: [
                Expanded(child: _picture(run)),
                if (expanded) _controls(run),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _picture(PhoneRun run) => Stack(
    fit: StackFit.expand,
    children: [
      ValueListenableBuilder<Uint8List?>(
        valueListenable: tracker.preview.frame,
        builder: (context, frame, _) => frame == null || run.takeoverActive
            ? _placeholder(run)
            : Image.memory(
                frame,
                fit: BoxFit.cover,
                gaplessPlayback: true,
                excludeFromSemantics: true,
              ),
      ),
      if (expanded)
        Positioned(
          top: 0,
          right: 0,
          child: Semantics(
            container: true,
            button: true,
            label: t('收起', 'Collapse'),
            excludeSemantics: true,
            onTap: () => setState(() => expanded = false),
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => setState(() => expanded = false),
              child: const SizedBox(
                width: 44,
                height: 44,
                child: Align(
                  alignment: Alignment.topRight,
                  child: Padding(
                    padding: EdgeInsets.all(6),
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: Color(0x99000000),
                        shape: BoxShape.circle,
                      ),
                      child: SizedBox(
                        width: 24,
                        height: 24,
                        child: Icon(
                          CupertinoIcons.xmark,
                          size: 13,
                          color: Colors.white,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
    ],
  );

  /// Before the first frame, while the user has the app, and for secure
  /// (black) pages the native side sends nothing.
  Widget _placeholder(PhoneRun run) => ColoredBox(
    color: const Color(0xff1d2226),
    child: Center(
      child: expanded && run.takeoverActive
          ? Padding(
              padding: const EdgeInsets.all(12),
              child: Text(
                t('你正在手机上操作这个 App', 'You have the app on your phone'),
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white70, fontSize: 13),
              ),
            )
          : const Icon(
              CupertinoIcons.device_phone_portrait,
              color: Colors.white38,
              size: 22,
            ),
    ),
  );

  Widget _controls(PhoneRun run) => SizedBox(
    height: _controlsHeight,
    child: ColoredBox(
      color: Nova.ink,
      child: Row(
        children: [
          Expanded(
            child: run.takeoverActive
                ? TextButton(
                    key: const ValueKey('pip-hand-back'),
                    onPressed: () =>
                        _command(() => tracker.handBack(run.taskId)),
                    style: _buttonStyle(pipNeedsYouColor),
                    child: Text(t('处理好了', 'Done')),
                  )
                : TextButton(
                    key: const ValueKey('pip-take-over'),
                    onPressed: () =>
                        _command(() => tracker.takeover(run.taskId)),
                    style: _buttonStyle(Nova.mint),
                    child: Text(t('我来', 'Take over')),
                  ),
          ),
          if (widget.onStop != null)
            IconButton(
              key: const ValueKey('pip-stop'),
              tooltip: t('停止任务', 'Stop task'),
              onPressed: widget.onStop,
              constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
              icon: const Icon(
                CupertinoIcons.stop_fill,
                size: 18,
                color: Nova.red,
              ),
            ),
        ],
      ),
    ),
  );

  ButtonStyle _buttonStyle(Color color) => TextButton.styleFrom(
    foregroundColor: color,
    minimumSize: const Size(44, _controlsHeight),
    padding: const EdgeInsets.symmetric(horizontal: 8),
    tapTargetSize: MaterialTapTargetSize.padded,
    textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
  );
}

/// The live virtual screen as a plain block (no dragging), for the realtime
/// voice page. It holds the preview open for as long as it is on screen.
class VirtualScreenView extends StatefulWidget {
  const VirtualScreenView({
    super.key,
    required this.tracker,
    required this.run,
    this.language = 'zh',
    this.maxWidth = 200,
    this.maxHeight = 320,
  });
  final PhoneRunTracker tracker;
  final PhoneRun run;
  final String language;
  final double maxWidth, maxHeight;

  @override
  State<VirtualScreenView> createState() => _VirtualScreenViewState();
}

class _VirtualScreenViewState extends State<VirtualScreenView>
    with SingleTickerProviderStateMixin {
  late final PreviewLease _lease = PreviewLease(widget.tracker.preview);
  late final AnimationController _breath = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  );
  String t(String zh, String en) => widget.language == 'zh' ? zh : en;

  @override
  void initState() {
    super.initState();
    _lease.wanted = true;
  }

  @override
  void dispose() {
    _lease.dispose();
    _breath.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final run = widget.run;
    final needs = run.needsUser;
    final reduced = MediaQuery.disableAnimationsOf(context);
    if (needs && !reduced && !_breath.isAnimating) {
      _breath.repeat(reverse: true);
    } else if ((!needs || reduced) && _breath.isAnimating) {
      _breath.stop();
      _breath.value = 0;
    }
    final color = needs ? pipNeedsYouColor : pipWorkingColor;
    final tracker = widget.tracker;
    return Semantics(
      container: true,
      label: run.takeoverActive
          ? t('你正在手机上操作', 'You are using the app')
          : needs
          ? t('需要你处理', 'Needs you')
          : t('正在手机上操作', 'Working on your phone'),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ValueListenableBuilder<double?>(
            valueListenable: tracker.preview.aspect,
            builder: (context, measured, _) {
              final aspect = (measured ?? .5).clamp(.3, 3.0);
              var width = widget.maxWidth;
              var height = width / aspect;
              if (height > widget.maxHeight) {
                height = widget.maxHeight;
                width = height * aspect;
              }
              return AnimatedBuilder(
                animation: _breath,
                builder: (context, child) {
                  final pulse = needs && !reduced ? _breath.value : 0.0;
                  return DecoratedBox(
                    key: ValueKey(
                      needs ? 'voice-screen-needs-you' : 'voice-screen-working',
                    ),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(_pipRadius),
                      border: Border.all(
                        color: color.withValues(
                          alpha: needs ? .55 + pulse * .45 : 1,
                        ),
                        width: needs ? 2 : 1.5,
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: color.withValues(
                            alpha: needs ? .25 + pulse * .35 : .22,
                          ),
                          blurRadius: needs ? 10 + pulse * 8 : 8,
                        ),
                      ],
                    ),
                    child: child,
                  );
                },
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(_pipRadius - 1.5),
                  child: SizedBox(
                    key: const ValueKey('voice-screen'),
                    width: width,
                    height: height,
                    child: ValueListenableBuilder<Uint8List?>(
                      valueListenable: tracker.preview.frame,
                      builder: (context, frame, _) =>
                          frame == null || run.takeoverActive
                          ? ColoredBox(
                              color: const Color(0xff1d2226),
                              child: Center(
                                child: run.takeoverActive
                                    ? Padding(
                                        padding: const EdgeInsets.all(10),
                                        child: Text(
                                          t(
                                            '你正在手机上操作这个 App',
                                            'You have the app on your phone',
                                          ),
                                          textAlign: TextAlign.center,
                                          style: const TextStyle(
                                            color: Colors.white70,
                                            fontSize: 12,
                                          ),
                                        ),
                                      )
                                    : const Icon(
                                        CupertinoIcons.device_phone_portrait,
                                        color: Colors.white38,
                                        size: 22,
                                      ),
                              ),
                            )
                          : Image.memory(
                              frame,
                              fit: BoxFit.cover,
                              gaplessPlayback: true,
                              excludeFromSemantics: true,
                            ),
                    ),
                  ),
                ),
              );
            },
          ),
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: run.takeoverActive
                ? TextButton(
                    key: const ValueKey('voice-screen-hand-back'),
                    onPressed: () => tracker.handBack(run.taskId),
                    child: Text(t('处理好了', 'Done')),
                  )
                : TextButton(
                    key: const ValueKey('voice-screen-take-over'),
                    onPressed: () => tracker.takeover(run.taskId),
                    child: Text(t('我来', 'Take over')),
                  ),
          ),
        ],
      ),
    );
  }
}
