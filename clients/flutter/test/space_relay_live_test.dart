import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/push_client.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/space/client_controller.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/relay_transport.dart';
import 'package:nova_mobile/space/space_crypto.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global =
      null; // This test exercises the actual loopback network.
  test(
    'real Node relay pairs Dart keys, restores >2MiB backlog, streams and deduplicates final',
    () async {
      final process = await Process.start('node', [
        'test/support/space_relay_fixture.mjs',
      ], environment: Platform.environment);
      final errors = <String>[];
      final errorSub = process.stderr
          .transform(utf8.decoder)
          .listen(errors.add);
      SpaceClientController? controller;
      HttpServer? stalledGateway;
      Completer<void>? releaseGateway;
      StreamSubscription<HttpRequest>? gatewayServing;
      Future<void>? refresh;
      try {
        final startup = jsonMap(
          await process.stdout
              .transform(utf8.decoder)
              .transform(const LineSplitter())
              .first
              .timeout(
                const Duration(seconds: 15),
                onTimeout: () => throw StateError(errors.join()),
              ),
        );
        final invitation = SpaceInvitation.parse(
          jsonEncode(startup['invitation']),
          allowLoopback: true,
        );
        final identity = await SpaceIdentity.generate();
        final record = SpaceRecord(
          id: 'live',
          name: 'Live',
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
        final transport = SpaceRelayTransport(crypto, allowLoopback: true);
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
        final pairRequest = {
          'invitationId': invitation.value['id'],
          'secret': invitation.value['secret'],
          'device': record.device,
          'signingPublicKey': identity.signingPublic,
          'encryptionPublicKey': identity.encryptionPublic,
          'proof': await crypto.signControl(proof),
          'business_versions': [1],
        };
        FlutterSecureStorage.setMockInitialValues({
          'nova.space.pair-request.live': jsonEncode(pairRequest),
          'nova.space.push.live': jsonEncode({
            'enabled': true,
            'provider': 'fcm',
            'token': 'old-token',
            'handle': 'stall-handle',
            'credential': 'test-scoped',
            'gateway_url': 'https://gateway.example',
          }),
        });
        // Begin while the relay is unreachable. This is a real refused socket,
        // and recovery must reuse the persisted keys and signed pair request.
        final unused = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
        final offlineUrl = 'http://127.0.0.1:${unused.port}';
        await unused.close();
        final offlineRecord = SpaceRecord(
          id: record.id,
          name: record.name,
          mode: record.mode,
          remoteSpace: record.remoteSpace,
          hostDevice: record.hostDevice,
          hostSigningKey: record.hostSigningKey,
          device: record.device,
          relay: offlineUrl,
        );
        final offlineTransport = SpaceRelayTransport(
          SpaceCrypto(offlineRecord, identity, MemorySpacePersistence()),
          allowLoopback: true,
        );
        try {
          await expectLater(
            offlineTransport.request(
              'POST',
              '/v1/pairing/requests',
              authenticated: false,
              body: pairRequest,
            ),
            throwsA(isA<SocketException>()),
          );
        } finally {
          await offlineTransport.dispose();
        }
        final state = SpaceClientState(MemorySpacePersistence());
        await state.open();
        controller = SpaceClientController(state, transport);
        controller.push = SpacePushClient(
          record,
          state,
          onWake: controller.sync,
        );
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(
              SpacePushClient.channel,
              (_) async => null,
            );
        stalledGateway = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        releaseGateway = Completer<void>();
        final gatewayEntered = Completer<void>();
        gatewayServing = stalledGateway.listen((request) async {
          await request.drain<void>();
          request.response.headers.contentType = ContentType.json;
          request.response.write('{"ok":');
          await request.response.flush();
          gatewayEntered.complete();
          await releaseGateway!.future;
          try {
            request.response.write('true}');
            await request.response.close();
          } catch (_) {
            /* Test cleanup can close it. */
          }
        });
        final gatewayUrl = 'http://127.0.0.1:${stalledGateway.port}';
        refresh = SpacePushClient.refreshSavedTokens(
          {'provider': 'fcm', 'token': 'new-token'},
          [record],
          request: (gateway, method, path, credential, {body}) =>
              SpacePushClient.gatewayRequest(
                gatewayUrl,
                method,
                path,
                credential,
                body: body,
                allowLoopback: true,
                responseBodyTimeout: const Duration(seconds: 15),
              ),
        );
        await gatewayEntered.future;
        controller.start();
        final deadline = DateTime.now().add(const Duration(seconds: 5));
        while (state.snapshot.isEmpty && DateTime.now().isBefore(deadline)) {
          await controller.sync().timeout(const Duration(seconds: 5));
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        expect(
          state.snapshot.isNotEmpty,
          true,
          reason: '${state.error} ${errors.join()}',
        );
        expect(state.cards('feed').single['body'], 'x' * (48 * 1024 * 34));
        expect(state.cursor, greaterThan(30));
        expect(releaseGateway.isCompleted, false);
        final mailbox =
            await transport.request('GET', '/v1/mailbox/status') as Map;
        expect(mailbox['ackCursor'], state.cursor);
        final keyInbox = await const SpaceSecurePersistence(
          'nova.space.push.key-inbox.live',
        ).read();
        expect(keyInbox, contains('stall-handle'));
        // Release gateway only after snapshot and cursor/ACK progressed past the
        // push.key. Its registration lock must not serialize relay processing.
        releaseGateway.complete();
        await refresh;
        await controller.push!.flushPendingKeys();
        final savedPush = jsonMap(
          (await const SpaceSecurePersistence('nova.space.push.live').read())!,
        );
        expect(savedPush['token'], 'new-token');
        expect(
          savedPush['notification_key'],
          base64UrlEncode(List.filled(32, 7)).replaceAll('=', ''),
        );

        final countBeforeOversize = state.messages.length;
        await expectLater(
          controller.sendChat('船' * 5000),
          throwsA(
            isA<StateError>().having(
              (error) => error.message,
              'message',
              'chat_message_too_large',
            ),
          ),
        );
        expect(state.messages.length, countBeforeOversize);
        final turn = await controller.sendChat('Dart to Host 中文🙂');
        final previewDeadline = DateTime.now().add(const Duration(seconds: 5));
        while (state.previews[turn] == null &&
            DateTime.now().isBefore(previewDeadline)) {
          await Future<void>.delayed(const Duration(milliseconds: 20));
        }
        expect(state.previews[turn]?['text'], 'Host preview 中文');
        await controller.sync();
        expect(
          state.messages.where((m) => m['role'] == 'assistant').single['text'],
          'Host final 中文🙂',
        );
        expect(state.previews, isEmpty);
        await controller.sync();
        expect(state.messages.where((m) => m['role'] == 'assistant').length, 1);
        expect(
          errors.where(
            (e) =>
                !e.contains('ExperimentalWarning') &&
                !e.contains('trace-warnings'),
          ),
          isEmpty,
        );
      } finally {
        if (releaseGateway != null && !releaseGateway.isCompleted) {
          releaseGateway.complete();
        }
        await refresh;
        await stalledGateway?.close(force: true);
        await gatewayServing?.cancel();
        await controller?.dispose();
        process.kill();
        await process.exitCode.timeout(const Duration(seconds: 5));
        await errorSub.cancel();
      }
    },
    skip: Platform.environment['NOVA_RELAY_BUILD_ROOT'] == null
        ? 'Set NOVA_RELAY_BUILD_ROOT to compiled relay src directory'
        : false,
    timeout: const Timeout(Duration(minutes: 2)),
  );
  test(
    'stalled relay response has a body deadline and later requests can recover',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final release = Completer<void>();
      final serving = server.listen((request) async {
        request.response.headers.contentType = ContentType.json;
        if (request.uri.path == '/complete') {
          request.response.write('{"ok":true}');
          await request.response.close();
          return;
        }
        request.response.write('{"ok":');
        await request.response.flush();
        await release.future;
        try {
          request.response.write('true}');
          await request.response.close();
        } catch (_) {
          /* Timeout closed this response. */
        }
      });
      final space = SpaceRecord(
        id: 'body-deadline',
        name: 'Client',
        mode: SpaceMode.client,
        relay: 'http://127.0.0.1:${server.port}',
      );
      final transport = SpaceRelayTransport(
        SpaceCrypto(
          space,
          SpaceIdentity(signing: {}, encryption: {}),
          MemorySpacePersistence(),
        ),
        allowLoopback: true,
        responseBodyTimeout: const Duration(milliseconds: 150),
      );
      try {
        await expectLater(
          transport.request('GET', '/stall', authenticated: false),
          throwsA(isA<TimeoutException>()),
        );
        expect(
          await transport.request('GET', '/complete', authenticated: false),
          {'ok': true},
        );
      } finally {
        release.complete();
        await transport.dispose();
        await server.close(force: true);
        await serving.cancel();
      }
    },
  );
}
