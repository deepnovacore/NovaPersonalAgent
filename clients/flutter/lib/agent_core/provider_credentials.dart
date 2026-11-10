import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../space/space_storage.dart';
import 'model_client.dart';
import 'model_presets.dart';

class ProviderCredential {
  const ProviderCredential({
    required this.id,
    required this.endpoint,
    required this.label,
    required this.key,
    this.protocol,
  });
  final String id, endpoint, label, key;

  /// The API this endpoint was saved with (a custom endpoint may speak
  /// Responses). Absent in older records, which read as the preset's protocol
  /// or Chat Completions.
  final ModelProtocol? protocol;
  Map<String, dynamic> toJson() => {
    'id': id,
    'endpoint': endpoint,
    'label': label,
    'key': key,
    if (protocol != null) 'protocol': protocol!.name,
  };
}

/// Device-wide API keys; model selections and OAuth accounts stay Space-scoped.
class ProviderCredentials {
  ProviderCredentials({this.storage = const FlutterSecureStorage()});
  final FlutterSecureStorage storage;
  static const storageKey = 'nova.provider-credentials.v1';
  static final Map<String, Future<void>> _tails = {};

  Future<T> _run<T>(Future<T> Function(List<ProviderCredential>) body) {
    final old = _tails[storageKey];
    Future<T> execute() async {
      try {
        final records = await storage.readAll();
        final entries = _load(records[storageKey]);
        await _migrateRegistries(entries, records);
        await _migrate(entries, records);
        return await body(entries);
      } catch (_) {
        throw const AgentFailure('provider_credentials_unavailable');
      }
    }

    final result = old == null ? execute() : old.then((_) => execute());
    final tail = result.then<void>((_) {}, onError: (Object _) {});
    _tails[storageKey] = tail;
    unawaited(
      tail.whenComplete(() {
        if (identical(_tails[storageKey], tail)) _tails.remove(storageKey);
      }),
    );
    return result;
  }

  /// Only known official routes share a credential; custom paths remain exact.
  static String scopeForEndpoint(String endpoint) {
    final text = endpoint.trim();
    final uri = Uri.tryParse(text);
    final host = uri?.host.replaceAll('[', '').replaceAll(']', '');
    final loopback =
        host == 'localhost' ||
        (host != null && InternetAddress.tryParse(host)?.isLoopback == true);
    if (uri == null ||
        uri.host.isEmpty ||
        uri.authority.contains('@') ||
        uri.hasQuery ||
        uri.hasFragment ||
        text.length > 4096 ||
        RegExp(r'\s').hasMatch(text) ||
        !(['https', 'wss'].contains(uri.scheme) ||
            (loopback && ['http', 'ws'].contains(uri.scheme)))) {
      throw const AgentFailure('invalid_provider_endpoint');
    }
    final normalized = uri
        .replace(path: uri.path.replaceFirst(RegExp(r'/+$'), ''))
        .toString();
    const aliases = {
      'wss://dashscope.aliyuncs.com/api-ws/v1/realtime':
          'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'wss://api.openai.com/v1/realtime': 'https://api.openai.com/v1',
      'wss://api.stepfun.com/v1/realtime': 'https://api.stepfun.com/v1',
      'https://generativelanguage.googleapis.com/v1beta':
          'https://generativelanguage.googleapis.com/v1beta/openai',
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent':
          'https://generativelanguage.googleapis.com/v1beta/openai',
    };
    return aliases[normalized] ??
        ModelPreset.forEndpoint(normalized)?.endpoint ??
        normalized;
  }

  Future<List<ProviderCredential>> list() =>
      _run((entries) async => List.unmodifiable(entries));
  Future<ProviderCredential?> get(String id) =>
      _run((entries) async => entries.where((e) => e.id == id).firstOrNull);
  Future<ProviderCredential?> resolve(
    String endpoint, {
    String? credentialId,
  }) => _run((entries) async {
    final scope = scopeForEndpoint(endpoint);
    if (credentialId != null) {
      final selected = entries.where((e) => e.id == credentialId).firstOrNull;
      return selected != null && selected.endpoint == scope ? selected : null;
    }
    return entries.where((e) => e.endpoint == scope).firstOrNull;
  });

  Future<ProviderCredential> save({
    String? id,
    required String endpoint,
    required String key,
    String? label,
    ModelProtocol? protocol,
  }) => _run((entries) async {
    final scope = scopeForEndpoint(endpoint);
    final old = entries.where((e) => e.id == id).firstOrNull;
    final secret = key.isEmpty && old?.endpoint == scope ? old!.key : key;
    _validateKey(secret);
    if (id != null && old == null) {
      throw const AgentFailure('provider_credential_missing');
    }
    final duplicate = id == null
        ? entries
              .where((e) => e.endpoint == scope && e.key == secret)
              .firstOrNull
        : null;
    // `chatgptResponses` is the ChatGPT account route (OAuth, a fixed
    // endpoint), never an API-key endpoint, so it is not recorded; the record
    // keeps whatever API it had before.
    final chosen = protocol == ModelProtocol.chatgptResponses ? null : protocol;
    if (duplicate != null && (chosen == null || duplicate.protocol == chosen)) {
      return duplicate;
    }
    final existing = old ?? duplicate;
    final value = ProviderCredential(
      id: existing?.id ?? newSpaceId(),
      endpoint: scope,
      label: label?.trim().isNotEmpty == true
          ? label!.trim()
          : existing?.label ?? ModelPreset.forEndpoint(scope)?.name ?? scope,
      key: secret,
      protocol:
          chosen ?? (existing?.endpoint == scope ? existing?.protocol : null),
    );
    if (existing != null) {
      entries[entries.indexOf(existing)] = value;
    } else {
      entries.add(value);
    }
    await _write(entries);
    return value;
  });

