import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import '../personal/local_life.dart';
import '../protocol/request_id.dart';

final class LocalMemoryEntry {
  const LocalMemoryEntry({
    required this.id,
    required this.kind,
    required this.text,
    required this.quote,
    required this.createdAt,
    this.forgottenAt,
  });
  final String id, kind, text, quote;
  final DateTime createdAt;
  final DateTime? forgottenAt;

  Map<String, dynamic> toJson() => {
    'id': id,
    'kind': kind,
    'text': text,
    'quote': quote,
    'createdAt': createdAt.toUtc().toIso8601String(),
    'forgottenAt': forgottenAt?.toUtc().toIso8601String(),
  };

  factory LocalMemoryEntry.fromJson(Map<String, dynamic> value) {
    final entry = LocalMemoryEntry(
      id: value['id'] as String,
      kind: value['kind'] as String,
      text: value['text'] as String,
      quote: value['quote'] as String,
      createdAt: DateTime.parse(value['createdAt'] as String),
      forgottenAt: value['forgottenAt'] == null
          ? null
          : DateTime.parse(value['forgottenAt'] as String),
    );
    if (entry.id.isEmpty ||
        entry.id.length > 256 ||
        !['fact', 'preference'].contains(entry.kind) ||
        entry.text.runes.length > 200 ||
        (entry.forgottenAt == null &&
            (entry.text.trim().isEmpty || entry.quote.trim().isEmpty)) ||
        (entry.forgottenAt != null &&
            (entry.text.isNotEmpty || entry.quote.isNotEmpty))) {
      throw const FormatException('invalid_memory');
    }
    return entry;
  }
}

final class LocalMemoryFailure implements Exception {
  const LocalMemoryFailure(this.code);
  final String code;
}

/// One writer per standalone Space; serialize with the same atomic persistence
/// used by LocalLife. Publish in-memory state only after the disk commit.
final class LocalMemoryStore {
  LocalMemoryStore(this.persistence);
  final LifePersistence persistence;
  // The app owns a store, not this registry. A lost app-level reference must
  // not keep an otherwise unreachable owner alive for the process lifetime.
  static final _owners = <Object, WeakReference<LocalMemoryStore>>{};
  Object? _pathKey;
  bool get _ownsLedger => identical(_owners[_pathKey]?.target, this);
  Future<void>? _closing;
  final _forgetListeners = <FutureOr<void> Function()>{};

  static const forgetListenerDeadline = Duration(seconds: 5);

  /// Listeners must fence synchronously, then bound any asynchronous shutdown.
  void addForgetListener(FutureOr<void> Function() listener) =>
      _forgetListeners.add(listener);
  void removeForgetListener(FutureOr<void> Function() listener) =>
      _forgetListeners.remove(listener);
  List<LocalMemoryEntry> _entries = [];
  Future<void> _tail = Future.value();
  bool _opened = false, _available = false, _closed = false;
  String? _recoveryCleanupError;
  String? get recoveryCleanupError => _recoveryCleanupError;
  String? _forgetListenerError;
  String? get forgetListenerError => _forgetListenerError;

  Future<void> _purgeRecoveryFiles({bool invalidateTransfers = false}) async {
    // Called only inside our serial queue, never alongside our own write.
    if (!_ownsLedger) return;
    _recoveryCleanupError = null;
    if (invalidateTransfers) {
      try {
        await _invalidateNativeTransfers();
      } catch (_) {
        _recoveryCleanupError = 'memory_recovery_cleanup_failed';
      }
    }
    await _purgeOrphanedModelResults();
    if (persistence is! FileLifePersistence) return;
    try {
      await (persistence as FileLifePersistence).purgeAbandonedPendingFiles();
    } catch (_) {
      _recoveryCleanupError = 'memory_recovery_cleanup_failed';
    }
  }

  // NativeModelTransfer.folder uses Application Support/spaces/<id>/ModelTransfers,
  // the same Space parent as local_memory.json. Orphan results are never replayed.
  Future<void> _purgeOrphanedModelResults() async {
    if (persistence is! FileLifePersistence) return;
    final parent = (persistence as FileLifePersistence).file.parent;
    final directory = Directory('${parent.path}/ModelTransfers');
    try {
      final type = await FileSystemEntity.type(
        directory.path,
        followLinks: false,
      );
      if (type == FileSystemEntityType.notFound) return;
      if (type != FileSystemEntityType.directory) {
        throw const FileSystemException('invalid_recovery_directory');
      }
      await for (final file in directory.list(followLinks: false)) {
        if (file is File && file.path.endsWith('.result')) {
          try {
            await file.delete();
          } catch (_) {
            _recoveryCleanupError = 'memory_recovery_cleanup_failed';
          }
        }
      }
    } catch (_) {
      _recoveryCleanupError = 'memory_recovery_cleanup_failed';
    }
  }

