import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/host_panel.dart';
import 'space_client_test.dart' show MemorySpacePersistence;
import 'support/space_client_fixture.dart';

SpaceClientState stateWith(Map<String, dynamic> extra) {
  final state = SpaceClientState(MemorySpacePersistence());
  state.snapshot = {'schema_version': 1, 'revision': 1, ...extra};
  return state;
}

Future<void> pump(
  WidgetTester tester,
  SpaceClientState state, {
  List<Uri>? opened,
}) async {
  tester.view.physicalSize = const Size(800, 6000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ListView(
          children: [
            SpaceHostPanel(
              state: state,
              onSync: () async {},
              openUrl: (uri) async => opened?.add(uri),
            ),
          ],
        ),
      ),
    ),
  );
}

void main() {
  setUpAll(loadSpaceTestFonts);

  testWidgets('hidden for a non-owner device', (tester) async {
    await pump(
      tester,
      stateWith({
        'owner': false,
        'host_credentials': [
          {'name': 'OPENAI_API_KEY', 'configured': false, 'source': null},
        ],
      }),
    );
    expect(find.text('Host 设置'), findsNothing);
    expect(find.text('OPENAI_API_KEY'), findsNothing);
  });

  testWidgets('owner edits enqueue settings.patch and credential intents', (
    tester,
  ) async {
    final state = stateWith({
      'owner': true,
      'host_settings': {
        'identity': {'assistant_name': 'nova', 'user_name': 'Ann'},
        'soul': {'available': false},
        'discovery': {'discovery_enabled': false},
        'news': {'interests': [], 'explore': true, 'profile_version': 0},
      },
      'host_credentials': [
        {
          'name': 'OPENAI_API_KEY',
          'configured': true,
          'source': 'space',
          'fingerprint': 'abcd1234',
        },
        {'name': 'GEMINI_API_KEY', 'configured': false, 'source': null},
      ],
      'host_feishu': {'configured': true, 'connected': false},
    });
    await pump(tester, state);
    await tester.tap(find.byKey(const ValueKey('host.discovery')).last);
    await tester.tap(find.byType(Switch));
    await tester.pump();
    expect(state.pending.single['kind'], 'settings.patch');
    expect(state.pending.single['input'], {
      'method': 'discovery.configure',
      'params': {'enabled': true},
    });
    await tester.tap(
      find.byKey(const ValueKey('host.credential.GEMINI_API_KEY')),
    );
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'g-secret');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(state.pending.last['kind'], 'secret.put');
    expect(state.pending.last['input'], {
      'name': 'GEMINI_API_KEY',
      'value': 'g-secret',
    });
    await tester.tap(
      find.byKey(const ValueKey('host.credential.clear.OPENAI_API_KEY')),
    );
    await tester.pump();
    expect(state.pending.last['kind'], 'secret.clear');
    expect(state.pending.last['input'], {'name': 'OPENAI_API_KEY'});
    // Queued offline name edits carry only their own field so neither reverts the other.
    await tester.tap(find.byKey(const ValueKey('host.assistant_name')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Nova2');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('host.user_name')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Bea');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    final identity = state.pending
        .where((op) => (op['input'] as Map)['method'] == 'identity.configure')
        .map((op) => (op['input'] as Map)['params'])
        .toList();
    expect(identity, [
      {'assistant_name': 'Nova2'},
      {'user_name': 'Bea'},
    ]);
  });

  testWidgets('Feishu card opens the Host verification URL and completes', (
    tester,
  ) async {
    final opened = <Uri>[];
    final state = stateWith({
      'owner': true,
      'host_feishu': {
        'configured': true,
        'connected': false,
        'verification_url': 'https://accounts.feishu.cn/device?code=x',
      },
    });
    await pump(tester, state, opened: opened);
    expect(find.text('等待在授权页确认'), findsOneWidget);
    expect(find.text('登录飞书'), findsNothing);
    expect(find.text('重新开始登录'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('host.feishu.open')));
    await tester.pump();
    expect(opened.single.host, 'accounts.feishu.cn');
    await tester.tap(find.byKey(const ValueKey('host.feishu.complete')));
    await tester.pump();
    expect(state.pending.single['kind'], 'connector.feishu');
    expect(state.pending.single['input'], {'action': 'complete'});
  });

  testWidgets('an expired Feishu link can be restarted from the phone', (
    tester,
  ) async {
    final state = stateWith({
      'owner': true,
      'host_feishu': {
        'configured': true,
        'connected': false,
        'login_pending': true,
        'verification_url': 'https://accounts.feishu.cn/device?code=old',
      },
    });
    await pump(tester, state);
    await tester.tap(find.byKey(const ValueKey('host.feishu.login')));
    await tester.pump();
    expect(state.pending.single['input'], {'action': 'login'});
  });

  test('conflict retry refreshes the version Host checks', () {
    final snapshot = {
      'host_settings': {
        'soul': {'version': 4},
        'news': {'profile_version': 7},
      },
    };
    Map<String, dynamic> patch(String method) => {
      'method': method,
      'params': {
        'interests': ['AI'],
        'expected_version': 1,
      },
    };
    expect(refreshSettingsPatch(patch('news.configure'), snapshot)['params'], {
      'interests': ['AI'],
      'expected_version': 7,
    });
    expect(
      refreshSettingsPatch(
        patch('soul.set'),
        snapshot,
      )['params']['expected_version'],
      4,
    );
    final identity = {
      'method': 'identity.configure',
      'params': {'user_name': 'x'},
    };
    expect(refreshSettingsPatch(identity, snapshot), identity);
  });
}