  Future<void> delete(String id) => _run((entries) async {
    entries.removeWhere((e) => e.id == id);
    await _write(entries);
  });

  static void _validateKey(String key) {
    if (key.trim().isEmpty ||
        key.length > 8192 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(key)) {
      throw const AgentFailure('invalid_provider_key');
    }
  }

  List<ProviderCredential> _load(String? raw) {
    if (raw == null) return [];
    final value = jsonDecode(raw) as Map;
    if (value['version'] != 1) throw const FormatException('invalid_registry');
    final ids = <String>{};
    return (value['credentials'] as List).map((v) {
      final entry = ProviderCredential(
        id: v['id'] as String,
        endpoint: v['endpoint'] as String,
        label: v['label'] as String,
        key: v['key'] as String,
        protocol: _storedProtocol(v['protocol']),
      );
      if (entry.id.isEmpty ||
          !ids.add(entry.id) ||
          scopeForEndpoint(entry.endpoint) != entry.endpoint) {
        throw const FormatException('invalid_registry');
      }
      _validateKey(entry.key);
      return entry;
    }).toList();
  }

  /// Unknown or missing values read as "not recorded", never as an error.
  static ModelProtocol? _storedProtocol(Object? name) =>
      name == ModelProtocol.chatCompletions.name
      ? ModelProtocol.chatCompletions
      : name == ModelProtocol.responses.name
      ? ModelProtocol.responses
      : null;

  Future<void> _write(List<ProviderCredential> entries) => storage.write(
    key: storageKey,
    value: jsonEncode({
      'version': 1,
      'credentials': entries.map((e) => e.toJson()).toList(),
    }),
  );

  Future<void> _migrateRegistries(
    List<ProviderCredential> entries,
    Map<String, String> records,
  ) async {
    final oldKeys = records.keys
        .where((key) => key.startsWith('$storageKey.space.'))
        .toList();
    if (oldKeys.isEmpty) return;
    for (final key in oldKeys) {
      for (final entry in _load(records[key])) {
        final existing = entries.where((e) => e.id == entry.id).firstOrNull;
        if (existing == null) {
          entries.add(entry);
        } else if (jsonEncode(existing.toJson()) !=
            jsonEncode(entry.toJson())) {
          throw const FormatException('conflicting_credential_id');
        }
      }
    }
    // Preserve IDs and different keys for the same endpoint; routes keep their references.
    await _write(entries);
    for (final key in oldKeys) {
      await storage.delete(key: key);
    }
  }

  Future<void> _migrate(
    List<ProviderCredential> entries,
    Map<String, String> records,
  ) async {
    final rewrites = <String, Map<String, dynamic>>{};
    var registryChanged = false;
    for (final record in records.entries) {
      final configKey = record.key;
      final model =
          configKey == 'nova.dart-model.v1' ||
          configKey.startsWith('nova.dart-model.v1.space.');
      final voice =
          configKey == 'nova.voice.v1' ||
          configKey.startsWith('nova.voice.v1.space.');
      if (!model && !voice) continue;
      Map<String, dynamic> value;
      try {
        value = jsonDecode(record.value) as Map<String, dynamic>;
      } catch (_) {
        continue;
      }
      var changed = false;
      void migrate(Map<String, dynamic> service, String label) {
        final secret = service['key'];
        if (secret is! String || secret.isEmpty) return;
        if (service['credentialId'] == null) {
          String scope;
          try {
            scope = scopeForEndpoint(service['endpoint'] as String);
            _validateKey(secret);
          } on AgentFailure {
            return; // Preserve malformed legacy secrets for explicit repair.
          }
          var credential = entries
              .where((e) => e.endpoint == scope && e.key == secret)
              .firstOrNull;
          if (credential == null) {
            credential = ProviderCredential(
              id: newSpaceId(),
              endpoint: scope,
              label:
                  '${ModelPreset.forEndpoint(scope)?.name ?? scope} · $label',
              key: secret,
            );
            entries.add(credential);
            registryChanged = true;
          }
          service['credentialId'] = credential.id;
        }
        service.remove('key');
        changed = true;
      }

      if (model && value['endpoint'] is String) {
        migrate(value, '对话');
      } else if (voice && value['version'] == 1) {
        for (final slot in ['integrated', 'asr', 'tts', 'fastLlm']) {
          final service = value[slot];
          if (service is Map<String, dynamic> &&
              service['endpoint'] is String) {
            migrate(
              service,
              {
                'integrated': '端到端语音',
                'asr': '语音识别',
                'tts': '语音合成',
                'fastLlm': '前脑',
              }[slot]!,
            );
          }
        }
      }
      if (changed) rewrites[configKey] = value;
    }
    // Never remove a legacy secret until the full registry write has succeeded.
    if (registryChanged) await _write(entries);
    for (final record in rewrites.entries) {
      await storage.write(key: record.key, value: jsonEncode(record.value));
    }
  }
}
