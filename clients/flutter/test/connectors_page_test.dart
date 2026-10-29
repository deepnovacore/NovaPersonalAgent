import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/components.dart';
import 'package:nova_mobile/ui/connectors_page.dart';
import 'package:nova_mobile/ui/theme.dart';

const _subtitle = '读取你授权的飞书消息，用于近况与时间线。';

/// Mirrors the five states the shell projects from `FeishuHost`.
const _statuses = <FeishuConnectorStatus>[
  (label: '正在读取本机资料…', subtitle: _subtitle, tone: NovaTone.neutral),
  (label: '未连接', subtitle: _subtitle, tone: NovaTone.neutral),
  (label: '等待授权', subtitle: _subtitle, tone: NovaTone.warning),
  (label: '正在同步消息', subtitle: _subtitle, tone: NovaTone.active),
  (label: '已连接', subtitle: _subtitle, tone: NovaTone.success),
];

const _zhStatus = (label: '未连接', subtitle: _subtitle, tone: NovaTone.neutral);

const _enStatus = (
  label: 'Not connected',
  subtitle: _subtitle,
  tone: NovaTone.neutral,
);

Color _toneColor(NovaTone tone) => switch (tone) {
  NovaTone.active || NovaTone.success => Nova.mint,
  NovaTone.warning => Nova.amber,
  NovaTone.danger => Nova.red,
  NovaTone.neutral => Nova.secondary,
};

Widget _app({
  required FeishuConnectorStatus status,
  String language = 'zh',
  VoidCallback? onOpenFeishu,
}) => MaterialApp(
  theme: novaTheme(),
  home: ConnectorsPage(
    language: language,
    feishuStatus: status,
    onOpenFeishu: onOpenFeishu ?? () {},
  ),
);

NovaStatusChip _feishuChip(WidgetTester tester, String label) =>
    tester.widget<NovaStatusChip>(find.widgetWithText(NovaStatusChip, label));

void main() {
  testWidgets('renders the five projected Feishu statuses with label, '
      'subtitle and tone', (tester) async {
    for (final status in _statuses) {
      await tester.pumpWidget(_app(status: status));
      await tester.pumpAndSettle();
      expect(find.text(status.label), findsOneWidget);
      expect(find.text(status.subtitle), findsOneWidget);
      final chip = _feishuChip(tester, status.label);
      expect(chip.tone, status.tone);
      final label = tester.widget<Text>(
        find.descendant(
          of: find.byType(NovaStatusChip),
          matching: find.text(status.label),
        ),
      );
      expect(label.style?.color, _toneColor(status.tone));
    }
  });

  testWidgets('status chip supports every palette tone', (tester) async {
    for (final tone in NovaTone.values) {
      final status = (
        label: 'status-${tone.name}',
        subtitle: _subtitle,
        tone: tone,
      );
      await tester.pumpWidget(_app(status: status));
      await tester.pumpAndSettle();
      final label = tester.widget<Text>(
        find.descendant(
          of: find.byType(NovaStatusChip),
          matching: find.text(status.label),
        ),
      );
      expect(label.style?.color, _toneColor(tone));
    }
  });

  testWidgets('tapping the Feishu row opens the connector settings', (
    tester,
  ) async {
    var opened = 0;
    await tester.pumpWidget(
      _app(status: _zhStatus, onOpenFeishu: () => opened++),
    );
    await tester.pumpAndSettle();
    expect(find.text('飞书'), findsOneWidget);
    await tester.tap(find.text('飞书'));
    await tester.pump();
    expect(opened, 1);
  });

  testWidgets('calendar and reminders are read-only and the footer explains '
      'authorization', (tester) async {
    var opened = 0;
    await tester.pumpWidget(
      _app(status: _zhStatus, onOpenFeishu: () => opened++),
    );
    await tester.pumpAndSettle();
    final title = find.text('日历与提醒事项');
    expect(title, findsOneWidget);
    expect(
      tester
          .widget<NovaTile>(
            find.ancestor(of: title, matching: find.byType(NovaTile)),
          )
          .onTap,
      isNull,
    );
    expect(find.text('首次在聊天中用到时询问权限；Nova 只读取，不会修改。'), findsOneWidget);
    expect(find.text('只读'), findsOneWidget);
    await tester.tap(title);
    await tester.pump();
    expect(opened, 0);
    expect(find.textContaining('只读取你授权的数据'), findsOneWidget);
    expect(find.text('所有连接均为只读授权，可随时关闭。更多连接器会逐步开放。'), findsOneWidget);
  });

  testWidgets('has Chinese and English copy', (tester) async {
    await tester.pumpWidget(_app(status: _zhStatus));
    await tester.pumpAndSettle();
    expect(find.text('连接器'), findsOneWidget);
    expect(find.text('聊天与资料'), findsOneWidget);
    expect(find.text('手机系统'), findsOneWidget);
    expect(find.text('飞书'), findsOneWidget);
    expect(find.text('日历与提醒事项'), findsOneWidget);
    expect(find.text('所有连接均为只读授权，可随时关闭。更多连接器会逐步开放。'), findsOneWidget);

    await tester.pumpWidget(_app(status: _enStatus, language: 'en'));
    await tester.pumpAndSettle();
    expect(find.text('Connectors'), findsOneWidget);
    expect(find.text('CHAT & DOCUMENTS'), findsOneWidget);
    expect(find.text('SYSTEM'), findsOneWidget);
    expect(find.text('Feishu'), findsOneWidget);
    expect(find.text('Calendar & reminders'), findsOneWidget);
    expect(find.text('Not connected'), findsOneWidget);
    expect(
      find.text(
        'All access is read-only and can be turned off at any time. '
        'More connectors are coming.',
      ),
      findsOneWidget,
    );
    expect(
      find.text(
        'Nova only reads the data you authorize for updates, timeline and '
        'personal info. It never edits, sends or acts on your behalf.',
      ),
      findsOneWidget,
    );
  });
}
