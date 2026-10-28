import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/services.dart';
import 'client_state.dart';
import 'relay_transport.dart';
import 'space_crypto.dart';
import 'space_storage.dart';

typedef SpaceGatewayRequest =
    Future<Map<String, dynamic>> Function(
      String gateway,
      String method,
      String path,
      String credential, {
      Map<String, dynamic>? body,
    });

/// Every writer to one Space registration shares this queue, including inactive
/// Space token refresh, foreground registration, key installation and disable.
class _PushLocks {
  static final Map<String, Future<void>> tails = {};
  static Future<T> run<T>(String id, Future<T> Function() body) {
    final old = tails[id];
    final result = old == null ? body() : old.then((_) => body());
    final tail = result.then<void>((_) {}, onError: (Object _) {});
    tails[id] = tail;
    unawaited(
      tail.whenComplete(() {
        if (identical(tails[id], tail)) tails.remove(id);
      }),
    );
    return result;
  }
}

/// Device tokens go only to the configured gateway. The Host receives a scoped
/// opaque handle and credential through the authenticated E2E channel.
class SpacePushClient {
  SpacePushClient(
    this.space,
    this.state, {
    required this.onWake,
    SpacePersistence? persistence,
    this.gatewayUrl = const String.fromEnvironment('NOVA_PUSH_GATEWAY_URL'),
    SpacePersistence? installationPersistence,
    DateTime Function()? now,
    this.environment = const String.fromEnvironment(
      'NOVA_APNS_ENVIRONMENT',
      defaultValue: 'production',
    ),
    SpaceGatewayRequest? request,
  }) : persistence =
           persistence ?? SpaceSecurePersistence('nova.space.push.${space.id}'),
       installationPersistence =
           installationPersistence ??
           SpaceSecurePersistence(
             'nova.push.installation.${b64url(utf8.encode(gatewayUrl))}',
           ),
       now = now ?? DateTime.now,
       request = request ?? gatewayRequest;
  final SpaceRecord space;
  final SpaceClientState state;
  final SpacePersistence persistence, installationPersistence;
  final DateTime Function() now;
  final Future<void> Function() onWake;
  final String gatewayUrl, environment;
  final SpaceGatewayRequest request;
  static const channel = MethodChannel('nova/space_push');
  static const events = EventChannel('nova/space_push/events');
  static final Stream<dynamic> eventStream = events.receiveBroadcastStream();
  Map<String, dynamic> registration = {};
  StreamSubscription<dynamic>? _events;
  bool _disposed = false;
  Timer? _leaseTimer;
  String status = '尚未启用锁屏通知';
  Future<void> _load() async {
    final raw = await persistence.read();
    registration = raw == null ? {} : jsonMap(raw);
  }

  Future<void> _save() => persistence.write(jsonEncode(registration));
  Future<T> _locked<T>(Future<T> Function() body) =>
      _PushLocks.run(space.id, body);

  String get _installationLock => 'push-installation:$gatewayUrl';
  Future<Map<String, dynamic>> _installation() async {
    final raw = await installationPersistence.read();
    return raw == null ? {} : jsonMap(raw);
  }

  // Caller holds the installation lock. A lost enrollment response must be
  // recoverable using the already-persisted credential even after invite expiry.
  Future<Map<String, dynamic>> _recoverInstallation({
    bool verifyExisting = false,
  }) async {
    final saved = await _installation();
    if ((saved['installationId'] == null || verifyExisting) &&
        saved['credential'] is String) {
      try {
        final recovered = await request(
          gatewayUrl,
          'GET',
          '/v1/installation',
          saved['credential'] as String,
        );
        if (recovered['installationId'] is! String) {
          throw StateError('通知网关返回无效安装信息');
        }
        saved['installationId'] = recovered['installationId'];
        saved.remove('invitation');
        await installationPersistence.write(jsonEncode(saved));
      } on RelayFailure catch (error) {
        if (error.code != 'gateway_401') rethrow;
        saved.remove('installationId');
        await installationPersistence.write(jsonEncode(saved));
      }
    }
    return saved;
  }

