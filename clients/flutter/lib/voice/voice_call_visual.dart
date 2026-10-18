import 'dart:math' as math;

import 'package:flutter/material.dart';

/// Decorative state animation. Only the supplied microphone level changes its
/// amplitude; connecting/thinking motion does not pretend to be captured audio.
class VoiceCallVisual extends StatefulWidget {
  const VoiceCallVisual({
    super.key,
    required this.status,
    required this.inputLevel,
    required this.isUserSpeaking,
    required this.isPlaying,
  });
  final String status;
  final double inputLevel;
  final bool isUserSpeaking, isPlaying;
  @override
  State<VoiceCallVisual> createState() => _VoiceCallVisualState();
}

class _VoiceCallVisualState extends State<VoiceCallVisual>
    with SingleTickerProviderStateMixin {
  late final AnimationController _motion = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 5200),
  );
  bool _reduced = false;
  bool get _moving =>
      !_reduced &&
      (widget.isUserSpeaking ||
          widget.isPlaying ||
          widget.status == 'thinking' ||
          widget.status == 'connecting');
  void _sync() {
    if (_moving) {
      if (!_motion.isAnimating) _motion.repeat();
    } else {
      _motion.stop();
      _motion.value = 0;
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduced = MediaQuery.disableAnimationsOf(context);
    _sync();
  }

  @override
  void didUpdateWidget(covariant VoiceCallVisual oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  @override
  void dispose() {
    _motion.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: AnimatedBuilder(
      animation: _motion,
      builder: (context, _) => CustomPaint(
        key: const ValueKey('voice-ripple'),
        painter: _VoiceRipplePainter(
          phase: _motion.value,
          moving: _moving,
          level: widget.inputLevel.isFinite
              ? widget.inputLevel.clamp(0.0, 1.0).toDouble()
              : 0.0,
        ),
      ),
    ),
  );
}

class _VoiceRipplePainter extends CustomPainter {
  _VoiceRipplePainter({
    required this.phase,
    required this.level,
    required this.moving,
  });
  final double phase, level;
  final bool moving;
  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = size.shortestSide * .24;
    final angle = moving ? phase * math.pi * 2 : 0.0;
    // Diffuse light rather than an outlined avatar. Microphone energy changes
    // the silhouette; slow phase motion communicates active processing only.
    canvas.drawCircle(
      center,
      radius * 1.65,
      Paint()
        ..shader = RadialGradient(
          colors: [
            const Color(0xff9cbeb0).withValues(alpha: .16 + level * .10),
            const Color(0xffc5d5cb).withValues(alpha: .05),
            const Color(0xfffaf9f6).withValues(alpha: 0),
          ],
        ).createShader(Rect.fromCircle(center: center, radius: radius * 1.65)),
    );
    for (var layer = 0; layer < 3; layer++) {
      final path = Path();
      for (var step = 0; step <= 120; step++) {
        final theta = step / 120 * math.pi * 2;
        final wave =
            math.sin(theta * 3 + angle + layer * .9) * .065 +
            math.cos(theta * 2 - angle + layer) * .045;
        final r = radius * (1 + wave + level * .13 - layer * .065);
        final point =
            center + Offset(math.cos(theta) * r, math.sin(theta) * r * .94);
        if (step == 0) {
          path.moveTo(point.dx, point.dy);
        } else {
          path.lineTo(point.dx, point.dy);
        }
      }
      path.close();
      canvas.drawPath(
        path,
        Paint()
          ..maskFilter = MaskFilter.blur(BlurStyle.normal, radius * .045)
          ..shader = LinearGradient(
            begin: Alignment(-.8 + math.sin(angle) * .2, -.9),
            end: const Alignment(.8, 1),
            colors: [
              const Color(0xffd8e5df).withValues(alpha: .5),
              const Color(0xffa6c2b8).withValues(alpha: .36),
              const Color(0xff487e73).withValues(alpha: .28),
            ],
          ).createShader(Rect.fromCircle(center: center, radius: radius)),
      );
    }
    canvas.drawOval(
      Rect.fromCenter(
        center: center + Offset(-radius * .2, -radius * .3),
        width: radius * 1.15,
        height: radius * .65,
      ),
      Paint()
        ..color = const Color(0xfffffef9).withValues(alpha: .52)
        ..maskFilter = MaskFilter.blur(BlurStyle.normal, radius * .22),
    );
  }

  @override
  bool shouldRepaint(covariant _VoiceRipplePainter oldDelegate) =>
      oldDelegate.phase != phase ||
      oldDelegate.level != level ||
      oldDelegate.moving != moving;
}
