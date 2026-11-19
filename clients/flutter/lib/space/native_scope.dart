import 'dart:async';
import 'package:flutter/services.dart';
import 'space_storage.dart';

/// Stop old native engines and replace scoped stores before constructing any
/// standalone widget. Unselected installs have the Client runtime restriction.
class SpaceNativeScope {
  static const channel = MethodChannel('nova/space_scope');
  static Future<void>? _tail;
  static void resetForTesting() {
    _tail = null;
  }

  static Future<void> _apply(SpaceRecord? space) async {
    try {
      await channel.invokeMethod<void>('setSpaceScope', {
        'spaceId': space?.id ?? 'unselected',
        'mode': space?.mode.name ?? 'client',
      });
    } on MissingPluginException {
      /* Desktop/test embedders have no native agent. */
    }
  }

  static Future<void> activate(SpaceRecord? space) {
    final previous = _tail;
    final next = previous == null
        ? _apply(space)
        : previous.then(
            (_) => _apply(space),
            onError: (Object _) => _apply(space),
          );
    _tail = next;
    unawaited(
      next
          .whenComplete(() {
            if (identical(_tail, next)) _tail = null;
          })
          .catchError((Object _) {}),
    );
    return next;
  }
}
