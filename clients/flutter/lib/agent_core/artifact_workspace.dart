import 'dart:convert';
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import '../personal/life_reducer.dart';
import '../personal/local_life.dart';
import 'model_client.dart';

typedef ArtifactInspection =
    Future<Map<String, dynamic>> Function(String html, String script);

/// The workspace owns its documents; model arguments never become host paths.
class ArtifactWorkspace {
  ArtifactWorkspace(this.persistence, {this.inspect, this.present});
  final LifePersistence persistence;
  final ArtifactInspection? inspect;
  final Future<void> Function(String title, String html)? present;
  Map<String, dynamic> _data = {
    'schema_version': 1,
    'items': <String, dynamic>{},
    'receipts': <String, dynamic>{},
  };
  static const channel = MethodChannel('nova/artifacts/v1');
  static bool supportsPlatform(TargetPlatform platform) =>
      platform == TargetPlatform.iOS || platform == TargetPlatform.android;
  static Future<ArtifactWorkspace> open() async {
    final root = await getApplicationSupportDirectory();
    final store = ArtifactWorkspace(
      FileLifePersistence(File('${root.path}/local-artifacts-v1.json')),
      inspect: (html, script) async => Map<String, dynamic>.from(
        await channel.invokeMapMethod<String, dynamic>('inspect', {
              'html': html,
              'script': script,
            }) ??
            {},
      ),
      present: (title, html) async {
        await channel.invokeMethod('open', {'title': title, 'html': html});
      },
    );
    await store.load();
    return store;
  }

  Future<void> load() async {
    final raw = await persistence.read();
    if (raw == null) return;
    final data = jsonDecode(raw);
    if (data is! Map ||
        data['schema_version'] != 1 ||
        data['items'] is! Map ||
        data['receipts'] is! Map) {
      throw const FormatException('invalid_artifact_store');
    }
    _data = Map<String, dynamic>.from(data);
  }

  Map<String, dynamic> _item(String id) {
    final item = (_data['items'] as Map)[id];
    if (item is! Map) throw const AgentFailure('artifact_not_found');
    return copyJson(Map<String, dynamic>.from(item));
  }

  Map<String, dynamic> _metadata(Map<String, dynamic> item) => {
    for (final k in ['id', 'title', 'version', 'updated_at']) k: item[k],
    'bytes': utf8.encode(item['html'] as String).length,
    'url': 'nova-artifact://${item['id']}',
  };
  List<Map<String, dynamic>> list() => (_data['items'] as Map).values
      .map((e) => _metadata(Map<String, dynamic>.from(e)))
      .toList();
  Map<String, dynamic> read(String id) => _item(id);
  Future<void> _save(Map<String, dynamic> next) async {
    await persistence.write(jsonEncode(next));
    _data = next;
  }

  Future<Map<String, dynamic>> write(
    Map<String, dynamic> input,
    String operationId,
  ) async {
    final title = input['title'], html = input['html'];
    if (title is! String ||
        title.trim().isEmpty ||
        title.length > 200 ||
        html is! String ||
        html.trim().isEmpty ||
        utf8.encode(html).length > 256 * 1024) {
      throw const AgentFailure('invalid_artifact');
    }
    final fingerprint = lifeFingerprint(input),
        prior = (_data['receipts'] as Map)[operationId];
    if (prior != null) {
      if (prior['fingerprint'] != fingerprint) {
        throw const AgentFailure('artifact_operation_conflict');
      }
      return copyJson(Map<String, dynamic>.from(prior['result']));
    }
    final id = input['id'] as String? ?? lifeId(operationId);
    final old = input['id'] == null ? null : _item(id);
    if (old != null && input['expected_version'] != old['version']) {
      throw const AgentFailure('artifact_version_conflict');
    }
    if (old == null && input['expected_version'] != null) {
      throw const AgentFailure('artifact_version_conflict');
    }
    if (old == null && (_data['items'] as Map).length >= 100) {
      throw const AgentFailure('artifact_capacity');
    }
    final item = <String, dynamic>{
      'id': id,
      'title': title.trim(),
      'html': html,
      'version': (old?['version'] as int? ?? 0) + 1,
      'updated_at': DateTime.now().toUtc().toIso8601String(),
    };
    final result = {'artifact': _metadata(item)};
    final next = copyJson(_data);
    next['items'][id] = item;
    next['receipts'][operationId] = {
      'fingerprint': fingerprint,
      'result': result,
    };
    await _save(next);
    return result;
  }

  Future<Map<String, dynamic>> test(String id, String script) async {
    final item = _item(id);
    if (inspect == null) {
      throw const AgentFailure('artifact_testing_unavailable');
    }
    if (script.length > 8000) {
      throw const AgentFailure('artifact_test_too_large');
    }
    final result = await inspect!(
      item['html'] as String,
      script,
    ).timeout(const Duration(seconds: 20));
    if (utf8.encode(jsonEncode(result)).length > 32768) {
      throw const AgentFailure('artifact_test_result_too_large');
    }
    final next = copyJson(_data);
    if (next['items'][id]['version'] != item['version']) {
      throw const AgentFailure('artifact_version_conflict');
    }
    next['items'][id]['test'] = {'version': item['version'], ...result};
    await _save(next);
    return {'artifact_id': id, 'version': item['version'], ...result};
  }

  Future<void> openPreview(String id) async {
    final item = _item(id);
    if (present == null) {
      throw const AgentFailure('artifact_preview_unavailable');
    }
    await present!(item['title'] as String, item['html'] as String);
  }
}
