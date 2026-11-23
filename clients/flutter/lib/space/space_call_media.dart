import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' show max;
import 'dart:typed_data';

/// One joined media leg (docs/design/space-voice.md §1). Frames are opaque
/// AEAD frames; only the relay's `ready` and the endpoint's `renew` are text.
abstract interface class SpaceCallSocket {
  Stream<Uint8List> get frames;

  /// Completes once, with the close reason, when the socket is gone.
  Future<String> get closed;
  Future<void> send(Uint8List frame);
  Future<void> close();
}

abstract interface class SpaceCallMedia {
  /// Joins a reserved session. Resolves only after the relay's `ready` text
  /// frame, so the caller can send its sealed `ready` immediately.
  Future<SpaceCallSocket> connect(String session);
}

typedef SpaceWebSocketConnector =
    Future<WebSocket> Function(Uri uri, Map<String, dynamic> headers);

/// Relay media client over `GET /v1/media` with the `X-Nova-Media-Session`
/// header and in-band token renewal ahead of expiry.
class RelaySpaceCallMedia implements SpaceCallMedia {
  RelaySpaceCallMedia({
    required this.uri,
    required this.token,
    required this.expiresAt,
    required this.renew,
    SpaceWebSocketConnector? connector,
    this.renewLead = const Duration(seconds: 60),
    this.minimumRenewDelay = const Duration(seconds: 1),
  }) : connector =
           connector ??
           ((uri, headers) => WebSocket.connect(
             uri.toString(),
             headers: headers,
           ).timeout(const Duration(seconds: 15)));
  final Uri Function() uri;
  final String? Function() token;
  final int Function() expiresAt;

  /// Fresh relay login; afterwards [token] and [expiresAt] are the new session.
  final Future<void> Function() renew;
  final SpaceWebSocketConnector connector;
  final Duration renewLead, minimumRenewDelay;

  @override
  Future<SpaceCallSocket> connect(String session) async {
    final bearer = token();
    if (bearer == null) throw StateError('relay_not_logged_in');
    final ws = await connector(uri(), {
      'authorization': 'Bearer $bearer',
      'x-nova-media-session': session,
    });
    final socket = _RelaySocket(this, ws);
    try {
      await socket._ready.future.timeout(const Duration(seconds: 15));
    } catch (_) {
      await socket.close();
      rethrow;
    }
    socket._schedule();
    return socket;
  }
}

class _RelaySocket implements SpaceCallSocket {
  _RelaySocket(this.media, this.ws) {
    _subscription = ws.listen(
      (data) {
        if (data is String) {
          if (!_ready.isCompleted) {
            try {
              final value = jsonDecode(data);
              if (value is Map && value['type'] == 'ready') {
                _ready.complete();
                return;
              }
            } catch (_) {}
            _ready.completeError(StateError('media_rejected'));
          }
          return;
        }
        if (_ready.isCompleted && data is List<int>) {
          _frames.add(data is Uint8List ? data : Uint8List.fromList(data));
        }
      },
      onDone: () => _finish(ws.closeReason ?? 'closed'),
      onError: (Object _) => _finish('transport_failed'),
      cancelOnError: true,
    );
  }
  final RelaySpaceCallMedia media;
  final WebSocket ws;
  final _ready = Completer<void>();
  final _frames = StreamController<Uint8List>.broadcast(sync: true);
  final _closed = Completer<String>();
  late final StreamSubscription<dynamic> _subscription;
  Timer? _renewal;
  bool _done = false;

  /// True while an in-band renewal is scheduled; tests only.
  bool get renewalPending => _renewal != null;

  void _schedule() {
    if (_done) return;
    final delay = max(
      media.minimumRenewDelay.inMilliseconds,
      media.expiresAt() -
          DateTime.now().millisecondsSinceEpoch -
          media.renewLead.inMilliseconds,
    );
    _renewal = Timer(Duration(milliseconds: delay), () async {
      _renewal = null;
      try {
        await media.renew();
        // The socket may have closed while the login was in flight.
        if (_done || ws.readyState != WebSocket.open) return;
        ws.add(jsonEncode({'type': 'renew', 'token': media.token()}));
        _schedule();
      } catch (_) {
        if (!_done) await close();
      }
    });
  }

  void _finish(String reason) {
    if (_done) return;
    _done = true;
    _renewal?.cancel();
    _renewal = null;
    if (!_ready.isCompleted) _ready.completeError(StateError(reason));
    if (!_closed.isCompleted) _closed.complete(reason);
    unawaited(_frames.close());
  }

  @override
  Stream<Uint8List> get frames => _frames.stream;
  @override
  Future<String> get closed => _closed.future;
  @override
  Future<void> send(Uint8List frame) async {
    if (_done || ws.readyState != WebSocket.open) {
      throw StateError('media_closed');
    }
    ws.add(frame);
  }

  @override
  Future<void> close() async {
    _finish('closed');
    await _subscription.cancel();
    await ws.close(1000, 'closed');
  }
}
