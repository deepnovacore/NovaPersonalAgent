import 'support/mobile_navigation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'support/fake_audio.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

Future<void> mount(WidgetTester tester, LocalLife repo) async {
  FlutterSecureStorage.setMockInitialValues({});
  SharedPreferences.setMockInitialValues({});
  final audioConfig = (
    audio: FakeAudio(),
    requestMicrophone: () async => false,
  );

  await tester.pumpWidget(
    NovaApp(
      audio: audioConfig.audio,
      requestMicrophone: audioConfig.requestMicrophone,

      preferences: Preferences(await SharedPreferences.getInstance()),
      lifeHost: LifeHost(repository: repo),
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  testWidgets('profile reads and edits phone data without a computer', (
    tester,
  ) async {
    final repo = LocalLife(MemoryLifePersistence());
    await repo.open();
    await repo.mutate({
      'op': 'profile',
      'about': 'A phone-owned profile',
      'expected_version': 0,
    });
    await mount(tester, repo);
    await tester.tap(find.text('Me'));
    await tester.pump();
    await tester.tap(find.text('Profile'));
    await tester.pumpAndSettle();
    expect(find.text('A phone-owned profile'), findsOneWidget);
    expect(find.textContaining('Reconnect to make changes'), findsNothing);
    await tester.tap(find.text('Edit'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byType(TextField).last,
      'Updated on this phone',
    );
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    expect(repo.life['profile']['about'], 'Updated on this phone');
    expect(find.text('Updated on this phone'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('dismissing focused Hub settings keeps the workspace usable', (
    tester,
  ) async {
    FlutterSecureStorage.setMockInitialValues({});
    final repo = LocalLife(MemoryLifePersistence());
    await repo.open();
    await mount(tester, repo);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await openSettingsItem(tester, 'Data sync');
    await tester.tap(find.byTooltip('同步设置'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(find.text('Advanced: manual connection'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).at(1), 'https://hub.example');
    await tester.pageBack();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(tester.takeException(), isNull);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(find.byTooltip('同步设置'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('Connect sync Hub'), findsOneWidget);
    await tester.pageBack();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
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
      await openLibrary(tester, 'Todos');
      expect(find.text('Read locally'), findsOneWidget);
      expect(find.byTooltip('本机空间'), findsNothing);
      expect(find.textContaining('1 项待同步'), findsNothing);
      await tester.pageBack();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      await openLibrary(tester, 'Goals');
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
        await openLibrary(tester, entry.key);
        expect(find.text('Local ${entry.value}'), findsOneWidget);
        expect(identical(host.store, store), isTrue);
        await tester.pageBack();
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
      }
      await openSettingsItem(tester, 'Data sync');
      await tester.tap(find.byTooltip('同步设置'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pageBack();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(identical(host.store, store), isTrue);
      expect(host.snapshot()['todos'], hasLength(1));
      await tester.pumpWidget(const SizedBox());
    },
  );
}
