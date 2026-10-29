import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/space/notification_router.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:nova_mobile/space/native_scope.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/space_root.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
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
}
