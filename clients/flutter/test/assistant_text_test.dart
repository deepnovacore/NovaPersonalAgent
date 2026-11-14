import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/assistant_text.dart';

void main() {
  testWidgets('raw Chinese DOCX links expose an encoded file action', (
    tester,
  ) async {
    final opened = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AssistantText(
            '预览与下载：nova-file:///workspace/outputs/工作文档.docx',
            onArtifactLink: (value) async => opened.add(value),
          ),
        ),
      ),
    );
    expect(tester.takeException(), isNull);
    await tester.tap(find.widgetWithText(TextButton, '工作文档.docx'));
    expect(opened, [
      'nova-file:///workspace/outputs/%E5%B7%A5%E4%BD%9C%E6%96%87%E6%A1%A3.docx',
    ]);
  });

  testWidgets('streamed DOCX URLs tolerate incomplete percent encoding', (
    tester,
  ) async {
    const url = 'nova-file:///workspace/outputs/%E9%98%85%E8%AF%BB100%25.docx';
    final opened = <String>[];
    for (var length = 1; length <= url.length; length++) {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AssistantText(
              url.substring(0, length),
              onArtifactLink: (value) async => opened.add(value),
            ),
          ),
        ),
      );
      expect(tester.takeException(), isNull, reason: url.substring(0, length));
    }
    await tester.tap(find.widgetWithText(TextButton, '阅读100%.docx'));
    expect(opened, [url]);
  });

  for (final text in [
    '`nova-file:///workspace/counter.html`',
    '打开：nova-file:///workspace/counter.html。',
    '(nova-file:///workspace/counter.html)',
    '网站已做好：**nova-file:///workspace/counter.html**',
    '_nova-file:///workspace/counter.html_',
    '~~nova-file:///workspace/counter.html~~',
    "'nova-file:///workspace/counter.html'",
    '是否打开 nova-file:///workspace/counter.html?',
  ]) {
    testWidgets('local HTML preview can be tapped from $text', (tester) async {
      final opened = <String>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AssistantText(
              text,
              onArtifactLink: (value) async => opened.add(value),
            ),
          ),
        ),
      );
      await tester.tap(find.widgetWithText(TextButton, 'counter.html'));
      await tester.pump();
      expect(opened, ['nova-file:///workspace/counter.html']);
    });
  }

  testWidgets('a bold markdown link opens its preview once', (tester) async {
    final opened = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AssistantText(
            '**[我的网站](nova-file:///workspace/index.html)**\n'
            '文件：nova-file:///workspace/my_site.html',
            onArtifactLink: (value) async => opened.add(value),
          ),
        ),
      ),
    );
    // The markdown link itself is tappable, so no duplicate chip appears.
    expect(find.widgetWithText(TextButton, 'index.html'), findsNothing);
    expect(find.textContaining('**'), findsNothing);
    await tester.tap(find.widgetWithText(TextButton, 'my_site.html'));
    await tester.pump();
    expect(opened, ['nova-file:///workspace/my_site.html']);
  });

  testWidgets('preview actions preserve encoded names and deduplicate URLs', (
    tester,
  ) async {
    final opened = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AssistantText(
            '`nova-file:///workspace/my%20game/index%20page.html`\n'
            'nova-file:///workspace/my%20game/index%20page.html\n'
            'nova-file:///workspace/second.htm',
            onArtifactLink: (value) async => opened.add(value),
          ),
        ),
      ),
    );
    expect(find.widgetWithText(TextButton, 'index page.html'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'index page.html'));
    await tester.tap(find.widgetWithText(TextButton, 'second.htm'));
    await tester.pump();
    expect(opened, [
      'nova-file:///workspace/my%20game/index%20page.html',
      'nova-file:///workspace/second.htm',
    ]);
  });

  testWidgets('unsupported and invalid URLs do not gain preview actions', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AssistantText(
            '`https://example.com/game.html`\n'
            '`file:///workspace/game.html`\n'
            '`javascript:alert(1)`\n'
            '`nova-file://remote/workspace/game.html`\n'
            '`nova-file:///outside/game.html`\n'
            '`nova-file:///workspace/../../outside.html`\n'
            '`nova-file:///workspace/%2e%2e/outside.html`\n'
            '`nova-file:///workspace/outputs/子目录/../报告.docx`\n'
            '`nova-file:///workspace/game.html?remote=1`\n'
            '`nova-file:///workspace/game.html#remote`',
            onArtifactLink: (_) async => fail('unexpected preview'),
          ),
        ),
      ),
    );
    expect(find.byType(TextButton), findsNothing);
  });

  testWidgets('document links render deduplicated tappable file chips', (
    tester,
  ) async {
    final opened = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AssistantText(
            '[Report](nova-file:///workspace/outputs/report.pdf)\n'
            '`nova-file:///workspace/outputs/report.pdf`\n'
            '`nova-file:///workspace/inbox/sales.xlsx`\n'
            '`nova-file:///workspace/outputs/%E6%91%98%E8%A6%81.txt`',
            onArtifactLink: (value) async => opened.add(value),
          ),
        ),
      ),
    );
    expect(find.widgetWithText(TextButton, 'report.pdf'), findsOneWidget);
    expect(find.byIcon(Icons.insert_drive_file_outlined), findsNWidgets(3));
    for (final name in ['report.pdf', 'sales.xlsx', '摘要.txt']) {
      await tester.tap(find.widgetWithText(TextButton, name));
    }
    expect(opened, [
      'nova-file:///workspace/outputs/report.pdf',
      'nova-file:///workspace/inbox/sales.xlsx',
      'nova-file:///workspace/outputs/%E6%91%98%E8%A6%81.txt',
    ]);
  });

  testWidgets('preview action requires a local preview handler', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: AssistantText('`nova-file:///workspace/counter.html`'),
      ),
    );
    expect(find.byType(TextButton), findsNothing);
  });

  testWidgets('workspace and legacy preview links stay inside Nova', (
    tester,
  ) async {
    final opened = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AssistantText(
            '[Open](nova-file:///workspace/my%20game/index.html)',
            onArtifactLink: (value) async => opened.add(value),
          ),
        ),
      ),
    );
    expect(find.byType(TextButton), findsNothing);
    await tester.tap(find.text('Open'));
    await tester.pump();
    expect(opened, ['nova-file:///workspace/my%20game/index.html']);
    opened.clear();
    final markdown = tester.widget<MarkdownBody>(find.byType(MarkdownBody));
    markdown.onTapLink!(
      'Open',
      'nova-file:///workspace/my%20game/index.html',
      '',
    );
    await tester.pump();
    expect(opened, ['nova-file:///workspace/my%20game/index.html']);
    markdown.onTapLink!('Old', 'nova-artifact://legacy-id', '');
    await tester.pump();
    expect(opened.last, 'legacy-id');
    markdown.onTapLink!('Local', '/workspace/index.html', '');
    await tester.pump();
    expect(opened.last, '/workspace/index.html');
  });
}
