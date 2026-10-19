import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/local_news.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/personal/personal_store.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

const source = NewsSource(
  'fixture',
  'Public feed',
  'https://example.com/rss',
  'en',
);
const rss =
    '''<rss version="2.0"><channel><item><title><![CDATA[New &amp; useful]]></title><link>https://example.com/new?utm_source=rss#top</link><description><![CDATA[<p>Clear &amp; useful</p>]]></description><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item><item><title>Old</title><link>https://example.com/old</link><pubDate>Sun, 18 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>''';
final now = DateTime.utc(2026, 10, 19, 12);
void main() {
  test('RSS and Atom decode text, dates and safe canonical URLs', () {
    final rows = parseNewsFeed(rss, source, now);
    expect(rows.first['title'], 'New & useful');
    expect(rows.first['summary'], 'Clear & useful');
    expect(rows.first['url'], 'https://example.com/new');
    expect(rows.first['published_at'], '2026-10-19T10:00:00.000Z');
    final atom = parseNewsFeed(
      '''<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A &amp; B</title><link rel="alternate" href="https://example.com/a"/><summary>Text</summary><updated>2026-10-19T09:00:00Z</updated></entry></feed>''',
      source,
      now,
    );
    expect(atom.single['title'], 'A & B');
    expect(atom.single['url'], 'https://example.com/a');
    for (final url in [
      'http://127.0.0.1/a',
      'http://localhost./',
      'http://127.0.0.1./',
      'http://10.0.0.1/a',
      'http://localhost/a',
      'http://x.local/a',
      'https://user:pass@example.com/a',
      'javascript:alert(1)',
      'http://[::1]/',
    ]) {
      expect(newsArticleUrl(url), isNull, reason: url);
    }
  });
  test('rejects oversized, deeply nested, malformed, DTD and HTML input', () {
    for (final xml in [
      'x' * (1024 * 1024 + 1),
      '<rss>${'<x>' * 40}${'</x>' * 40}</rss>',
      '<rss><item></rss>',
      '<!DOCTYPE rss SYSTEM "file:///etc/passwd"><rss/>',
      '<html><body>error</body></html>',
    ]) {
      expect(() => parseNewsFeed(xml, source, now), throwsFormatException);
    }
  });
  test(
    'automatic foreground refresh populates local store and respects TTL',
    () async {
      var calls = 0;
      final news = LocalNews(
        MemoryLifePersistence(),
        sources: [source],
        language: 'en',
        now: () => now,
        fetcher: (_) async {
          calls++;
          return rss;
        },
      );
      await news.open();
      final life = LocalLife(MemoryLifePersistence());
      await life.open();
      final store = PersonalStore(
        send: (_) => throw StateError('remote forbidden'),
        local: life,
        news: news,
      );
      addTearDown(() {
        store.dispose();
        news.dispose();
        life.dispose();
      });
      await news.setForeground(true);
      expect(store.snapshot!.object('news')['items'], hasLength(2));
      await news.setForeground(false);
      await news.setForeground(true);
      expect(calls, 1);
      await store.command('news.refresh');
      expect(calls, 2);
      final items = store.snapshot!.object('news')['items'] as List;
      expect(items.first['title'], 'New & useful');
      expect(store.snapshot!.rows('feed'), isEmpty);
    },
  );
  test(
    'read and save persist through changed content, failure and offline restart',
    () async {
      final disk = MemoryLifePersistence();
      var failed = false, text = rss;
      final news = LocalNews(
        disk,
        sources: [source],
        language: 'en',
        now: () => now,
        fetcher: (_) async {
          if (failed) throw StateError('offline');
          return text;
        },
      );
      await news.open();
      await news.refresh();
      final first = (news.snapshot()['items'] as List).first as Map;
      await news.action({'action': 'save', 'id': first['id'], 'value': true});
      await news.action({'action': 'read', 'id': first['id'], 'value': true});
      text = rss.replaceFirst('New &amp; useful', 'Updated');
      await news.refresh();
      expect((news.snapshot()['saved'] as List).single['title'], 'Updated');
      failed = true;
      await news.refresh();
      expect(news.snapshot()['items'], hasLength(2));
      expect((news.snapshot()['sources'] as List).single['error'], isNotNull);
      news.dispose();
      final restored = LocalNews(
        disk,
        sources: [source],
        language: 'en',
        now: () => now,
        fetcher: (_) async => throw StateError('offline'),
      );
      await restored.open();
      addTearDown(restored.dispose);
      final saved = (restored.snapshot()['saved'] as List).single;
      expect(saved['read'], true);
      expect(saved['title'], 'Updated');
      expect(restored.snapshot()['items'], hasLength(2));
    },
  );
  test(
    'concurrent refreshes share one fetch and disposal blocks late publication',
    () async {
      final response = Completer<String>();
      var calls = 0;
      final disk = MemoryLifePersistence();
      final news = LocalNews(
        disk,
        sources: [source],
        language: 'en',
        now: () => now,
        fetcher: (_) {
          calls++;
          return response.future;
        },
      );
      await news.open();
      final first = news.refresh(), second = news.refresh();
      await Future<void>.delayed(Duration.zero);
      expect(calls, 1);
      news.dispose();
      response.complete(rss);
      await Future.wait([first, second]);
      final restored = LocalNews(disk, sources: [source], language: 'en');
      await restored.open();
      expect(restored.snapshot()['items'], isEmpty);
      restored.dispose();
    },
  );
  test(
    'partial source failure retains old cache and publishes successful source',
    () async {
      const other = NewsSource(
        'other',
        'Other',
        'https://other.example/rss',
        'en',
      );
      var failFirst = false;
      final news = LocalNews(
        MemoryLifePersistence(),
        sources: [source, other],
        language: 'en',
        now: () => now,
        fetcher: (s) async {
          if (s.id == source.id && failFirst) throw StateError('offline');
          return s.id == source.id
              ? rss
              : rss.replaceAll('example.com/', 'other.example/');
        },
      );
      await news.open();
      addTearDown(news.dispose);
      await news.refresh();
      failFirst = true;
      await news.refresh();
      expect(news.snapshot()['items'], hasLength(4));
      expect(
        (news.snapshot()['sources'] as List).where((s) => s['error'] != null),
        hasLength(1),
      );
    },
  );
}
