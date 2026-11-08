import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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
  for (final welcome in [true, false]) {
    testWidgets(
      'persona selection only offers redemption on first welcome: $welcome',
      (tester) async {
        final catalog = SpaceCatalog(persistence: MemorySpacePersistence());
        await tester.pumpWidget(
          MaterialApp(
            home: ExperienceChooser(
              catalog: catalog,
              language: 'en',
              allowInvite: welcome,
            ),
          ),
        );
        expect(find.byType(TextField), welcome ? findsOneWidget : findsNothing);
        expect(
          find.text('Redeem experience code'),
          welcome ? findsOneWidget : findsNothing,
        );
        if (!welcome) {
          expect(
            find.text(
              'Choose a sample persona to browse offline. Online features require active experience access.',
            ),
            findsOneWidget,
          );
        }
        await tester.pumpWidget(const SizedBox.shrink());
      },
    );
  }

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

  for (final managed in [false, true]) {
    testWidgets(
      'chat model and voice controls respect managed mode: $managed',
      (tester) async {
        final store = ConversationStore(MemoryPersistence());
        await store.open();
        await store.ensureMain();
        final settings = managed
            ? ModelSettings(
                managedConfiguration: () async =>
                    throw const AgentFailure('experience_enrollment_required'),
              )
            : FixtureSettings();
        final host = AgentCoreHost(store: store, settings: settings);
        if (managed) host.error = 'experience_enrollment_required';
        var picked = 0;
        var voiced = 0;
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: LocalChatPanel(
                host: host,
                conversationId: ConversationStore.mainId,
                onModelSettings: () => picked++,
                onChooseModel: managed ? null : () => picked++,
                onVoice: managed ? null : () => voiced++,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final menu = tester.widget<PopupMenuButton<String>>(
          find.byType(PopupMenuButton<String>),
        );
        expect(menu.enabled, !managed);
        if (managed) {
          expect(find.text('体验模式'), findsOneWidget);
          expect(find.text('选择模型'), findsNothing);
          expect(find.byTooltip('实时语音'), findsNothing);
          expect(
            find.text('在线功能需要有效体验资格。请在普通 Space 的设置中兑换体验码。'),
            findsOneWidget,
          );
          await tester.tap(find.text('体验模式'));
          await tester.pumpAndSettle();
          expect(find.text('模型设置'), findsNothing);
          expect(picked, 0);
        } else {
          await tester.tap(find.text('fixture'));
          await tester.pumpAndSettle();
          await tester.tap(find.text('模型设置'));
          await tester.pumpAndSettle();
          expect(picked, 1);
          await tester.tap(find.byTooltip('实时语音'));
          await tester.pumpAndSettle();
          expect(voiced, 1);
        }
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