  Future<bool> needsInvitation({bool verifyExisting = false}) => _PushLocks.run(
    _installationLock,
    () async {
      if (gatewayUrl.isEmpty) throw StateError('此构建尚未配置通知网关');
      final saved = await _recoverInstallation(verifyExisting: verifyExisting);
      return saved['installationId'] == null || saved['credential'] == null;
    },
  );
  Future<void> redeemInvitation(
    String invitation,
  ) => _PushLocks.run(_installationLock, () async {
    if (gatewayUrl.isEmpty) throw StateError('此构建尚未配置通知网关');
    relayUri(gatewayUrl);
    invitation = invitation.trim();
    if (invitation.isEmpty || invitation.length > 4096) {
      throw StateError('请输入有效的一次性邀请');
    }
    var saved = await _recoverInstallation();
    // Another Space may have completed enrollment while this dialog was open.
    // Do not replace a working installation or consume its second invitation.
    if (saved['installationId'] != null && saved['credential'] is String) {
      return;
    }
    if (saved['invitation'] != invitation) {
      saved = {'invitation': invitation, 'credential': b64url(randomBytes(32))};
      // Commit the redemption secret first: response loss must not consume the
      // same invitation with a different installation identity after restart.
      await installationPersistence.write(jsonEncode(saved));
    }
    final created = await request(
      gatewayUrl,
      'POST',
      '/v1/installations',
      invitation,
      body: {'credential': saved['credential']},
    );
    if (created['installationId'] is! String) throw StateError('通知网关返回无效安装信息');
    await installationPersistence.write(
      jsonEncode({
        'installationId': created['installationId'],
        'credential': saved['credential'],
      }),
    );
  });
  Future<String?> _installationCredential() =>
      _PushLocks.run(_installationLock, () async {
        final saved = await _recoverInstallation();
        return saved['installationId'] == null
            ? null
            : saved['credential'] as String?;
      });
  bool get _leaseDue {
    final expiresAt = registration['expiresAt'];
    return expiresAt is num &&
        expiresAt <=
            now().millisecondsSinceEpoch +
                const Duration(days: 1).inMilliseconds;
  }

  Future<void> refreshRegistration() async {
    final enabled = await _locked(() async {
      await _load();
      return !_disposed && registration['enabled'] == true;
    });
    if (!enabled) return;
    final token = await channel.invokeMapMethod<String, dynamic>('getToken');
    if (token != null) await _register(token);
  }

  Future<void> start() async {
    if (_disposed) return;
    await _locked(() async {
      await _load();
      if (registration['enabled'] == true) {
        await _ensureHostRegistration();
        if (registration['notification_key'] != null) {
          await channel.invokeMethod<void>('configureSpace', {
            'handle': registration['handle'],
            'notificationKey': registration['notification_key'],
          });
        }
        status = registration['notification_key'] != null
            ? '锁屏通知已启用'
            : '等待 Host 完成通知密钥配置';
      }
    });
    if (_disposed) return;
    unawaited(flushPendingKeys());
    try {
      _events = eventStream.listen(
        (raw) {
          final event = Map<String, dynamic>.from(raw as Map);
          if (event['type'] == 'token') {
            unawaited(
              _register(event).catchError((Object _) {
                status = '通知令牌更新失败，将在恢复连接后重试';
                state.changed();
              }),
            );
          }
          if (event['type'] == 'syncRequired' ||
              (event['type'] == 'open' &&
                  (event['handle'] == null ||
                      event['handle'] == registration['handle']))) {
            unawaited(onWake());
          }
        },
        onError: (Object _) {
          status = '此平台推送服务暂不可用';
          state.changed();
        },
      );
      if (registration['enabled'] == true) {
        final token = await channel.invokeMapMethod<String, dynamic>(
          'getToken',
        );
        if (token != null) await _register(token);
      }
      unawaited(
        _locked(() async {
          await _load();
          await _retire();
        }).catchError((Object _) {}),
      );
    } on MissingPluginException {
      status = '此平台不支持锁屏通知';
    } on PlatformException {
      status = '推送服务暂不可用，请重试';
    }
    if (_disposed) return;
    _leaseTimer?.cancel();
    _leaseTimer = Timer.periodic(const Duration(hours: 1), (_) {
      unawaited(
        refreshRegistration().catchError((Object _) {
          if (registration['enabled'] == true) {
            status = '通知注册等待重试，空间内容仍可同步';
            state.changed();
          }
        }),
      );
    });
    state.changed();
  }

