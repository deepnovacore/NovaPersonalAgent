import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_chat_panel.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/ui/pet_avatar.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'agent_core_test.dart' show MemoryPersistence;

const _approvedSha256 =
    '77fce72aae44c5da545f146c5a1162a05ccf13ed606f0c248e417400354fd1cf';
const _approvedIOSAsset =
    'packages/nova_audio/ios/nova_audio/Sources/nova_audio/Resources/nova_orb_avatar.png';

/// Creates a solid synthetic PNG so decode/resize tests do not depend on
/// checked-in photo fixtures.
Future<Uint8List> _png(int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.drawRect(
    Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    Paint()..color = const Color(0xff237c68),
  );
  canvas.drawCircle(
    Offset(width / 2, height / 2),
    math.min(width, height) / 3,
    Paint()..color = const Color(0xffffcc00),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  picture.dispose();
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data!.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
}

Future<(int, int)> _pngSize(Uint8List bytes) async {
  final codec = await ui.instantiateImageCodec(bytes);
  final frame = await codec.getNextFrame();
  final size = (frame.image.width, frame.image.height);
  frame.image.dispose();
  codec.dispose();
  return size;
}

Future<Map<String, dynamic>> _persisted() async {
  final preferences = await SharedPreferences.getInstance();
  return jsonDecode(preferences.getString(petAvatarPreferenceKey)!)
      as Map<String, dynamic>;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory support;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    support = await Directory.systemTemp.createTemp('nova-pet-avatar-');
  });

  tearDown(() async {
    if (support.existsSync()) await support.delete(recursive: true);
  });

  PetAvatarStore storeWith({Future<Uint8List?> Function()? pickImage}) =>
      PetAvatarStore(
        supportDirectory: () async => support,
        pickImage: pickImage,
      );

  test('bundled default avatar is the approved byte-identical copy', () async {
    final bundled = await File(petAvatarAsset).readAsBytes();
    final approved = await File(_approvedIOSAsset).readAsBytes();
    expect(bundled, equals(approved));
    expect(sha256.convert(bundled).toString(), _approvedSha256);
  });

  test('starts on the default avatar when nothing is stored', () async {
    final store = storeWith();
    await store.load();
    expect(store.loaded, isTrue);
    expect(store.mode, 'default');
    expect(store.hasCustom, isFalse);
    expect(store.customPath, isNull);
    final preferences = await SharedPreferences.getInstance();
    expect(preferences.getString(petAvatarPreferenceKey), isNull);
  });

  test('installs a picked image as a bounded PNG and persists the path', () async {
    final source = await _png(1200, 600);
    final store = storeWith(pickImage: () async => source);
    await store.load();
    expect(await store.pickCustomImage(), isTrue);
    expect(store.mode, 'custom');
    expect(store.hasCustom, isTrue);
    expect(store.error, isNull);
    final path = store.customPath!;
    expect(path, endsWith(petAvatarFileName));
    expect(File(path).existsSync(), isTrue);
    expect(await _pngSize(await File(path).readAsBytes()), (512, 256));
    final preferences = await SharedPreferences.getInstance();
    expect(jsonDecode(preferences.getString(petAvatarPreferenceKey)!), {
      'mode': 'custom',
      'path': path,
    });
  });

  test('does not upscale images already within the bound', () async {
    final store = storeWith(pickImage: () async => _png(128, 128));
    await store.load();
    expect(await store.pickCustomImage(), isTrue);
    expect(await _pngSize(await File(store.customPath!).readAsBytes()), (
      128,
      128,
    ));
  });

  test('rejects gallery images larger than 8 MB', () async {
    final store = storeWith(
      pickImage: () async => Uint8List(petAvatarMaxInputBytes + 1),
    );
    await store.load();
    expect(await store.pickCustomImage(), isFalse);
    expect(store.error, 'image_too_large');
    expect(store.hasCustom, isFalse);
    expect(File('${support.path}/$petAvatarFileName').existsSync(), isFalse);
  });

  test('cancelling the picker keeps the current avatar', () async {
    final store = storeWith(pickImage: () async => null);
    await store.load();
    expect(await store.pickCustomImage(), isFalse);
    expect(store.error, isNull);
    expect(store.mode, 'default');
  });

  test('a corrupt image fails without changing the avatar', () async {
    final store = storeWith(
      pickImage: () async => Uint8List.fromList([1, 2, 3, 4]),
    );
    await store.load();
    expect(await store.pickCustomImage(), isFalse);
    expect(store.error, 'image_decode_failed');
    expect(store.mode, 'default');
  });

  test('reset deletes the custom file and restores default preferences', () async {
    final store = storeWith(pickImage: () async => _png(300, 300));
    await store.load();
    expect(await store.pickCustomImage(), isTrue);
    final path = store.customPath!;
    await store.resetToDefault();
    expect(store.mode, 'default');
    expect(store.customPath, isNull);
    expect(File(path).existsSync(), isFalse);
    expect(await _persisted(), {'mode': 'default', 'path': null});
    // Resetting twice is safe.
    await store.resetToDefault();
    expect(store.mode, 'default');
  });

  test('loads a stored custom path from preferences', () async {
    final file = File('${support.path}/$petAvatarFileName')
      ..writeAsBytesSync(await _png(64, 64));
    SharedPreferences.setMockInitialValues({
      petAvatarPreferenceKey: jsonEncode({'mode': 'custom', 'path': file.path}),
    });
    final store = storeWith();
    await store.load();
    expect(store.mode, 'custom');
    expect(store.customPath, file.path);
  });

  for (final raw in [
    'not json',
    '[]',
    '"custom"',
    '{"mode":"something"}',
    '{"mode":"custom"}',
    '{"mode":"custom","path":42}',
    '{"mode":"custom","path":""}',
  ]) {
    test('malformed preferences $raw fall back to default', () async {
      SharedPreferences.setMockInitialValues({petAvatarPreferenceKey: raw});
      final store = storeWith();
      await store.load();
      expect(store.mode, 'default');
      expect(store.loaded, isTrue);
    });
  }

  test('a stored path that no longer exists falls back to default', () async {
    SharedPreferences.setMockInitialValues({
      petAvatarPreferenceKey: jsonEncode({
        'mode': 'custom',
        'path': '${support.path}/missing.png',
      }),
    });
    final store = storeWith();
    await store.load();
    expect(store.mode, 'default');
    expect(store.customPath, isNull);
  });

  testWidgets('PetAvatar renders the default asset with rounded decode bounds', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = storeWith();
    await store.load();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: Center(child: PetAvatar(store: store, size: 64))),
      ),
    );
    final image = tester.widget<Image>(find.byType(Image));
    final resized = image.image as ResizeImage;
    expect((resized.imageProvider as AssetImage).assetName, petAvatarAsset);
    expect(resized.width, 64);
    expect(image.width, 64);
    expect(image.height, 64);
    final clip = tester.widget<ClipRRect>(
      find.descendant(
        of: find.byType(PetAvatar),
        matching: find.byType(ClipRRect),
      ),
    );
    expect(clip.borderRadius, BorderRadius.circular(64 * .28));
  });

  testWidgets('PetAvatar uses the installed custom file', (tester) async {
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = storeWith(pickImage: () async => _png(200, 200));
    await store.load();
    // Image decode is real asynchronous engine work, so it must run outside
    // the fake-async test zone.
    expect(await tester.runAsync(store.pickCustomImage), isTrue);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: Center(child: PetAvatar(store: store, size: 96))),
      ),
    );
    final image = tester.widget<Image>(find.byType(Image));
    final resized = image.image as ResizeImage;
    expect((resized.imageProvider as FileImage).file.path, store.customPath);
    // Test device pixel ratio is 1.
    expect(resized.width, 96);
  });

  testWidgets('PetAvatar falls back to the default asset for a corrupt file', (
    tester,
  ) async {
    final corrupt = File('${support.path}/$petAvatarFileName')
      ..writeAsBytesSync([1, 2, 3, 4]);
    SharedPreferences.setMockInitialValues({
      petAvatarPreferenceKey: jsonEncode({
        'mode': 'custom',
        'path': corrupt.path,
      }),
    });
    final store = storeWith();
    await tester.runAsync(store.load);
    expect(store.hasCustom, isTrue);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: Center(child: PetAvatar(store: store, size: 64))),
      ),
    );
    // The file exists but cannot decode; the error builder owns the fallback.
    final image = tester.widget<Image>(find.byType(Image));
    expect(
      (image.image as ResizeImage).imageProvider,
      isA<FileImage>(),
    );
    expect(image.errorBuilder, isNotNull);
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('PetAvatar falls back to the default asset for a missing file', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({
      petAvatarPreferenceKey: jsonEncode({
        'mode': 'custom',
        'path': '${support.path}/missing-$petAvatarFileName',
      }),
    });
    final store = storeWith();
    await tester.runAsync(store.load);
    expect(store.hasCustom, isFalse);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: Center(child: PetAvatar(store: store, size: 64))),
      ),
    );
    final image = tester.widget<Image>(find.byType(Image));
    expect((image.image as ResizeImage).imageProvider, isA<AssetImage>());
  });

  Future<(PetAvatarStore, AgentCoreHost, String)> chatFixture(
    WidgetTester tester, {
    bool withMessages = true,
    bool keyboardVisible = false,
    PetAvatarStore? petAvatarStore,
  }) async {
    SharedPreferences.setMockInitialValues({});
    final conversation = ConversationStore(MemoryPersistence());
    await conversation.open();
    final id = await conversation.create();
    if (withMessages) {
      await conversation.append(id, {'role': 'user', 'content': 'Hello Nova'});
      await conversation.append(id, {
        'role': 'assistant',
        'content': 'Hello! How can I help?',
      });
    }
    final host = AgentCoreHost(store: conversation, settings: ModelSettings());
    final store = petAvatarStore ?? storeWith();
    await store.load();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(
            host: host,
            conversationId: id,
            language: 'en',
            petAvatarStore: store,
            keyboardVisible: keyboardVisible,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (store, host, id);
  }

  testWidgets('chat shows a centered 64px avatar with a Nova caption', (
    tester,
  ) async {
    final (_, host, _) = await chatFixture(tester);
    expect(find.byType(PetAvatar), findsOneWidget);
    expect(tester.widget<PetAvatar>(find.byType(PetAvatar)).size, 64);
    expect(find.text('Nova'), findsOneWidget);
    expect(tester.getCenter(find.byType(PetAvatar)).dx, closeTo(400, 1));
    host.dispose();
  });

  testWidgets('empty chat shows the larger 96px avatar without a caption', (
    tester,
  ) async {
    final (_, host, _) = await chatFixture(tester, withMessages: false);
    expect(find.byType(PetAvatar), findsOneWidget);
    expect(tester.widget<PetAvatar>(find.byType(PetAvatar)).size, 96);
    expect(find.text('Nova'), findsNothing);
    expect(find.text('Start here.'), findsOneWidget);
    expect(tester.getCenter(find.byType(PetAvatar)).dx, closeTo(400, 1));
    host.dispose();
  });

  testWidgets('chat hides the avatar while the keyboard is open', (
    tester,
  ) async {
    final (_, host, _) = await chatFixture(tester, keyboardVisible: true);
    expect(find.byType(PetAvatar), findsNothing);
    expect(find.text('Nova'), findsNothing);
    host.dispose();
  });

  testWidgets('chat hides the avatar in a compact layout', (tester) async {
    final conversation = ConversationStore(MemoryPersistence());
    await conversation.open();
    final id = await conversation.create();
    final host = AgentCoreHost(store: conversation, settings: ModelSettings());
    final store = storeWith();
    await store.load();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            height: 240,
            child: LocalChatPanel(
              host: host,
              conversationId: id,
              language: 'en',
              petAvatarStore: store,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(PetAvatar), findsNothing);
    host.dispose();
  });

  testWidgets('chat hides the avatar when no store is passed', (tester) async {
    final conversation = ConversationStore(MemoryPersistence());
    await conversation.open();
    final id = await conversation.create();
    final host = AgentCoreHost(store: conversation, settings: ModelSettings());
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(host: host, conversationId: id, language: 'en'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(PetAvatar), findsNothing);
    host.dispose();
  });

  testWidgets('tapping the chat avatar opens the Chinese settings sheet', (
    tester,
  ) async {
    final conversation = ConversationStore(MemoryPersistence());
    await conversation.open();
    final id = await conversation.create();
    await conversation.append(id, {'role': 'user', 'content': 'Hi'});
    final host = AgentCoreHost(store: conversation, settings: ModelSettings());
    final store = storeWith();
    await store.load();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: LocalChatPanel(
            host: host,
            conversationId: id,
            language: 'zh',
            petAvatarStore: store,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byType(PetAvatar));
    await tester.pumpAndSettle();
    expect(find.text('宠物头像'), findsOneWidget);
    expect(find.text('从相册选择'), findsOneWidget);
    expect(find.text('恢复默认'), findsOneWidget);
    expect(find.text('仅保存在本机'), findsOneWidget);
    // The sheet previews the same avatar store rendered in the chat.
    expect(find.byType(PetAvatar), findsNWidgets(2));
    await tester.tap(find.text('完成'));
    await tester.pumpAndSettle();
    expect(find.text('宠物头像'), findsNothing);
    host.dispose();
  });
}
