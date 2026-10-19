import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'workspace_posix.dart';
import 'model_client.dart';

/// The native Linux host bind-mounts this same directory at /workspace.
/// Model paths are virtual paths, never host filesystem paths.
class AgentWorkspace {
  AgentWorkspace(this.root, {this.inspect, this.present});
  final Directory root;
  final Future<Map<String, dynamic>> Function(String html, String script)?
  inspect;
  final Future<void> Function(String title, String html)? present;
  static const channel = MethodChannel('nova/artifacts/v1');
  static const readBytes = 65536;
  Future<void> _tail = Future.value();

  static bool supportsPlatform(TargetPlatform platform) =>
      platform == TargetPlatform.iOS || platform == TargetPlatform.android;

  static Future<AgentWorkspace> open() async {
    final support = await getApplicationSupportDirectory();
    final workspace = AgentWorkspace(
      Directory('${support.path}/nova-workspace'),
      inspect: (html, script) async => Map<String, dynamic>.from(
        await channel.invokeMapMethod<String, dynamic>('inspect', {
              'html': html,
              'script': script,
            }) ??
            {},
      ),
      present: (title, html) =>
          channel.invokeMethod<void>('open', {'title': title, 'html': html}),
    );
    await workspace.initialize();
    await workspace.migrateLegacy(
      File('${support.path}/local-artifacts-v1.json'),
    );
    return workspace;
  }

  Future<void> initialize() async {
    await root.create(recursive: true);
  }

  String normalize(String path) {
    if (path.isEmpty || path.contains('\u0000') || path.length > 4096) {
      throw const AgentFailure('invalid_workspace_path');
    }
    if (path.startsWith('/')) {
      if (path != '/workspace' && !path.startsWith('/workspace/')) {
        throw const AgentFailure('path_outside_workspace');
      }
      path = path.substring('/workspace'.length);
    }
    final parts = <String>[];
    for (final part in path.split('/')) {
      if (part.isEmpty || part == '.') continue;
      if (part == '..') {
        if (parts.isEmpty) throw const AgentFailure('path_outside_workspace');
        parts.removeLast();
      } else {
        parts.add(part);
      }
    }
    return '/workspace${parts.isEmpty ? '' : '/${parts.join('/')}'}';
  }

  /// Reject symlinks rather than resolve guest absolute symlinks on the host.
  Future<File> resolve(String path) async {
    final virtual = normalize(path);
    await initialize();
    final canonicalRoot = await root.resolveSymbolicLinks();
    var current = canonicalRoot;
    for (final part in virtual.substring('/workspace'.length).split('/')) {
      if (part.isEmpty) continue;
      current = '$current/$part';
      if (await FileSystemEntity.type(current, followLinks: false) ==
          FileSystemEntityType.link) {
        throw const AgentFailure('workspace_symlink_not_allowed');
      }
    }
    return File(current);
  }

  T _at<T>(
    String path,
    T Function(WorkspaceDirectory, String?) action, {
    bool create = false,
  }) {
    final parts = normalize(path)
        .substring('/workspace'.length)
        .split('/')
        .where((s) => s.isNotEmpty)
        .toList();
    var directory = WorkspaceDirectory.openRoot(root.path);
    try {
      for (final part in parts.take(parts.isEmpty ? 0 : parts.length - 1)) {
        final next = directory.child(part, create: create);
        directory.close();
        directory = next;
      }
      return action(directory, parts.isEmpty ? null : parts.last);
    } finally {
      directory.close();
    }
  }

  Future<T> _serial<T>(Future<T> Function() run) {
    final future = _tail.then((_) => run());
    _tail = future.then<void>((_) {}, onError: (Object _, StackTrace _) {});
    return future;
  }

  Map<String, dynamic> _metadata(String path, int bytes) => {
    'path': normalize(path),
    'bytes': bytes,
    'url': Uri(scheme: 'nova-file', host: '', path: normalize(path)).toString(),
  };

  Future<Map<String, dynamic>> write(String path, String content) =>
      _serial(() async {
        final bytes = utf8.encode(content);
        if (bytes.length > 1024 * 1024) {
          throw const AgentFailure('file_write_too_large');
        }
        await resolve(path);
        _at(path, (directory, name) {
          if (name == null) throw const AgentFailure('not_regular_file');
          directory.atomicWrite(name, bytes);
        }, create: true);
        return _metadata(path, bytes.length);
      });