  Future<bool> _enableCurrent(String generation) => _locked(() async {
    await _load();
    return !_disposed && registration['enable_request'] == generation;
  });
  Future<void> enable({Future<String?> Function()? requestInvitation}) async {
    if (gatewayUrl.isEmpty) throw StateError('此构建尚未配置通知网关');
    relayUri(gatewayUrl);
    final generation = newSpaceId();
    await _locked(() async {
      await _load();
      registration['enable_request'] = generation;
      await _save();
    });
    try {
      if (await needsInvitation(verifyExisting: true)) {
        if (!await _enableCurrent(generation)) return;
        if (requestInvitation == null) throw StateError('请先兑换通知网关的一次性邀请');
        final invitation = await requestInvitation();
        if (invitation == null ||
            invitation.isEmpty ||
            !await _enableCurrent(generation)) {
          return;
        }
        await redeemInvitation(invitation);
      }
      if (!await _enableCurrent(generation)) return;
      final allowed =
          await channel.invokeMethod<bool>('requestPermission') ?? false;
      if (!await _enableCurrent(generation)) return;
      if (!allowed) {
        status = '通知权限未授予';
        state.changed();
        return;
      }
      final enabled = await _locked(() async {
        await _load();
        if (_disposed || registration['enable_request'] != generation) {
          return false;
        }
        if (registration['enabled'] != true) {
          final retired = _retired();
          _addRetired(retired, registration);
          registration = {
            'enabled': true,
            'retired': retired,
            'enable_request': generation,
          };
          await _save();
        }
        return true;
      });
      if (!enabled) return;
      final token = await channel.invokeMapMethod<String, dynamic>('getToken');
      if (!await _enableCurrent(generation)) return;
      if (token == null) {
        status = '等待系统提供推送令牌';
        state.changed();
        return;
      }
      await _register(token);
    } finally {
      await _locked(() async {
        await _load();
        if (registration['enable_request'] == generation) {
          registration.remove('enable_request');
          await _save();
        }
      });
    }
  }

  List<Map<String, dynamic>> _retired() =>
      ((registration['retired'] as List?) ?? [])
          .whereType<Map>()
          .map((v) => Map<String, dynamic>.from(v))
          .toList();
  void _addRetired(
    List<Map<String, dynamic>> retired,
    Map<String, dynamic> value,
  ) {
    if (value['handle'] != null &&
        !retired.any((r) => r['handle'] == value['handle'])) {
      retired.add({
        'handle': value['handle'],
        'credential': value['credential'],
        'gateway_url': value['gateway_url'] ?? gatewayUrl,
      });
    }
  }

  Future<void> _retire() async {
    final remaining = <Map<String, dynamic>>[];
    for (final old in _retired()) {
      try {
        await request(
          old['gateway_url'] as String,
          'DELETE',
          '/v1/registrations/${old['handle']}',
          old['credential'] as String,
        );
      } on RelayFailure catch (error) {
        if (error.code != 'gateway_401') remaining.add(old);
      } catch (_) {
        remaining.add(old);
      }
    }
    registration['retired'] = remaining;
    await _save();
  }

