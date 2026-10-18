import 'dart:async';

/// Only schedules data synchronization. It has no task dispatch capability.
class LifeSyncScheduler {
  LifeSyncScheduler({required this.sync, required this.onError});
  final Future<void> Function() sync;
  final void Function(Object) onError;
  Timer? _timer;
  bool _foreground = false, _running = false, _disposed = false;
  int _failures = 0;
  void setForeground(bool foreground) {
    if (_disposed || _foreground == foreground) return;
    _foreground = foreground;
    _timer?.cancel();
    if (foreground) _schedule(Duration.zero);
  }

  void changed() {
    if (_foreground && !_disposed && !_running) {
      _schedule(const Duration(milliseconds: 500));
    }
  }

  void _schedule(Duration delay) {
    _timer?.cancel();
    _timer = Timer(delay, () => unawaited(_run()));
  }

  Future<void> _run() async {
    if (_disposed || !_foreground || _running) return;
    _running = true;
    try {
      await sync();
      _failures = 0;
    } catch (error) {
      _failures++;
      if (!_disposed) onError(error);
    } finally {
      _running = false;
      if (!_disposed && _foreground) {
        _schedule(
          Duration(
            seconds: _failures == 0 || _failures > 3
                ? 30
                : 1 << (_failures - 1),
          ),
        );
      }
    }
  }

  void dispose() {
    _disposed = true;
    _timer?.cancel();
  }
}
