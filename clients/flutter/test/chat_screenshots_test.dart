import 'dart:io';
import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'local_life_test.dart' show MemoryLifePersistence;
import 'support/fake_audio.dart';

void main() {
  setUpAll(() async {
    final config = File('.dart_tool/package_config.json');
    final packages =
        jsonDecode(await config.readAsString())['packages'] as List;
    final flutter = packages.singleWhere((p) => p['name'] == 'flutter');
    final sdk = Directory.fromUri(
      config.absolute.uri.resolve(flutter['rootUri'] as String),
    ).parent.parent.path;
    for (final font in {
      'Roboto': 'Roboto-Regular.ttf',
      'CupertinoSystemText': 'Roboto-Regular.ttf',
      'CupertinoSystemDisplay': 'Roboto-Regular.ttf',
      'MaterialIcons': 'MaterialIcons-Regular.otf',
    }.entries) {
      await (FontLoader(font.key)..addFont(
            File(
              '$sdk/bin/cache/artifacts/material_fonts/${font.value}',
            ).readAsBytes().then((bytes) => ByteData.sublistView(bytes)),
          ))
          .load();
    }
    final icons = packages.singleWhere((p) => p['name'] == 'cupertino_icons');
    await (FontLoader('packages/cupertino_icons/CupertinoIcons')..addFont(
          File.fromUri(
            config.absolute.uri.resolve(
              '${icons['rootUri']}/assets/CupertinoIcons.ttf',
            ),
          ).readAsBytes().then((bytes) => ByteData.sublistView(bytes)),
        ))
        .load();
  });
  testWidgets(
    'chat home, conversation and settings render without workspace chrome',
    (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      SharedPreferences.setMockInitialValues({'language': 'en'});
      FlutterSecureStorage.setMockInitialValues({});
      final audioConfig = (
        audio: FakeAudio(),
        requestMicrophone: () async => false,
      );
      final store = ConversationStore(MemoryLifePersistence());
      await store.open();
      final archived = await store.create();
      await store.append(archived, {
        'role': 'user',
        'content': 'Plan a quieter weekend',
      });
      await store.append(archived, {
        'role': 'assistant',
        'content': 'Keep Saturday afternoon open.',
      });
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
      await expectLater(
        find.byType(NovaApp),
        matchesGoldenFile('goldens/chat-home-empty.png'),
      );
      final id = ConversationStore.mainId;
      await store.append(id, {'role': 'user', 'content': 'A quieter weekend'});
      await store.append(id, {
        'role': 'assistant',
        'content':
            'Leave one afternoon open. A walk, a book, and nowhere you need to be.\n\nWhat would you like to make time for?',
      });
      await tester.tap(find.text('Me'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Settings'));
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(NovaApp),
        matchesGoldenFile('goldens/chat-settings.png'),
      );
      await tester.tap(find.text('Done'));
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(NovaApp),
        matchesGoldenFile('goldens/chat-home.png'),
      );
      await tester.tap(find.text('Profile'));
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(NovaApp),
        matchesGoldenFile('goldens/chat-personal.png'),
      );
      await tester.pageBack();
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nova').last);
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(NovaApp),
        matchesGoldenFile('goldens/chat-conversation.png'),
      );
      await tester.tap(find.text('Tasks'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'New task'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Prepare a weekend plan');
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(NovaApp),
        matchesGoldenFile('goldens/chat-task-draft.png'),
      );
      await tester.tap(find.byTooltip('All tasks'));
      await tester.pumpAndSettle();
      await expectLater(
        find.byType(NovaApp),
        matchesGoldenFile('goldens/chat-tasks.png'),
      );
      await tester.tap(find.text('Nova').last);
      await tester.pumpAndSettle();
      // Exercise both compact and landscape layouts at accessible text sizes.
      for (final size in [const Size(320, 640), const Size(844, 390)]) {
        tester.view.physicalSize = size;
        tester.platformDispatcher.textScaleFactorTestValue = 2;
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        tester.view.viewInsets = const FakeViewPadding(bottom: 200);
        await tester.enterText(
          find.byType(TextField),
          'A draft with the keyboard open',
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        tester.view.resetViewInsets();
      }
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      await tester.pumpWidget(const SizedBox());
    },
  );
}
