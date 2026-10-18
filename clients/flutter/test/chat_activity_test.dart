import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/artifact_workspace.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/ui/chat_activity.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'agent_chat_test.dart' show FakeNative;

class WritingModel extends ModelClient {
  final gate = Completer<void>();
  var calls = 0;
  @override
  Stream<Map<String, dynamic>> stream(
    ModelConfiguration c,
    List<Map<String, dynamic>> messages, {
    List<Map<String, dynamic>> tools = const [],
  }) async* {
    if (calls++ > 0) {
      yield {'content': '已做好'};
      return;
    }
    yield {'content': '我来创建一个游戏。'};
    yield {
      'tool_calls': [
        {
          'index': 0,
          'id': 'game',
          'function': {
            'name': 'artifact_write',
            'arguments': '{"title":"Blocks","html":"<html>',
          },
        },
      ],
    };
    await gate.future;
    yield {
      'tool_calls': [
        {
          'index': 0,
          'function': {'arguments': 'Play</html>"}'},
        },
      ],
    };
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'visible progress survives a preamble while source streams; saved card opens',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({});
      final settings = ModelSettings(native: FakeNative());
      await settings.save(
        endpoint: 'https://example.com',
        model: 'm',
        key: 'secret',
      );
      final disk = MemoryPersistence(), life = LocalLife(MemoryPersistence());
      await life.open();
      var opened = false;
      final workspace = ArtifactWorkspace(
        disk,
        present: (title, html) async {
          opened = html.contains('Play');
        },
      );
      await workspace.load();
      final registry = ToolRegistry(
        snapshot: () => life.life,
        mutate: life.mutate,
        hasConflict: () => false,
        fetch: (_) async => {},
        artifacts: workspace,
        automaticExecution: true,
      );
      final journal = ToolJournal(MemoryPersistence());
      await journal.open();
      final model = WritingModel();
      final store = ConversationStore(MemoryPersistence());
      await store.open();
      final id = await store.create();
      final host = AgentCoreHost(
        store: store,
        settings: settings,
        tools: ToolRunner(registry: registry, journal: journal),
        clientFactory: () => model,
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: LocalChatPanel(
              host: host,
              conversationId: id,

            ),
          ),
        ),
      );
      final sending = host.send(id, '写游戏', approve: (_) async => true);
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(find.text('我来创建一个游戏。'), findsOneWidget);
      expect(find.byType(ChatActivity), findsOneWidget);
      await tester.tap(find.byTooltip('查看执行过程'));
      await tester.pump();
      expect(find.textContaining('artifact_write'), findsWidgets);
      expect(find.textContaining('正在编写作品'), findsOneWidget);
      expect(host.receivedToolCharacters, greaterThan(0));
      expect(find.textContaining('characters received'), findsNothing);
      expect(find.textContaining('已接收'), findsNothing);
      model.gate.complete();
      await sending;
      await tester.pumpAndSettle();
      expect(find.byType(ChatActivity), findsNothing);
      expect(find.text('Blocks'), findsOneWidget);
      await tester.tap(find.text('Blocks'));
      await tester.pump();
      expect(opened, true);
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      life.dispose();
    },
  );
  testWidgets('shimmer respects reduced motion without hiding the activity', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: MediaQuery(
          data: const MediaQueryData(disableAnimations: true),
          child: ChatActivity(
            label: '正在运行检查',
            startedAt: DateTime.now(),
            language: 'zh',
          ),
        ),
      ),
    );
    expect(find.text('正在运行检查'), findsOneWidget);
    expect(find.byType(ShaderMask), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });
}