  Future<Map<String, dynamic>> read(
    String path, {
    int offset = 1,
    int limit = 2000,
  }) async {
    if (offset < 1 || limit < 1 || limit > 2000) {
      throw const AgentFailure('invalid_read_range');
    }
    await resolve(
      path,
    ); // Preflight only; held descriptors authorize all IO below.
    final opened = _at<Object>(path, (directory, name) {
      WorkspaceDirectory? listing;
      if (name == null) {
        return {
          'path': normalize(path),
          ...directory.listing(offset: offset, limit: limit),
        };
      }
      try {
        listing = directory.child(name);
      } on FileSystemException catch (error) {
        if (error.osError?.errorCode != 20) rethrow;
      }
      if (listing != null) {
        try {
          return {
            'path': normalize(path),
            ...listing.listing(offset: offset, limit: limit),
          };
        } finally {
          listing.close();
        }
      }
      return directory.file(name);
    });
    if (opened is Map<String, dynamic>) return opened;
    final input = opened as WorkspaceFile;
    final length = input.length;
    final bytes = <int>[];
    var line = 1, consumed = 0;
    var done = false;
    var batches = 0;
    try {
      while (!done) {
        final chunk = input.read(32768);
        if (chunk.isEmpty) break;
        for (final byte in chunk) {
          if (line >= offset && bytes.length == readBytes) {
            done = true;
            break;
          }
          consumed++;
          if (line >= offset) bytes.add(byte);
          if (byte == 10) line++;
          if (line >= offset + limit) {
            done = true;
            break;
          }
        }
        if (!done && ++batches % 8 == 0) {
          // Keep the inode open while yielding; never reopen through a path.
          await Future<void>.delayed(Duration.zero);
        }
      }
    } finally {
      input.close();
    }
    final truncated = consumed < length;
    String? content;
    if (!bytes.contains(0)) {
      // A byte budget may split the final UTF-8 sequence; don't split a scalar.
      for (
        var trim = 0;
        trim <= (truncated ? min(3, bytes.length) : 0);
        trim++
      ) {
        try {
          content = utf8.decode(bytes.sublist(0, bytes.length - trim));
          break;
        } on FormatException {
          /* A binary file is returned as metadata only. */
        }
      }
    }
    return {
      ..._metadata(path, length),
      'type': 'file',
      'offset': offset,
      'binary': content == null,
      'content': ?content,
      'truncated': truncated,
    };
  }

  Future<Map<String, dynamic>> edit(
    String path,
    String oldString,
    String newString, {
    bool replaceAll = false,
  }) => _serial(() async {
    if (oldString.isEmpty) throw const AgentFailure('empty_edit_match');
    await resolve(path);
    return _at(path, (directory, name) {
      if (name == null) throw const AgentFailure('not_regular_file');
      final input = directory.file(name);
      late String source;
      try {
        if (input.length > 1024 * 1024) {
          throw const AgentFailure('file_edit_too_large');
        }
        source = utf8.decode(input.readAll(1024 * 1024));
      } finally {
        input.close();
      }
      final matches = oldString.allMatches(source).length;
      if (matches == 0) throw const AgentFailure('edit_match_not_found');
      if (matches > 1 && !replaceAll) {
        throw const AgentFailure('edit_match_ambiguous');
      }
      final result = source.replaceAll(oldString, newString);
      final bytes = utf8.encode(result);
      if (bytes.length > 1024 * 1024) {
        throw const AgentFailure('file_edit_too_large');
      }
      directory.atomicWrite(name, bytes);
      return {..._metadata(path, bytes.length), 'replacements': matches};
    });
  });

