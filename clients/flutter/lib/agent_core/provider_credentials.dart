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
  });
  final String id, endpoint, label, key;
  Map<String, dynamic> toJson() => {
    'id': id,
    'endpoint': endpoint,
    'label': label,
    'key': key,
  };
}

/// API keys only. The captured secure keys never follow a later Space switch.
class ProviderCredentials {
  ProviderCredentials({this.storage = const FlutterSecureStorage()})
    : _scopedKey = SpaceStorage.secureKey(storageKey),
      _modelKey = SpaceStorage.secureKey('nova.dart-model.v1'),
      _voiceKey = SpaceStorage.secureKey('nova.voice.v1');
  final FlutterSecureStorage storage;
  final String _scopedKey, _modelKey, _voiceKey;
  static const storageKey = 'nova.provider-credentials.v1';
  static final Map<String, Future<void>> _tails = {};

  Future<T> _run<T>(Future<T> Function(List<ProviderCredential>) body) {
    final old = _tails[_scopedKey];
    Future<T> execute() async {
      try {
        final entries = await _load();
        await _migrate(entries);
        return await body(entries);
      } catch (_) {
        throw const AgentFailure('provider_credentials_unavailable');
      }
    }

    final result = old == null ? execute() : old.then((_) => execute());
    final tail = result.then<void>((_) {}, onError: (Object _) {});
    _tails[_scopedKey] = tail;
    unawaited(
      tail.whenComplete(() {
        if (identical(_tails[_scopedKey], tail)) _tails.remove(_scopedKey);
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
    if (duplicate != null) return duplicate;
    final value = ProviderCredential(
      id: id ?? newSpaceId(),
      endpoint: scope,
      label: label?.trim().isNotEmpty == true
          ? label!.trim()
          : old?.label ?? ModelPreset.forEndpoint(scope)?.name ?? scope,
      key: secret,
    );
    if (old != null) {
      entries[entries.indexOf(old)] = value;
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

  Future<List<ProviderCredential>> _load() async {
    final raw = await storage.read(key: _scopedKey);
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

  Future<void> _write(List<ProviderCredential> entries) => storage.write(
    key: _scopedKey,
    value: jsonEncode({
      'version': 1,
      'credentials': entries.map((e) => e.toJson()).toList(),
    }),
  );

  Future<void> _migrate(List<ProviderCredential> entries) async {
    final rewrites = <String, Map<String, dynamic>>{};
    var registryChanged = false;
    for (final configKey in [_modelKey, _voiceKey]) {
      final raw = await storage.read(key: configKey);
      if (raw == null) continue;
      Map<String, dynamic> value;
      try {
        value = jsonDecode(raw) as Map<String, dynamic>;
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

      if (configKey == _modelKey && value['endpoint'] is String) {
        migrate(value, '对话');
      } else if (configKey == _voiceKey && value['version'] == 1) {
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
