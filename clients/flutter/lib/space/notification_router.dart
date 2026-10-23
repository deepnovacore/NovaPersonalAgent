import 'dart:convert';
import 'space_storage.dart';

class SpaceNotificationRouter {
  static Future<String?> resolve(
    String handle,
    Iterable<SpaceRecord> spaces, {
    Future<String?> Function(SpaceRecord)? readRegistration,
  }) async {
    for (final space in spaces.where((s) => s.mode == SpaceMode.client)) {
      final raw =
          await (readRegistration?.call(space) ??
              SpaceSecurePersistence('nova.space.push.${space.id}').read());
      if (raw != null && (jsonDecode(raw) as Map)['handle'] == handle) {
        return space.id;
      }
    }
    return null;
  }
}
