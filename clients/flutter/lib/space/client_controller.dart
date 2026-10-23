import 'dart:async';
import 'dart:io';
import 'package:flutter/widgets.dart';
import 'client_state.dart';
import 'mobile_tools.dart';
import 'push_client.dart';
import 'relay_transport.dart';
import 'space_crypto.dart';
import 'space_storage.dart';

class SpaceClientController with WidgetsBindingObserver {
  SpaceClientController(this.state, this.transport, {SpaceMobileTools? tools}) {
    mobile = SpaceMobileActions(
      state,
      tools ?? NativeSpaceMobileTools(),
      isForeground: () => foreground,
    );
  }
  final SpaceClientState state;
  final SpaceRelayTransport transport;
  late final SpaceMobileActions mobile;
  SpacePushClient? push;
  Timer? _timer;
  StreamSubscription<Map<String, dynamic>>? _subscription;
  bool foreground = true, _disposed = false;
  Future<void>? _pumping;
  String get fingerprint => deviceFingerprint(transport.crypto.identity);
  static Future<SpaceClientController> open(SpaceRecord space) async {
    if (space.mode != SpaceMode.client) throw StateError('not_a_client_space');
    final raw = await SpaceSecurePersistence(
      'nova.space.identity.${space.id}',
    ).read();
    if (raw == null) throw StateError('missing_device_identity');
    final crypto = SpaceCrypto(
      space,
      SpaceIdentity.fromJson(jsonMap(raw)),
      SpaceSecurePersistence('nova.space.keys.${space.id}'),
    );
    await crypto.load();
    final directory = await SpaceStorage.directory(space: space);
    final state = SpaceClientState(
      SpaceFilePersistence(File('${directory.path}/client-v1.json')),
    );
    await state.open();
    final controller = SpaceClientController(
      state,
      SpaceRelayTransport(
        crypto,
        allowLoopback: const bool.fromEnvironment('NOVA_ALLOW_LOOPBACK_RELAY'),
      ),
    );
    controller.push = SpacePushClient(space, state, onWake: controller.sync);
    controller.start();
    unawaited(
      controller.push!.start().catchError((Object _) {
        controller.push!.status = '锁屏通知暂不可用，空间内容仍可同步';
        state.changed();
      }),
    );
    return controller;
  }

  void start() {
    foreground =
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    WidgetsBinding.instance.addObserver(this);
    _subscription = transport.events.listen(
      (event) {
        unawaited(_stream(event));
      },
      onError: (Object error) {
        state.error = '$error';
        state.changed();
      },
    );
    _timer = Timer.periodic(const Duration(seconds: 3), (_) {
      if (foreground) unawaited(sync());
    });
    unawaited(sync());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    foreground = state == AppLifecycleState.resumed;
    if (foreground) unawaited(sync());
  }

  Future<void> _stream(Map<String, dynamic> envelope) async {
    try {
      final payload = await transport.crypto.openEnvelope(envelope);
      if (payload != null && !_disposed) {
        if (payload['type'] == 'push.key') {
          await push?.acceptKey(payload);
        } else if (payload['type'] == 'mobile.action') {
          await _action(payload);
        } else {
          await state.apply(payload);
        }
      }
    } catch (error) {
      if (!_disposed) {
        state.error = '$error';
        state.changed();
      }
    }
  }

  Future<void> _action(Map<String, dynamic> payload) async {
    final result = await mobile.handle(payload);
    await state.enqueue(
      'mobile.result',
      result,
      operationId: 'effect_${stableSpaceId(payload['action_id'] as String)}',
    );
  }

  Future<void> sync() {
    if (_disposed) return Future.value();
    return _pumping ??= _sync().whenComplete(() => _pumping = null);
  }

