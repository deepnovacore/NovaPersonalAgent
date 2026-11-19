import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/reconnect_page.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

SpaceClientState fresh() => SpaceClientState(MemorySpacePersistence());

void main() {
  final t0 = DateTime.utc(2026, 11, 1, 10);

  test('a working channel keeps a failing one from looking disconnected', () {
    final state = fresh()..hostOnline = true;
    state.markFailure('SocketException');
    state.markFailure('SocketException');
    state.markFailure('SocketException');
    state.markOk(t0);
    state.markFailure('SocketException');
    expect(
      state.linkStatus(t0.add(const Duration(seconds: 5))),
      SpaceLinkStatus.degraded,
    );
  });

  test('only repeated failures with no recent success disconnect', () {
    final state = fresh()..hostOnline = true;
    state.markFailure('SocketException');
    expect(state.linkStatus(t0), SpaceLinkStatus.connecting);
    state.markFailure('SocketException');
    state.markFailure('SocketException');
    expect(state.linkStatus(t0), SpaceLinkStatus.disconnected);
    state.markOk(t0);
    expect(state.error, isNull);
    expect(state.linkStatus(t0), SpaceLinkStatus.online);
  });

  test('success never clears a fatal condition and stale success expires', () {
    final state = fresh()..hostOnline = true;
    state.markFailure('device revoked');
    state.markOk(t0);
    expect(state.linkStatus(t0), SpaceLinkStatus.blocked);
    final other = fresh()..hostOnline = true;
    other.markOk(t0);
    for (var i = 0; i < 3; i++) {
      other.markFailure('timeout');
    }
    expect(
      other.linkStatus(t0.add(const Duration(seconds: 60))),
      SpaceLinkStatus.disconnected,
    );
  });

  testWidgets('the reconnect page offers a retry and shows progress', (
    tester,
  ) async {
    var retries = 0;
    Future<void> pump(bool reconnecting) => tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SpaceReconnectPage(
            reconnecting: reconnecting,
            lastOkAt: DateTime(2026, 11, 1, 9, 5),
            onRetry: () => retries++,
          ),
        ),
      ),
    );
    await pump(false);
    expect(find.text('暂时连不上你的空间'), findsOneWidget);
    expect(find.text('上次同步 09:05'), findsOneWidget);
    await tester.tap(find.text('重新连接'));
    expect(retries, 1);
    await pump(true);
    expect(find.text('正在重新连接…'), findsOneWidget);
    expect(
      tester.widget<FilledButton>(find.byType(FilledButton)).onPressed,
      isNull,
    );
  });
}
