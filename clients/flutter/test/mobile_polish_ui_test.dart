import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/space_root.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'package:nova_mobile/ui/tool_step.dart';

void main() {
  testWidgets(
    'global Space header keeps settings and switching accessible on narrow screens',
    (tester) async {
      tester.view.physicalSize = const Size(320, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      var settings = 0, switches = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StandaloneSpaceBar(
              space: const SpaceRecord(
                id: 'local',
                name: 'My long Space name',
                mode: SpaceMode.standalone,
              ),
              onSwitch: () => switches++,
              onSettings: () => settings++,
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(const ValueKey('global.settings')));
      await tester.tap(find.text('Space'));
      expect(settings, 1);
      expect(switches, 1);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'tool steps distinguish completed rejected and cancelled safely',
    (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: Column(
              children: [
                ToolStep(name: 'file_write', status: 'completed'),
                ToolStep(name: 'shell_execute', status: 'rejected'),
                ToolStep(name: 'web_fetch', status: 'cancelled'),
                ToolStep(name: '', status: 'outcome_unknown'),
              ],
            ),
          ),
        ),
      );
      expect(find.text('写入文件 · 已完成'), findsOneWidget);
      expect(find.text('执行命令 · 未执行'), findsOneWidget);
      expect(find.text('读取网页 · 已取消'), findsOneWidget);
      expect(find.text('使用工具 · 结果待核实'), findsOneWidget);
      await tester.tap(find.text('写入文件 · 已完成'));
      await tester.pumpAndSettle();
      expect(find.textContaining('file_write'), findsOneWidget);
    },
  );
}
