import 'support/mobile_navigation.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'dart:io';
import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
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
      final loader = FontLoader(font.key)
        ..addFont(
          File(
            '$sdk/bin/cache/artifacts/material_fonts/${font.value}',
          ).readAsBytes().then((bytes) => ByteData.sublistView(bytes)),
        );
      await loader.load();
    }
    final icons = packages.singleWhere((p) => p['name'] == 'cupertino_icons');
    await (FontLoader('packages/cupertino_icons/CupertinoIcons')..addFont(
          File.fromUri(
            config.absolute.uri.resolve(
              "${icons['rootUri']}/assets/CupertinoIcons.ttf",
            ),
          ).readAsBytes().then((bytes) => ByteData.sublistView(bytes)),
        ))
        .load();
  });
  testWidgets('library pages remain accessible from settings at phone size', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    SharedPreferences.setMockInitialValues({'language': 'en'});
    FlutterSecureStorage.setMockInitialValues({});
    final repo = LocalLife(MemoryLifePersistence());
    await repo.open();
    final goal = await repo.mutate({
      'op': 'create',
      'kind': 'goal',
      'title': 'Ship mobile workbench',
      'success_criteria': 'Daily use for two weeks',
    });
    await repo.mutate({
      'op': 'create',
      'kind': 'idea',
      'title': 'A weekly reflection',
    });
    await repo.mutate({
      'op': 'create',
      'kind': 'todo',
      'title': 'Prepare the demo',
      'note': 'Review the checklist',
      'goal_id': goal['id'],
    });
    for (final item in [
      {
        'title': 'Send the weekly update',
        'status': 'doing',
        'due': '2000-01-01',
      },
      {'title': 'Book the review room', 'status': 'done'},
    ]) {
      final todo = await repo.mutate({
        'op': 'create',
        'kind': 'todo',
        'title': item['title'],
        if (item['due'] != null) 'due': item['due'],
      });
      await repo.mutate({
        'op': 'update',
        'kind': 'todo',
        'id': todo['id'],
        'expected_version': todo['version'],
        'status': item['status'],
      });
    }
    final audioConfig = (
      audio: FakeAudio(),
      requestMicrophone: () async => false,
    );

    final conversations = ConversationStore(MemoryLifePersistence());
    await conversations.open();
    final core = AgentCoreHost(store: conversations, settings: ModelSettings());
    addTearDown(core.dispose);
    final lifeHost = LifeHost(repository: repo);
    await lifeHost.open();
    await tester.pumpWidget(
      NovaApp(
        audio: audioConfig.audio,
        requestMicrophone: audioConfig.requestMicrophone,
        lifeHost: lifeHost,
        agentCore: core,

        preferences: Preferences(await SharedPreferences.getInstance()),
      ),
    );
    await tester.pump();
    lifeHost.store!.receive({
      'type': 'personal.state',
      'revision': 1,
      'conversations': {
        'selected_id': 'main',
        'voice_id': null,
        'unread_count': 2,
        'items': [
          {
            'id': 'main',
            'kind': 'chat',
            'title': 'Mobile workbench',
            'unread_count': 0,
          },
          {
            'id': 'proactive',
            'kind': 'proactive',
            'title': 'Reminders',
            'unread_count': 2,
          },
        ],
        'messages': [
          {
            'id': 'm1',
            'conversation_id': 'main',
            'role': 'assistant',
            'text': 'Your plan is ready. Pick a task to continue.',
          },
        ],
      },
      'news': {
        'items': [
          {
            'id': 'news',
            'title': 'Designing a calmer workday',
            'summary': 'Small routines that keep important work visible.',
            'published_at': '2025-03-04',
            'url': 'https://example.com/article',
            'source_name': 'Example Daily',
          },
          {
            'id': 'news-2',
            'title': 'Notes on building a personal agent',
            'summary': 'Why proactive suggestions need traceable evidence.',
            'published_at': '2025-03-03',
            'source_name': 'Field Notes',
            'read': true,
          },
        ],
        'saved': [],
      },
      'life': {
        'profile': {
          'about': 'I build useful tools and keep a weekly plan.',
          'version': 1,
        },
      },
      'tasks': [
        {
          'id': 'task',
          'goal': 'Review the mobile changes',
          'phase': 'running',
          'waiting_reason': null,
        },
      ],
      'feed': [
        {
          'id': 'feed',
          'title': 'Review your demo',
          'why_now': 'Your demo is coming up.',
          'lifecycle': 'active',
          'user_state': 'new',
          'delivery': {'presented_at': null},
        },
      ],
      'workbench_context': {
        'status': 'ready',
        'recap': {
          'text': 'Mostly polishing the mobile workbench this week.',
          'projects': [
            {'name': 'Mobile workbench', 'line': 'iOS-style layout pass'},
          ],
        },
        'cards': [
          {
            'id': 'card-todo',
            'tab': 'todos',
            'title': 'Run the acceptance checklist',
            'why': 'The demo is next week.',
            'next': 'Open the checklist and tick the first item',
            'source_count': 2,
          },
          {
            'id': 'card-idea',
            'tab': 'ideas',
            'title': 'Morning summary by voice',
            'body': 'Nova reads the day plan when you open the app.',
            'source_count': 1,
          },
          {
            'id': 'card-goal',
            'tab': 'goals',
            'title': 'Use Nova every day',
            'body': 'Make the assistant part of the daily routine.',
            'source_count': 3,
          },
        ],
      },
      'memory': {
        'entries': [
          {
            'id': 'memory',
            'version': 1,
            'kind': 'preference',
            'status': 'active',
            'content': 'Keep explanations concise.',
            'origin': 'stated',
            'observed_at': '2025-09-28T08:00:00Z',
            'evidence_refs': ['e1'],
            'editable': true,
          },
        ],
        'cursor': null,
      },
    });
    await tester.pump(const Duration(milliseconds: 100));
    for (final page in ['Nova', 'Feeds', 'Todos', 'Ideas', 'Goals']) {
      if (page != 'Nova') {
        await openLibrary(tester, page);
        await tester.pumpAndSettle();
      }
      expect(tester.takeException(), isNull);
      await expectLater(
        find.byType(NovaApp),
        matchesGoldenFile(
          'goldens/workbench-${page.toLowerCase().replaceAll('·', '-')}.png',
        ),
      );
      if (page != 'Nova') {
        await tester.pageBack();
        await tester.pumpAndSettle();
      }
    }

    await openLibrary(tester, 'Profile');
    await tester.pumpAndSettle();
    await expectLater(
      find.byType(NovaApp),
      matchesGoldenFile('goldens/workbench-profile.png'),
    );
    await tester.pageBack();
    await tester.pumpAndSettle();
    tester.view.physicalSize = const Size(320, 740);
    tester.platformDispatcher.textScaleFactorTestValue = 1.3;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    for (final page in ['Nova', 'Feeds', 'Todos', 'Ideas', 'Goals']) {
      if (page != 'Nova') await openLibrary(tester, page);
      expect(tester.takeException(), isNull);
      if (page != 'Nova') {
        await tester.pageBack();
        await tester.pumpAndSettle();
      }
    }
    await tester.pumpWidget(const SizedBox());
  });
}
