import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/personal/life_host.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/ui/devices_page.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'local_life_test.dart' show MemoryLifePersistence;

void main() {
  for (final language in ['zh', 'en']) {
    testWidgets(
      'independent Space describes this device without network setup ($language)',
      (tester) async {
        final host = LifeHost(repository: LocalLife(MemoryLifePersistence()));
        addTearDown(host.dispose);
        await tester.pumpWidget(
          MaterialApp(
            theme: novaTheme(),
            home: DevicesPage(host: host, language: language),
          ),
        );
        expect(
          find.text(language == 'zh' ? '这台设备' : 'This device'),
          findsOneWidget,
        );
        expect(
          find.text(
            language == 'zh'
                ? '独立运行，数据保存在本机。'
                : 'Independent Space. Data stays on this device.',
          ),
          findsOneWidget,
        );
      },
    );
  }
}
