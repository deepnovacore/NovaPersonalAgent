import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../personal/local_life.dart';
import '../protocol/request_id.dart';

/// An immutable local Space scope. Client Spaces never grant local publication.
/// Consent, source and model revisions are checked separately by each producer.
class LocalPublicationContext extends ChangeNotifier {
  LocalPublicationContext(
    this.persistence, {
    String? spaceId,
    this.permitsPublication,
  }) : _configuredSpace = spaceId;
  final LifePersistence persistence;
  final String? _configuredSpace;
  final bool Function()? permitsPublication;
  Map<String, dynamic>? _identity;
  bool _disposed = false;
  String get spaceId => _identity!['space_id'] as String;
  String get deviceId => _identity!['device_id'] as String;
  bool get canPublish =>
      !_disposed && _identity != null && (permitsPublication?.call() ?? true);

  Future<void> open() async {
    if (_disposed) throw StateError('publication_scope_closed');
    if (_identity != null) return;
    final saved = await persistence.read();
    final identity = saved == null
        ? {
            'space_id': _configuredSpace ?? requestId(),
            'device_id': requestId(),
          }
        : jsonDecode(saved) as Map<String, dynamic>;
    final id = RegExp(r'^[A-Za-z0-9_-]{1,200}$');
    if (identity.length != 2 ||
        !['space_id', 'device_id'].every(
          (key) => identity[key] is String && id.hasMatch(identity[key]),
        )) {
      throw const FormatException('invalid_publication_scope');
    }
    if (_configuredSpace != null && identity['space_id'] != _configuredSpace) {
      throw StateError('publication_space_mismatch');
    }
    if (saved == null) await persistence.write(jsonEncode(identity));
    if (_disposed) throw StateError('publication_scope_closed');
    _identity = identity;
    notifyListeners();
  }

  void requireCurrent() {
    if (!canPublish) throw StateError('local_host_required');
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    notifyListeners();
    super.dispose();
  }
}
