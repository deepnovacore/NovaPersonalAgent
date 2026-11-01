import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/phone_channel.dart';
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
import 'support/fake_phone_channel.dart';

Future<void> _pumpApp(WidgetTester tester, {PhoneChannel? phone}) async {
  SharedPreferences.setMockInitialValues({'language': 'en'});
  FlutterSecureStorage.setMockInitialValues({});
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final store = ConversationStore(MemoryLifePersistence());
  await store.open();
  final host = AgentCoreHost(store: store, settings: ModelSettings());
  addTearDown(host.dispose);
  await tester.pumpWidget(
    NovaApp(
      audio: FakeAudio(),
      requestMicrophone: () async => false,
      agentCore: host,
      lifeHost: LifeHost(repository: LocalLife(MemoryLifePersistence())),
      preferences: Preferences(await SharedPreferences.getInstance()),
      phoneChannel: phone,
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('settings lists Phone control and opens its page', (
    tester,
  ) async {
    final channel = FakePhoneChannel(
      const PhoneStatus(apiLevel: 34, accessibility: true),
    );
    addTearDown(channel.close);
    await _pumpApp(tester, phone: channel);
    await tester.tap(find.text('Me'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Settings'));
    await tester.pumpAndSettle();
    expect(find.text('Phone control'), findsOneWidget);
    await tester.tap(find.text('Phone control'));
    await tester.pumpAndSettle();
    expect(find.text('Accessibility'), findsOneWidget);
    expect(channel.calls, contains('status'));
  });

  testWidgets('without a phone bridge the entry is absent', (tester) async {
    await _pumpApp(tester);
    await tester.tap(find.text('Me'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Settings'));
    await tester.pumpAndSettle();
    expect(find.text('Model services'), findsOneWidget);
    expect(find.text('Phone control'), findsNothing);
  });

  testWidgets(
    'a virtual task shows the picture over the app and stops with it',
    (tester) async {
      final channel = FakePhoneChannel(const PhoneStatus(apiLevel: 34));
      addTearDown(channel.close);
      await _pumpApp(tester, phone: channel);
      expect(find.byKey(const ValueKey('pip-working')), findsNothing);
      channel.emit(stepEvent());
      await tester.runAsync(pumpEventQueue);
      await tester.pump();
      expect(find.byKey(const ValueKey('pip-working')), findsOneWidget);
      expect(channel.previews, [true]);
      // It stays clear of the tab bar at the bottom.
      final tabBar = tester.getRect(find.text('Tasks')).top;
      expect(
        tester.getRect(find.byKey(const ValueKey('pip-working'))).bottom,
        lessThanOrEqualTo(tabBar),
      );
      channel.emit(doneEvent());
      await tester.runAsync(pumpEventQueue);
      await tester.pump();
      expect(find.byKey(const ValueKey('pip-working')), findsNothing);
      expect(channel.previews, [true, false]);
    },
  );
}
