import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:xml/xml.dart';
import 'package:xml/xml_events.dart';
import 'local_life.dart';

class NewsSource {
  const NewsSource(this.id, this.name, this.url, this.language);
  final String id, name, url, language;
}

/// Same public sources as the desktop NewsService. No account or model needed.
const publicNewsSources = [
  NewsSource('bbc', 'BBC News', 'https://feeds.bbci.co.uk/news/rss.xml', 'en'),
  NewsSource(
    'guardian',
    'The Guardian · Technology',
    'https://www.theguardian.com/uk/technology/rss',
    'en',
  ),
  NewsSource('ithome', 'IT之家', 'https://www.ithome.com/rss/', 'zh-CN'),
  NewsSource('sspai', '少数派', 'https://sspai.com/feed', 'zh-CN'),
  NewsSource(
    'solidot',
    'Solidot',
    'https://www.solidot.org/index.rss',
    'zh-CN',
  ),
  NewsSource('36kr', '36氪', 'https://www.36kr.com/feed', 'zh-CN'),
];
String _language(String value) =>
    value.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
String _digest(String value) => sha256.convert(utf8.encode(value)).toString();

String? newsArticleUrl(String value) {
  final uri = Uri.tryParse(value.trim());
  if (uri == null ||
      value.length > 4096 ||
      !['http', 'https'].contains(uri.scheme) ||
      uri.userInfo.isNotEmpty ||
      uri.host.isEmpty ||
      !uri.host.contains('.') ||
      uri.host.endsWith('.') ||
      uri.host.toLowerCase() == 'localhost' ||
      uri.host.toLowerCase().endsWith('.localhost') ||
      uri.host.toLowerCase().endsWith('.local') ||
      InternetAddress.tryParse(uri.host) != null ||
      RegExp(r'^\d+(?:\.\d+)*$').hasMatch(uri.host)) {
    return null;
  }
  final query = <String, dynamic>{
    for (final entry in uri.queryParametersAll.entries)
      if (!entry.key.toLowerCase().startsWith('utm_')) entry.key: entry.value,
  };
  return uri
      .replace(
        queryParameters: query.isEmpty ? null : query,
        query: query.isEmpty ? '' : null,
        fragment: '',
      )
      .toString()
      .replaceFirst(RegExp(r'[?#]+$'), '');
}

String _plain(String value, int limit) {
  final plain = value
      .replaceAll(RegExp(r'<[^>]*>'), ' ')
      .replaceAllMapped(
        RegExp(r'&(#x[0-9a-fA-F]+|#[0-9]+|nbsp|amp|lt|gt|quot|apos);'),
        (match) {
          final entity = match[1]!;
          if (entity.startsWith('#')) {
            final code = int.tryParse(
              entity.substring(entity.startsWith('#x') ? 2 : 1),
              radix: entity.startsWith('#x') ? 16 : 10,
            );
            return code != null &&
                    code > 0 &&
                    code <= 0x10ffff &&
                    !(code >= 0xd800 && code <= 0xdfff)
                ? String.fromCharCode(code)
                : '';
          }
          return {
            'nbsp': ' ',
            'amp': '&',
            'lt': '<',
            'gt': '>',
            'quot': '"',
            'apos': "'",
          }[entity]!;
        },
      )
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  return String.fromCharCodes(plain.runes.take(limit));
}

