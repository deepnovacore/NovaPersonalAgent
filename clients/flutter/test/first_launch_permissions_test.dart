import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/services/preferences.dart';
import 'package:nova_mobile/ui/app.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'support/fake_audio.dart';

void main() {
  for (final requested in [false, true]) {
    testWidgets(
      'iOS startup requests notifications once (previously requested: $requested)',
      (tester) async {
        debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
        addTearDown(() => debugDefaultTargetPlatformOverride = null);
        SharedPreferences.setMockInitialValues({
          'language': 'en',
          'notifications_requested_v1': requested,
        });
        FlutterSecureStorage.setMockInitialValues({});
        final calls = <String>[];
        const notificationChannel = MethodChannel('nova/schedule/v1');
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          notificationChannel,
          (call) async {
            if (call.method == 'requestNotifications') calls.add(call.method);
            return null;
          },
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            notificationChannel,
            null,
          ),
        );
        const channel = MethodChannel('nova/local_agent/v1');
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (call) async {
            calls.add(call.method);
            return jsonEncode({'already_requested': true});
          },
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          ),
        );
        final store = ConversationStore(MemoryPersistence());
        await store.open();
        final host = AgentCoreHost(store: store, settings: ModelSettings());
        var microphoneRequests = 0;
        final audioConfig = (
          audio: FakeAudio(),
          requestMicrophone: () async {
            microphoneRequests++;
            return false;
          },
        );
        addTearDown(host.dispose);

        await tester.pumpWidget(
          NovaApp(
            agentCore: host,
            audio: audioConfig.audio,
            requestMicrophone: audioConfig.requestMicrophone,

            preferences: Preferences(await SharedPreferences.getInstance()),
          ),
        );
        for (var i = 0; i < 5; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(calls.where((e) => e == 'preparePermissions'), hasLength(1));
        expect(
          calls.where((e) => e == 'requestNotifications'),
          hasLength(requested ? 0 : 1),
        );
        expect(
          (await SharedPreferences.getInstance()).getBool(
            'notifications_requested_v1',
          ),
          isTrue,
        );
        expect(microphoneRequests, 0);
        await tester.tap(find.text('Tasks').last);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Nova').last);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Tasks').last);
        await tester.pumpAndSettle();
        expect(calls.where((e) => e == 'preparePermissions'), hasLength(1));
        expect(
          calls.where((e) => e == 'requestNotifications'),
          hasLength(requested ? 0 : 1),
        );
        expect(microphoneRequests, 0);
        await tester.pumpWidget(const SizedBox());
        debugDefaultTargetPlatformOverride = null;
      },
    );
  }
}
