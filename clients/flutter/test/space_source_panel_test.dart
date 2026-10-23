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
}