  Future<void> _register(Map<String, dynamic> token) => _locked(() async {
    await _load();
    if (_disposed || registration['enabled'] != true || gatewayUrl.isEmpty) {
      return;
    }
    if (token['token'] == registration['token'] &&
        token['provider'] == registration['provider'] &&
        registration['handle'] != null &&
        registration['refresh_error'] == null &&
        registration['expiresAt'] is num &&
        !_leaseDue) {
      await _ensureHostRegistration();
      status = registration['notification_key'] != null
          ? '锁屏通知已启用'
          : '等待 Host 完成通知密钥配置';
      state.changed();
      return;
    }
    if (registration['handle'] != null &&
        registration['provider'] == token['provider'] &&
        !_leaseDue) {
      try {
        final updated = await request(
          gatewayUrl,
          'PUT',
          '/v1/registrations/${registration['handle']}',
          registration['credential'] as String,
          body: {
            'provider': token['provider'],
            'token': token['token'],
            if (token['provider'] == 'apns') 'environment': environment,
          },
        );
        registration.addAll({
          'token': token['token'],
          'gateway_url': gatewayUrl,
          if (updated['expiresAt'] is num) 'expiresAt': updated['expiresAt'],
        });
        registration.remove('refresh_error');
        await _save();
        await _ensureHostRegistration();
        status = registration['notification_key'] != null
            ? '锁屏通知已启用'
            : '等待 Host 完成通知密钥配置';
        state.changed();
        return;
      } on RelayFailure catch (error) {
        if (error.code != 'gateway_401') rethrow;
      }
    }
    final installationCredential = await _installationCredential();
    if (installationCredential == null) {
      status = '需要一次性邀请才能注册或续期锁屏通知';
      state.changed();
      return;
    }
    final old = {...registration};
    var pending = registration['pending_registration'] as Map?;
    if (pending == null) {
      pending = {
        'registrationId': newSpaceId(),
        'provider': token['provider'],
        'token': token['token'],
        if (token['provider'] == 'apns') 'environment': environment,
      };
      registration['pending_registration'] = pending;
      await _save();
    }
    late Map<String, dynamic> created;
    try {
      created = await request(
        gatewayUrl,
        'POST',
        '/v1/registrations',
        installationCredential,
        body: Map<String, dynamic>.from(pending),
      );
    } on RelayFailure catch (error) {
      if (error.code == 'gateway_401') {
        await _PushLocks.run(_installationLock, () async {
          final current = await _installation();
          if (current['credential'] == installationCredential) {
            current.remove('installationId');
            await installationPersistence.write(jsonEncode(current));
          }
        });
        status = '通知准入已失效，请兑换新的一次性邀请';
        state.changed();
      }
      rethrow;
    }
    if (created['handle'] is! String ||
        created['credential'] is! String ||
        created['expiresAt'] is! num) {
      throw StateError('通知网关返回无效注册信息');
    }
    final retired = _retired();
    _addRetired(retired, old);
    registration = {
      'enabled': true,
      'gateway_url': gatewayUrl,
      'provider': pending['provider'],
      'token': pending['token'],
      if (pending['environment'] != null) 'environment': pending['environment'],
      'expiresAt': created['expiresAt'],
      'handle': created['handle'],
      'credential': created['credential'],
      'retired': retired,
    };
    await _save();
    await _ensureHostRegistration();
    if (old['handle'] != null) {
      await channel.invokeMethod<void>('removeSpace', {
        'handle': old['handle'],
      });
    }
    await _retire();
    status = '等待 Host 完成通知密钥配置';
    state.changed();
    unawaited(onWake());
    if (registration['token'] != token['token'] ||
        registration['provider'] != token['provider']) {
      // Finish an uncertain registration first; then process a newer token.
      unawaited(
        _register(token).catchError((Object _) {
          status = '通知令牌更新等待重试';
          state.changed();
        }),
      );
    }
  });
  Future<void> _ensureHostRegistration() async {
    if (registration['enabled'] != true ||
        registration['handle'] == null ||
        registration['credential'] == null) {
      return;
    }
    await state.enqueue('push.register', {
      'handle': registration['handle'],
      'credential': registration['credential'],
      'gateway_url': registration['gateway_url'] ?? gatewayUrl,
    }, operationId: 'push_${registration['handle']}');
  }

  SpacePersistence get _keyInbox =>
      SpaceSecurePersistence('nova.space.push.key-inbox.${space.id}');
  Future<void>? _drainingKeys;
  int _keyGeneration = 0;

  /// Receive from E2E before ACK without waiting for gateway registration I/O.
  /// Keys stay in device-only secure storage while the independent worker waits
  /// for registration mutations. A crash leaves a retryable durable inbox.
  Future<void> acceptKey(Map<String, dynamic> payload) async {
    final key = payload['notification_key'] as String;
    if (payload['handle'] is! String || unb64(key).length != 32) {
      throw StateError('invalid_notification_key');
    }
    await _PushLocks.run(
      '${space.id}/key-inbox',
      () =>
          _keyInbox.write(jsonEncode({'id': newSpaceId(), 'payload': payload})),
    );
    _keyGeneration++;
    unawaited(flushPendingKeys());
  }

  Future<void> flushPendingKeys() {
    if (_disposed) return Future.value();
    final existing = _drainingKeys;
    if (existing != null) return existing;
    final generation = _keyGeneration;
    final work =
        _locked(() async {
          final raw = await _PushLocks.run(
            '${space.id}/key-inbox',
            _keyInbox.read,
          );
          if (raw == null || raw == '{}') return;
          final item = jsonMap(raw);
          await _installKeyUnlocked(
            Map<String, dynamic>.from(item['payload'] as Map),
          );
          await _PushLocks.run('${space.id}/key-inbox', () async {
            final current = await _keyInbox.read();
            if (current != null && jsonMap(current)['id'] == item['id']) {
              await _keyInbox.write('{}');
            }
          });
        }).catchError((Object _) {
          status = '通知密钥等待系统存储恢复，将自动重试';
          state.changed();
        });
    _drainingKeys = work.whenComplete(() {
      _drainingKeys = null;
      if (generation != _keyGeneration && !_disposed) {
        unawaited(flushPendingKeys());
      }
    });
    return _drainingKeys!;
  }

