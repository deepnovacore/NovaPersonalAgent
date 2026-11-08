import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:nova_mobile/generic/shared_ideas.dart';
import 'package:nova_mobile/space/client_controller.dart';
import 'package:nova_mobile/space/space_root.dart';
import 'package:nova_mobile/ui/shared_idea_suggestions.dart';
import 'package:nova_mobile/ui/components.dart';
import 'package:nova_mobile/ui/theme.dart';

import 'support/space_client_fixture.dart';

class _TopicRelay extends SpaceClientController {
  _TopicRelay(SpaceClientController fixture)
    : super(fixture.state, fixture.transport);

  final sent = <(String, String)>[];
  final release = Completer<void>();

  @override
  Future<String> sendChat(
    String text, {
    String conversationId = 'chat:main',
  }) async {
    sent.add((conversationId, text));
    await release.future;
    await state.beginChat(
      'topic-send',
      text,
      1,
      conversationId: conversationId,
    );
    return 'topic-send';
  }
}

void main() {
  testWidgets(
    'Ideas sends one topic back to main chat without clearing its draft',
    (tester) async {
      SharedPreferences.setMockInitialValues({'language': 'zh'});
      const text = '怎么泡一杯好茶？';
      final state = seededState();
      state.snapshot['conversations'] = [
        {'id': 'chat:main', 'kind': 'chat', 'mode': 'chat'},
      ];
      state.messages
        ..clear()
        ..add({
          'role': 'assistant',
          'origin': 'proactive',
          'text': '你好，我是 Nova。',
        });
      final relay = _TopicRelay(await fakeController(tester, state));
      final ideas = SharedIdeas(
        read: (language) async {
          expect(language, 'zh');
          return '{"version":1,"language":"zh","topics":[{"id":"tea","text":"$text"}]}';
        },
      );
      await tester.pumpWidget(
        SharedIdeasScope(
          notifier: ideas,
          child: MaterialApp(
            theme: novaTheme(),
            home: SpaceClientScreen(
              space: spaceRecord,
              onSwitchSpace: () {},
              open: (_) async => relay,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('shared-idea-opening:tea')),
        findsOneWidget,
      );

      await tester.enterText(find.byType(TextField), '没发出去的草稿');
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('shared-idea-opening:tea')),
        findsNothing,
      );
      await tester.tap(find.text('我的'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('想法'));
      await tester.pumpAndSettle();
      final card = find.byKey(const ValueKey('shared-idea:tea'));
      await tester.ensureVisible(card);
      final repeat = tester.widget<NovaTile>(card).onTap!;
      await tester.tap(card);
      repeat();
      await tester.pumpAndSettle();
      expect(relay.sent, [('chat:main', text)]);
      relay.release.complete();
      await tester.pumpAndSettle();

      expect(find.text('想法'), findsNothing);
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '没发出去的草稿',
      );
      expect(find.text(text), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      ideas.dispose();
    },
  );
}
