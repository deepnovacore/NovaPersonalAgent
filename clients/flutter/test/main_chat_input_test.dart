import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/experience/persona.dart';
import 'package:nova_mobile/space/native_scope.dart';
import 'package:nova_mobile/space/space_root.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'experience_test.dart' show fixture;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  for (final mode in ['ordinary', 'legacy-author', 'persona']) {
    testWidgets(
      'iOS $mode Space keeps keyboard input through insets and task switching',
      (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        tester.view.viewPadding = const FakeViewPadding(top: 47, bottom: 34);
        tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetViewPadding);
        addTearDown(tester.view.resetPadding);
        addTearDown(tester.view.resetViewInsets);
        final root = await tester.runAsync(
          () => Directory.systemTemp.createTemp('main-chat-input-'),
        );
        final space = SpaceRecord(
          id: 'input-$mode',
          name: 'Input test',
          mode: SpaceMode.standalone,
          personaId: mode == 'persona' ? 'sample' : null,
          experienceSeededAt: mode == 'persona'
              ? DateTime.utc(2026, 1, 1)
              : null,
        );
        SharedPreferences.setMockInitialValues({
          'language': 'en',
          'notifications_requested_v1': true,
        });
        FlutterSecureStorage.setMockInitialValues({
          'nova.spaces.catalog.v1': jsonEncode({
            'selected': space.id,
            'spaces': [space.toJson()],
          }),
          if (mode == 'legacy-author')
            'novacore.experience.author-conversation.v1.space.${space.id}':
                'tester_sample',
        });
        SpaceStorage.active = null;
        SpaceNativeScope.resetForTesting();
        final messenger = tester.binding.defaultBinaryMessenger;
        final nativeCalls = <String>[];
        messenger.setMockMethodCallHandler(SpaceNativeScope.channel, (
          call,
        ) async {
          nativeCalls.add(call.method);
          return call.method == 'prepareSpaceDirectory' ? root!.path : null;
        });
        const paths = MethodChannel('plugins.flutter.io/path_provider');
        messenger.setMockMethodCallHandler(paths, (_) async => root!.path);
        const push = MethodChannel('nova/space_push/events');
        messenger.setMockMethodCallHandler(push, (_) async => null);
        const audio = MethodChannel('nova/audio');
        messenger.setMockMethodCallHandler(audio, (_) async => null);
        const agent = MethodChannel('nova/local_agent/v1');
        messenger.setMockMethodCallHandler(agent, (_) async => '{}');
        final bundle = fixture();
        if (mode == 'persona') {
          // Reuse the already public test-bundle icon; the manifest fixture has only dummy bytes.
          final icon = (await tester.runAsync(
            () => rootBundle.load('assets/pets/nova.png'),
          ))!;
          bundle.files['assets/experience/sample.png'] = icon.buffer
              .asUint8List(icon.offsetInBytes, icon.lengthInBytes);
          final manifest = jsonDecode(
            utf8.decode(bundle.files['assets/experience/manifest.json']!),
          );
          manifest['personas'][0]['sha256']['avatar'] = sha256
              .convert(bundle.files['assets/experience/sample.png']!)
              .toString();
          bundle.json('assets/experience/manifest.json', manifest);
        }
        messenger.setMockMessageHandler('flutter/assets', (message) async {
          final key = utf8.decode(message!.buffer.asUint8List());
          if (key.startsWith('assets/experience/')) {
            final bytes = mode == 'persona' ? bundle.files[key] : null;
            return bytes == null ? null : ByteData.sublistView(bytes);
          }
          return messenger.delegate.send('flutter/assets', message);
        });
        rootBundle.clear();
        addTearDown(() async {
          messenger.setMockMethodCallHandler(SpaceNativeScope.channel, null);
          messenger.setMockMethodCallHandler(paths, null);
          messenger.setMockMethodCallHandler(push, null);
          messenger.setMockMethodCallHandler(agent, null);
          messenger.setMockMethodCallHandler(audio, null);
          messenger.setMockMessageHandler('flutter/assets', null);
          rootBundle.clear();
          ExperiencePersona.choices = const [];
          SpaceStorage.active = null;
          SpaceNativeScope.resetForTesting();
          await root!.delete(recursive: true);
        });

        Future<void> settleUntil(bool Function() ready) async {
          for (var i = 0; i < 100 && !ready(); i++) {
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 10)),
            );
            await tester.pump();
          }
          await tester.pumpAndSettle(
            const Duration(milliseconds: 100),
            EnginePhase.sendSemanticsUpdate,
            const Duration(seconds: 3),
          );
          expect(ready(), isTrue);
        }

        Future<void> typeThroughKeyboard(String text) async {
          final field = find.byType(TextField);
          expect(field, findsOneWidget);
          expect(tester.widget<TextField>(field).enabled, isTrue);
          await tester.tap(field);
          await tester.pump();
          expect(tester.testTextInput.isVisible, isTrue);
          final editable = tester.state<EditableTextState>(
            find.byType(EditableText),
          );
          expect(editable.widget.focusNode.hasFocus, isTrue);
          tester.view.viewInsets = const FakeViewPadding(bottom: 335);
          tester.view.padding = const FakeViewPadding(top: 47);
          await tester.pumpAndSettle(
            const Duration(milliseconds: 100),
            EnginePhase.sendSemanticsUpdate,
            const Duration(seconds: 3),
          );
          expect(find.byType(BottomAppBarTabs), findsNothing);
          expect(editable.widget.focusNode.hasFocus, isTrue);
          tester.testTextInput.updateEditingValue(
            TextEditingValue(
              text: text,
              selection: TextSelection.collapsed(offset: text.length),
            ),
          );
          await tester.pump();
          expect(tester.widget<TextField>(field).controller!.text, text);
          expect(tester.takeException(), isNull);
        }

        Future<void> hideKeyboard() async {
          FocusManager.instance.primaryFocus?.unfocus();
          tester.testTextInput.hide();
          tester.view.viewInsets = const FakeViewPadding();
          tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
          await tester.pumpAndSettle(
            const Duration(milliseconds: 100),
            EnginePhase.sendSemanticsUpdate,
            const Duration(seconds: 3),
          );
        }

        // No injected AgentCore/LifeHost: exercise the real asynchronous selected-Space path.
        await tester.pumpWidget(const NovaApp());
        await settleUntil(
          () => find.byType(LocalChatPanel).evaluate().isNotEmpty,
        );
        expect(find.byType(SpaceRoot), findsOneWidget);
        expect(find.byType(StandaloneSpaceBar), findsOneWidget);
        expect(SpaceStorage.active?.id, space.id);
        expect(nativeCalls, contains('prepareSpaceDirectory'));
        final panel = tester.state<LocalChatPanelState>(
          find.byType(LocalChatPanel),
        );
        expect(panel.widget.conversationId, ConversationStore.mainId);
        expect(panel.dictation == null, mode == 'persona');
        expect(panel.widget.host.experienceModel, isNotNull);
        expect(panel.widget.host.experiencePersona, mode == 'persona');
        await tester.tap(find.byTooltip('Settings'));
        await tester.pumpAndSettle();
        expect(find.text('Experience code'), findsOneWidget);
        expect(find.text('Configure keys'), findsOneWidget);
        expect(find.text('Conversation model'), findsOneWidget);
        await tester.tap(find.text('Experience code'));
        await tester.pumpAndSettle();
        expect(find.text('Enter experience code'), findsOneWidget);
        expect(find.text('Enable'), findsNothing);
        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();
        await typeThroughKeyboard('Main draft');
        await hideKeyboard();
        await tester.tap(find.text('Tasks'));
        await tester.pumpAndSettle(
          const Duration(milliseconds: 100),
          EnginePhase.sendSemanticsUpdate,
          const Duration(seconds: 3),
        );
        await tester.tap(find.text('New task'));
        await settleUntil(
          () => find.byType(LocalChatPanel).evaluate().isNotEmpty,
        );
        expect(panel.widget.conversationId, isNot(ConversationStore.mainId));
        await typeThroughKeyboard('Task draft');
        await hideKeyboard();
        await tester.tap(find.text('Nova'));
        await tester.pumpAndSettle(
          const Duration(milliseconds: 100),
          EnginePhase.sendSemanticsUpdate,
          const Duration(seconds: 3),
        );
        expect(panel.widget.conversationId, ConversationStore.mainId);
        expect(panel.input.text, 'Main draft');
        await typeThroughKeyboard('Main draft continued');
        await hideKeyboard();
        await tester.tap(find.text('Tasks'));
        await tester.pumpAndSettle(
          const Duration(milliseconds: 100),
          EnginePhase.sendSemanticsUpdate,
          const Duration(seconds: 3),
        );
        expect(panel.input.text, 'Task draft');
        await typeThroughKeyboard('Task draft continued');
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 30)),
        );
      },
      variant: TargetPlatformVariant.only(TargetPlatform.iOS),
      timeout: const Timeout(Duration(seconds: 30)),
    );
  }
}
