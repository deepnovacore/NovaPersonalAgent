import '../../context/source_store.dart';
import 'api.dart';
import 'auth.dart';

class FeishuChatDiscovery {
  FeishuChatDiscovery(this.chats, this.identity, this.generation);
  final List<Map<String, dynamic>> chats;
  final String? identity;
  final int generation;
}

class FeishuIngest {
  FeishuIngest(this.auth, this.sources, {DateTime Function()? now})
    : now = now ?? DateTime.now;
  final FeishuAuth auth;
  final SourceStore sources;
  final DateTime Function() now;
  bool _busy = false;
  void _check(int generation, String? identity) {
    if (!auth.authorized ||
        auth.generation != generation ||
        auth.identityKey != identity ||
        sources.identity != identity ||
        sources.generation != generation) {
      throw const FeishuFailure('authorization_changed');
    }
  }

  Future<Map<String, dynamic>> chats({String? pageToken}) async {
    final generation = auth.generation, identity = auth.identityKey;
    final token = await auth.accessToken();
    _check(generation, identity);
    final page = await auth.api.get(
      auth.brand,
      '/open-apis/im/v1/chats',
      token,
      query: {
        'page_size': '50',
        'types': 'p2p,group',
        'user_id_type': 'open_id',
        'page_token': ?pageToken,
      },
    );
    _check(generation, identity);
    return page;
  }

  /// Discover every accessible page, preserving removals and explicit pauses.
  /// No message bodies are read until discovery completes successfully.
  Future<FeishuChatDiscovery> discoverAll({bool Function()? stopped}) async {
    final generation = auth.generation, identity = auth.identityKey;
    final result = <String, Map<String, dynamic>>{};
    final seen = <String>{};
    String? cursor;
    do {
      if (stopped?.call() == true) {
        throw const FeishuFailure('collection_stopped');
      }
      _check(generation, identity);
      final response = await chats(pageToken: cursor);
      _check(generation, identity);
      if (response['items'] is! List || response['has_more'] is! bool) {
        throw const FeishuFailure('invalid_page');
      }
      for (final item in response['items'] as List) {
        if (item is! Map ||
            item['chat_id'] is! String ||
            (item['chat_id'] as String).isEmpty) {
          throw const FeishuFailure('invalid_page');
        }
        result[item['chat_id']] = Map<String, dynamic>.from(item);
      }
      cursor = response['has_more'] == true
          ? response['page_token'] as String?
          : null;
      if (response['has_more'] == true &&
          (cursor == null || cursor.isEmpty || !seen.add(cursor))) {
        throw const FeishuFailure('invalid_page');
      }
    } while (cursor != null);
    return FeishuChatDiscovery(result.values.toList(), identity, generation);
  }

  Future<void> selectAccessible(FeishuChatDiscovery discovery) async {
    final generation = discovery.generation, identity = discovery.identity;
    _check(generation, identity);
    for (final chat in discovery.chats) {
      _check(generation, identity);
      if (!sources.allAccessible) {
        throw const FeishuFailure('collection_stopped');
      }
      final id = chat['chat_id'] as String;
      if (!sources.excluded(id)) {
        await sources.select(
          id,
          now().subtract(const Duration(days: 30)),
          expectedIdentity: identity,
          expectedGeneration: generation,
          requireAllAccessible: true,
        );
      }
    }
    _check(generation, identity);
  }

  Future<bool> page(String id) async {
    if (_busy) throw const FeishuFailure('collection_busy');
    _busy = true;
    try {
      final generation = auth.generation, identity = auth.identityKey;
      _check(generation, identity);
      final fence = sources.fence(id), checkpoint = sources.checkpoint(id);
      final end = checkpoint['window_end'] == null
          ? now().toUtc()
          : DateTime.parse(checkpoint['window_end']);
      final from = DateTime.parse(checkpoint['from']);
      final token = await auth.accessToken();
      _check(generation, identity);
      final page = await auth.api.get(
        auth.brand,
        '/open-apis/im/v1/messages',
        token,
        query: {
          'container_id_type': 'chat',
          'container_id': id,
          'page_size': '50',
          'sort_type': 'ByCreateTimeAsc',
          'start_time': '${from.millisecondsSinceEpoch ~/ 1000}',
          'end_time': '${end.millisecondsSinceEpoch ~/ 1000}',
          if (checkpoint['page_token'] != null)
            'page_token': checkpoint['page_token'],
        },
      );
      _check(generation, identity);
      if (page['items'] is! List ||
          page['has_more'] is! bool ||
          (page['has_more'] == true &&
              (page['page_token'] is! String ||
                  (page['page_token'] as String).isEmpty))) {
        throw const FeishuFailure('invalid_page');
      }
      await sources.ingestPage(
        fence,
        page['items'] as List,
        nextPage: page['has_more'] == true
            ? page['page_token'] as String
            : null,
        windowEnd: end,
      );
      _check(generation, identity);
      return page['has_more'] as bool;
    } finally {
      _busy = false;
    }
  }
}