DateTime? _published(String raw, DateTime now) {
  DateTime? date = DateTime.tryParse(raw);
  if (date == null) {
    try {
      date = HttpDate.parse(raw);
    } catch (_) {
      // RSS commonly uses numeric offsets, which HttpDate intentionally omits.
      final match = RegExp(
        r'^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+([+-])(\d{2})(\d{2})$',
      ).firstMatch(raw.trim());
      if (match != null) {
        const months = [
          'jan',
          'feb',
          'mar',
          'apr',
          'may',
          'jun',
          'jul',
          'aug',
          'sep',
          'oct',
          'nov',
          'dec',
        ];
        final month = months.indexOf(match[2]!.toLowerCase()) + 1;
        if (month > 0) {
          final offset =
              (int.parse(match[8]!) * 60 + int.parse(match[9]!)) *
              (match[7] == '+' ? 1 : -1);
          date = DateTime.utc(
            int.parse(match[3]!),
            month,
            int.parse(match[1]!),
            int.parse(match[4]!),
            int.parse(match[5]!),
            int.parse(match[6] ?? '0'),
          ).subtract(Duration(minutes: offset));
        }
      }
    }
  }
  return date != null && !date.isAfter(now.add(const Duration(minutes: 5)))
      ? date.toUtc()
      : null;
}

List<Map<String, dynamic>> parseNewsFeed(
  String xml,
  NewsSource source,
  DateTime now,
) {
  if (utf8.encode(xml).length > 1024 * 1024) {
    throw const FormatException('feed_too_large');
  }
  try {
    var depth = 0;
    for (final event in parseEvents(xml)) {
      if (event is XmlDoctypeEvent) throw const FormatException('feed_doctype');
      if (event is XmlStartElementEvent && !event.isSelfClosing && ++depth > 32) {
        throw const FormatException('feed_depth');
      }
      if (event is XmlEndElementEvent) depth--;
    }
    final document = XmlDocument.parse(xml);
    if (![
      'rss',
      'feed',
      'rdf',
    ].contains(document.rootElement.name.local.toLowerCase())) {
      throw const FormatException('invalid_feed');
    }
    final rows = <String, Map<String, dynamic>>{};
    for (final element
        in document.descendants
            .whereType<XmlElement>()
            .where(
              (e) => ['item', 'entry'].contains(e.name.local.toLowerCase()),
            )
            .take(200)) {
      String field(List<String> keys) {
        for (final key in keys) {
          final found = element.childElements
              .where((e) => e.name.local.toLowerCase() == key)
              .firstOrNull;
          if (found != null) return found.innerText;
        }
        return '';
      }

      final links = element.childElements.where((e) => e.name.local == 'link');
      final link = links
          .where(
            (e) =>
                e.getAttribute('href') != null &&
                [null, '', 'alternate'].contains(e.getAttribute('rel')),
          )
          .firstOrNull;
      final url = newsArticleUrl(link?.getAttribute('href') ?? field(['link']));
      final title = _plain(field(['title']), 300);
      if (url == null || title.isEmpty) continue;
      final summary = _plain(
        field(['description', 'summary', 'encoded', 'content']),
        1500,
      );
      final id = _digest(url);
      rows[id] = {
        'id': id,
        'source_id': source.id,
        'source_name': source.name,
        'title': title,
        'summary': summary,
        'url': url,
        'published_at': _published(
          field(['pubdate', 'published', 'updated', 'date']),
          now,
        )?.toIso8601String(),
        'first_seen': now.toUtc().toIso8601String(),
        'content_hash': _digest('$title\n$summary'),
      };
    }
    return rows.values.toList();
  } on FormatException {
    rethrow;
  } catch (_) {
    throw const FormatException('invalid_feed');
  }
}

