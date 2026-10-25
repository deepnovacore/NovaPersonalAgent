// Synthetic phone UI and native playback lifecycle; no live service or recording.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:nova_audio/channel_audio.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../test/agent_core_test.dart' show MemoryPersistence;
import '../test/support/fake_audio.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('phone pages and native playback lifecycle', (tester) async {
    final audio = ChannelAudio();
    expect((await audio.capabilities())['relay'], true);
    for (var generation = 1; generation <= 3; generation++) {
      await audio.startRelay(
        generation: generation,
        capture: false,
        threshold: .045,
      );
      await audio.stop();
    }
    await audio.disconnect();
    SharedPreferences.setMockInitialValues({'language': 'en'});
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final host = AgentCoreHost(store: store, settings: ModelSettings());
    addTearDown(host.dispose);
    await tester.pumpWidget(
      NovaApp(
        audio: FakeAudio(),
        requestMicrophone: () async => false,
        agentCore: host,
        preferences: Preferences(await SharedPreferences.getInstance()),
      ),
    );
    await tester.pumpAndSettle();
    await binding.convertFlutterSurfaceToImage();
    await binding.takeScreenshot('phone-home');
    await tester.tap(find.text('Me'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Devices'));
    await tester.pumpAndSettle();
    expect(find.text('This phone'), findsOneWidget);
    await binding.takeScreenshot('phone-devices');
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Nova').last);
    await tester.pumpAndSettle();
    final id = store.conversations.single['id'] as String;
    await store.append(id, {'role': 'user', 'content': 'A synthetic question'});
    await store.append(id, {
      'role': 'assistant',
      'content': 'A synthetic answer',
    });
    host.notifyListeners();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await binding.takeScreenshot('phone-chat');
    await tester.pumpWidget(const SizedBox());
  });
}
