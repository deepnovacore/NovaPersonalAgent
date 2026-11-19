import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/generic/shared_ideas.dart';

Map<String, String> topic(String id) => {'id': id, 'text': 'Discuss $id'};
String catalog(
  List<Object> topics, {
  int version = 1,
  String language = 'en',
}) => jsonEncode({'version': version, 'language': language, 'topics': topics});

void main() {
  test('concurrent loads share one sample with unique IDs', () async {
    final calls = <String>[];
    final ideas = SharedIdeas(
      read: (language) async {
        calls.add(language);
        if (language == 'zh') {
          return catalog([
            {'id': 'zh-only', 'text': '聊聊茶'},
          ], language: 'zh');
        }
        return catalog([
          topic('a'),
          topic('a'),
          ...'bcdefghi'.split('').map(topic),
        ]);
      },
    );
    await Future.wait([ideas.load('en'), ideas.load('en')]);
    final first = ideas.topics('en').map((row) => row.id).toList();
    expect(first, hasLength(6));
    expect(first.toSet(), hasLength(6));
    await ideas.load('en');
    expect(ideas.topics('en').map((row) => row.id), first);
    await ideas.load('zh');
    expect(ideas.topics('zh').single.id, 'zh-only');
    expect(ideas.topics('en').map((row) => row.id), first);
    expect(calls, ['en', 'zh']);
  });

  test(
    'offline and invalid catalogs can be retried; small pools are valid',
    () async {
      final data = [
        catalog([topic('a')], version: 2),
        catalog([
          {'id': 'a', 'text': ' '},
        ]),
        'x' * 65537,
        catalog([topic('wrong-language')], language: 'zh'),
        catalog([topic('a'), topic('a'), topic('b')]),
      ];
      var offline = true;
      final ideas = SharedIdeas(
        read: (_) async {
          if (offline) {
            offline = false;
            throw StateError('offline');
          }
          return data.removeAt(0);
        },
      );
      for (var i = 0; i < 5; i++) {
        await ideas.load('en');
        expect(ideas.topics('en'), isEmpty);
      }
      await ideas.load('en');
      expect(ideas.topics('en').map((row) => row.id).toSet(), {'a', 'b'});
    },
  );

  test('only the first marked welcome is eligible for the opening', () {
    const welcome = {'role': 'assistant', 'nova_welcome': true};
    expect(emptyIdeaOpening([]), isTrue);
    expect(emptyIdeaOpening([welcome]), isTrue);
    expect(emptyIdeaOpening([welcome, welcome]), isFalse);
    expect(
      emptyIdeaOpening([
        {'role': 'assistant'},
      ]),
      isFalse,
    );
    expect(
      emptyIdeaOpening([
        {'role': 'user'},
      ]),
      isFalse,
    );
  });
}
