import 'package:flutter/services.dart';
import '../protocol/request_id.dart';

/// One user-started turn; expiry stops execution rather than replaying writes.
class BackgroundExecution {
  static const _channel = MethodChannel('nova/execution/v1');
  static final _expirationCallbacks = <String, void Function()>{};
  String? _id;
  Future<void> begin(void Function() onExpired) async {
    final id = _id = requestId();
    _expirationCallbacks[id] = onExpired;
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'expired' &&
          call.arguments is Map &&
          call.arguments['id'] is String) {
        _expirationCallbacks[call.arguments['id']]?.call();
      }
    });
    try {
      final value = await _channel.invokeMethod<Object?>('begin', {'id': id});
      if (value is Map &&
          ['expired', 'foreground_required'].contains(value['mode'])) {
        onExpired();
      }
    } on PlatformException {
      /* Foreground work still runs with a limited lease. */
    } on MissingPluginException {
      /* Unsupported hosts remain foreground only. */
    }
  }

  Future<void> progress(int units, String phase) async {
    final id = _id;
    if (id == null) return;
    try {
      await _channel.invokeMethod<Object?>('progress', {
        'id': id,
        'units': units,
        'phase': phase,
      });
    } catch (_) {}
  }

  Future<void> end({required bool success}) async {
    final id = _id;
    _id = null;
    if (id == null) return;
    _expirationCallbacks.remove(id);
    try {
      await _channel.invokeMethod<Object?>('end', {
        'id': id,
        'success': success,
      });
    } catch (_) {}
    if (_expirationCallbacks.isEmpty) _channel.setMethodCallHandler(null);
  }
}
