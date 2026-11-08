import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';

const _url = 'https://api.deepnovacore.com/nova/common/v1/ideas';
const _maxBytes = 64 * 1024;
const _timeout = Duration(seconds: 4);
final _idPattern = RegExp(r'^[a-z0-9-]{1,64}$');

typedef SharedIdea = ({String id, String text});

bool emptyIdeaOpening(List<dynamic> messages) {
  if (messages.isEmpty) return true;
  final first = messages.first;
  return messages.length == 1 &&
      first is Map &&
      first['role'] == 'assistant' &&
      (first['nova_welcome'] == true || first['origin'] == 'proactive');
}

bool _validText(Object? value) =>
    value is String &&
    value.trim().isNotEmpty &&
    value.length <= 180 &&
    !value.contains(RegExp(r'[\r\n]'));

Future<String> _readCatalog(String language) async {
  final client = HttpClient()..connectionTimeout = _timeout;
  try {
    return await (() async {
      final request = await client.getUrl(Uri.parse('$_url/$language.json'));
      request.followRedirects = false;
      final response = await request.close();
      if (response.statusCode != HttpStatus.ok) {
        throw const FormatException('Ideas unavailable');
      }
      final bytes = BytesBuilder(copy: false);
      await for (final chunk in response) {
        if (bytes.length + chunk.length > _maxBytes) {
          throw const FormatException('Ideas catalog too large');
        }
        bytes.add(chunk);
      }
      return utf8.decode(bytes.takeBytes());
    })().timeout(_timeout);
  } finally {
    client.close(force: true);
  }
}

class SharedIdeas extends ChangeNotifier {
  SharedIdeas({Future<String> Function(String)? read})
    : _read = read ?? _readCatalog;

  final Future<String> Function(String) _read;
  final _samples = <String, List<SharedIdea>>{};
  final _pending = <String, Future<void>>{};
  List<SharedIdea> topics(String language) => _samples[language] ?? const [];

  Future<void> load(String language) {
    if (_samples.containsKey(language) || !['zh', 'en'].contains(language)) {
      return Future.value();
    }
    return _pending[language] ??= _load(language).whenComplete(() {
      _pending.remove(language);
    });
  }

  Future<void> _load(String language) async {
    try {
      final raw = await _read(language);
      if (utf8.encode(raw).length > _maxBytes) return;
      final data = jsonDecode(raw);
      if (data is! Map ||
          data['version'] != 1 ||
          data['language'] != language ||
          data['topics'] is! List) {
        return;
      }
      final unique = <String, SharedIdea>{};
      for (final row in data['topics'] as List) {
        if (row is! Map) return;
        final id = row['id'], text = row['text'];
        if (id is! String || !_idPattern.hasMatch(id) || !_validText(text)) {
          return;
        }
        unique.putIfAbsent(id, () => (id: id, text: (text as String).trim()));
      }
      final shuffled = unique.values.toList()..shuffle();
      _samples[language] = List.unmodifiable(shuffled.take(6));
    } catch (_) {
      // A later visit to either surface can retry.
      return;
    }
    notifyListeners();
  }
}
