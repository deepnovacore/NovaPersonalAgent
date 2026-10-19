import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/assistant_text.dart';

void main() {
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
