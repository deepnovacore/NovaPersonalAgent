import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/experience/persona.dart';
import 'package:nova_mobile/space/space_root.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'package:nova_mobile/ui/app.dart';
import 'experience_test.dart' show Bundle, fixture;
import 'persona_rich_snapshot_test.dart' show richSnapshot;

void main() {
  testWidgets(
    'persona startup opens real stores and chat from packaged assets',
    (tester) async {
      final assetDirectory =
          Platform.environment['NOVA_PERSONA_STARTUP_ASSETS'];
      final bundle = assetDirectory == null ? fixture() : Bundle();
      if (assetDirectory == null) {
        bundle.files['assets/experience/sample.png'] = File(
          'assets/pets/nova.png',
        ).readAsBytesSync();
        final sources = bundle.files['assets/experience/sample.sources.json']!;
        bundle.json(
          'assets/experience/sample.snapshot.json',
          richSnapshot(sha256.convert(sources).toString()),
        );
        final manifest = jsonDecode(
          utf8.decode(bundle.files['assets/experience/manifest.json']!),
        );
        manifest['personas'][0]['sha256']['snapshot'] = sha256
            .convert(bundle.files['assets/experience/sample.snapshot.json']!)
            .toString();
        manifest['personas'][0]['sha256']['avatar'] = sha256
            .convert(bundle.files['assets/experience/sample.png']!)
            .toString();
        bundle.json('assets/experience/manifest.json', manifest);
      } else {
        for (final file in Directory(
          assetDirectory,
        ).listSync().whereType<File>()) {
          bundle.files['assets/experience/${file.uri.pathSegments.last}'] = file
              .readAsBytesSync();
        }
      }
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMessageHandler('flutter/assets', (message) async {
        final key = utf8.decode(message!.buffer.asUint8List());
        if (key == 'AssetManifest.bin')
          return const StandardMessageCodec().encodeMessage({});
        final bytes =
            bundle.files[key] ??
            (File(key).existsSync() ? File(key).readAsBytesSync() : null);
        return bytes == null ? null : ByteData.sublistView(bytes);
      });
      final root = Directory.systemTemp.createTempSync('persona-startup-');
      addTearDown(() {
        messenger.setMockMessageHandler('flutter/assets', null);
        messenger.setMockMethodCallHandler(
          const MethodChannel('nova/space_scope'),
          null,
        );
        messenger.setMockMethodCallHandler(
          const MethodChannel('nova/audio'),
          null,
        );
        ExperiencePersona.choices = const [];
        SpaceStorage.active = null;
        rootBundle.clear();
        root.deleteSync(recursive: true);
      });
      messenger.setMockMethodCallHandler(
        const MethodChannel('nova/audio'),
        (_) async => null,
      );
      messenger.setMockMethodCallHandler(
        const MethodChannel('nova/space_scope'),
        (call) async {
          if (call.method != 'prepareSpaceDirectory') return null;
          return (Directory(
            '${root.path}/${call.arguments['spaceId']}',
          )..createSync(recursive: true)).path;
        },
      );
      SharedPreferences.setMockInitialValues({'language': 'en'});
      FlutterSecureStorage.setMockInitialValues({});
      final personas = await ExperiencePersona.loadManifest(bundle: bundle);
      expect(personas, isNotEmpty);
      final backup = Platform.environment['NOVA_PERSONA_STARTUP_BACKUP'];
      final imports = Platform.environment['NOVA_PERSONA_STARTUP_IMPORTS'];
      final imported = imports == null
          ? <dynamic>[]
          : jsonDecode(File(imports).readAsStringSync()) as List;
      for (final persona in personas) {
        final space = SpaceRecord(
          id: 'test-${persona.id}',
          name: 'Test persona',
          mode: SpaceMode.standalone,
          personaId: persona.id,
          experienceSeededAt: DateTime.utc(2026),
        );
        final directory = Directory('${root.path}/${space.id}')..createSync();
        final saved = imported
            .where((r) => r['persona'] == persona.id)
            .firstOrNull;
        if (imports != null) {
          expect(backup, isNotNull);
          expect(saved, isNotNull, reason: persona.id);
        }
        if (saved != null && backup != null) {
          for (final file in Directory(
            '$backup/spaces/${saved['space']}',
          ).listSync().whereType<File>()) {
            if (file.path.endsWith('.json'))
              file.copySync('${directory.path}/${file.uri.pathSegments.last}');
          }
        }
        SpaceStorage.active = space;
        await tester.pumpWidget(
          MaterialApp(
            home: Builder(
              builder: (context) {
                final root =
                    (const NovaApp().build(context) as MaterialApp).home!
                        as SpaceRoot;
                return root.standalonePageBuilder!(space, () {});
              },
            ),
          ),
        );
        for (
          var attempt = 0;
          attempt < 100 && find.byType(LocalChatPanel).evaluate().isEmpty;
          attempt++
        ) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 20)),
          );
          await tester.pump(const Duration(milliseconds: 20));
        }
        expect(
          find.text('Could not open local chat. Please retry.'),
          findsNothing,
          reason: persona.id,
        );
        expect(find.byType(LocalChatPanel), findsOneWidget, reason: persona.id);
        final chat = tester.widget<LocalChatPanel>(find.byType(LocalChatPanel));
        expect(
          chat.host.store.conversation(ConversationStore.mainId)['messages'],
          saved == null ? isEmpty : hasLength(saved['messages'] as int),
        );
        expect(chat.onVoice, isNotNull);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 100)),
        );
        await tester.pump();
      }
    },
    variant: TargetPlatformVariant({TargetPlatform.iOS}),
  );
}
