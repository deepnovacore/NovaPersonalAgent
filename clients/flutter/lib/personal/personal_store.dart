import 'dart:async';
import 'package:flutter/foundation.dart';
import '../protocol/request_id.dart';
import 'models.dart';
import 'local_life.dart';

final class PersonalCommandError implements Exception {
  const PersonalCommandError(this.code);
  final String code;
  @override
  String toString() => code == 'version_conflict'
      ? 'This item changed on another device. Refresh and try again.'
      : code;
}

final class PersonalStore extends ChangeNotifier {
  PersonalStore({
    required this.send,
    this.timeout = const Duration(seconds: 30),
    this.local,
  }) {
    local?.addListener(_localChanged);
    if (local != null) _localChanged();
  }
  final LocalLife? local;
  bool get available => local?.ready ?? connected;
  void _localChanged() {
    final repository = local;
    if (repository == null || !repository.ready) return;
    snapshot = PersonalSnapshot({
      'type': 'personal.state',
      'revision': repository.revision,
      'life': repository.life,
    });
    notifyListeners();
  }

  final bool Function(Map<String, dynamic>) send;
  final Duration timeout;
  final _pending = <String, ({Completer<dynamic> result, Timer timer})>{};
  PersonalSnapshot? snapshot;
  bool connected = false, _reloadRequested = false, _acceptFirst = true;
  bool _disposed = false, _reloadBlocked = false;
  String? _instance;
  String? error;
  void setConnected(bool value, {String? instance}) {
    if (connected == value && (instance == null || instance == _instance)) {
      return;
    }
    connected = value;
    if (!value) {
      for (final pending in _pending.values) {
        pending.timer.cancel();
        pending.result.completeError(
          const PersonalCommandError(
            'Connection lost. Check state before retrying.',
          ),
        );
      }
      _pending.clear();
      _reloadRequested = false;
    } else {
      _acceptFirst =
          instance == null || instance != _instance || snapshot == null;
      _instance = instance;
      _reloadRequested = false;
      _reloadBlocked = false;
      refresh();
    }
    notifyListeners();
  }

  void restore(PersonalSnapshot cached) {
    if (snapshot == null && !connected) {
      snapshot = cached;
      notifyListeners();
    }
  }

  void clear() {
    snapshot = null;
    _instance = null;
    _acceptFirst = true;
    notifyListeners();
  }

  void refresh({bool force = false}) {
    if (local != null) {
      _localChanged();
      return;
    }
    if (!connected || _reloadRequested || (_reloadBlocked && !force)) return;
    _reloadBlocked = false;
    _reloadRequested = true;
    unawaited(
      command('state').then<void>(
        (_) {
          _reloadRequested = false;
        },
        onError: (Object e) {
          if (_disposed) return;
          error = e.toString();
          _reloadRequested = false;
          notifyListeners();
        },
      ),
    );
  }

  Future<dynamic> command(
    String method, [
    Map<String, dynamic> params = const {},
  ]) => commandWithRequestId(method, params, requestId());

  /// Reuse only for a retry of the exact same scheduled operation after a lost ACK.
  Future<dynamic> commandWithRequestId(
    String method,
    Map<String, dynamic> params,
    String id,
  ) {
    final repository = local;
    if (repository != null) {
      if (method == 'state') return Future.value(snapshot?.data);
      if (method == 'life.mutate') {
        return repository.mutate(params, operationId: id);
      }
      return Future.error(
        const PersonalCommandError('This action requires a connected host.'),
      );
    }
    if (_pending.containsKey(id)) {
      return Future.error(
        const PersonalCommandError('Wait for pending operations'),
      );
    }
    if (!connected) return Future.error(const PersonalCommandError('Offline'));
    if (_pending.length >= 32) {
      return Future.error(
        const PersonalCommandError('Wait for pending operations'),
      );
    }
    final result = Completer<dynamic>();
    final timer = Timer(timeout, () {
      _pending.remove(id);
      result.completeError(
        TimeoutException('Check state before retrying', timeout),
      );
    });
    _pending[id] = (result: result, timer: timer);
    if (!send({
      'type': 'personal.command',
      'request_id': id,
      'method': method,
      'params': params,
    })) {
      _pending.remove(id);
      timer.cancel();
      result.completeError(const PersonalCommandError('Send failed'));
    }
    return result.future;
  }

  void receive(Map<String, dynamic> frame) {
    if (frame['type'] == 'personal.result') {
      final pending = _pending.remove(frame['request_id']);
      if (pending != null) {
        pending.timer.cancel();
        if (frame['ok'] == true) {
          pending.result.complete(frame['data']);
        } else {
          pending.result.completeError(
            PersonalCommandError(
              frame['error'] as String? ?? 'Operation failed',
            ),
          );
        }
      }
      final data = frame['data'];
      if (data is Map<String, dynamic> && data['type'] == 'personal.state') {
        receive(data);
      }
      if (frame['reload_required'] == true) _reload();
    }
    if (frame['type'] == 'personal.state') {
      if (frame['reload_required'] == true) {
        error = 'State is too large. Refresh after reducing host history.';
        _reload();
      } else {
        final next = PersonalSnapshot(frame);
        if (_acceptFirst ||
            snapshot == null ||
            next.revision > snapshot!.revision) {
          snapshot = next;
          _acceptFirst = false;
        }
        _reloadRequested = false;
        _reloadBlocked = false;
        error = null;
      }
    }
    notifyListeners();
  }

  void _reload() {
    if (_reloadRequested) {
      _reloadBlocked = true;
    } else {
      refresh();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    local?.removeListener(_localChanged);
    for (final pending in _pending.values) {
      pending.timer.cancel();
      pending.result.completeError(const PersonalCommandError('Disposed'));
    }
    _pending.clear();
    super.dispose();
  }
}
