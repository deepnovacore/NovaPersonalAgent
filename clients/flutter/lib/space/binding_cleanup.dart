import 'dart:async';
import 'client_controller.dart';
import 'space_storage.dart';

/// Retire local records only after the Host confirms the other devices are gone.
Future<void> consolidateClientBindings(
  SpaceCatalog catalog,
  SpaceRecord keep, {
  Future<SpaceClientController> Function(SpaceRecord) open =
      SpaceClientController.openForBindingCleanup,
}) async {
  final old = catalog.bindings(keep).where((v) => v.id != keep.id).toList();
  if (old.isEmpty) return;
  final client = await open(keep);
  try {
    final deadline = DateTime.now().add(const Duration(seconds: 25));
    const blocked = {
      'cleanup_waiting_for_mobile_action',
      'cleanup_waiting_for_push_key',
    };
    await client.sync();
    if (blocked.contains(client.state.error)) {
      throw StateError('cleanup_sync_failed');
    }
    if (client.state.snapshot['owner'] != true) {
      throw StateError('cleanup_owner_required');
    }
    final devices = old
        .map((v) => v.device)
        .whereType<String>()
        .where((v) => v != keep.device)
        .toSet();
    for (final device in devices) {
      final id = await client.state.enqueue('device.revoke', {
        'device': device,
      });
      while (!client.state.completedOperations.contains(id)) {
        if (DateTime.now().isAfter(deadline)) {
          throw StateError('cleanup_not_confirmed');
        }
        await client.sync();
        if (blocked.contains(client.state.error)) {
          throw StateError('cleanup_sync_failed');
        }
        if (client.state.pending.any(
          (p) => p['op_id'] == id && p['status'] == 'rejected',
        )) {
          throw StateError('cleanup_not_confirmed');
        }
        await Future<void>.delayed(const Duration(milliseconds: 150));
      }
    }
    await catalog.retireBindings(keep);
  } finally {
    await client.dispose();
  }
}