  Future<void> _sync() async {
    try {
      try {
        await transport.login();
      } on RelayFailure catch (error) {
        if (![
          'unknown_device',
          'inactive_device',
          'device_inactive',
        ].contains(error.code)) {
          rethrow;
        }
        final pendingPair = await SpaceSecurePersistence(
          'nova.space.pair-request.${transport.crypto.space.id}',
        ).read();
        if (pendingPair != null) {
          final request = jsonMap(pendingPair);
          if (request.containsKey('invitationId')) {
            try {
              await transport.request(
                'POST',
                '/v1/pairing/requests',
                authenticated: false,
                body: request,
              );
            } on RelayFailure catch (pairError) {
              if (![
                'invitation_used',
                'invalid_invitation',
              ].contains(pairError.code)) {
                rethrow;
              }
            }
          }
        }
        rethrow;
      }
      if (_disposed) return;
      unawaited(push?.flushPendingKeys() ?? Future.value());
      await transport.connectLive();
      state.hostOnline = await transport.hostOnline();
      var more = true;
      while (more && !_disposed) {
        Map<String, dynamic> page;
        try {
          page = await transport.pull(state.cursor);
        } on RelayFailure catch (error) {
          if (error.code != 'cursor_expired') rethrow;
          final status =
              await transport.request('GET', '/v1/mailbox/status') as Map;
          // Recover authoritative state using a fresh Host snapshot. Retain all
          // pending user edits and the previous read-only cache in the meantime.
          await state.enqueue('snapshot.request', {});
          await state.transaction(() async {
            state.cursor = status['retainedAfter'] as int;
            await state.save();
          });
          page = await transport.pull(state.cursor);
        }
        for (final raw in page['messages'] as List) {
          final item = raw as Map;
          final payload = await transport.crypto.openEnvelope(
            Map<String, dynamic>.from(item['envelope'] as Map),
          );
          if (_disposed) return;
          if (payload?['type'] == 'push.key') await push?.acceptKey(payload!);
          if (payload?['type'] == 'mobile.action') await _action(payload!);
          if (payload != null) {
            await state.apply(payload, sequence: item['seq'] as int);
          } else {
            await state.transaction(() async {
              state.cursor = item['seq'] as int;
              await state.save();
            });
          }
        }
        // Empty reads at a retention floor still need an ACK after durability.
        if ((page['nextCursor'] as int) > state.cursor) {
          await state.transaction(() async {
            state.cursor = page['nextCursor'] as int;
            await state.save();
          });
        }
        await transport.ack(state.cursor);
        more = page['hasMore'] == true;
      }
      if (_disposed) return;
      if (transport.crypto.keys.containsKey(transport.crypto.epoch)) {
        if (state.snapshot.isEmpty &&
            !state.pending.any((p) => p['kind'] == 'snapshot.request')) {
          await state.enqueue('snapshot.request', {});
        }
        for (final pending in List<Map<String, dynamic>>.from(state.pending)) {
          if (_disposed) return;
          if (pending['status'] != 'pending') continue;
          final dependencies = (pending['depends_on'] as List? ?? [])
              .cast<String>();
          if (dependencies.any(
            (id) => !state.completedOperations.contains(id),
          )) {
            continue;
          }
          var envelope = (pending['envelope'] as Map?)?.cast<String, dynamic>();
          if (envelope?['epoch'] != transport.crypto.epoch) {
            envelope = await transport.crypto.seal(
              state.wireIntent(pending),
              id: '${pending['op_id']}_e${transport.crypto.epoch}',
            );
            await state.transaction(() async {
              pending['envelope'] = envelope;
              await state.save();
            });
          }
          // Exact signed ciphertext is durable before send. Retries reuse it.
          await transport.send(envelope!);
        }
      }
      state.error = null;
    } catch (error) {
      state.error = '$error';
      state.hostOnline = false;
    }
    if (!_disposed) state.changed();
  }

  Future<String> sendChat(String text) async {
    if (text.trim().isEmpty) throw StateError('empty_chat');
    await transport.login();
    if (!await transport.hostOnline()) {
      throw StateError('host_offline_chat_unavailable');
    }
    final id = newSpaceId(), now = DateTime.now().millisecondsSinceEpoch;
    final payload = {
      'v': 1,
      'type': 'intent',
      'kind': 'chat.send',
      'op_id': id,
      'created_at': now,
      'expires_at': now + 45000,
      'input': {'conversation_id': 'chat:main', 'text': text},
    };
    final envelope = await transport.crypto.seal(
      payload,
      id: id,
      channel: 'stream',
      expiresAt: now + 45000,
    );
    await state.beginChat(id, text, now);
    try {
      await transport.send(envelope); // No durable offline queue or retry.
      await state.markChat(id, 'sent');
    } catch (_) {
      await state.markChat(id, 'unknown', error: 'send_outcome_unknown');
      rethrow;
    }
    return id;
  }

  Future<void> cancelChat(String turn) async {
    if (!await transport.hostOnline()) {
      throw StateError('host_offline_chat_unavailable');
    }
    final now = DateTime.now().millisecondsSinceEpoch;
    final id = newSpaceId();
    await transport.send(
      await transport.crypto.seal(
        {
          'v': 1,
          'type': 'intent',
          'kind': 'chat.cancel',
          'op_id': id,
          'created_at': now,
          'expires_at': now + 45000,
          'input': {'op_id': turn},
        },
        id: id,
        channel: 'stream',
        expiresAt: now + 45000,
      ),
    );
  }

  Future<void> dispose() async {
    _disposed = true;
    _timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    await _subscription?.cancel();
    await push?.dispose();
    await transport.dispose();
    await _pumping;
    state.dispose();
  }
}
