import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/memory/local_memory_store.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:nova_mobile/voice/phone_voice_panel.dart';
import 'package:nova_mobile/voice/phone_voice_session.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'local_life_test.dart' show MemoryLifePersistence;
import 'support/fake_audio.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory root;
  late Preferences preferences;
  const space = SpaceRecord(
    id: 'memory-startup',
    name: 'Memory startup',
    mode: SpaceMode.standalone,
  );
  setUp(() async {
    root = await Directory.systemTemp.createTemp('memory-startup-');
    SharedPreferences.setMockInitialValues({'language': 'en'});
    preferences = Preferences(await SharedPreferences.getInstance());
    FlutterSecureStorage.setMockInitialValues({});
    SpaceStorage.active = space;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/path_provider'),
          (_) async => root.path,
        );
  });
  tearDown(() async {
    SpaceStorage.active = null;
    await root.delete(recursive: true);
  });

  Future<void> settleStartup(WidgetTester tester) async {
    for (var i = 0; i < 100; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 10)),
      );
      await tester.pump();
      if (find.text('Retry').evaluate().isNotEmpty ||
          find.byType(LocalChatPanel).evaluate().isNotEmpty) {
        break;
      }
    }
    await tester.pumpAndSettle();
  }

  Future<void> mount(WidgetTester tester) async {
    await tester.pumpWidget(
      NovaApp(
        audio: FakeAudio(),
        requestMicrophone: () async => false,
        preferences: preferences,
        lifeHost: LifeHost(repository: LocalLife(MemoryLifePersistence())),
      ),
    );
    await settleStartup(tester);
  }

  Future<PhoneVoiceSession> voice(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Live voice'));
    await tester.pumpAndSettle();
    return tester.widget<PhoneVoicePanel>(find.byType(PhoneVoicePanel)).session;
  }

  for (final failedFile in [
    'nova-workspace',
    'local-conversations-v1.json',
    'local-tool-journal-v1.json',
  ]) {
    testWidgets(
      '$failedFile startup failure then Retry then Space remount releases memory',
      (tester) async {
        final directory = (await tester.runAsync(SpaceStorage.directory))!;
        final failure = File('${directory.path}/$failedFile');
        await tester.runAsync(
          () => failure.writeAsString('invalid startup resource'),
        );
        await mount(tester);
        expect(find.text('Retry'), findsOneWidget);
        await tester.runAsync(() => failure.delete());
        await tester.tap(find.text('Retry'));
        await settleStartup(tester);
        final first = (await voice(tester)).localMemory!;
        expect(first.available, isTrue);
        await tester.runAsync(
          () => first.save(
            kind: 'preference',
            text: 'green tea',
            quote: 'green tea',
            userUtterance: 'green tea',
          ),
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await mount(tester);
        final second = (await voice(tester)).localMemory!;
        expect(second.available, isTrue);
        expect(second.recall('tea').single.text, 'green tea');
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.runAsync(second.close);
      },
    );
  }

  testWidgets(
    'second opener explains memory unavailability without taking ownership',
    (tester) async {
      final directory = (await tester.runAsync(SpaceStorage.directory))!;
      final owner = LocalMemoryStore(
        FileLifePersistence(File('${directory.path}/local_memory.json')),
      );
      await tester.runAsync(owner.open);
      addTearDown(owner.close);
      await mount(tester);
      expect(
        find.text(
          'Local memory is unavailable in this Space. Chat and voice still work.',
        ),
        findsOneWidget,
      );
      final rejected = (await voice(tester)).localMemory!;
      expect(rejected.available, isFalse);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.runAsync(rejected.close);
      expect(owner.available, isTrue);
      await tester.runAsync(
        () => owner.save(
          kind: 'fact',
          text: 'tea',
          quote: 'tea',
          userUtterance: 'tea',
        ),
      );
    },
  );
}
