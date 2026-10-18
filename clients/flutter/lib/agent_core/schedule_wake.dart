import 'package:flutter/services.dart';

class ScheduleWake {
  static const channel = MethodChannel('nova/schedule/v1');
  bool available = false;
  Future<void> acquire({required bool headless}) async {
    try {
      available =
          await channel.invokeMethod<bool>('acquire', {'headless': headless}) ??
          false;
      if (!available) throw StateError('scheduler_owned_elsewhere');
    } on MissingPluginException {
      available = false;
    }
  }

  Future<void> attach(
    Future<void> Function() wake,
    void Function() expire,
  ) async {
    if (!available) return;
    channel.setMethodCallHandler((call) async {
      if (call.method == 'wake') {
        await wake();
        return {'finished': true};
      }
      if (call.method == 'expired') {
        expire();
        return true;
      }
      throw MissingPluginException();
    });
    await channel.invokeMethod<void>('ready');
  }

  Future<void> configure(bool enabled) async {
    if (available) {
      await channel.invokeMethod<void>('configure', {'enabled': enabled});
    }
  }

  Future<void> notifyWaiting() async {
    if (available) await channel.invokeMethod<void>('notifyWaiting');
  }

  static Future<void> requestNotifications() async {
    try {
      await channel.invokeMethod<void>('requestNotifications');
    } on MissingPluginException {
      /* Foreground-only test hosts. */
    }
  }

  Future<void> release() async {
    if (available) {
      await channel.invokeMethod<void>('release');
      channel.setMethodCallHandler(null);
      available = false;
    }
  }
}
