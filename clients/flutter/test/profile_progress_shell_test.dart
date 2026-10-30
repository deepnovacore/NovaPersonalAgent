import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/context/profile_generation_coordinator.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/ui/local_profile_results.dart';
import 'phone_voice_app_test.dart' show openChat;
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  testWidgets(
    'profile progress keeps the chat editor mounted; completed revision refreshes results',
    (tester) async {
      await openChat(
        tester,
        lifeHost: LifeHost(repository: LocalLife(MemoryLifePersistence())),
      );
      final results = find.byType(LocalProfileResults, skipOffstage: false);
      LocalProfileResults profile() => tester
          .widgetList<LocalProfileResults>(results)
          .firstWhere((widget) => widget.generation != null);
      final generation = profile().generation!;
      // Prime lifecycle state before measuring progress-only notifications.
      // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
      generation.notifyListeners();
      await tester.pump();
      final chat = find.byType(LocalChatPanel, skipOffstage: false);
      final panel = tester.widget<LocalChatPanel>(chat);
      final state = tester.state(chat);
      final editor = tester
          .widget<TextField>(find.byType(TextField))
          .controller;
      final revision = profile().revision;
      generation.phase = ProfileGenerationPhase.working;
      for (var i = 0; i < 3; i++) {
        generation.covered = i;
        // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
        generation.notifyListeners();
        await tester.pump();
        expect(tester.widget<LocalChatPanel>(chat), same(panel));
        expect(profile().revision, revision);
      }
      generation.revision += 5;
      generation.phase = ProfileGenerationPhase.ready;
      // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
      generation.notifyListeners();
      await tester.pump();
      expect(profile().revision, revision + 1);
      expect(tester.state(chat), same(state));
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller,
        same(editor),
      );
      expect(editor!.text, 'Keep this unsent draft');
      await tester.pumpWidget(const SizedBox());
    },
  );
}
