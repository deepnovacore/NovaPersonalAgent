import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/personal/hub_errors.dart';
import 'package:nova_mobile/personal/hub_pairing.dart';

const _host = 'mac.example.ts.net';
final _code = 'C' * 43;
final _token = 'T' * 43;

Map<String, Object> _credential() => {
  'account_id': 'account-1',
  'hub_id': 'hub-1',
  'device_id': 'device-1',
  'device_name': 'My Android',
  'device_epoch': 1,
  'token': _token,
};

class _ReceivedRequest {
  _ReceivedRequest(HttpRequest request, this.body)
    : method = request.method,
      uri = request.uri,
      authorization = request.headers.value(HttpHeaders.authorizationHeader),
      cookie = request.headers.value(HttpHeaders.cookieHeader),
      contentType = request.headers.contentType?.mimeType;

  final String method, body;
  final Uri uri;
  final String? authorization, cookie, contentType;
}

class _TlsHub {
  _TlsHub(this.server, FutureOr<void> Function(HttpRequest, String) respond) {
    server.listen((request) async {
      final body = await utf8.decoder.bind(request).join();
      received.add(_ReceivedRequest(request, body));
      await respond(request, body);
      await request.response.close();
    });
  }

  final HttpServer server;
  final received = <_ReceivedRequest>[];
  final connections = <Uri>[];

  static Future<_TlsHub> start(
    SecurityContext context,
    FutureOr<void> Function(HttpRequest, String) respond,
  ) async => _TlsHub(
    await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, context),
    respond,
  );

  HubPairingInvitation get invitation => HubPairingInvitation.parse(
    jsonEncode({
      'type': 'nova.hub',
      'version': 1,
      'url': 'https://$_host:${server.port}',
      'code': _code,
      'expires_at': DateTime.now().millisecondsSinceEpoch + 300000,
      'hub_id': 'hub-1',
      'account_id': 'account-1',
    }),
  );

  HubPairingClient get client => HubPairingClient(
    clientFactory: () =>
        configureClient(_RealHttpOverrides().createHttpClient(null)),
  );

  HttpClient configureClient(HttpClient client) {
    client.findProxy = (_) => 'DIRECT';
    // Only this test's synthetic tailnet hostname can reach its loopback TLS
    // listener. Certificate trust is deliberately scoped to the fixture.
    bool acceptFixtureCertificate(X509Certificate _, String host, int port) =>
        host == _host && port == server.port;
    client.badCertificateCallback = acceptFixtureCertificate;
    client.connectionFactory = (uri, proxyHost, proxyPort) async {
      if (uri.host != _host || uri.port != server.port || proxyHost != null) {
        throw StateError('unexpected fixture destination');
      }
      connections.add(uri);
      final connection = await Socket.startConnect(
        InternetAddress.loopbackIPv4,
        server.port,
      );
      // A custom connection factory also owns the TLS handshake. Preserve
      // the synthetic hostname as SNI while connecting only to loopback.
      final secured = connection.socket.then(
        (socket) => SecureSocket.secure(
          socket,
          host: uri.host,
          onBadCertificate: (certificate) =>
              acceptFixtureCertificate(certificate, uri.host, uri.port),
        ),
      );
      return ConnectionTask.fromSocket(secured, connection.cancel);
    };
    return client;
  }

  Future<void> close() async => server.close(force: true);
}

class _RealHttpOverrides extends HttpOverrides {}

class _TailnetHttpOverrides extends HttpOverrides {
  _TailnetHttpOverrides(this.hub);
  final _TlsHub hub;

  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      hub.configureClient(super.createHttpClient(context));
}

Future<Map<String, dynamic>> _admin(
  Directory directory,
  Map<String, Object> body,
) async {
  final client = _RealHttpOverrides().createHttpClient(null);
  client.findProxy = (_) => 'DIRECT';
  client.connectionFactory = (uri, proxyHost, proxyPort) {
    if (uri.host != 'unix' || proxyHost != null) {
      throw StateError('unexpected admin destination');
    }
    return Socket.startConnect(
      InternetAddress(
        '${directory.path}/admin.sock',
        type: InternetAddressType.unix,
      ),
      0,
    );
  };
  try {
    final request = await client.postUrl(Uri.parse('http://unix/admin'));
    request.headers.contentType = ContentType.json;
    request.write(jsonEncode(body));
    final response = await request.close();
    final text = await utf8.decoder.bind(response).join();
    if (response.statusCode != 200) {
      throw StateError('test admin request failed');
    }
    return Map<String, dynamic>.from(jsonDecode(text) as Map);
  } finally {
    client.close(force: true);
  }
}

