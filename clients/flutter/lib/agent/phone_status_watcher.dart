import 'dart:async';
import 'package:flutter/widgets.dart';
import 'phone_channel.dart';

/// Live [PhoneStatus] for the settings page and the setup wizard: the first
/// read, every `status` event, and a re-read when the app returns from the
/// system settings screens the user was sent to.
class PhoneStatusWatcher extends ChangeNotifier with WidgetsBindingObserver {
  PhoneStatusWatcher(this.channel);
  final PhoneChannel channel;
  PhoneStatus? status;

  /// The bridge answered with an error or is missing (not an Android build).
  bool unavailable = false;
  StreamSubscription<PhoneEvent>? _events;
  bool _started = false, _disposed = false;

  void start() {
    if (_started) return;
    _started = true;
    WidgetsBinding.instance.addObserver(this);
    _events = channel.events.listen((event) {
      if (event is PhoneStatusEvent) _apply(event.status);
    }, onError: (Object _) {});
    unawaited(refresh());
  }

  void _apply(PhoneStatus next) {
    if (_disposed) return;
    unavailable = false;
    if (next == status) return;
    status = next;
    notifyListeners();
  }

  Future<void> refresh() async {
    try {
      _apply(await channel.status());
    } catch (_) {
      if (_disposed) return;
      if (status == null) {
        unavailable = true;
        notifyListeners();
      }
    }
  }

  /// Runs a command that returns the new status and publishes it.
  Future<void> run(Future<PhoneStatus> Function() command) async {
    try {
      _apply(await command());
    } catch (_) {
      await refresh();
      rethrow;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(refresh());
  }

  @override
  void dispose() {
    _disposed = true;
    if (_started) WidgetsBinding.instance.removeObserver(this);
    unawaited(_events?.cancel());
    super.dispose();
  }
}
