import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/assistant_text.dart';

void main() {
  for (final text in [
    '`nova-file:///workspace/counter.html`',
    '打开：nova-file:///workspace/counter.html。',
    '(nova-file:///workspace/counter.html)',
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
            '`nova-file:///workspace/game.html?remote=1`\n'
            '`nova-file:///workspace/game.html#remote`\n'
            '`nova-file:///workspace/check.py`',
            onArtifactLink: (_) async => fail('unexpected preview'),
          ),
        ),
      ),
    );
    expect(find.byType(TextButton), findsNothing);
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
