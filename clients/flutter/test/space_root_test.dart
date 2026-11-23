import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:io';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'dart:async';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/space/notification_router.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:nova_mobile/space/native_scope.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/space_root.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'package:nova_mobile/space/space_crypto.dart';
import 'space_client_test.dart' show MemorySpacePersistence;
import 'support/space_client_fixture.dart' show pumpClient;
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/ui/app.dart' show BottomAppBarTabs;
import 'experience_test.dart' show fixture;
import 'package:nova_mobile/experience/persona.dart';

class SlowCatalog extends SpaceCatalog {
  SlowCatalog() : super(persistence: MemorySpacePersistence());
  final release = Completer<void>();
  int adds = 0;
  @override
  Future<void> add(SpaceRecord space) async {
    adds++;
    await release.future;
    await super.add(space);
  }
}

class PairingCatalog extends SpaceCatalog {
  PairingCatalog() : super(persistence: MemorySpacePersistence());
  int pairingCalls = 0;
  SpaceRecord? created;
  @override
  Future<SpaceRecord> pairOnce(Future<SpaceRecord> Function() work) {
    pairingCalls++;
    return super.pairOnce(work);
  }

  @override
  Future<void> add(SpaceRecord space) async {
    created = space;
    throw const HandshakeException('https://private-relay.example failed');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({'language': 'zh'});
    SpaceNativeScope.resetForTesting();
    FlutterSecureStorage.setMockInitialValues({});
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SpaceNativeScope.channel, (_) async => null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('nova/space_push/events'),
          (_) async => null,
        );
  });
  tearDown(() => SpaceStorage.active = null);
  testWidgets('Space deletion requires confirmation and survives reopening', (
    tester,
  ) async {
    final disk = MemorySpacePersistence();
    final catalog = SpaceCatalog(persistence: disk);
    const space = SpaceRecord(
      id: 'delete-me',
      name: '测试 Space',
      mode: SpaceMode.standalone,
    );
    await catalog.open();
    await catalog.add(space);
    await catalog.select(null);
    await tester.pumpWidget(
      MaterialApp(
        home: SpaceRoot(
          catalog: catalog,
          standaloneBuilder: (_) => const SizedBox(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    Future<void> openConfirmation() async {
      await tester.tap(find.byTooltip('管理 Space'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('删除 Space'));
      await tester.pumpAndSettle();
    }

    await openConfirmation();
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(find.text(space.name), findsOneWidget);

    await openConfirmation();
    await tester.tap(find.text('删除'));
    await tester.pumpAndSettle();
    expect(find.text(space.name), findsNothing);
    expect(find.text('新建 Space'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    catalog.dispose();

    final reopened = SpaceCatalog(persistence: disk);
    await reopened.open();
    expect(reopened.spaces, isEmpty);
    expect(reopened.retired.single.id, space.id);
    reopened.dispose();
  });

  testWidgets('Space chooser and creation use the selected language only', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({'language': 'en'});
    final catalog = SpaceCatalog(persistence: MemorySpacePersistence());
    await tester.pumpWidget(
      MaterialApp(
        home: SpaceRoot(
          catalog: catalog,
          standaloneBuilder: (_) => const Text('Local runtime'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('New Space'), findsOneWidget);
    expect(find.text('新建 Space'), findsNothing);
    await tester.tap(find.text('New Space'));
    await tester.pumpAndSettle();
    expect(find.text('Create a Space'), findsOneWidget);
    expect(find.text('Name'), findsOneWidget);
    expect(
      find.text('新建 Space 不会带入旧 Space 的数据。要更换运行方式，请新建 Space。'),
      findsNothing,
    );
    await tester.pumpWidget(const SizedBox.shrink());
  });
  for (final failure in [
    'malformed manifest',
    'missing asset',
    'hash mismatch',
  ]) {
    for (final selectedExperience in [false, true]) {
      testWidgets(
        '$failure only disables experience, selected experience: $selectedExperience',
        (tester) async {
          final bundle = fixture();
          await ExperiencePersona.loadManifest(bundle: bundle);
          if (failure == 'malformed manifest') {
            bundle.files['assets/experience/manifest.json'] =
                Uint8List.fromList(utf8.encode('{broken'));
          } else if (failure == 'missing asset') {
            bundle.files.remove('assets/experience/sample.png');
          } else {
            bundle.files['assets/experience/sample.png'] = Uint8List.fromList([
              9,
            ]);
          }
          rootBundle.clear();
          final messenger =
              TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
          messenger.setMockMessageHandler('flutter/assets', (message) async {
            final key = utf8.decode(message!.buffer.asUint8List());
            final bytes = bundle.files[key];
            return bytes == null ? null : ByteData.sublistView(bytes);
          });
          addTearDown(() {
            messenger.setMockMessageHandler('flutter/assets', null);
            rootBundle.clear();
            ExperiencePersona.choices = const [];
          });
          const normal = SpaceRecord(
            id: 'normal',
            name: 'My Space',
            mode: SpaceMode.standalone,
          );
          final experience = SpaceRecord(
            id: 'sample-space',
            name: 'Sample Space',
            mode: SpaceMode.standalone,
            personaId: 'sample',
            experienceSeededAt: DateTime.utc(2026),
          );
          final disk = MemorySpacePersistence()
            ..value = jsonEncode({
              'selected': selectedExperience ? experience.id : normal.id,
              'spaces': [normal.toJson(), experience.toJson()],
            });
          final catalog = SpaceCatalog(persistence: disk);
          var experienceStarts = 0;
          await tester.pumpWidget(
            MaterialApp(
              home: SpaceRoot(
                catalog: catalog,
                standaloneBuilder: (space) {
                  if (space.personaId != null) experienceStarts++;
                  return Text('Opened ${space.id}');
                },
              ),
            ),
          );
          await tester.pumpAndSettle();
          if (!selectedExperience) {
            expect(find.text('Opened normal'), findsOneWidget);
            expect(catalog.selectedId, normal.id);
            await catalog.select(null);
            await tester.pumpAndSettle();
          }
          expect(experienceStarts, 0);
          expect(ExperiencePersona.choices, isEmpty);
          expect(find.text('体验 Space 暂不可用'), findsOneWidget);
          expect(find.text('选择示例人物或兑换体验码'), findsNothing);
          expect(find.text('My Space'), findsOneWidget);
          expect(catalog.spaces, hasLength(2));
          await tester.pumpWidget(const SizedBox.shrink());
          catalog.dispose();
        },
      );
    }
  }
  testWidgets(
    'Create Space page paints an opaque background over the transparent theme',
    (tester) async {
      // The app theme leaves scaffolds transparent; a pushed page without its
      // own background lets the Space list show through the iOS slide.
      final catalog = SlowCatalog();
      await tester.pumpWidget(
        MaterialApp(
          theme: novaTheme(),
          home: SpaceRoot(
            catalog: catalog,
            standaloneBuilder: (_) => const Text('Local'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('新建 Space'));
      await tester.pumpAndSettle();
      final page = tester.widget<Scaffold>(
        find
            .ancestor(
              of: find.text('创建 Space'),
              matching: find.byType(Scaffold),
            )
            .first,
      );
      expect(page.backgroundColor?.a, 1);
    },
  );
  testWidgets(
    'Space creation ignores a second tap while persistence is pending',
    (tester) async {
      final catalog = SlowCatalog();
      await tester.pumpWidget(
        MaterialApp(
          home: SpaceRoot(
            catalog: catalog,
            standaloneBuilder: (_) => const Text('Local'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('新建 Space'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, 'One');
      final submit = tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, '创建独立 Space'))
          .onPressed!;
      submit();
      submit();
      await tester.pump();
      expect(catalog.adds, 1);
      catalog.release.complete();
      await tester.pumpAndSettle();
      expect(catalog.spaces, hasLength(1));
    },
  );
  testWidgets(
    'Client scan opens one fingerprint and name confirmation before pairing',
    (tester) async {
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(
        const MethodChannel('dev.steenbakker.mobile_scanner/scanner/method'),
        (call) async => switch (call.method) {
          'state' => 1,
          'start' => {
            'textureId': 1,
            'size': {'width': 640.0, 'height': 480.0},
          },
          _ => null,
        },
      );
      for (final channel in ['event', 'deviceOrientation']) {
        messenger.setMockMethodCallHandler(
          MethodChannel('dev.steenbakker.mobile_scanner/scanner/$channel'),
          (_) async => null,
        );
      }
      final catalog = PairingCatalog();
      final identity = (await tester.runAsync(SpaceIdentity.generate))!;
      final fingerprint = signingFingerprint(identity.signingPublic);
      final invitation = jsonEncode({
        'id': 'invitation',
        'space': fingerprint,
        'host': 'host',
        'hostSigningPublicKey': identity.signingPublic,
        'relay': 'https://relay.example',
        'secret': 'one-time-secret',
        'expiresAt': DateTime.now().millisecondsSinceEpoch + 60000,
        'business_versions': [1],
      });
      await tester.pumpWidget(
        MaterialApp(
          home: SpaceRoot(
            catalog: catalog,
            standaloneBuilder: (_) => const Text('Local'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('新建 Space'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(TextField, '名称'), findsOneWidget);
      await tester.tap(find.text('连接 Host'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(TextField, '名称'), findsNothing);
      await tester.tap(find.text('扫描 Host 邀请码'));
      await tester.pump();
      final detect = tester
          .widget<MobileScanner>(find.byType(MobileScanner))
          .onDetect!;
      final capture = BarcodeCapture(barcodes: [Barcode(rawValue: invitation)]);
      detect(capture);
      detect(capture);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text('连接电脑'), findsOneWidget);
      expect(find.text(fingerprint), findsOneWidget);
      expect(find.text('我的电脑'), findsOneWidget);
      expect(find.text('Space 名称'), findsOneWidget);
      expect(catalog.pairingCalls, 0);
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(find.text('已读取电脑邀请码，可继续确认连接。'), findsOneWidget);
      expect(catalog.pairingCalls, 0);
      expect(catalog.created, isNull);
      expect(await const FlutterSecureStorage().readAll(), isEmpty);
      detect(capture);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      await tester.scrollUntilVisible(
        find.text('确认连接电脑'),
        250,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('确认连接电脑'));
      await tester.pumpAndSettle();
      expect(find.text(fingerprint), findsOneWidget);
      final name = find.descendant(
        of: find.byType(AlertDialog),
        matching: find.byType(TextField),
      );
      await tester.enterText(name, '书房电脑');
      await tester.tap(find.text('确认绑定'));
      await tester.runAsync(() async {
        for (
          var attempts = 0;
          attempts < 100 && catalog.created == null;
          attempts++
        ) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
      });
      await tester.pumpAndSettle();
      expect(catalog.pairingCalls, 1);
      expect(catalog.created?.name, '书房电脑');
      expect(catalog.created?.mode, SpaceMode.client);
      expect(find.text('暂时无法连接电脑，请检查网络后重试。'), findsOneWidget);
      expect(find.textContaining('HandshakeException'), findsNothing);
      expect(find.textContaining('private-relay'), findsNothing);
    },
  );

  test(
    'opening a catalog twice never duplicates its persisted Spaces',
    () async {
      const record = SpaceRecord(
        id: 'client',
        name: 'Remote',
        mode: SpaceMode.client,
      );
      final disk = MemorySpacePersistence()
        ..value = jsonEncode({
          'selected': record.id,
          'spaces': [record.toJson()],
        });
      final catalog = SpaceCatalog(persistence: disk);
      await Future.wait([catalog.open(), catalog.open()]);
      await catalog.open();
      expect(catalog.spaces.map((space) => space.id), ['client']);
    },
  );
  testWidgets(
    'unconfigured install asks user to choose a Space before starting runtime',
    (tester) async {
      var starts = 0;
      final catalog = SpaceCatalog(persistence: MemorySpacePersistence());
      await tester.pumpWidget(
        MaterialApp(
          home: SpaceRoot(
            catalog: catalog,
            standaloneBuilder: (_) {
              starts++;
              return const Text('Local runtime');
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(starts, 0);
      expect(find.text('新建 Space'), findsOneWidget);
    },
  );
  testWidgets(
    'Client selection routes exclusively to Client UI after native scope activation',
    (tester) async {
      var starts = 0;
      final record = SpaceRecord(
        id: 'client',
        name: 'Remote',
        mode: SpaceMode.client,
        remoteSpace: 'remote',
      );
      final disk = MemorySpacePersistence()
        ..value = jsonEncode({
          'selected': 'client',
          'spaces': [record.toJson()],
        });
      final catalog = SpaceCatalog(persistence: disk);
      await tester.pumpWidget(
        MaterialApp(
          home: SpaceRoot(
            catalog: catalog,
            clientBuilder: (_) => const Text('Client UI'),
            standaloneBuilder: (_) {
              starts++;
              return const Text('Local runtime');
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(starts, 0);
      expect(find.text('Client UI'), findsOneWidget);
      expect(SpaceStorage.allowsLocalRuntime, false);
    },
  );
  test(
    'catalog preserves immutable modes and scoped keys across async switch',
    () async {
      final disk = MemorySpacePersistence();
      final catalog = SpaceCatalog(persistence: disk);
      await catalog.open();
      const one = SpaceRecord(id: 'one', name: 'A', mode: SpaceMode.standalone);
      const two = SpaceRecord(id: 'two', name: 'B', mode: SpaceMode.client);
      await catalog.add(one);
      final scoped = SpaceStorage.runScoped(one, () async {
        await Future<void>.delayed(Duration.zero);
        return SpaceStorage.secureKey('key');
      });
      await catalog.add(two);
      expect(await scoped, 'key.space.one');
      expect(SpaceStorage.secureKey('key'), 'key.space.two');
      final restored = SpaceCatalog(persistence: disk);
      await restored.open();
      expect(restored.spaces.map((s) => s.mode), [
        SpaceMode.standalone,
        SpaceMode.client,
      ]);
      expect(restored.selected!.id, 'two');
    },
  );
  test(
    'notification handle selects its own Space even when another is active',
    () async {
      const one = SpaceRecord(id: 'one', name: 'A', mode: SpaceMode.client);
      const two = SpaceRecord(id: 'two', name: 'B', mode: SpaceMode.client);
      SpaceStorage.active = two;
      expect(
        await SpaceNotificationRouter.resolve(
          'handle-a',
          [one, two],
          readRegistration: (space) async => jsonEncode({
            'handle': space.id == 'one' ? 'handle-a' : 'handle-b',
          }),
        ),
        'one',
      );
    },
  );
  testWidgets(
    'only the standalone page removes the inset already consumed by the strip',
    (tester) async {
      double? standaloneTop;
      final standalone = SpaceRecord(
        id: 'local',
        name: 'Local',
        mode: SpaceMode.standalone,
      );
      final standaloneCatalog = SpaceCatalog(
        persistence: MemorySpacePersistence()
          ..value = jsonEncode({
            'selected': standalone.id,
            'spaces': [standalone.toJson()],
          }),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: const MediaQueryData(padding: EdgeInsets.only(top: 47)),
            child: SpaceRoot(
              catalog: standaloneCatalog,
              standaloneBuilder: (_) => Builder(
                builder: (context) {
                  standaloneTop = MediaQuery.paddingOf(context).top;
                  return const Text('Local runtime');
                },
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      // The strip's SafeArea consumed the inset; the page must not add it twice.
      expect(standaloneTop, 0);
      expect(find.text('Local runtime'), findsOneWidget);
      expect(find.textContaining('独立运行'), findsOneWidget);

      // Unmount before switching modes: the shell keeps one catalog per state.
      await tester.pumpWidget(const SizedBox());
      double? clientTop;
      final client = SpaceRecord(
        id: 'client',
        name: 'Remote',
        mode: SpaceMode.client,
        remoteSpace: 'remote',
      );
      final clientCatalog = SpaceCatalog(
        persistence: MemorySpacePersistence()
          ..value = jsonEncode({
            'selected': client.id,
            'spaces': [client.toJson()],
          }),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: MediaQuery(
            data: const MediaQueryData(padding: EdgeInsets.only(top: 47)),
            child: SpaceRoot(
              catalog: clientCatalog,
              standaloneBuilder: (_) => const SizedBox(),
              clientBuilder: (_) => Builder(
                builder: (context) {
                  clientTop = MediaQuery.paddingOf(context).top;
                  return const Text('Client UI');
                },
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(clientTop, 47);
      expect(find.text('Client UI'), findsOneWidget);
    },
  );

  testWidgets('Client Space screens render no CJK text in an English locale', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    tester.platformDispatcher.localeTestValue = const Locale('en', 'US');
    addTearDown(tester.platformDispatcher.clearLocaleTestValue);
    final state = SpaceClientState(MemorySpacePersistence())
      ..hostOnline = true
      ..snapshot = {
        'schema_version': 1,
        'owner': true,
        'goals': [
          {
            'id': 'g1',
            'title': 'Ship the client',
            'status': 'active',
            'version': 1,
          },
        ],
        'todos': [
          {'id': 't1', 'title': 'Check icons', 'status': 'open', 'version': 1},
        ],
        'ideas': <Object>[],
        'profile': {'about': 'Engineer', 'version': 1},
        'notifications': [
          {
            'id': 'n1',
            'title': 'Host finished',
            'body': 'Three inputs processed.',
          },
        ],
        'feed': [
          {'id': 'f1', 'title': 'Morning brief', 'body': 'Cloudy today.'},
        ],
        'timeline': <Object>[],
        'conversations': [
          {
            'id': 'chat:main',
            'kind': 'main',
            'mode': 'chat',
            'opening_empty': false,
          },
          {
            'id': 'topic:1',
            'kind': 'topic',
            'title': 'Fix tests',
            'preview': 'Running checks',
          },
        ],
        'pending_approvals': [
          {
            'id': 'ap1',
            'conversation_id': 'chat:main',
            'summary': 'Run npm test',
            'kind': 'command_execution',
            'allowed_decisions': ['accept', 'decline'],
            'expires_at': null,
          },
          {
            'id': 'ap2',
            'conversation_id': 'topic:1',
            'summary': 'Edit README',
            'kind': 'file_change',
            'allowed_decisions': ['accept', 'decline'],
            'expires_at': 1,
          },
        ],
        'host_settings': {'devices': <Object>[]},
      };
    state.messages.addAll([
      {'role': 'user', 'turn_id': 'a', 'text': 'Hello?', 'status': 'done'},
      {
        'role': 'assistant',
        'turn_id': 'a',
        'text': 'Hi there.',
        'status': 'done',
      },
      {
        'role': 'user',
        'turn_id': 'b',
        'text': 'Again',
        'status': 'failed',
        'error': 'chat_expired',
      },
      {
        'role': 'assistant',
        'turn_id': 'c',
        'text': '',
        'status': 'failed',
        'failure_reason': 'quota',
      },
    ]);
    state.pending.add({
      'op_id': 'p1',
      'kind': 'life.mutate',
      'input': <String, dynamic>{},
      'status': 'rejected',
      'error': 'invalid',
    });
    await pumpClient(tester, state, language: null);
    await tester.pump();
    final cjk = RegExp(r'[　-〿㐀-鿿＀-￯]');
    void expectNoCjk(String screen) {
      final texts = <String>[
        for (final widget in tester.allWidgets)
          if (widget is Text)
            widget.data ?? widget.textSpan?.toPlainText() ?? ''
          else if (widget is RichText)
            widget.text.toPlainText()
          else if (widget is Tooltip)
            widget.message ?? ''
          else if (widget is Semantics)
            widget.properties.label ?? '',
      ];
      expect(texts.where(cjk.hasMatch).toList(), isEmpty, reason: screen);
    }

    expect(find.text('Approval needed · Run a command'), findsOneWidget);
    expect(find.text('Message Host'), findsOneWidget);
    expectNoCjk('chat');
    for (final (label, screen) in [
      ('Tasks', 'tasks'),
      ('Timeline', 'timeline'),
      ('Me', 'me'),
    ]) {
      await tester.tap(
        find.descendant(
          of: find.byType(BottomAppBarTabs),
          matching: find.text(label),
        ),
      );
      await tester.pump();
      await tester.pump();
      expectNoCjk(screen);
    }
    expect(find.text('Me'), findsWidgets);
    await tester.tap(find.byTooltip('Settings'));
    await tester.pumpAndSettle();
    expectNoCjk('settings');
    await tester.tap(find.text('Devices'));
    await tester.pumpAndSettle();
    expectNoCjk('devices');
  });

  testWidgets('Standalone Space bar follows the selected language', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StandaloneSpaceBar(
            space: const SpaceRecord(
              id: 's',
              name: 'Desk',
              mode: SpaceMode.standalone,
              device: 'd',
            ),
            onSwitch: () {},
            onSettings: () {},
            language: 'en',
          ),
        ),
      ),
    );
    expect(find.textContaining('On this device'), findsOneWidget);
    expect(find.byTooltip('Settings'), findsOneWidget);
  });
}
