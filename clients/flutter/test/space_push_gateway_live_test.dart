import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/push_client.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

class _ActualHttp extends HttpOverrides {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'real gateway recovers expired-invite enrollment, retries registration and rotates leased handle',
    () async {
      await HttpOverrides.runZoned(() async {
        final process = await Process.start('node', [
          'test/support/space_gateway_fixture.mjs',
        ]);
        final stderr = <String>[];
        final errors = process.stderr
            .transform(utf8.decoder)
            .listen(stderr.add);
        final lines = StreamIterator(
          process.stdout
              .transform(utf8.decoder)
              .transform(const LineSplitter()),
        );
        String? url;
        final clients = <SpacePushClient>[];
        try {
          expect(
            await lines.moveNext().timeout(const Duration(seconds: 20)),
            true,
            reason: stderr.join(),
          );
          final fixture = jsonDecode(lines.current) as Map;
          url = fixture['url'] as String;
          var instant = DateTime.fromMillisecondsSinceEpoch(
            fixture['now'] as int,
            isUtc: true,
          );
          Future<void> advance(Duration duration) async {
            final http = HttpClient();
            try {
              final req = await http.postUrl(Uri.parse('$url/test/advance'));
              req.headers.set('x-test-advance-ms', duration.inMilliseconds);
              final response = await req.close();
              await response.drain<void>();
              instant = instant.add(duration);
            } finally {
              http.close(force: true);
            }
          }

          var loseEnrollment = true, loseRegistration = true;
          final registrationIds = <String>[], handles = <String>[];
          Future<Map<String, dynamic>> request(
            String gateway,
            String method,
            String path,
            String credential, {
            Map<String, dynamic>? body,
          }) async {
            final result = await SpacePushClient.gatewayRequest(
              url!,
              method,
              path,
              credential,
              body: body,
              allowLoopback: true,
            );
            if (path == '/v1/installations' && loseEnrollment) {
              loseEnrollment = false;
              throw StateError('synthetic lost enrollment response');
            }
            if (path == '/v1/registrations') {
              registrationIds.add(body!['registrationId'] as String);
              handles.add(result['handle'] as String);
              if (loseRegistration) {
                loseRegistration = false;
                throw StateError('synthetic lost registration response');
              }
            }
            return result;
          }

          final disk = MemorySpacePersistence(),
              installation = MemorySpacePersistence();
          final state = SpaceClientState(MemorySpacePersistence());
          await state.open();
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
              .setMockMethodCallHandler(SpacePushClient.channel, (call) async {
                if (call.method == 'requestPermission') return true;
                if (call.method == 'getToken') {
                  return {
                    'provider': 'fcm',
                    'token': 'synthetic-fcm-token-for-real-gateway-contract',
                  };
                }
                return null;
              });
          SpacePushClient make() {
            final client = SpacePushClient(
              const SpaceRecord(
                id: 'real-gateway-client',
                name: 'Client',
                mode: SpaceMode.client,
              ),
              state,
              onWake: () async {},
              persistence: disk,
              installationPersistence: installation,
              gatewayUrl: 'https://configured-gateway.example',
              request: request,
              now: () => instant,
            );
            clients.add(client);
            return client;
          }

          var client = make();
          await expectLater(
            client.redeemInvitation(fixture['invitation'] as String),
            throwsStateError,
          );
          final secret = (jsonDecode(installation.value!) as Map)['credential'];
          await client.dispose();
          await advance(const Duration(minutes: 20));
          client = make();
          expect(await client.needsInvitation(), false);
          expect(
            (jsonDecode(installation.value!) as Map)['credential'],
            secret,
          );
          await expectLater(client.enable(), throwsStateError);
          await client.dispose();
          client = make();
          await client.refreshRegistration();
          expect(registrationIds.length, 2);
          expect(registrationIds.toSet().length, 1);
          expect(handles.toSet().length, 1);
          final firstHandle = (jsonDecode(disk.value!) as Map)['handle'];
          await advance(const Duration(days: 29, seconds: 1));
          await client.refreshRegistration();
          expect(registrationIds.toSet().length, 2);
          expect(
            (jsonDecode(disk.value!) as Map)['handle'],
            isNot(firstHandle),
          );
          expect(jsonEncode(state.pending), isNot(contains(secret as String)));
          await client.disable();
          await client.refreshRegistration();
          expect(registrationIds.length, 3);
        } finally {
          for (final client in clients) {
            await client.dispose();
          }
          if (url != null) {
            final http = HttpClient();
            try {
              final req = await http.postUrl(Uri.parse('$url/test/stop'));
              await (await req.close()).drain<void>();
            } catch (_) {
              process.kill();
            } finally {
              http.close(force: true);
            }
          } else {
            process.kill();
          }
          await process.exitCode.timeout(
            const Duration(seconds: 10),
            onTimeout: () {
              process.kill(ProcessSignal.sigkill);
              return -1;
            },
          );
          await lines.cancel();
          await errors.cancel();
        }
      }, createHttpClient: _ActualHttp().createHttpClient);
    },
    skip: Platform.environment['NOVA_GATEWAY_BUILD_ROOT'] == null
        ? 'Set NOVA_GATEWAY_BUILD_ROOT to the isolated compiled gateway package'
        : false,
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
