import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/generic/shared_ideas.dart';
import 'package:nova_mobile/experience/onboarding.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'space_client_test.dart' show MemorySpacePersistence;
import 'package:nova_mobile/ui/shared_idea_suggestions.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'scheduled_agent_runner_test.dart' show FixtureSettings;

void main() {
  testWidgets(
    'persona selection allows optional redemption with existing Spaces',
    (tester) async {
      final catalog = SpaceCatalog(persistence: MemorySpacePersistence());
      await catalog.add(
        const SpaceRecord(
          id: 'existing',
          name: 'Existing',
          mode: SpaceMode.standalone,
        ),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: ExperienceChooser(catalog: catalog, language: 'en'),
        ),
      );
      expect(
        find.text('Choose a sample persona and browse the sample data.'),
        findsOneWidget,
      );
      expect(find.text('Experience code'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  testWidgets('missing model error offers the explicit model chooser', (
    tester,
  ) async {
    final store = ConversationStore(MemoryPersistence());
    await store.open();
    await store.ensureMain();
    final host = AgentCoreHost(store: store, settings: FixtureSettings())
      ..error = 'model_settings_required';
    var selected = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(
            host: host,
            conversationId: ConversationStore.mainId,
            onChooseModel: () => selected++,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('选择模型'));
    expect(selected, 1);
    await tester.pumpWidget(const SizedBox.shrink());
    host.dispose();
  });

  for (final persona in [false, true]) {
    testWidgets(
      'experience setup and custom models are available in either Space: $persona',
      (tester) async {
        final store = ConversationStore(MemoryPersistence());
        await store.open();
        await store.ensureMain();
        FlutterSecureStorage.setMockInitialValues({});
        final host = AgentCoreHost(
          store: store,
          settings: ModelSettings(headless: true),
          experienceModel: () async =>
              throw const AgentFailure('experience_enrollment_required'),
          experiencePersona: persona,
        );
        var picked = 0, redeemed = 0, voiced = 0;
        final key = GlobalKey<LocalChatPanelState>();
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: LocalChatPanel(
                key: key,
                host: host,
                conversationId: ConversationStore.mainId,
                onModelSettings: () => picked++,
                onChooseModel: () => picked++,
                onExperienceCode: () => redeemed++,
                onVoice: () => voiced++,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('体验服务'), findsNothing);
        expect(find.byTooltip('对话方式'), findsNothing);
        key.currentState!.prefill('保留这条草稿');
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('发送'));
        await tester.pumpAndSettle();
        expect(key.currentState!.input.text, '保留这条草稿');
        expect(
          store.conversation(ConversationStore.mainId)['messages'],
          isEmpty,
        );
        await tester.tap(find.text('兑换体验码'));
        await tester.tap(find.text('配置自己的模型'));
        expect(redeemed, 1);
        expect(picked, 1);
        await tester.tap(find.byTooltip('实时语音'));
        expect(voiced, 1);
        await tester.pumpWidget(const SizedBox.shrink());
        host.dispose();
      },
    );
  }

  testWidgets('compact suggestions stack vertically and send the chosen topic', (
    tester,
  ) async {
    final ideas = SharedIdeas(
      read: (_) async =>
          '{"version":1,"language":"en","topics":[{"id":"one","text":"First idea"},{"id":"two","text":"Second idea"}]}',
    );
    String? sent;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SharedIdeasScope(
            notifier: ideas,
            child: SharedIdeaSuggestions(
              language: 'en',
              compact: true,
              onSend: (text) => sent = text,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final first = find.byKey(const ValueKey('shared-idea-opening:one'));
    final second = find.byKey(const ValueKey('shared-idea-opening:two'));
    expect(tester.getTopLeft(first).dx, tester.getTopLeft(second).dx);
    expect(
      (tester.getTopLeft(first).dy - tester.getTopLeft(second).dy).abs(),
      greaterThanOrEqualTo(48),
    );
    await tester.tap(first);
    expect(sent, 'First idea');
    await tester.pumpWidget(const SizedBox.shrink());
    ideas.dispose();
  });
}