  Future<void> installKey(Map<String, dynamic> payload) =>
      _locked(() => _installKeyUnlocked(payload));
  Future<void> _installKeyUnlocked(Map<String, dynamic> payload) async {
    await _load();
    if (registration['enabled'] != true ||
        payload['handle'] != registration['handle']) {
      return;
    }
    final key = payload['notification_key'] as String;
    if (unb64(key).length != 32) throw StateError('invalid_notification_key');
    registration['notification_key'] = key;
    await _save();
    await channel.invokeMethod<void>('configureSpace', {
      'handle': registration['handle'],
      'notificationKey': key,
    });
    status = '锁屏通知已启用';
    state.changed();
  }

  Future<void> disable() => _locked(() async {
    await _load();
    final old = {...registration};
    final retired = _retired();
    _addRetired(retired, old);
    // Durable opt-out precedes external calls. An offline gateway or stale key
    // delivery cannot erase this tombstone or silently re-enable notifications.
    registration = {'enabled': false, 'retired': retired};
    await _save();
    if (old['handle'] != null) {
      await channel.invokeMethod<void>('removeSpace', {
        'handle': old['handle'],
      });
      await state.enqueue('push.unregister', {
        'handle': old['handle'],
      }, operationId: 'unregister_${old['handle']}');
    }
    await _retire();
    status = _retired().isEmpty ? '锁屏通知已关闭' : '已在本机关闭，等待网关注销';
    state.changed();
    unawaited(onWake());
  });
  static Future<void> refreshSavedTokens(
    Map<String, dynamic> token,
    Iterable<SpaceRecord> spaces, {
    SpaceGatewayRequest? request,
  }) async {
    final send = request ?? gatewayRequest;
    for (final space in spaces.where((s) => s.mode == SpaceMode.client)) {
      await _PushLocks.run(space.id, () async {
        final persistence = SpaceSecurePersistence(
          'nova.space.push.${space.id}',
        );
        final raw = await persistence.read();
        if (raw == null) return;
        final saved = jsonMap(raw);
        if (saved['enabled'] != true ||
            saved['handle'] == null ||
            saved['provider'] != token['provider'] ||
            saved['token'] == token['token']) {
          return;
        }
        final gateway =
            saved['gateway_url'] as String? ??
            const String.fromEnvironment('NOVA_PUSH_GATEWAY_URL');
        if (gateway.isEmpty) return;
        try {
          final updated = await send(
            gateway,
            'PUT',
            '/v1/registrations/${saved['handle']}',
            saved['credential'] as String,
            body: {
              'provider': token['provider'],
              'token': token['token'],
              if (saved['environment'] != null)
                'environment': saved['environment'],
            },
          );
          saved['token'] = token['token'];
          if (updated['expiresAt'] is num) {
            saved['expiresAt'] = updated['expiresAt'];
          }
          saved.remove('refresh_error');
        } catch (_) {
          saved['refresh_error'] = 'registration_refresh_required';
        }
        await persistence.write(jsonEncode(saved));
      });
    }
  }

  static Future<Map<String, dynamic>> gatewayRequest(
    String gateway,
    String method,
    String path,
    String credential, {
    Map<String, dynamic>? body,
    Duration responseBodyTimeout = const Duration(seconds: 20),
    bool allowLoopback = false,
  }) async {
    final client = HttpClient();
    try {
      final req = await client
          .openUrl(
            method,
            relayUri(gateway, allowLoopback: allowLoopback).resolve(path),
          )
          .timeout(const Duration(seconds: 15));
      req.followRedirects = false;
      req.headers.set('authorization', 'Bearer $credential');
      if (body != null) {
        req.headers.contentType = ContentType.json;
        req.write(jsonEncode(body));
      }
      final response = await req.close().timeout(const Duration(seconds: 20));
      final bytes = await (() async {
        final collected = <int>[];
        await for (final chunk in response) {
          collected.addAll(chunk);
          if (collected.length > 32768) {
            throw StateError('gateway_response_too_large');
          }
        }
        return collected;
      })().timeout(responseBodyTimeout);
      final result = jsonMap(utf8.decode(bytes));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw RelayFailure('gateway_${response.statusCode}');
      }
      return result;
    } finally {
      client.close(force: true);
    }
  }

  Future<void> dispose() async {
    _disposed = true;
    _leaseTimer?.cancel();
    await _events?.cancel();
  }
}
