import 'package:nova_audio/nova_audio.dart';
import 'package:nova_mobile/conversation/phone_dictation.dart';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show FontLoader;
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/space/client_controller.dart';
import 'package:nova_mobile/space/client_state.dart';
import 'package:nova_mobile/space/relay_transport.dart';
import 'package:nova_mobile/space/space_call_controller.dart';
import 'package:nova_mobile/space/space_crypto.dart';
import 'package:nova_mobile/space/space_root.dart';
import 'package:nova_mobile/space/space_storage.dart';
import 'package:nova_mobile/ui/theme.dart';
import '../space_client_test.dart' show MemorySpacePersistence;

const spaceRecord = SpaceRecord(
  id: 'ui',
  name: 'Relay',
  mode: SpaceMode.client,
  remoteSpace: 'remote',
  hostDevice: 'host',
  relay: 'https://relay.example',
  device: 'phone',
);

/// Fonts the way the other screenshot tests load them. [cjk] swaps the Latin
/// test font for a system CJK font so Chinese copy is legible in local
/// screenshots; it is not portable, so only the opt-in screenshot test uses it.
Future<void> loadSpaceTestFonts({String? cjk}) async {
  final config = File('.dart_tool/package_config.json');
  final packages = jsonDecode(await config.readAsString())['packages'] as List;
  final flutter = packages.singleWhere((p) => p['name'] == 'flutter');
  final sdk = Directory.fromUri(
    config.absolute.uri.resolve(flutter['rootUri'] as String),
  ).parent.parent.path;
  Future<ByteData> bytes(String path) async =>
      ByteData.sublistView(await File(path).readAsBytes());
  final text =
      cjk ?? '$sdk/bin/cache/artifacts/material_fonts/Roboto-Regular.ttf';
  for (final family in [
    'Roboto',
    'CupertinoSystemText',
    'CupertinoSystemDisplay',
  ]) {
    await (FontLoader(family)..addFont(bytes(text))).load();
  }
  await (FontLoader('MaterialIcons')..addFont(
        bytes(
          '$sdk/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
        ),
      ))
      .load();
  final icons = packages.singleWhere((p) => p['name'] == 'cupertino_icons');
  await (FontLoader('packages/cupertino_icons/CupertinoIcons')..addFont(
        bytes(
          File.fromUri(
            config.absolute.uri.resolve(
              '${icons['rootUri']}/assets/CupertinoIcons.ttf',
            ),
          ).path,
        ),
      ))
      .load();
}

SpaceClientState seededState({bool online = true, String? error}) {
  final state = SpaceClientState(MemorySpacePersistence())
    ..hostOnline = online
    ..error = error
    ..snapshot = {
      'goals': [
        {
          'id': 'g1',
          'title': '把 Space 客户端做漂亮',
          'note': '',
          'status': 'active',
          'version': 1,
        },
      ],
      'todos': [
        {
          'id': 't1',
          'title': '核对底栏图标',
          'note': '和本机应用保持一致',
          'status': 'open',
          'version': 1,
        },
        {
          'id': 't2',
          'title': '补一组截图',
          'note': '',
          'status': 'done',
          'version': 2,
        },
      ],
      'ideas': <Map<String, dynamic>>[],
      'notifications': [
        {'id': 'n1', 'title': 'Host 已完成处理', 'body': '三份采集内容已整理为资料。'},
      ],
      'feed': [
        {'id': 'f1', 'title': '今日简报', 'body': '明天上海多云，14–21°C，下午有短时阵雨，出门带伞。'},
      ],
      'timeline': <Map<String, dynamic>>[],
    };
  state.messages.addAll([
    {'role': 'user', 'turn_id': 'a', 'text': 'hi?', 'status': 'done'},
    {
      'role': 'assistant',
      'turn_id': 'a',
      'text': '你好呀，我是 Nova，很高兴见到你！有什么我可以帮你的吗？',
      'status': 'done',
    },
    {'role': 'user', 'turn_id': 'b', 'text': '帮我搜索一下今天的上海天气', 'status': 'done'},
    {
      'role': 'assistant',
      'turn_id': 'b',
      'text': '今天上海多云转阴，气温 14–21°C，下午可能有短时阵雨，建议带一把伞。需要我把降雨提醒加到待办里吗？',
      'status': 'done',
    },
  ]);
  return state;
}

Future<SpaceClientController> fakeController(
  WidgetTester tester,
  SpaceClientState state,
) async {
  final identity = (await tester.runAsync(SpaceIdentity.generate))!;
  final crypto = SpaceCrypto(spaceRecord, identity, MemorySpacePersistence());
  return SpaceClientController(state, SpaceRelayTransport(crypto));
}

/// Mounts the Host-client screen at phone size around [state].
Future<void> pumpClient(
  WidgetTester tester,
  SpaceClientState state, {
  VoidCallback? onSwitchSpace,
  Widget Function(Widget app)? wrap,
  String? language = 'zh',
  AudioPort? audio,
  Future<bool> Function()? requestMicrophone,
  PhoneDictation Function(ValueChanged<String> onText)? createDictation,
  SpaceCallController Function(SpaceClientController controller)? createCall,
  ValueChanged<SpaceClientController>? onController,
}) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final controller = await fakeController(tester, state);
  onController?.call(controller);
  final app = MaterialApp(
    theme: novaTheme(),
    home: SpaceClientScreen(
      space: spaceRecord,
      onSwitchSpace: onSwitchSpace ?? () {},
      open: (_) async => controller,
      language: language,
      audio: audio,
      requestMicrophone: requestMicrophone,
      createDictation: createDictation,
      createCall: createCall,
    ),
  );
  await tester.pumpWidget(wrap?.call(app) ?? app);
  await tester.pump();
  await tester.pump();
  addTearDown(() => tester.pumpWidget(const SizedBox()));
}
