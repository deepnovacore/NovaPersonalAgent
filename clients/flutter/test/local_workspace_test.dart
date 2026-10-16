import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/connection/session.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'support/fake_audio.dart';
import 'conversation_widget_test.dart' show MemoryCredentials;
import 'local_life_test.dart' show MemoryLifePersistence;

Future<void> mount(WidgetTester tester, LocalLife repo) async {
  FlutterSecureStorage.setMockInitialValues({});
  SharedPreferences.setMockInitialValues({});
  final session = Session(
    audio: FakeAudio(),
    requestMicrophone: () async => false,
  );
  addTearDown(session.dispose);
  await tester.pumpWidget(
    NovaApp(
      session: session,
      store: MemoryCredentials(),
      preferences: Preferences(await SharedPreferences.getInstance()),
      lifeHost: LifeHost(repository: repo),
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));
  await tester.tap(find.text("Todos").last);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('dismissing focused Hub settings keeps the workspace usable', (
    tester,
  ) async {
    FlutterSecureStorage.setMockInitialValues({});
    final repo = LocalLife(MemoryLifePersistence());
    await repo.open();
    await mount(tester, repo);
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('同步设置'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).first, 'https://hub.example');
    await tester.tap(find.text('取消'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.takeException(), isNull);
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('同步设置'));
    await tester.pumpAndSettle();
    expect(find.text('连接同步 Hub'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
  });
  testWidgets(
    'local workspace shows editable todos without connecting a host',
    (tester) async {
      final repo = LocalLife(MemoryLifePersistence());
      await repo.open();
      await repo.mutate({
        'op': 'create',
        'kind': 'todo',
        'title': 'Read locally',
      });
      await mount(tester, repo);
      await tester.tap(find.text("Todos").last);
      await tester.pumpAndSettle();
      expect(find.text('Read locally'), findsOneWidget);
      expect(find.byTooltip('本机空间'), findsNothing);
      expect(find.textContaining('1 项待同步'), findsOneWidget);
      await tester.tap(find.text('Goals'));
      await tester.pumpAndSettle();
      expect(find.byTooltip('New goal'), findsOneWidget);
    },
  );
  testWidgets(
    'tabs and settings retain one local store across foreground changes',
    (tester) async {
      final repo = LocalLife(MemoryLifePersistence());
      await repo.open();
      for (final kind in ['todo', 'idea', 'goal']) {
        await repo.mutate({
          'op': 'create',
          'kind': kind,
          'title': 'Local $kind',
        });
      }
      await mount(tester, repo);
      final host = tester.widget<NovaApp>(find.byType(NovaApp)).lifeHost!;
      final store = host.store;
      for (final entry in {
        'Todos': 'todo',
        'Ideas': 'idea',
        'Goals': 'goal',
      }.entries) {
        await tester.tap(find.text(entry.key).last);
        await tester.pumpAndSettle();
        expect(find.text('Local ${entry.value}'), findsOneWidget);
        expect(identical(host.store, store), isTrue);
      }
      await tester.tap(find.byTooltip('同步设置'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(identical(host.store, store), isTrue);
      expect(host.snapshot()['todos'], hasLength(1));
      await tester.pumpWidget(const SizedBox());
    },
  );
}