/// Device-owned public news; it never reads or writes personal Profile data.
class LocalNews extends ChangeNotifier {
  LocalNews(
    this.persistence, {
    List<NewsSource>? sources,
    String language = 'zh-CN',
    this.fetcher,
    DateTime Function()? now,
  }) : sources = sources ?? publicNewsSources,
       _languageCode = _language(language),
       _now = now ?? DateTime.now;
  final LifePersistence persistence;
  final List<NewsSource> sources;
  final Future<String> Function(NewsSource)? fetcher;
  final DateTime Function() _now;
  static const refreshInterval = Duration(minutes: 15);
  String _languageCode;
  final _clients = <HttpClient>{};
  Map<String, dynamic> _state = {
    'version': 1,
    'items': <dynamic>[],
    'sources': <String, dynamic>{},
  };
  Future<void>? _run;
  Future<void> _tail = Future.value();
  Timer? _timer;
  bool ready = false, _disposed = false, _foreground = false;
  String? error;
  List<NewsSource> get _sources =>
      sources.where((s) => s.language == _languageCode).toList();
  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> open() async {
    if (ready) return;
    try {
      final raw = await persistence.read();
      if (raw != null) {
        if (utf8.encode(raw).length > 4 * 1024 * 1024) {
          throw const FormatException('cache_too_large');
        }
        final parsed = jsonDecode(raw);
        if (parsed is! Map ||
            parsed['version'] != 1 ||
            parsed['items'] is! List ||
            parsed['sources'] is! Map ||
            (parsed['items'] as List).length > 500) {
          throw const FormatException('invalid_cache');
        }
        for (final item in parsed['items'] as List) {
          if (item is! Map ||
              [
                'id',
                'source_id',
                'title',
                'summary',
                'url',
                'first_seen',
                'content_hash',
              ].any((k) => item[k] is! String) ||
              newsArticleUrl(item['url']) == null ||
              item['saved'] is! bool ||
              item['read'] is! bool) {
            throw const FormatException('invalid_cache');
          }
        }
        _state = Map<String, dynamic>.from(parsed);
      }
    } catch (_) {
      error = 'cache_unavailable';
    }
    if (_disposed) return;
    ready = true;
    _notify();
  }

  Future<void> _change(void Function(Map<String, dynamic>) change) {
    final next = _tail.then((_) async {
      if (_disposed) return;
      final state = jsonDecode(jsonEncode(_state)) as Map<String, dynamic>;
      change(state);
      await persistence.write(jsonEncode(state));
      if (_disposed) return;
      _state = state;
      _notify();
    });
    _tail = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  Future<String> _fetch(NewsSource source) async {
    if (fetcher != null) {
      return fetcher!(source).timeout(const Duration(seconds: 20));
    }
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 10);
    _clients.add(client);
    try {
      return await (() async {
        final request = await client.getUrl(Uri.parse(source.url));
        request.followRedirects = false;
        request.headers.set(
          'Accept',
          'application/rss+xml, application/atom+xml, application/xml, text/xml',
        );
        request.headers.set('User-Agent', 'NovaPersonalAgent-News/0.3');
        final response = await request.close();
        if (response.statusCode != 200 ||
            response.headers.contentType?.mimeType == 'text/html') {
          throw const FormatException('source_unavailable');
        }
        if (response.contentLength > 1024 * 1024) {
          throw const FormatException('feed_too_large');
        }
        final bytes = <int>[];
        await for (final chunk in response) {
          bytes.addAll(chunk);
          if (bytes.length > 1024 * 1024) {
            throw const FormatException('feed_too_large');
          }
        }
        return utf8.decode(bytes);
      })().timeout(const Duration(seconds: 20));
    } finally {
      client.close(force: true);
      _clients.remove(client);
    }
  }

  Future<void> setLanguage(String value) async {
    final next = _language(value);
    if (next == _languageCode) return;
    _languageCode = next;
    _notify();
    if (_foreground) {
      await _run;
      await _refreshIfStale();
    }
  }

  Future<void> setForeground(bool value) async {
    if (_disposed) return;
    _foreground = value;
    _timer?.cancel();
    _timer = null;
    if (!value) return;
    _timer = Timer.periodic(refreshInterval, (_) {
      unawaited(_refreshIfStale());
    });
    await _refreshIfStale();
  }

  Future<void> _refreshIfStale() async {
    if (_disposed || !_foreground || !ready) return;
    final statuses = _state['sources'] as Map;
    if (_sources.any((s) {
      final status = statuses[s.id];
      final attempted = status is Map
          ? DateTime.tryParse('${status['last_attempt']}')
          : null;
      return attempted == null ||
          _now().difference(attempted) >= refreshInterval;
    })) {
      await refresh();
    }
  }

