import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'local_life_test.dart' show MemoryLifePersistence;
import 'support/fake_audio.dart';

void main() {
  testWidgets(
    'model hub keeps its four entries when returning from each detail',
    (tester) async {
      SharedPreferences.setMockInitialValues({'language': 'en'});
      FlutterSecureStorage.setMockInitialValues({});
      final settings = ModelSettings();
      final credential = await settings.credentials.save(
        endpoint: 'https://support.example/v1',
        key: 'hidden-key',
      );
      await settings.saveSupport(
        endpoint: credential.endpoint,
        model: 'organizer',
        credentialId: credential.id,
      );
      final store = ConversationStore(MemoryLifePersistence());
      await store.open();
      final host = AgentCoreHost(store: store, settings: settings);
      addTearDown(host.dispose);
      await tester.pumpWidget(
        NovaApp(
          audio: FakeAudio(),
          requestMicrophone: () async => false,
          agentCore: host,
          lifeHost: LifeHost(repository: LocalLife(MemoryLifePersistence())),
          preferences: Preferences(await SharedPreferences.getInstance()),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Me'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Settings'));
      await tester.pumpAndSettle();
      expect(find.text('Background model'), findsNothing);
      expect(find.text('Voice settings'), findsNothing);
      await tester.tap(find.text('Model services'));
      await tester.pumpAndSettle();
      expect(find.text('Conversation model'), findsOneWidget);
      expect(find.text('Information processing'), findsOneWidget);
      expect(find.text('Voice services'), findsOneWidget);
      expect(find.text('Provider credentials'), findsOneWidget);
      expect(find.text('Separate model · organizer'), findsOneWidget);
      await tester.tap(find.text('Information processing'));
      await tester.pumpAndSettle();
      expect(find.text('Current: Separate model · organizer'), findsOneWidget);
      await tester.tap(find.text('Follow chat model'));
      await tester.pumpAndSettle();
      expect(find.text('Follow chat model'), findsOneWidget);
      for (final entry in [
        'Conversation model',
        'Voice services',
        'Provider credentials',
      ]) {
        await tester.tap(find.text(entry));
        await tester.pumpAndSettle();
        await tester.tap(
          find.text(entry == 'Provider credentials' ? 'Done' : 'Cancel'),
        );
        await tester.pumpAndSettle();
        expect(find.text('Model services'), findsOneWidget);
        expect(find.text('Information processing'), findsOneWidget);
      }
      expect(find.text('hidden-key'), findsNothing);
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.text('Me'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
