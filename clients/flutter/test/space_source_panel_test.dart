import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/source_panel.dart';
import 'space_client_test.dart' show MemorySpacePersistence;

void main() {
  testWidgets(
    'Client source input requires upload consent and creates dependent Host intents',
    (tester) async {
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      state.snapshot = {
        'processing_provider': {
          'id': 'https://model.example|v1',
          'label': 'Model v1',
        },
      };
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SpaceSourcePanel(state: state, onSync: () async {}),
          ),
        ),
      );
      await tester.tap(find.text('发送采集输入'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byType(TextField).at(1),
        'I prefer walking to work.',
      );
      var button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, '授权并发送'),
      );
      expect(button.onPressed, isNull);
      await tester.ensureVisible(find.text('允许将这份内容发送并保存在 Host'));
      await tester.tap(find.text('允许将这份内容发送并保存在 Host'));
      await tester.pump();
      await tester.ensureVisible(find.text('授权并发送'));
      await tester.tap(find.text('授权并发送'));
      await tester.pumpAndSettle();
      expect(state.pending.length, 2);
      expect(
        (state.pending.last['depends_on'] as List).single,
        state.pending.first['op_id'],
      );
      expect((state.pending.first['input'] as Map)['allow_processing'], false);
    },
  );
  testWidgets(
    'source receipts and Host processing status remain distinct with cached offline labels',
    (tester) async {
      final state = SpaceClientState(MemorySpacePersistence());
      await state.open();
      await state.collectSource(
        name: 'Phone note',
        text: 'A user supplied fact',
        provider: 'https://model.example|v1',
        allowProcessing: true,
      );
      final grant = state.pending.first['op_id'],
          fact = state.pending.last['op_id'];
      await state.apply({
        'v': 1,
        'type': 'receipt',
        'op_id': grant,
        'status': 'accepted',
      });
      await state.apply({
        'v': 1,
        'type': 'receipt',
        'op_id': fact,
        'status': 'accepted',
      });
      var revision = 0;
      Future<void> showStatus(
        String status, {
        bool online = true,
        bool needsUpdate = false,
      }) async {
        state.hostOnline = online;
        await state.apply({
          'v': 1,
          'type': 'snapshot',
          'snapshot': {
            'schema_version': 1,
            'revision': ++revision,
            'source_processing': {
              'status': status,
              'needs_update': needsUpdate,
            },
          },
        });
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SingleChildScrollView(
                child: SpaceSourcePanel(state: state, onSync: () async {}),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      await showStatus('idle');
      expect(find.textContaining('Host 已收妥'), findsOneWidget);
      expect(find.text('等待 Host 处理'), findsOneWidget);
      await showStatus('working');
      expect(find.text('Host 正在处理采集内容'), findsOneWidget);
      expect(find.text('Host 已完成处理'), findsNothing);
      await showStatus('ready');
      expect(find.text('Host 已完成处理'), findsOneWidget);
      expect(find.text('Host 处理汇总'), findsOneWidget);
      await showStatus('ready', needsUpdate: true);
      expect(find.text('Host 已完成上次处理'), findsOneWidget);
      expect(find.text('Host 已完成处理'), findsNothing);
      expect(find.text('有新内容等待更新'), findsOneWidget);
      await showStatus('failed');
      expect(find.text('Host 处理失败，请检查 Host'), findsOneWidget);
      await showStatus('future-state', needsUpdate: true);
      expect(find.text('等待 Host 处理'), findsOneWidget);
      expect(find.textContaining('有新内容等待更新'), findsOneWidget);
      await showStatus('ready', online: false);
      expect(find.text('Host 已完成处理'), findsOneWidget);
      expect(find.textContaining('Host 不在线，显示上次处理状态'), findsOneWidget);

      await state.apply({
        'v': 1,
        'type': 'snapshot',
        'snapshot': {'schema_version': 1, 'revision': ++revision},
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SpaceSourcePanel(state: state, onSync: () async {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('等待 Host 提供处理状态'), findsOneWidget);
      expect(find.text('Host 不在线，等待获取处理状态'), findsOneWidget);
      expect(find.text('Host 已完成处理'), findsNothing);
    },
  );
}