  Future<void> refresh() {
    if (_disposed || !ready) return Future.value();
    return _run ??= _refresh().whenComplete(() {
      _run = null;
      _notify();
    });
  }

  Future<void> _refresh() async {
    // Yield so the single-flight Future is installed before notifying listeners.
    await Future<void>.delayed(Duration.zero);
    if (_disposed) return;
    _notify();
    error = null;
    await Future.wait(
      _sources.map((source) async {
        List<Map<String, dynamic>>? rows;
        String? failure;
        try {
          rows = parseNewsFeed(await _fetch(source), source, _now());
        } catch (_) {
          failure = 'source_unavailable';
        }
        if (_disposed) return;
        try {
          await _change((state) {
            final statuses = state['sources'] as Map;
            final prior = statuses[source.id] as Map? ?? {};
            statuses[source.id] = {
              'last_attempt': _now().toUtc().toIso8601String(),
              'last_success': failure == null
                  ? _now().toUtc().toIso8601String()
                  : prior['last_success'],
              'error': failure,
              'count': rows?.length ?? 0,
            };
            if (rows == null) return;
            final items = (state['items'] as List).cast<Map>();
            for (final row in rows) {
              final old = items
                  .where((item) => item['id'] == row['id'])
                  .firstOrNull;
              if (old != null) {
                old.addAll(<String, dynamic>{
                  ...row,
                  'first_seen': old['first_seen'],
                });
              } else {
                items.add({
                  ...row,
                  'saved': false,
                  'read': false,
                  'ranking': null,
                });
              }
            }
            items.sort(_compare);
            final saved = items.where((a) => a['saved'] == true).toList();
            state['items'] = [
              ...saved,
              ...items
                  .where((a) => a['saved'] != true)
                  .take(500 - saved.length),
            ];
          });
        } catch (_) {
          error = 'cache_unavailable';
          _notify();
        }
      }),
    );
  }

  static int _compare(Map a, Map b) {
    final order = '${b['published_at'] ?? b['first_seen']}'.compareTo(
      '${a['published_at'] ?? a['first_seen']}',
    );
    return order != 0 ? order : '${a['id']}'.compareTo('${b['id']}');
  }

  Future<void> action(Map<String, dynamic> params) async {
    if (!['read', 'save'].contains(params['action']) ||
        params['id'] is! String ||
        params['value'] is! bool) {
      throw const FormatException('invalid_news_action');
    }
    await _change((state) {
      final items = state['items'] as List;
      final row = items
          .cast<Map>()
          .where((item) => item['id'] == params['id'])
          .firstOrNull;
      if (row == null) throw StateError('article_not_found');
      final key = params['action'] == 'save' ? 'saved' : 'read';
      if (key == 'saved' &&
          params['value'] == true &&
          row[key] != true &&
          items.where((item) => item['saved'] == true).length >= 100) {
        throw StateError('saved_limit_100');
      }
      row[key] = params['value'];
    });
  }

  Map<String, dynamic> snapshot() {
    final allowed = _sources.map((s) => s.id).toSet();
    final items =
        (_state['items'] as List)
            .cast<Map>()
            .where((a) => allowed.contains(a['source_id']))
            .toList()
          ..sort(_compare);
    final statuses = _state['sources'] as Map;
    return jsonDecode(
          jsonEncode({
            'enabled': true,
            'mode': 'timeline',
            'refreshing': _run != null,
            'error': error,
            'total': items.length,
            'items': items.take(50).toList(),
            'saved':
                (_state['items'] as List)
                    .where((a) => a['saved'] == true)
                    .toList()
                  ..sort((a, b) => _compare(a as Map, b as Map)),
            'sources': _sources
                .map(
                  (s) => {
                    'id': s.id,
                    'name': s.name,
                    'url': s.url,
                    ...?(statuses[s.id] as Map?),
                  },
                )
                .toList(),
          }),
        )
        as Map<String, dynamic>;
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    for (final client in _clients.toList()) {
      client.close(force: true);
    }
    _clients.clear();
    super.dispose();
  }
}