  Future<void> _invalidateNativeTransfers() async {
    if (defaultTargetPlatform != TargetPlatform.iOS ||
        persistence is! FileLifePersistence) {
      return;
    }
    final parent = (persistence as FileLifePersistence).file.parent;
    final spaceId = parent.uri.pathSegments.where((s) => s.isNotEmpty).last;
    await const MethodChannel('nova/space_scope')
        .invokeMethod<void>('invalidateModelTransfers', {'spaceId': spaceId})
        .timeout(forgetListenerDeadline);
  }

  bool get available => _available && !_closed;

  /// Stops new operations immediately and drains already queued writes.
  Future<void> close() {
    _closed = true;
    return _closing ??= _tail.then((_) {
      if (_ownsLedger) _owners.remove(_pathKey);
    });
  }

  /// Recovery is explicit, never called by open or tools. Preserve the original
  /// bytes (including invalid UTF-8) before replacing an unavailable file.
  Future<void> resetUnavailable() => _serial(() async {
    if (!_opened ||
        !_ownsLedger ||
        _available ||
        persistence is! FileLifePersistence) {
      throw const LocalMemoryFailure('memory_reset_unavailable');
    }
    // Explicit recovery must revoke native requests before preserving/resetting
    // the ledger. Unlike forget, no commit has occurred: failure aborts reset.
    await _invalidateNativeTransfers();
    await _purgeRecoveryFiles();
    final file = (persistence as FileLifePersistence).file;
    if (await file.exists()) {
      await file.copy(
        '${file.path}.corrupt-${DateTime.now().microsecondsSinceEpoch}',
      );
    }
    await persistence.write(jsonEncode({'schema_version': 1, 'entries': []}));
    _entries = [];
    _available = true;
  });

  Future<T> _serial<T>(Future<T> Function() work) {
    final result = _tail.then((_) {
      if (_closed) throw const LocalMemoryFailure('memory_unavailable');
      return work();
    });
    _tail = result.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return result;
  }

  /// A second live owner fails closed (available == false). A closing owner
  /// retains ownership through its drain; only then may a new store take over.
  Future<void> open() => _serial(() async {
    if (_opened) return;
    _opened = true;
    try {
      _pathKey = persistence is FileLifePersistence
          ? await FileLifePersistence.canonicalIdentity(
              (persistence as FileLifePersistence).file,
            )
          : persistence;
    } catch (_) {
      return; // Identity is unknown: do not read, write or clean this ledger.
    }
    while (true) {
      final owner = _owners[_pathKey]?.target;
      if (owner == null) break;
      if (!owner._closed) return;
      await owner.close();
      if (_closed) return;
    }
    _owners[_pathKey!] = WeakReference(this);
    await _purgeRecoveryFiles();
    String? raw;
    try {
      raw = await persistence.read();
    } catch (_) {
      return; // Unreadable storage must not be overwritten as an empty ledger.
    }
    try {
      if (raw != null) {
        final data = jsonDecode(raw) as Map<String, dynamic>;
        if (data['schema_version'] != 1) {
          return; // Do not overwrite a newer schema.
        }
        final entries = (data['entries'] as List)
            .map((e) => LocalMemoryEntry.fromJson(Map<String, dynamic>.from(e)))
            .toList();
        if (entries.map((e) => e.id).toSet().length != entries.length ||
            entries.where((e) => e.forgottenAt == null).length > 200) {
          throw const FormatException('invalid_memory');
        }
        _entries = entries;
      }
    } catch (_) {
      // Fail closed: preserve the entire corrupt document for explicit recovery.
      return;
    }
    _available = true;
  });

  Future<void> _commit(List<LocalMemoryEntry> next) async {
    if (!available) throw const LocalMemoryFailure('memory_unavailable');
    try {
      await persistence.write(
        jsonEncode({
          'schema_version': 1,
          'entries': next.map((e) => e.toJson()).toList(),
        }),
      );
    } catch (_) {
      throw const LocalMemoryFailure('memory_unavailable');
    }
    _entries = next;
  }

