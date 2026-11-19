import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/connectors/feishu/host.dart';
import 'package:nova_mobile/context/source_store.dart';
import 'package:nova_mobile/personal/local_life.dart';

/// Fails the first secure-storage read, like a locked phone at cold start.
class _FlakyPersistence implements LifePersistence {
  String? value;
  bool fail = true;
  int reads = 0;
  @override
  Future<String?> read() async {
    reads++;
    if (fail) throw StateError('locked');
    return value;
  }

  @override
  Future<void> write(String next) async => value = next;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test('a failed open is retryable and marks local data restored', () async {
    final disk = _FlakyPersistence();
    final host = FeishuHost(sources: SourceStore(disk));
    await expectLater(host.open(), throwsA(isA<StateError>()));
    expect(host.restored, false);
    expect(host.ready, false);
    disk.fail = false;
    var notifications = 0;
    host.addListener(() => notifications++);
    await host.open();
    expect(host.restored, true);
    // Restored means local state is readable, not that Feishu is authorized.
    expect(host.ready, false);
    // A retry must not attach the source listener twice.
    notifications = 0;
    await host.sources.bind('identity', 1);
    expect(notifications, 1);
    host.dispose();
  });

  test('a successful open keeps restored true without double opening', () async {
    final disk = _FlakyPersistence()..fail = false;
    final host = FeishuHost(sources: SourceStore(disk));
    var notifications = 0;
    host.addListener(() => notifications++);
    await host.open();
    await host.open();
    expect(host.restored, true);
    expect(notifications, 1);
    host.dispose();
  });
}
