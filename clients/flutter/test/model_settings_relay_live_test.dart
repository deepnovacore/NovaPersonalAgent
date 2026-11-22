@Tags(['live'])
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/settings/model_settings_backend.dart';
import 'package:nova_mobile/space/client_controller.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/model_settings_backend.dart';
import 'package:nova_mobile/space/relay_transport.dart';
import 'package:nova_mobile/space/space_crypto.dart';
import 'package:nova_mobile/space/space_storage.dart';

import 'space_client_test.dart' show MemorySpacePersistence;

class _State extends SpaceClientState {
  _State(super.persistence);
  final receipts = <Map<String, dynamic>>[];

  @override
  Future<void> apply(Map<String, dynamic> event, {int? sequence}) async {
    await super.apply(event, sequence: sequence);
    if (event['type'] == 'receipt') receipts.add(Map.of(event));
  }
}

Map<String, dynamic> _models(SpaceClientState state) =>
    Map<String, dynamic>.from(
      (state.snapshot['host_settings'] as Map?)?['models'] as Map? ?? {},
    );

Future<void> _syncUntil(
  SpaceClientController controller,
  bool Function() ready,
  List<String> errors,
) async {
  final deadline = DateTime.now().add(const Duration(seconds: 15));
  while (!ready() && DateTime.now().isBefore(deadline)) {
    await controller.sync().timeout(const Duration(seconds: 5));
    await Future<void>.delayed(const Duration(milliseconds: 30));
  }
  expect(ready(), true, reason: '${controller.state.error} ${errors.join()}');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;
  test(
    'encrypted phone settings reach a real Host, persist, conflict with local CAS and survive restart',
    () async {
      const syntheticKey = 'phone-synthetic-secret-123';
      FlutterSecureStorage.setMockInitialValues({});
      final directory = await Directory(
        '/private/tmp',
      ).createTemp('nova-model-client-');
      final process = await Process.start('node', [
        'test/support/model_settings_relay_fixture.mjs',
      ], environment: Platform.environment);
      final errors = <String>[];
      final errorSub = process.stderr
          .transform(utf8.decoder)
          .listen(errors.add);
      final lines = StreamIterator(
        process.stdout.transform(utf8.decoder).transform(const LineSplitter()),
      );
      final sendGate = Completer<void>();
      SpaceClientController? controller;
      var commandId = 0;
      Future<Map<String, dynamic>> command(
        String method, [
        Map<String, dynamic> params = const {},
      ]) async {
        final id = ++commandId;
        process.stdin.writeln(
          jsonEncode({'id': id, 'method': method, ...params}),
        );
        await process.stdin.flush();
        if (!await lines.moveNext().timeout(const Duration(seconds: 15))) {
          throw StateError('Host fixture exited: ${errors.join()}');
        }
        final reply = jsonMap(lines.current);
        expect(reply['id'], id);
        expect(reply['error'], isNull);
        return Map<String, dynamic>.from(reply['result'] as Map);
      }

      try {
        expect(
          await lines.moveNext().timeout(const Duration(seconds: 15)),
          true,
        );
        final invitation = SpaceInvitation.parse(
          jsonEncode(jsonMap(lines.current)['invitation']),
          allowLoopback: true,
        );
        final identity = await SpaceIdentity.generate();
        final record = SpaceRecord(
          id: 'model-settings-live',
          name: 'Settings integration',
          mode: SpaceMode.client,
          remoteSpace: invitation.value['space'] as String,
          hostDevice: invitation.value['host'] as String,
          hostSigningKey: Map<String, dynamic>.from(
            invitation.value['hostSigningPublicKey'] as Map,
          ),
          relay: invitation.relay,
          device: newSpaceId(),
        );
        final crypto = SpaceCrypto(record, identity, MemorySpacePersistence());
        await crypto.load();
        final proof = {
          'v': 1,
          'purpose': 'pair-request',
          'invitationId': invitation.value['id'],
          'secret': invitation.value['secret'],
          'device': record.device,
          'signingPublicKey': identity.signingPublic,
          'encryptionPublicKey': identity.encryptionPublic,
          'business_versions': [1],
        };
        await const SpaceSecurePersistence(
          'nova.space.pair-request.model-settings-live',
        ).write(
          jsonEncode({
            'invitationId': invitation.value['id'],
            'secret': invitation.value['secret'],
            'device': record.device,
            'signingPublicKey': identity.signingPublic,
            'encryptionPublicKey': identity.encryptionPublic,
            'proof': await crypto.signControl(proof),
            'business_versions': [1],
          }),
        );
        final disk = SpaceFilePersistence(
          File('${directory.path}/client.json'),
          const SpaceSecurePersistence('model-settings-live.storage-key'),
        );
        final state = _State(disk);
        await state.open();
        controller = SpaceClientController(
          state,
          SpaceRelayTransport(crypto, allowLoopback: true),
        );
        final active = controller;
        await _syncUntil(
          active,
          () =>
              state.snapshot['owner'] == true && _models(state)['version'] == 0,
          errors,
        );
        final backend = RemoteModelSettingsBackend(
          state,
          lane: 'conversationText',
          onSync: () async {
            await sendGate.future;
            await active.sync();
          },
        );
        final initial = await backend.load();
        expect(initial.customEndpoint, false);
        expect(initial.modelDiscovery, false);
        expect(await backend.hasCredential('deepseek', ''), false);
        await backend.save(
          const ModelSettingsInput(
            providerId: 'deepseek',
            endpoint: '',
            model: 'phone-model',
            protocol: ModelProtocol.chatCompletions,
            newKey: syntheticKey,
          ),
        );
        // Reopen the actual encrypted file before allowing any settings send.
        final restored = SpaceClientState(disk);
        await restored.open();
        final secret = restored.pending.singleWhere(
          (op) => op['kind'] == 'secret.put',
        );
        final route = restored.pending.singleWhere(
          (op) => op['kind'] == 'settings.patch',
        );
        final secretId = secret['op_id'] as String,
            routeId = route['op_id'] as String;
        expect(route['depends_on'], [secretId]);
        expect(
          ((route['input'] as Map)['params'] as Map)['expected_version'],
          0,
        );
        expect((secret['input'] as Map)['value'], syntheticKey);
        expect(
          utf8.decode(await disk.file.readAsBytes(), allowMalformed: true),
          isNot(contains(syntheticKey)),
        );
        restored.dispose();
        sendGate.complete();
        await _syncUntil(
          active,
          () =>
              state.completedOperations.contains(secretId) &&
              state.completedOperations.contains(routeId) &&
              _models(state)['version'] == 1,
          errors,
        );
        final receipts = state.receipts
            .where((receipt) => [secretId, routeId].contains(receipt['op_id']))
            .toList();
        expect(
          receipts.map((receipt) => receipt['status']),
          everyElement('accepted'),
        );
        expect(receipts.first['op_id'], secretId);
        expect(receipts.any((receipt) => receipt['op_id'] == routeId), true);
        expect(jsonEncode(state.snapshot), isNot(contains(syntheticKey)));
        expect(await backend.hasCredential('deepseek', ''), true);
        expect((await backend.load()).model, 'phone-model');
        var inspect = await command('inspect');
        expect(inspect['secretMatches'], true);
        expect(inspect['snapshotContainsSecret'], false);
        expect(inspect['journalContainsSecret'], false);
        expect(inspect['wireContainsSecret'], false);
        expect(inspect['phoneEnvelopeCount'] as int, greaterThanOrEqualTo(2));
        expect((inspect['persisted'] as Map)['version'], 1);
        expect(
          ((inspect['persisted'] as Map)['routes'] as Map)['conversationText'],
          {'provider': 'deepseek', 'model': 'phone-model'},
        );

        // A local desktop edit updates the same store and invalidates an open phone editor.
        await command('local.configure', {'expected_version': 1});
        await _syncUntil(active, () => _models(state)['version'] == 2, errors);
        expect((_models(state)['routes'] as Map)['conversationText'], {
          'provider': 'deepseek',
          'model': 'desktop-model',
        });
        await backend.save(
          const ModelSettingsInput(
            providerId: 'deepseek',
            endpoint: '',
            model: 'stale-phone-model',
            protocol: ModelProtocol.chatCompletions,
          ),
        );
        await _syncUntil(
          active,
          () => state.pending.any((op) => op['status'] == 'conflict'),
          errors,
        );
        expect(
          state.pending.singleWhere(
            (op) => op['status'] == 'conflict',
          )['error'],
          'version_conflict',
        );
        expect(
          (_models(state)['routes'] as Map)['conversationText']['model'],
          'desktop-model',
        );

        inspect = await command('restart');
        expect(inspect['secretMatches'], true);
        expect((inspect['models'] as Map)['version'], 2);
        expect((inspect['models'] as Map)['applied_version'], 2);
        await _syncUntil(
          active,
          () => _models(state)['applied_version'] == 2,
          errors,
        );
        final reopened = RemoteModelSettingsBackend(
          state,
          lane: 'conversationText',
          onSync: active.sync,
        );
        expect((await reopened.load()).model, 'desktop-model');
        expect(await reopened.hasCredential('deepseek', ''), true);
        expect(jsonEncode(state.snapshot), isNot(contains(syntheticKey)));
        expect(
          errors.where(
            (error) =>
                !error.contains('ExperimentalWarning') &&
                !error.contains('trace-warnings'),
          ),
          isEmpty,
        );
      } finally {
        if (!sendGate.isCompleted) sendGate.complete();
        await controller?.dispose();
        process.kill();
        await process.exitCode.timeout(
          const Duration(seconds: 10),
          onTimeout: () {
            process.kill(ProcessSignal.sigkill);
            return -1;
          },
        );
        await lines.cancel();
        await errorSub.cancel();
        await directory.delete(recursive: true);
      }
    },
    skip:
        Platform.environment['NOVA_RELAY_BUILD_ROOT'] == null ||
            Platform.environment['NOVA_RUNTIME_BUILD_ROOT'] == null
        ? 'Set NOVA_RELAY_BUILD_ROOT and NOVA_RUNTIME_BUILD_ROOT to compiled src directories'
        : false,
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
