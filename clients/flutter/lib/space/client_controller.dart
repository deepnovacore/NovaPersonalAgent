import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' show max;
import 'package:flutter/widgets.dart';
import 'client_state.dart';
import 'mobile_tools.dart';
import 'push_client.dart';
import 'relay_transport.dart';
import 'space_crypto.dart';
import 'space_storage.dart';

class SpaceClientController with WidgetsBindingObserver {
  SpaceClientController(
    this.state,
    this.transport, {
    SpaceMobileTools? tools,
    this.bindingCleanup = false,
  }) {
    mobile = SpaceMobileActions(
      state,
      tools ?? NativeSpaceMobileTools(),
      isForeground: () => foreground,
    );
  }
  final bool bindingCleanup;
  final SpaceClientState state;
  final SpaceRelayTransport transport;
  late final SpaceMobileActions mobile;
  SpacePushClient? push;
  Timer? _timer;
  StreamSubscription<Map<String, dynamic>>? _subscription;
  bool foreground = true, _disposed = false;
  Future<void>? _pumping;
  String get fingerprint => deviceFingerprint(transport.crypto.identity);
  static Future<SpaceClientController> openForBindingCleanup(
    SpaceRecord space,
  ) => open(space, bindingCleanup: true);

  static Future<SpaceClientController> open(
    SpaceRecord space, {
    bool bindingCleanup = false,
  }) async {
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
      SpaceFilePersistence(
        File('${directory.path}/client-v1.json'),
        SpaceSecurePersistence('nova.space.client-storage-key.${space.id}'),
      ),
    );
    await state.open();
    final controller = SpaceClientController(
      state,
      SpaceRelayTransport(
        crypto,
        allowLoopback: const bool.fromEnvironment('NOVA_ALLOW_LOOPBACK_RELAY'),
      ),
      bindingCleanup: bindingCleanup,
    );
    if (bindingCleanup) return controller;
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
    if (bindingCleanup) return;
    foreground =
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    WidgetsBinding.instance.addObserver(this);
    _subscription = transport.events.listen(
      (event) {
        // Live envelopes are handled one at a time, in arrival order.
        final run = _streamTail.then((_) => _stream(event));
        _streamTail = run;
        unawaited(run);
      },
      onError: (Object error) {
        state.markFailure('$error');
        state.changed();
      },
    );
    _timer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (foreground &&
          (state.waitingForApproval ||
              state.snapshot.isEmpty ||
              timer.tick % 3 == 0)) {
        unawaited(sync());
      }
    });
    unawaited(sync());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    foreground = state == AppLifecycleState.resumed;
    if (foreground) unawaited(sync());
  }

  Future<void> _streamTail = Future.value();

  Future<void> _stream(Map<String, dynamic> envelope) async {
    try {
      // The channel is covered by the Host signature; enforce it at ingress.
      if (envelope['chan'] != 'stream') {
        throw StateError('invalid_envelope_channel');
      }
      final payload = await transport.crypto.openEnvelope(envelope);
      if (payload != null && !_disposed) {
        state.markOk();
        if (payload['type'] == 'push.key') {
          await push?.acceptKey(payload);
        } else if (payload['type'] == 'mobile.action') {
          await _action(payload);
        } else {
          await state.apply(payload);
        }
      }
    } catch (error) {
      // One undecryptable envelope is not a link failure; only fatal conditions surface.
      if (!_disposed) {
        if (isFatalConnectionError('$error')) state.error = '$error';
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
    var presenceConfirmed = false;
    try {
      try {
        await transport.login();
      } on RelayFailure catch (error) {
        if (bindingCleanup) rethrow;
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
          state.waitingForApproval = state.snapshot.isEmpty;
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
      state.waitingForApproval = false;
      if (!bindingCleanup) {
        unawaited(push?.flushPendingKeys() ?? Future.value());
        await transport.connectLive();
      }
      state.hostOnline = await transport.hostOnline();
      presenceConfirmed = true;
      state.changed();
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
        var rewind = false;
        for (final raw in page['messages'] as List) {
          final item = raw as Map;
          // Items at or before the cursor are relay replays; never reapply.
          if ((item['seq'] as int) <= state.cursor) continue;
          final envelope = Map<String, dynamic>.from(item['envelope'] as Map);
          Map<String, dynamic>? payload;
          // The channel is covered by the Host signature: a stream envelope
          // replayed into the mailbox is skipped, never applied.
          if (envelope['chan'] == 'mailbox') {
            try {
              payload = await transport.crypto.openEnvelope(envelope);
            } on SpaceInvalidKeyDelivery catch (error) {
              // Host-signed but unusable: permanent, so skip it.
              debugPrint('[Space] skipped key delivery ${item['seq']}: $error');
            } on StateError catch (error) {
              if (error.message != 'waiting_for_host_key' ||
                  !await _recoverKey(item['seq'] as int, envelope)) {
                rethrow;
              }
              rewind = true;
              break;
            }
          }
          if (_disposed) return;
          if (payload?['type'] == 'push.key') {
            if (bindingCleanup) {
              throw const RelayFailure('cleanup_waiting_for_push_key');
            }
            await push?.acceptKey(payload!);
          }
          if (payload?['type'] == 'mobile.action') {
            if (bindingCleanup) {
              throw const RelayFailure('cleanup_waiting_for_mobile_action');
            }
            await _action(payload!);
          }
          if (payload != null) {
            await state.apply(payload, sequence: item['seq'] as int);
          } else {
            await state.transaction(() async {
              state.cursor = item['seq'] as int;
              await state.save();
            });
          }
        }
        if (rewind) continue;
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
      if (transport.crypto.canSeal) {
        if (state.snapshot.isEmpty &&
            !state.pending.any((p) => p['kind'] == 'snapshot.request')) {
          await state.enqueue('snapshot.request', {});
        }
        for (final pending in List<Map<String, dynamic>>.from(state.pending)) {
          if (_disposed) return;
          if (pending['status'] != 'pending') continue;
          if (bindingCleanup &&
              ![
                'device.revoke',
                'snapshot.request',
              ].contains(pending['kind'])) {
            continue;
          }
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
          // send() re-checks sealability just before writing; if rotation
          // evidence arrived, nothing is sent and the intent stays queued to
          // be re-sealed once the new key is installed.
          if (!transport.crypto.canSeal) break;
          try {
            await transport.send(envelope!);
          } on RelayFailure catch (error) {
            if (error.code != SpaceRelayTransport.sendAborted) rethrow;
            break;
          }
        }
      }
      state.error = null;
      state.markOk();
    } catch (error) {
      state.markFailure('$error');
      if (!presenceConfirmed) state.hostOnline = false;
    }
    if (!_disposed) state.changed();
  }

  /// Read-ahead keeps at most this many newer-epoch key deliveries.
  static const maxKeyCandidates = 8;

  @visibleForTesting
  int get keyCandidateCount => _scan?.candidates.length ?? 0;

  /// Bounded read-ahead progress, kept apart from the durable cursor so that
  /// successive syncs continue scanning instead of starting over.
  ({
    int blockedSeq,
    int blockedEpoch,
    int scanned,
    List<Map<String, dynamic>> candidates,
  })?
  _scan;

  /// Content at [blocked] cannot be opened because its key has not been
  /// installed. After a Host epoch rotation the Host may queue content for the
  /// new epoch ahead of this device's key delivery, so read ahead (without
  /// ACK) for that Host-signed delivery.
  ///
  /// A delivery for exactly the blocked epoch is installed as soon as it is
  /// found; Host epochs only grow in mailbox order, so nothing decryptable is
  /// skipped. A newer delivery is a "jump": it is used only once the scan
  /// reaches the end of the mailbox without the exact one, because the
  /// blocked content can then never be decrypted. Before a jump installs, a
  /// fresh snapshot.request is queued durably, so a crash cannot ACK skipped
  /// content without a resync. Snapshots restore projections and receipts
  /// (pending intents are resent and the Host replays their receipts), but
  /// not skipped `mobile.action` (they expire on the Host) or `push.key` (the
  /// Host sends it once per push.register and does not resend it on
  /// reconnect; notifications stay unkeyed until push re-registers).
  ///
  /// Candidates are used only after their Host signature verifies (and each
  /// verified newer epoch is recorded durably as rotation evidence), so a
  /// forged envelope cannot shadow a genuine delivery. Candidates are tried
  /// smallest epoch first, so messages of intermediate epochs still replay.
  /// A verified delivery whose key material is unusable is permanent: it is
  /// logged and dropped. Storage errors propagate and keep the scan state,
  /// so the next sync retries. The scan cursor never moves backwards, and the
  /// candidate list is bounded (one per epoch, at most [maxKeyCandidates]).
  /// Returns
  /// true when a key was installed and the page must be reread.
  Future<bool> _recoverKey(int blockedSeq, Map<String, dynamic> blocked) async {
    final crypto = transport.crypto;
    final blockedEpoch = blocked['epoch'] as int;
    var scan = _scan;
    if (scan == null ||
        scan.blockedSeq != blockedSeq ||
        scan.blockedEpoch != blockedEpoch) {
      scan = (
        blockedSeq: blockedSeq,
        blockedEpoch: blockedEpoch,
        scanned: blockedSeq,
        candidates: const [],
      );
    }
    final start = crypto.epoch;
    bool installed() =>
        crypto.epoch != start || crypto.keys.containsKey(blockedEpoch);
    // Opens a verified delivery; false when its key material is unusable.
    Future<bool> usable(Map<String, dynamic> envelope) async {
      try {
        await crypto.openEnvelope(envelope);
        return true;
      } on SpaceInvalidKeyDelivery catch (error) {
        debugPrint('[Space] dropped key delivery ${envelope['epoch']}: $error');
        return false;
      }
    }

    var reachedEnd = false;
    for (var pages = 0; pages < 64 && !_disposed; pages++) {
      final page = await transport.pull(scan!.scanned);
      var scanned = scan.scanned;
      final candidates = [...scan.candidates];
      for (final raw in page['messages'] as List) {
        final item = raw as Map;
        final seq = item['seq'] as int;
        // A relay replaying older items cannot move the scan backwards.
        if (seq <= scanned) continue;
        final envelope = Map<String, dynamic>.from(item['envelope'] as Map);
        final epoch = envelope['epoch'];
        if (envelope['chan'] == 'mailbox' &&
            epoch is int &&
            epoch >= blockedEpoch &&
            SpaceCrypto.isKeyDelivery(envelope) &&
            await crypto.verifyAndObserve(envelope)) {
          if (epoch == blockedEpoch) {
            if (await usable(envelope) && installed()) {
              _scan = null;
              return true;
            }
          } else if (!candidates.any((c) => c['epoch'] == epoch)) {
            // One candidate per epoch; a replayed delivery adds nothing.
            candidates.add(envelope);
          }
        }
        scanned = seq;
      }
      scanned = max(scanned, page['nextCursor'] as int);
      // Smallest epochs are preferred, so the highest beyond the cap go.
      candidates.sort((a, b) => (a['epoch'] as int) - (b['epoch'] as int));
      if (candidates.length > maxKeyCandidates) {
        candidates.removeRange(maxKeyCandidates, candidates.length);
      }
      _scan = scan = (
        blockedSeq: blockedSeq,
        blockedEpoch: blockedEpoch,
        scanned: scanned,
        candidates: candidates,
      );
      if (page['hasMore'] != true) {
        reachedEnd = true;
        break;
      }
    }
    if (!reachedEnd || scan!.candidates.isEmpty) return false;
    // A resync is durable before the jump is installed. Its op_id is derived
    // from this blocked position, so it is new for this jump (an older
    // request may already have been answered) yet retries and reopens reuse
    // it. It cannot be sent while sealing is blocked.
    await state.enqueue(
      'snapshot.request',
      {},
      operationId:
          'resync-${transport.crypto.space.id}-$blockedEpoch-$blockedSeq',
    );
    final scanned = scan.scanned;
    final remaining = [...scan.candidates];
    void keep() => _scan = (
      blockedSeq: blockedSeq,
      blockedEpoch: blockedEpoch,
      scanned: scanned,
      candidates: [...remaining],
    );
    keep();
    while (remaining.isNotEmpty) {
      // Storage errors propagate here and leave this candidate cached.
      final ok = await usable(remaining.first);
      remaining.removeAt(0);
      keep();
      if (ok && installed()) {
        _scan = null;
        return true;
      }
    }
    return false;
  }

  /// Manual retry from the reconnect page.
  Future<void> reconnectNow() async {
    state.reconnecting = true;
    state.changed();
    try {
      await sync();
    } finally {
      state.reconnecting = false;
      state.changed();
    }
  }

  Future<String> sendChat(
    String text, {
    String conversationId = 'chat:main',
  }) async {
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
      'input': {'conversation_id': conversationId, 'text': text},
    };
    final envelope = await transport.crypto.seal(
      payload,
      id: id,
      channel: 'stream',
      expiresAt: now + 45000,
    );
    if (text.length > 16000 ||
        utf8.encode(jsonEncode(envelope)).length > 64 * 1024) {
      throw StateError('chat_message_too_large');
    }
    await state.beginChat(id, text, now, conversationId: conversationId);
    try {
      await transport.send(envelope); // No durable offline queue or retry.
      state.markOk();
      await state.markChat(id, 'sent');
    } on RelayFailure catch (error) {
      // Nothing was written: the turn failed and a retry is sealed afresh.
      if (error.code == SpaceRelayTransport.sendAborted) {
        await state.markChat(id, 'failed', error: error.code);
      } else {
        await state.markChat(id, 'unknown', error: 'send_outcome_unknown');
      }
      rethrow;
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
    // Let an in-flight live envelope finish before the transport closes.
    await _streamTail;
    await push?.dispose();
    await transport.dispose();
    await _pumping;
    state.dispose();
  }
}