  Future<void> migrateLegacy(File legacy) => _serial(() async {
    if (!await legacy.exists()) return;
    final legacyDirectory = WorkspaceDirectory.openRoot(legacy.parent.path);
    late dynamic parsed;
    try {
      final input = legacyDirectory.file(legacy.uri.pathSegments.last);
      try {
        parsed = jsonDecode(utf8.decode(input.readAll(64 * 1024 * 1024)));
      } finally {
        input.close();
      }
    } finally {
      legacyDirectory.close();
    }
    if (parsed is! Map ||
        parsed['schema_version'] != 1 ||
        parsed['items'] is! Map) {
      throw const AgentFailure('invalid_legacy_artifacts');
    }
    // This sidecar is beside the legacy store in app support, outside the
    // guest workspace. A missing destination after success means the user
    // deleted/moved it, not that we should restore the old source again.
    final checkpoint = File('${legacy.path}.migration-v1.json');
    final completed = <String>{};
    if (await checkpoint.exists()) {
      final saved = jsonDecode(await checkpoint.readAsString());
      if (saved is! Map ||
          saved['schema_version'] != 1 ||
          saved['migrated_ids'] is! List ||
          (saved['migrated_ids'] as List).any((id) => id is! String)) {
        throw const AgentFailure('invalid_legacy_migration_checkpoint');
      }
      completed.addAll((saved['migrated_ids'] as List).cast<String>());
    }
    for (final entry in (parsed['items'] as Map).entries) {
      final id = entry.key;
      if (id is! String ||
          !RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(id) ||
          entry.value is! Map ||
          entry.value['html'] is! String) {
        throw const AgentFailure('invalid_legacy_artifact');
      }
      if (completed.contains(id)) continue;
      final path = 'artifacts/$id/index.html';
      await resolve(path);
      _at(path, (directory, name) {
        if (directory.exists(name!)) return;
        final bytes = utf8.encode(entry.value['html'] as String);
        directory.atomicWrite(name, bytes, onlyIfMissing: true);
      }, create: true);
      completed.add(id);
      final metadata = WorkspaceDirectory.openRoot(legacy.parent.path);
      try {
        metadata.atomicWrite(
          checkpoint.uri.pathSegments.last,
          utf8.encode(
            jsonEncode({
              'schema_version': 1,
              'migrated_ids': completed.toList(),
            }),
          ),
        );
      } finally {
        metadata.close();
      }
    }
  });

  String previewPath(String pathOrUrl) {
    final uri = Uri.tryParse(pathOrUrl);
    if (uri?.scheme == 'nova-file' &&
        uri!.host.isEmpty &&
        !uri.hasQuery &&
        !uri.hasFragment) {
      return normalize(uri.path);
    }
    if (uri?.scheme == 'nova-artifact' &&
        uri!.path.isEmpty &&
        !uri.hasQuery &&
        !uri.hasFragment) {
      pathOrUrl = uri.host;
    } else if (uri?.hasScheme == true) {
      throw const AgentFailure('invalid_preview_url');
    }
    if (RegExp(r'^[a-zA-Z0-9_-]+$').hasMatch(pathOrUrl)) {
      return '/workspace/artifacts/$pathOrUrl/index.html';
    }
    return normalize(pathOrUrl);
  }

  Future<String> _browserSource(String path, int maxBytes) async {
    await resolve(path);
    return _at(path, (directory, name) {
      if (name == null) throw const AgentFailure('not_regular_file');
      final input = directory.file(name);
      try {
        if (input.length > maxBytes) {
          throw const AgentFailure('browser_file_too_large');
        }
        return utf8.decode(input.readAll(maxBytes));
      } finally {
        input.close();
      }
    });
  }

  Future<Map<String, dynamic>> inspectFiles(
    String path,
    String scriptPath,
  ) async {
    if (inspect == null) throw const AgentFailure('browser_unavailable');
    final html = await _browserSource(path, 256 * 1024);
    final script = await _browserSource(scriptPath, 8000);
    final result = await inspect!(
      html,
      script,
    ).timeout(const Duration(seconds: 20));
    if (utf8.encode(jsonEncode(result)).length > 32768) {
      throw const AgentFailure('browser_result_too_large');
    }
    return {'path': normalize(path), ...result};
  }

  Future<void> openPreview(String pathOrUrl) async {
    if (present == null) throw const AgentFailure('browser_unavailable');
    final path = previewPath(pathOrUrl);
    final html = await _browserSource(path, 256 * 1024);
    await present!(path.split('/').last, html);
  }
}
