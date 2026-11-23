import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/host_panel.dart';
import 'package:nova_mobile/space/push_client.dart';
import 'package:nova_mobile/space/source_panel.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

final _cjk = RegExp(r'[　-〿㐀-鿿＀-￯]');

void _expectNoCjk(WidgetTester tester, String screen) {
  final texts = <String>[
    for (final widget in tester.allWidgets)
      if (widget is Text)
        widget.data ?? widget.textSpan?.toPlainText() ?? ''
      else if (widget is RichText)
        widget.text.toPlainText()
      else if (widget is Tooltip)
        widget.message ?? '',
  ];
  expect(texts.where(_cjk.hasMatch).toList(), isEmpty, reason: screen);
}

Future<void> _pump(WidgetTester tester, Widget child) async {
  tester.view.physicalSize = const Size(800, 6000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: ListView(children: [child])),
    ),
  );
}

void main() {
  testWidgets('Host panel renders no CJK text in English', (tester) async {
    final state = SpaceClientState(MemorySpacePersistence());
    state.snapshot = {
      'schema_version': 1,
      'owner': true,
      'host_settings': {
        'identity': {'assistant_name': 'Nova', 'user_name': 'Sam'},
        'soul': {'available': true, 'role': 'Helper', 'version': 1},
        'discovery': {'discovery_enabled': true},
        'news': {'enabled': true, 'explore': true, 'interests': <Object>[]},
      },
      'host_credentials': {
        'damaged': false,
        'credentials': [
          {'name': 'ARK_API_KEY', 'configured': false},
          {'name': 'OPENAI_API_KEY', 'configured': true, 'source': 'space'},
          {
            'name': 'DASHSCOPE_API_KEY',
            'configured': true,
            'source': 'environment',
          },
          {'name': 'UNKNOWN_KEY', 'configured': false},
        ],
      },
      'host_feishu': {
        'configured': true,
        'connected': false,
        'login_pending': true,
        'verification_url': 'https://example.test/auth',
      },
    };
    await _pump(
      tester,
      SpaceHostPanel(state: state, onSync: () async {}, language: 'en'),
    );
    expect(find.text('Host settings'), findsOneWidget);
    _expectNoCjk(tester, 'host panel');
    await tester.tap(find.byKey(const ValueKey('host.assistant_name')));
    await tester.pumpAndSettle();
    expect(find.text('Cancel'), findsOneWidget);
    _expectNoCjk(tester, 'host panel dialog');
  });

  testWidgets('Source panel renders no CJK text in English', (tester) async {
    final state = SpaceClientState(MemorySpacePersistence());
    await state.open();
    state.snapshot = {
      'processing_provider': {'id': 'p', 'label': 'Model'},
      'source_processing': {'status': 'ready', 'needs_update': true},
    };
    await _pump(
      tester,
      SpaceSourcePanel(state: state, onSync: () async {}, language: 'en'),
    );
    _expectNoCjk(tester, 'source panel');
    await tester.tap(find.text('Send input'));
    await tester.pumpAndSettle();
    _expectNoCjk(tester, 'collect dialog');
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Correct profile'));
    await tester.pumpAndSettle();
    _expectNoCjk(tester, 'correction dialog');
  });

  testWidgets('Push notification status follows the platform language', (
    tester,
  ) async {
    tester.platformDispatcher.localeTestValue = const Locale('en', 'US');
    addTearDown(tester.platformDispatcher.clearLocaleTestValue);
    SpacePushClient make() => SpacePushClient(
      const SpaceRecord(id: 's', name: 'S', mode: SpaceMode.client),
      null,
      onWake: () async {},
      persistence: MemorySpacePersistence(),
      installationPersistence: MemorySpacePersistence(),
      gatewayUrl: '',
    );
    final en = make();
    expect(en.status, 'Lock-screen notifications are not enabled yet');
    expect(_cjk.hasMatch(en.status), isFalse);
    tester.platformDispatcher.localeTestValue = const Locale('zh', 'CN');
    expect(make().status, '尚未启用锁屏通知');
  });
}
