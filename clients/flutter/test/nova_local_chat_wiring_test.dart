import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter/material.dart';
import 'package:nova_mobile/ui/conversation_home.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'local_life_test.dart' show MemoryLifePersistence;
import 'support/fake_audio.dart';

void main() {
  testWidgets('Nova tab shows local chat when an agent core is available', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({'language': 'en'});
    FlutterSecureStorage.setMockInitialValues({});
    final audioConfig = (
      audio: FakeAudio(),
      requestMicrophone: () async => false,
    );

    final store = ConversationStore(MemoryLifePersistence());
    await store.open();
    final host = AgentCoreHost(store: store, settings: ModelSettings());
    await tester.pumpWidget(
      NovaApp(
        audio: audioConfig.audio,
        requestMicrophone: audioConfig.requestMicrophone,

        preferences: Preferences(await SharedPreferences.getInstance()),
        agentCore: host,
        lifeHost: LifeHost(repository: LocalLife(MemoryLifePersistence())),
      ),
    );
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.byType(ConversationHome), findsNothing);
    expect(store.conversations.single['id'], 'chat:main');
    expect(find.byType(LocalChatPanel), findsOneWidget);
    expect(find.byType(BottomAppBarTabs), findsOneWidget);
    expect(find.text('Timeline'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'Keep this draft');
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Me'));
    await tester.pumpAndSettle();
    expect(find.text('Profile'), findsOneWidget);
    await tester.tap(find.text('Nova').last);
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      'Keep this draft',
    );
    await tester.tap(find.text('Me'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    expect(find.text('Model provider'), findsOneWidget);
    await tester.tap(find.text('Devices'));
    await tester.pumpAndSettle();
    expect(find.text('This phone'), findsOneWidget);
    expect(find.text('Computer & voice'), findsNothing);
    // Disconnected from the computer, so a fresh conversation is local.
    expect(store.conversations.single['backend'], 'local');
    await tester.pumpWidget(const SizedBox());
    host.dispose();
  });
  testWidgets(
    'saved Chinese language reaches the home without a connection event',
    (tester) async {
      SharedPreferences.setMockInitialValues({'language': 'zh'});
      FlutterSecureStorage.setMockInitialValues({});
      final audioConfig = (
        audio: FakeAudio(),
        requestMicrophone: () async => false,
      );
      final store = ConversationStore(MemoryLifePersistence());
      await store.open();
      final host = AgentCoreHost(store: store, settings: ModelSettings());

      addTearDown(host.dispose);
      await tester.pumpWidget(
        NovaApp(
          audio: audioConfig.audio,
          requestMicrophone: audioConfig.requestMicrophone,
          agentCore: host,
          lifeHost: LifeHost(repository: LocalLife(MemoryLifePersistence())),

          preferences: Preferences(await SharedPreferences.getInstance()),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('新对话'), findsNothing);
      expect(find.text('我的'), findsOneWidget);
      expect(find.byType(LocalChatPanel), findsOneWidget);
      expect(find.text('Nova'), findsNWidgets(2));
      expect(find.text('时间线'), findsOneWidget);
      expect(find.text('任务'), findsOneWidget);
      expect(find.text('资讯'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
