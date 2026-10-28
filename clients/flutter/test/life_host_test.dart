import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  test(
    'one owner opens once; mutations survive restart and snapshot is readonly',
    () async {
      final disk = MemoryLifePersistence();
      final host = LifeHost(repository: LocalLife(disk));
      expect(identical(host.open(), host.open()), isTrue);
      await host.open();
      host.didChangeAppLifecycleState(AppLifecycleState.paused);
      final store = host.store;
      var changes = 0;
      host.changes.addListener(() => changes++);
      final input = {'op': 'create', 'kind': 'todo', 'title': 'Offline'};
      final first = await host.mutate(input, operationId: 'once');
      expect(await host.mutate(input, operationId: 'once'), first);
      expect(host.snapshot()['todos'], hasLength(1));
      expect(
        () => host.snapshot()['todos'][0]['title'] = 'Changed',
        throwsUnsupportedError,
      );
      expect(
        () => (host.snapshot()['todos'] as List).clear(),
        throwsUnsupportedError,
      );
      expect(changes, greaterThan(0));
      await host.open();
      expect(identical(host.store, store), isTrue);
      host.dispose();
      await expectLater(
        host.mutate(input, operationId: 'late'),
        throwsStateError,
      );
      final restored = LifeHost(repository: LocalLife(disk));
      await restored.open();
      restored.didChangeAppLifecycleState(AppLifecycleState.paused);
      expect(await restored.mutate(input, operationId: 'once'), first);
      expect(restored.snapshot()['todos'], hasLength(1));
      restored.dispose();
    },
  );
}
