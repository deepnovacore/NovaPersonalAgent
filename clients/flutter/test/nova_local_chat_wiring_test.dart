import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/connection/session.dart';
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
    final session = Session(
      audio: FakeAudio(),
      requestMicrophone: () async => false,
    );
    addTearDown(session.dispose);
    final store = ConversationStore(MemoryLifePersistence());
    await store.open();
    final host = AgentCoreHost(store: store, settings: ModelSettings());
    await tester.pumpWidget(
      NovaApp(
        session: session,
        preferences: Preferences(await SharedPreferences.getInstance()),
        agentCore: host,
      ),
    );
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.byType(LocalChatPanel), findsOneWidget);
    // Disconnected from the computer, so a fresh conversation is local.
    expect(store.conversations.single['backend'], 'local');
  });
}
