import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/ui/assistant_text.dart';
import 'package:nova_mobile/ui/thinking_block.dart';
import 'package:nova_mobile/ui/tool_timeline.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'local_chat_preview_test.dart' show PreviewWorkspace;

void main() {
  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'interleaved process gaps are symmetric without shrinking reply or artifact spacing at ${scale}x',
      (tester) async {
        tester.view.physicalSize = const Size(390, 2600);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        FlutterSecureStorage.setMockInitialValues({});
        final store = ConversationStore(MemoryPersistence());
        await store.open();
        final id = await store.create();
        Future<void> tool(String name, [String? path]) => store.append(id, {
          'role': 'tool',
          'tool_name': name,
          'content': jsonEncode({
            'status': 'completed',
            'data': {'path': path},
          }),
        });
        await store.append(id, {'role': 'user', 'content': 'User turn'});
        await store.append(id, {
          'role': 'assistant',
          'content': '',
          'reasoning_content': 'Think A',
        });
        await tool('file_read');
        await store.append(id, {
          'role': 'assistant',
          'content': '',
          'reasoning_content': 'Think B',
        });
        await tool('shell_execute');
        await store.append(id, {
          'role': 'assistant',
          'content': 'Tool preamble',
          'reasoning_content': 'Think C',
          'tool_calls': [
            {'id': 'next'},
          ],
        });
        await tool('web_fetch');
        await tool('file_write', '/workspace/page.html');
        await store.append(id, {
          'role': 'assistant',
          'content': '',
          'reasoning_content': 'Think D',
        });
        await store.append(id, {
          'role': 'assistant',
          'content': 'Final paragraph one',
        });
        await store.append(id, {
          'role': 'assistant',
          'content': 'Final paragraph two',
        });
        await store.append(id, {'role': 'user', 'content': 'Next user'});
        final host = AgentCoreHost(
          store: store,
          settings: ModelSettings(),
          tools: ToolRunner(
            registry: ToolRegistry(
              snapshot: () => {},
              mutate: (input, {required operationId}) async => {},
              hasConflict: () => false,
              fetch: (_) async => {},
              workspace: PreviewWorkspace(),
            ),
            journal: ToolJournal(MemoryPersistence()),
          ),
        );
        addTearDown(host.dispose);
        await tester.pumpWidget(
          MaterialApp(
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: Scaffold(
              body: LocalChatPanel(host: host, conversationId: id),
            ),
          ),
        );
        await tester.pumpAndSettle();
        // Think A and B only introduce tools: they are narration inside the
        // first run's timeline, so the visible thoughts are C and D.
        final thoughts = find.byType(ThinkingBlock);
        expect(thoughts, findsNWidgets(2));
        final tools = find.byWidgetPredicate(
          (widget) => widget is ExpansionTile || widget is ToolTimeline,
        );
        Finder reply(String text) => find.ancestor(
          of: find.text(text, findRichText: true),
          matching: find.byType(AssistantText),
        );
        double gap(Finder before, Finder after) =>
            tester.getTopLeft(after).dy - tester.getBottomLeft(before).dy;
        // The saved page's card follows its run instead of splitting it.
        expect(find.byType(ToolTimeline), findsNWidgets(2));
        expect(gap(tools.at(0), thoughts.at(0)), closeTo(8, .01));
        expect(gap(thoughts.at(0), reply('Tool preamble')), closeTo(8, .01));
        expect(gap(reply('Tool preamble'), tools.at(1)), closeTo(8, .01));
        expect(
          gap(find.widgetWithText(ListTile, 'page.html'), thoughts.at(1)),
          closeTo(16, .01),
        );
        // Only the turn's last text ends in the 32 px action row; earlier
        // texts keep the 24 px bottom padding.
        expect(
          gap(reply('Final paragraph one'), reply('Final paragraph two')),
          closeTo(24, .01),
        );
        final users = find.byWidgetPredicate(
          (widget) =>
              widget is Container && widget.constraints?.maxWidth == 300,
        );
        expect(gap(users.first, tools.at(0)), closeTo(32, .01));
        expect(gap(reply('Final paragraph two'), users.last), closeTo(32, .01));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
}
