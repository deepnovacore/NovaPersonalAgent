import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/mobile_tools.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

class FakeTools implements SpaceMobileTools {
  bool granted = true, uncertain = false;
  int executions = 0;
  @override
  Future<bool> requestPermission(String tool) async => granted;
  @override
  Future<Map<String, dynamic>> execute(
    String id,
    String tool,
    Map<String, dynamic> args,
  ) async {
    executions++;
    if (uncertain) throw PlatformException(code: 'connection_lost');
    return {'id': 'system-reminder'};
  }
}

Map<String, dynamic> action() => {
  'v': 1,
  'type': 'mobile.action',
  'action_id': 'one',
  'tool': 'reminder.create',
  'args': {'title': 'Call'},
  'expires_at': DateTime.now().millisecondsSinceEpoch + 60000,
};
void main() {
  test(
    'permission denial and duplicate actions never execute an effect',
    () async {
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      final tools = FakeTools()..granted = false;
      final executor = SpaceMobileActions(
        state,
        tools,
        isForeground: () => true,
      );
      final request = action();
      expect((await executor.handle(request))['status'], 'denied');
      tools.granted = true;
      expect((await executor.handle(request))['status'], 'denied');
      expect(tools.executions, 0);
    },
  );
  test('uncertain effect survives restart without automatic retry', () async {
    final disk = MemorySpacePersistence();
    var state = SpaceClientState(disk);
    await state.open();
    final tools = FakeTools()..uncertain = true;
    final request = action();
    expect(
      (await SpaceMobileActions(
        state,
        tools,
        isForeground: () => true,
      ).handle(request))['status'],
      'unknown',
    );
    state = SpaceClientState(disk);
    await state.open();
    expect(
      (await SpaceMobileActions(
        state,
        tools,
        isForeground: () => true,
      ).handle(request))['status'],
      'unknown',
    );
    expect(tools.executions, 1);
  });
  test('persisted admission crash converts executing to unknown', () async {
    final disk = MemorySpacePersistence();
    var state = SpaceClientState(disk);
    await state.open();
    final request = action();
    state.effects['one'] = {
      'action_id': 'one',
      'status': 'executing',
      'fingerprint': 'unused',
    };
    await state.save();
    state = SpaceClientState(disk);
    await state.open();
    expect(state.effects['one']!['status'], 'unknown');
    final tools = FakeTools();
    expect(
      (await SpaceMobileActions(
        state,
        tools,
        isForeground: () => true,
      ).handle(request))['error'],
      'action_id_conflict',
    );
    expect(tools.executions, 0);
  });
}