  /// Seeds only the reserved persona IDs. Previously forgotten IDs still count as imported.
  Future<void> seedPersona(Iterable<LocalMemoryEntry> entries) =>
      _serial(() async {
        if (!available) throw const LocalMemoryFailure('memory_unavailable');
        final seen = _entries.map((entry) => entry.id).toSet();
        final next = [..._entries];
        for (final entry in entries) {
          if (!entry.id.startsWith('persona:') || entry.forgottenAt != null) {
            throw const LocalMemoryFailure('invalid_memory');
          }
          if (seen.add(entry.id)) {
            next.add(LocalMemoryEntry.fromJson(entry.toJson()));
          }
        }
        if (next.length == _entries.length) return;
        if (next.where((entry) => entry.forgottenAt == null).length > 200) {
          throw const LocalMemoryFailure('memory_full');
        }
        await _commit(next);
      });

  Future<LocalMemoryEntry> save({
    required String kind,
    required String text,
    required String quote,
    required String? userUtterance,
  }) => _serial(() async {
    if (!available) throw const LocalMemoryFailure('memory_unavailable');
    if (quote.trim().isEmpty ||
        userUtterance == null ||
        !userUtterance.contains(quote)) {
      throw const LocalMemoryFailure('invalid_source_quote');
    }
    if (!['fact', 'preference'].contains(kind) ||
        text.trim().isEmpty ||
        text.runes.length > 200) {
      throw const LocalMemoryFailure('invalid_memory');
    }
    if (_entries.where((e) => e.forgottenAt == null).length >= 200) {
      throw const LocalMemoryFailure('memory_full');
    }
    final entry = LocalMemoryEntry(
      id: requestId(),
      kind: kind,
      text: text,
      quote: quote,
      createdAt: DateTime.now().toUtc(),
    );
    await _commit([..._entries, entry]);
    return entry;
  });

  List<LocalMemoryEntry> recall(String query, {int limit = 5}) {
    if (!available || limit <= 0) return [];
    final terms = RegExp(
      r'[a-z0-9_]{2,}|[\u3400-\u4dbf\u4e00-\u9fff]{2}',
    ).allMatches(_normalize(query)).map((m) => m.group(0)!).toSet();
    if (terms.isEmpty) return [];
    return _entries.reversed
        .where((e) {
          if (e.forgottenAt != null) return false;
          final text = _normalize(e.text);
          return terms.where(text.contains).length / terms.length >= 0.25;
        })
        .take(limit)
        .toList();
  }

  Future<void> forget(String id) => _serial(() async {
    if (!available) throw const LocalMemoryFailure('memory_unavailable');
    final index = _entries.indexWhere((e) => e.id == id);
    if (index < 0) throw const LocalMemoryFailure('memory_not_found');
    final entry = _entries[index];
    if (entry.forgottenAt == null) {
      final next = List<LocalMemoryEntry>.of(_entries);
      next[index] = LocalMemoryEntry(
        id: entry.id,
        kind: entry.kind,
        text: '',
        quote: '',
        createdAt: entry.createdAt,
        forgottenAt: DateTime.now().toUtc(),
      );
      await _commit(next);
    }
    await _purgeRecoveryFiles(invalidateTransfers: true);
    // A committed tombstone must not leave the ledger/retirement queue blocked
    // by a consumer. Report only fixed diagnostic codes, never exception text.
    _forgetListenerError = null;
    await Future.wait(
      _forgetListeners.toList().map((listener) async {
        try {
          await Future<void>.sync(listener).timeout(forgetListenerDeadline);
        } on TimeoutException {
          _forgetListenerError = 'memory_invalidation_timeout';
        } catch (_) {
          _forgetListenerError ??= 'memory_invalidation_failed';
        }
      }),
    );
  });

  /// JSON data, not instructions. Whole entries keep the bounded value valid JSON.
  String summary({int maxChars = 600}) {
    if (!available || maxChars < 2) return '';
    final entries = _entries.reversed
        .where((e) => e.forgottenAt == null)
        .toList();
    final ordered = [
      ...entries.where((e) => e.kind == 'preference'),
      ...entries.where((e) => e.kind == 'fact'),
    ];
    final items = <Map<String, String>>[];
    var result = '';
    for (final entry in ordered) {
      final item = {'kind': entry.kind, 'text': entry.text};
      final candidate = jsonEncode([
        ...items,
        item,
      ]).replaceAll('<', r'\u003c').replaceAll('>', r'\u003e');
      if (candidate.length > maxChars) continue;
      items.add(item);
      result = candidate;
    }
    return result;
  }
}

// Dependency-free compatibility folding for full-width ASCII and spaces, plus
// case folding. This is deliberately not a full Unicode NFKC implementation.
String _normalize(String text) => String.fromCharCodes(
  text.runes.map(
    (c) => c >= 0xff01 && c <= 0xff5e
        ? c - 0xfee0
        : c == 0x3000
        ? 0x20
        : c,
  ),
).toLowerCase();
