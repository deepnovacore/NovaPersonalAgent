import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:shared_preferences/shared_preferences.dart';
// ignore: depend_on_referenced_packages
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';
import 'local_life_test.dart' show MemoryLifePersistence;
import 'message_display_preferences_test.dart' show FailingDisplayStore;
import 'support/fake_audio.dart';

class _DelayedPreferencesStore extends InMemorySharedPreferencesStore {
  _DelayedPreferencesStore()
    : super.withData({'flutter.language': 'en', 'flutter.show_process': false});
  final ready = Completer<void>();
  @override
  Future<Map<String, Object>> getAll() async {
    await ready.future;
    return super.getAll();
  }
}

Future<Preferences> _openApp(WidgetTester tester, {bool? saved}) async {
  SharedPreferences.setMockInitialValues({
    'language': 'en',
    'show_process': ?saved,
  });
  FlutterSecureStorage.setMockInitialValues({});
  final storage = await SharedPreferences.getInstance();
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
      preferences: Preferences(storage),
    ),
  );
  await tester.pumpAndSettle();
  return Preferences(storage);
}

Future<void> _choose(WidgetTester tester, String choice) async {
  await tester.tap(find.text('Me'));
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip('Settings'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Message display'));
  await tester.pumpAndSettle();
  expect(find.text('Full process'), findsOneWidget);
  expect(find.text('Concise'), findsOneWidget);
  await tester.tap(find.text(choice));
  await tester.pumpAndSettle();
}

bool _showProcess(WidgetTester tester) => tester
    .widget<LocalChatPanel>(find.byType(LocalChatPanel, skipOffstage: false))
    .showProcess;

void main() {
  testWidgets(
    'startup waits for persisted concise mode before showing conversation history',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      FlutterSecureStorage.setMockInitialValues({});
      final delayed = _DelayedPreferencesStore();
      SharedPreferencesStorePlatform.instance = delayed;
      final store = ConversationStore(MemoryLifePersistence());
      await store.open();
      await store.ensureMain();
      await store.append(ConversationStore.mainId, {
        'role': 'user',
        'content': 'A stored request',
      });
      await store.append(ConversationStore.mainId, {
        'role': 'assistant',
        'content': 'A stored final reply',
        'reasoning_content': 'Hidden restored thinking',
      });
      final host = AgentCoreHost(store: store, settings: ModelSettings());
      try {
        await tester.pumpWidget(
          NovaApp(
            audio: FakeAudio(),
            requestMicrophone: () async => false,
            agentCore: host,
            lifeHost: LifeHost(repository: LocalLife(MemoryLifePersistence())),
          ),
        );
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.byType(LocalChatPanel, skipOffstage: false), findsNothing);
        expect(find.textContaining('Hidden restored thinking'), findsNothing);
        delayed.ready.complete();
        await tester.pumpAndSettle();
        expect(_showProcess(tester), isFalse);
        expect(
          find.text('A stored final reply', findRichText: true),
          findsOneWidget,
        );
        expect(find.textContaining('Hidden restored thinking'), findsNothing);
      } finally {
        if (!delayed.ready.isCompleted) {
          delayed.ready.complete();
        }
        await tester.pumpWidget(const SizedBox());
        host.dispose();
        SharedPreferences.setMockInitialValues({});
      }
    },
  );

  testWidgets(
    'settings restore concise and switch the existing chat in both directions',
    (tester) async {
      final prefs = await _openApp(tester, saved: false);
      expect(_showProcess(tester), isFalse);
      final panelState = tester.state(find.byType(LocalChatPanel));
      await _choose(tester, 'Full process');
      expect(_showProcess(tester), isTrue);
      expect(prefs.showProcess, isTrue);
      await _choose(tester, 'Concise');
      expect(_showProcess(tester), isFalse);
      expect(prefs.showProcess, isFalse);
      expect(
        tester.state(find.byType(LocalChatPanel, skipOffstage: false)),
        same(panelState),
      );
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'failed settings save keeps full display and shows a safe error',
    (tester) async {
      final prefs = await _openApp(tester);
      expect(_showProcess(tester), isTrue);
      final previous = SharedPreferencesStorePlatform.instance;
      SharedPreferencesStorePlatform.instance = FailingDisplayStore();
      addTearDown(() => SharedPreferencesStorePlatform.instance = previous);
      await _choose(tester, 'Concise');
      expect(_showProcess(tester), isTrue);
      expect(prefs.showProcess, isTrue);
      expect(
        find.text('Could not save message display settings. Please retry.'),
        findsOneWidget,
      );
      expect(find.textContaining('preference_save_failed'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