Future<({int status, Map<String, dynamic> body})> _state(
  int port,
  String token,
) async {
  final client = _RealHttpOverrides().createHttpClient(null)
    ..findProxy = (_) => 'DIRECT';
  try {
    final request = await client.getUrl(
      Uri.parse('http://127.0.0.1:$port/hub/v1/state'),
    );
    request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    final response = await request.close();
    final body = jsonDecode(await utf8.decoder.bind(response).join()) as Map;
    return (status: response.statusCode, body: Map<String, dynamic>.from(body));
  } finally {
    client.close(force: true);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory certificates;
  late SecurityContext context;

  setUpAll(() async {
    certificates = await Directory.systemTemp.createTemp('nova-hub-test-tls-');
    final certificate = '${certificates.path}/certificate.pem';
    final privateKey = '${certificates.path}/private-key.pem';
    final generated = await Process.run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=$_host',
      '-addext',
      'subjectAltName=DNS:$_host',
      '-keyout',
      privateKey,
      '-out',
      certificate,
    ]);
    if (generated.exitCode != 0) {
      throw StateError('Could not create the ephemeral HTTPS test certificate');
    }
    context = SecurityContext()
      ..useCertificateChain(certificate)
      ..usePrivateKey(privateKey);
  });

  tearDownAll(() async {
    await certificates.delete(recursive: true);
  });

  test(
    'real HTTPS redemption sends only invitation credentials and expected identities',
    () async {
      final hub = await _TlsHub.start(context, (request, _) {
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode(_credential()));
      });
      addTearDown(hub.close);

      final credential = await hub.client.redeem(
        hub.invitation,
        deviceName: '  My Android  ',
      );

      expect(credential.token, _token);
      expect(hub.connections, hasLength(1));
      expect(hub.connections.single.scheme, 'https');
      expect(hub.connections.single.host, _host);
      expect(hub.received, hasLength(1));
      final request = hub.received.single;
      expect(request.method, 'POST');
      expect(request.uri.path, '/hub/v1/pairing/redeem');
      expect(request.uri.hasQuery, isFalse);
      expect(request.contentType, 'application/json');
      expect(request.authorization, isNull);
      expect(request.cookie, isNull);
      expect(jsonDecode(request.body), {
        'code': _code,
        'device_name': 'My Android',
        'hub_id': 'hub-1',
        'account_id': 'account-1',
      });
      expect(request.body, isNot(contains(_token)));
      expect(request.uri.toString(), isNot(contains(_code)));
    },
  );

  test(
    'HTTPS 307 redirect is rejected without following or forwarding its code',
    () async {
      final hub = await _TlsHub.start(context, (request, _) {
        request.response.headers.contentType = ContentType.json;
        if (request.uri.path == '/redirect-target') {
          request.response.write(jsonEncode(_credential()));
        } else {
          request.response.statusCode = HttpStatus.temporaryRedirect;
          request.response.headers.set(
            HttpHeaders.locationHeader,
            '/redirect-target',
          );
          request.response.write(jsonEncode({'error': 'redirect_not_allowed'}));
        }
      });
      addTearDown(hub.close);

      await expectLater(
        hub.client.redeem(hub.invitation, deviceName: 'My Android'),
        throwsA(
          isA<HubPairingException>().having(
            (error) => error.code,
            'code',
            'invalid_response',
          ),
        ),
      );
      expect(hub.received.map((request) => request.uri.path), [
        '/hub/v1/pairing/redeem',
      ]);
      expect(hub.connections, hasLength(1));
    },
  );

  for (final size in [16384, 16385]) {
    test('HTTPS response size boundary: $size bytes', () async {
      final base = jsonEncode({..._credential(), 'padding': ''});
      final body = jsonEncode({
        ..._credential(),
        'padding': 'x' * (size - utf8.encode(base).length),
      });
      expect(utf8.encode(body), hasLength(size));
      final hub = await _TlsHub.start(context, (request, _) {
        request.response.headers.contentType = ContentType.json;
        // Force chunked delivery so this checks the streamed byte limit rather
        // than relying on a Content-Length header supplied by the server.
        request.response.write(body.substring(0, 8192));
        request.response.write(body.substring(8192));
      });
      addTearDown(hub.close);

      final pending = hub.client.redeem(
        hub.invitation,
        deviceName: 'My Android',
      );
      if (size == 16384) {
        expect((await pending).token, _token);
      } else {
        await expectLater(
          pending,
          throwsA(
            isA<HubPairingException>().having(
              (error) => error.code,
              'code',
              'invalid_response',
            ),
          ),
        );
      }
    });
  }

  final secret = 'server-private-detail-$_code-$_token';
  final invalidResponses = <({String name, int status, String body})>[
    (
      name: 'unrecognized server error',
      status: 400,
      body: jsonEncode({'error': secret}),
    ),
    (name: 'HTML failure', status: 503, body: '<html>$secret</html>'),
    (name: 'malformed success JSON', status: 200, body: '{"token":"$secret"'),
    (
      name: 'wrong success identity',
      status: 200,
      body: jsonEncode({..._credential(), 'hub_id': secret}),
    ),
  ];
  for (final invalid in invalidResponses) {
    test('${invalid.name} cannot expose server text or credentials', () async {
      final hub = await _TlsHub.start(context, (request, _) {
        request.response.statusCode = invalid.status;
        request.response.write(invalid.body);
      });
      addTearDown(hub.close);

      Object? failure;
      try {
        await hub.client.redeem(hub.invitation, deviceName: 'My Android');
      } catch (error) {
        failure = error;
      }
      expect(
        failure,
        isA<HubPairingException>().having(
          (error) => error.code,
          'code',
          'invalid_response',
        ),
      );
      for (final text in [
        failure.toString(),
        hubErrorMessage(failure!, language: 'en'),
        hubErrorMessage(failure),
      ]) {
        expect(text, isNot(contains(secret)));
        expect(text, isNot(contains(_code)));
        expect(text, isNot(contains(_token)));
      }
    });
  }

  test(
    'Flutter pairs and syncs Todo, Idea and Goal with a real managed Hub through HTTPS, then revocation denies access',
    () async {
      FlutterSecureStorage.setMockInitialValues({});
      final temporary = await Directory(
        '/tmp',
      ).createTemp('nova-hub-roundtrip-');
      final directory = Directory(await temporary.resolveSymbolicLinks());
      addTearDown(() async {
        if (await directory.exists()) await directory.delete(recursive: true);
      });
      final hubDirectory = Directory('${directory.path}/hub');
      final runtime = File(
        '../../runtime/dist/src/hub/managed-entry.js',
      ).absolute;
      expect(
        await runtime.exists(),
        isTrue,
        reason:
            'Build the runtime before running this cross-client acceptance test',
      );
      final daemon = await Process.start('node', [
        runtime.path,
        '--data-dir',
        hubDirectory.path,
        '--port',
        '0',
      ]);
      final ready = Completer<void>();
      final stdout = daemon.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen((line) {
            if (line == 'Nova managed Hub ready' && !ready.isCompleted) {
              ready.complete();
            }
          });
      // This fixture has not issued any credentials before readiness. Capture
      // only that startup phase, bounded to 4 KiB, to diagnose missing builds
      // and child-process startup failures without retaining later output.
      var startupStderr = '';
      final stderr = daemon.stderr.transform(utf8.decoder).forEach((chunk) {
        if (ready.isCompleted || startupStderr.length >= 4096) return;
        final remaining = 4096 - startupStderr.length;
        startupStderr += chunk.length <= remaining
            ? chunk
            : chunk.substring(0, remaining);
      });
      unawaited(
        daemon.exitCode.then((code) async {
          await stderr;
          if (!ready.isCompleted) {
            ready.completeError(
              StateError(
                'managed Hub fixture exited before ready (exit $code; '
                'runtime ${runtime.path}): $startupStderr',
              ),
            );
          }
        }),
      );
      _TlsHub? proxy;
      LifeHost? host;
      try {
        await ready.future.timeout(
          const Duration(seconds: 15),
          onTimeout: () => throw TimeoutException(
            'managed Hub fixture readiness timed out: $startupStderr',
          ),
        );
        final status = await _admin(hubDirectory, {'action': 'status'});
        final port = status['port'] as int;
        expect(port, isNot(anyOf(8787, 8443)));
        final backend = _RealHttpOverrides().createHttpClient(null)
          ..findProxy = (_) => 'DIRECT';
        try {
          proxy = await _TlsHub.start(context, (request, body) async {
            final forwarded = await backend.openUrl(
              request.method,
              Uri.parse('http://127.0.0.1:$port${request.uri}'),
            );
            forwarded.followRedirects = false;
            final authorization = request.headers.value(
              HttpHeaders.authorizationHeader,
            );
            if (authorization != null) {
              forwarded.headers.set(
                HttpHeaders.authorizationHeader,
                authorization,
              );
            }
            if (body.isNotEmpty) {
              forwarded.headers.contentType = ContentType.json;
              forwarded.write(body);
            }
            final response = await forwarded.close();
            request.response.statusCode = response.statusCode;
            request.response.headers.contentType = ContentType.json;
            await request.response.addStream(response);
          });
          final url = 'https://$_host:${proxy.server.port}';
          final qr = await _admin(hubDirectory, {
            'action': 'invite',
            'url': url,
          });
          final invitation = HubPairingInvitation.parse(jsonEncode(qr));
          expect(invitation.hubId, status['hub_id']);
          expect(invitation.accountId, status['account_id']);
          final credential = await proxy.client.redeem(
            invitation,
            deviceName: 'Synthetic Android acceptance',
          );
          expect(
            (await _admin(hubDirectory, {
              'action': 'status',
            }))['invitation_active'],
            isFalse,
          );

          final local = LocalLife(
            FileLifePersistence(File('${directory.path}/mobile-life.json')),
          );
          host = LifeHost(repository: local);
          await host.open();
          host.didChangeAppLifecycleState(AppLifecycleState.paused);
          for (final kind in ['todo', 'idea', 'goal']) {
            await host.mutate({
              'op': 'create',
              'kind': kind,
              'title': 'Synthetic $kind',
            }, operationId: 'roundtrip-$kind');
          }
          expect(local.pendingCount, 3);
          final mobile = host;
          await HttpOverrides.runWithHttpOverrides(() async {
            await mobile.configureHub(
              url: url,
              token: credential.token,
              expectedHubId: invitation.hubId,
              expectedAccountId: invitation.accountId,
            );
            await mobile.sync();
          }, _TailnetHttpOverrides(proxy));
          expect(local.pendingCount, 0);
          expect(local.hubId, invitation.hubId);
          expect(local.accountId, invitation.accountId);
          final saved =
              jsonDecode(
                    (await const FlutterSecureStorage().read(
                      key: 'nova.local.hub.credentials',
                    ))!,
                  )
                  as Map;
          expect(saved, {'url': url, 'token': credential.token});

          final snapshot = await _state(port, credential.token);
          expect(snapshot.status, 200);
          expect(snapshot.body['hub_id'], invitation.hubId);
          expect(snapshot.body['account_id'], invitation.accountId);
          for (final kind in ['todo', 'idea', 'goal']) {
            final entities =
                (snapshot.body['state'] as Map)['${kind}s'] as List;
            expect(entities, hasLength(1));
            expect((entities.single as Map)['title'], 'Synthetic $kind');
            expect(mobile.snapshot()['${kind}s'], hasLength(1));
          }
          final paired = proxy.received
              .where((request) => request.uri.path == '/hub/v1/pairing/redeem')
              .single;
          expect(paired.authorization, isNull);
          expect(jsonDecode(paired.body), {
            'code': invitation.code,
            'device_name': 'Synthetic Android acceptance',
            'hub_id': invitation.hubId,
            'account_id': invitation.accountId,
          });
          expect(
            proxy.received.where(
              (request) => request.uri.path == '/hub/v1/mutations',
            ),
            hasLength(3),
          );

          final devices =
              (await _admin(hubDirectory, {'action': 'devices'}))['devices']
                  as List;
          expect(devices, hasLength(1));
          final device = devices.single as Map;
          expect(device['device_name'], 'Synthetic Android acceptance');
          await _admin(hubDirectory, {
            'action': 'revoke',
            'device_id': device['device_id'] as String,
          });
          expect((await _state(port, credential.token)).status, 401);
          await expectLater(
            HttpOverrides.runWithHttpOverrides(
              mobile.sync,
              _TailnetHttpOverrides(proxy),
            ),
            throwsA(isA<HttpException>()),
          );
          expect(mobile.snapshot()['todos'], hasLength(1));
        } finally {
          backend.close(force: true);
        }
      } finally {
        host?.dispose();
        await proxy?.close();
        daemon.kill(ProcessSignal.sigterm);
        await daemon.exitCode.timeout(
          const Duration(seconds: 5),
          onTimeout: () async {
            daemon.kill(ProcessSignal.sigkill);
            return daemon.exitCode;
          },
        );
        await stdout.cancel();
        await stderr;
        await directory.delete(recursive: true);
      }
    },
    timeout: const Timeout(Duration(seconds: 45)),
    skip: Platform.isWindows
        ? 'Managed Hub administration uses a Unix socket'
        : false,
  );
}
