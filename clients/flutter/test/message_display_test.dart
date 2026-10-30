import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/ui/chat_activity.dart';
import 'package:nova_mobile/ui/thinking_block.dart';
import 'package:nova_mobile/ui/tool_step.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'local_chat_preview_test.dart' show PreviewWorkspace;

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));
  testWidgets(
    'concise display is reversible and keeps final replies, links and errors',
    (tester) async {
      tester.view.physicalSize = const Size(800, 2400);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final id = await store.create();
      for (final message in <Map<String, dynamic>>[
        {'role': 'user', 'content': '保留用户请求'},
        {
          'role': 'assistant',
          'content': '中间计划',
          'reasoning_content': '中间思考',
          'tool_calls': [
            {'id': 'one'},
          ],
        },
        {
          'role': 'tool',
          'tool_name': 'file_write',
          'content': jsonEncode({
            'status': 'completed',
            'data': {'path': '/workspace/index.html'},
          }),
        },
        {'role': 'assistant', 'content': '中间说明'},
        {
          'role': 'assistant',
          'content': '最终答复\n[打开作品](nova-file:///workspace/index.html)',
          'reasoning_content': '最终思考',
          'tool_calls': [],
        },
        {'role': 'user', 'content': '第二次请求'},
        {
          'role': 'assistant',
          'content': '保留的部分回复',
          'interrupted': true,
          'error': 'cancelled',
        },
        {'role': 'user', 'content': '第三次请求'},
        {
          'role': 'assistant',
          'content': '',
          'reasoning_content': '中断前的思考',
          'tool_calls': [],
          'interrupted': true,
          'error': 'cancelled',
        },
      ]) {
        await store.append(id, message);
      }
      final original = store.conversation(id)['messages'];
      final snapshot = jsonEncode(original);
      final persisted = await store.persistence.read();
      final workspace = PreviewWorkspace();
      final host = AgentCoreHost(
        store: store,
        settings: ModelSettings(),
        tools: ToolRunner(
          registry: ToolRegistry(
            snapshot: () => {},
            mutate: (input, {required operationId}) async => {},
            hasConflict: () => false,
            fetch: (_) async => {},
            workspace: workspace,
          ),
          journal: ToolJournal(MemoryPersistence()),
        ),
      );
      host.error = 'model_http_401';
      addTearDown(host.dispose);
      final showProcess = ValueNotifier(true);
      addTearDown(showProcess.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ValueListenableBuilder<bool>(
              valueListenable: showProcess,
              builder: (context, show, _) => LocalChatPanel(
                host: host,
                conversationId: id,
                showProcess: show,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(ThinkingBlock), findsNWidgets(3));
      expect(find.byType(ToolStepGroup), findsOneWidget);
      expect(find.text('index.html'), findsOneWidget);
      expect(find.text('中间计划', findRichText: true), findsOneWidget);
      showProcess.value = false;
      await tester.pumpAndSettle();
      expect(find.byType(ThinkingBlock), findsNothing);
      expect(find.byType(ToolStepGroup), findsNothing);
      expect(find.text('index.html'), findsNothing);
      expect(find.text('中间计划', findRichText: true), findsNothing);
      expect(find.text('中间说明', findRichText: true), findsNothing);
      expect(find.text('保留用户请求', findRichText: true), findsOneWidget);
      expect(find.textContaining('最终答复', findRichText: true), findsOneWidget);
      expect(find.text('保留的部分回复', findRichText: true), findsOneWidget);
      expect(find.text('已停止生成'), findsNWidgets(2));
      expect(find.text('模型服务拒绝访问，请检查密钥与服务权限。'), findsOneWidget);
      await tester.tap(find.text('打开作品'));
      await tester.pumpAndSettle();
      expect(workspace.opened, ['nova-file:///workspace/index.html']);
      showProcess.value = true;
      await tester.pumpAndSettle();
      expect(find.byType(ThinkingBlock), findsNWidgets(3));
      expect(find.byType(ToolStepGroup), findsOneWidget);
      expect(find.text('中间计划', findRichText: true), findsOneWidget);
      expect(store.conversation(id)['messages'], equals(original));
      expect(jsonEncode(store.conversation(id)['messages']), snapshot);
      expect(await store.persistence.read(), persisted);
    },
  );

  testWidgets('concise running state hides live process and keeps Stop', (
    tester,
  ) async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    final id = await store.create();
    final host = AgentCoreHost(store: store, settings: ModelSettings())
      ..busy = true
      ..activeConversationId = id
      ..draft = '秘密草稿'
      ..reasoning = '秘密思考'
      ..activeTool = 'file_write'
      ..activeToolArguments = '秘密参数';
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(
            host: host,
            conversationId: id,
            showProcess: false,
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
    final activity = tester.widget<ChatActivity>(find.byType(ChatActivity));
    expect(activity.label, '正在回复');
    expect(activity.summary, isNull);
    expect(activity.details, isNull);
    expect(find.textContaining('秘密'), findsNothing);
    expect(find.textContaining('file_write'), findsNothing);
    expect(
      tester
          .widget<IconButton>(
            find.byWidgetPredicate(
              (widget) => widget is IconButton && widget.tooltip == '停止',
            ),
          )
          .onPressed,
      isNotNull,
    );
    await tester.pumpWidget(const SizedBox());
  });
}
