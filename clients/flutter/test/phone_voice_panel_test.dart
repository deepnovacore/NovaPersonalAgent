import 'package:flutter/foundation.dart' show ValueListenable;
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/agent_core_host.dart';
import 'package:nova_mobile/agent_core/model_settings.dart';
import 'package:nova_mobile/conversation/local_conversation_store.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'package:nova_mobile/voice/phone_voice_panel.dart';
import 'package:nova_mobile/voice/phone_voice_session.dart';
import 'package:nova_mobile/voice/voice_call_visual.dart';
import 'package:nova_mobile/voice/voice_delegate.dart';
import 'agent_core_test.dart' show MemoryPersistence;
import 'support/fake_audio.dart';

class PanelSession extends PhoneVoiceSession {
  PanelSession({super.delegates})
    : super(
        audio: FakeAudio(),
        requestMicrophone: () async => true,
        store: ConversationStore(MemoryPersistence()),
      ) {
    active = true;
  }
  final level = ValueNotifier<double>(0);
  String phase = 'listening', caption = '周末想留一点时间，读书和散步。';
  bool playing = false,
      userSpeaking = false,
      userCaption = true,
      delegation = true;
  int interruptions = 0, endings = 0, taskCancellations = 0;
  Completer<void>? finishStop;
  bool disposing = false;
  @override
  String get status => phase;
  @override
  ValueListenable<double> get audioLevel => level;
  @override
  double get inputLevel => level.value;
  @override
  bool get isUserSpeaking => userSpeaking;
  @override
  bool get isPlaying => playing;
  @override
  String get captionText => caption;
  @override
  bool get captionIsUser => userCaption;
  @override
  bool get supportsVoiceDelegation => delegation;
  @override
  Future<void> toggleMute() async {
    muted = !muted;
    notifyListeners();
  }

  @override
  Future<void> toggleSpeaker() async {
    speaker = !speaker;
    notifyListeners();
  }

  @override
  Future<void> interruptPlayback() async {
    interruptions++;
    playing = false;
    notifyListeners();
  }

  @override
  void cancelDelegate() {
    taskCancellations++;
  }

  @override
  Future<void> stop() async {
    endings++;
    if (finishStop != null) await finishStop!.future;
    active = false;
    if (!disposing) notifyListeners();
  }

  @override
  void dispose() {
    disposing = true;
    level.dispose();
    super.dispose();
  }
}

Widget panelHost(
  PanelSession session, {
  Size size = const Size(390, 844),
  double scale = 1,
  bool reduced = false,
  bool compact = false,
  VoidCallback? onMinimize,
  VoidCallback? onExpand,
  ThemeData? theme,
}) => MaterialApp(
  theme: theme ?? novaTheme(),
  home: RepaintBoundary(
    key: const ValueKey('call-preview'),
    child: Scaffold(
      backgroundColor: Nova.ink,
      body: MediaQuery(
        data: MediaQueryData(
          size: size,
          textScaler: TextScaler.linear(scale),
          disableAnimations: reduced,
        ),
        child: PhoneVoicePanel(
          session: session,
          onSettings: () {},
          onStart: () {},
          compact: compact,
          onMinimize: onMinimize,
          onExpand: onExpand,
        ),
      ),
    ),
  ),
);

void main() {
  testWidgets('capture failure is not mislabeled as a network failure', (
    tester,
  ) async {
    final session = PanelSession()..error = 'audio_capture_stalled';
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PhoneVoicePanel(
            session: session,
            onSettings: () {},
            onStart: () {},
          ),
        ),
      ),
    );
    expect(find.text('音频采集暂时卡住，请重新开始通话。'), findsOneWidget);
    expect(find.text('请检查语音设置或网络，再重新通话。'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    session.dispose();
  });
  testWidgets('playback failure is not mislabeled as a network failure', (
    tester,
  ) async {
    final session = PanelSession()..error = 'audio_playback_stalled';
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PhoneVoicePanel(
            session: session,
            onSettings: () {},
            onStart: () {},
          ),
        ),
      ),
    );
    expect(find.text('音频播放暂时卡住，请重新开始通话。'), findsOneWidget);
    expect(find.text('请检查语音设置或网络，再重新通话。'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    session.dispose();
  });

  for (final layout in [
    (size: const Size(320, 700), scale: 1.0),
    (size: const Size(390, 844), scale: 1.0),
    (size: const Size(320, 700), scale: 2.0),
    (size: const Size(700, 320), scale: 2.0),
  ]) {
    testWidgets(
      'call layout ${layout.size.width}x${layout.size.height} scale ${layout.scale}',
      (tester) async {
        tester.view.physicalSize = layout.size;
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final session = PanelSession();
        addTearDown(session.dispose);
        final path = layout.size.width == 390
            ? Platform.environment['NOVA_CALL_PREVIEW']
            : null;
        var theme = novaTheme();
        if (path != null && path.isNotEmpty) {
          await tester.runAsync(() async {
            final fontPath =
                Platform.environment['NOVA_CALL_PREVIEW_FONT'] ??
                '/System/Library/Fonts/Supplemental/Arial Unicode.ttf';
            await (FontLoader('CallPreview')..addFont(
                  File(fontPath).readAsBytes().then(ByteData.sublistView),
                ))
                .load();
            final config = File('.dart_tool/package_config.json');
            final packages =
                jsonDecode(await config.readAsString())['packages'] as List;
            final flutter = packages.singleWhere((p) => p['name'] == 'flutter');
            final sdk = Directory.fromUri(
              config.absolute.uri.resolve(flutter['rootUri'] as String),
            ).parent.parent.path;
            await (FontLoader('MaterialIcons')..addFont(
                  File(
                    '$sdk/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
                  ).readAsBytes().then(ByteData.sublistView),
                ))
                .load();
          });
          theme = theme.copyWith(
            textTheme: theme.textTheme.apply(fontFamily: 'CallPreview'),
            textButtonTheme: TextButtonThemeData(
              style: theme.textButtonTheme.style?.copyWith(
                textStyle: const WidgetStatePropertyAll<TextStyle>(
                  TextStyle(fontFamily: 'CallPreview', fontSize: 15),
                ),
              ),
            ),
          );
        }
        await tester.pumpWidget(
          panelHost(
            session,
            size: layout.size,
            scale: layout.scale,
            onMinimize: () {},
            theme: theme,
          ),
        );
        await tester.pump();
        expect(find.byKey(const ValueKey('voice-captions')), findsOneWidget);
        expect(find.text(session.caption), findsOneWidget);
        expect(find.text('你'), findsOneWidget);
        expect(
          tester.getBottomRight(find.byTooltip('结束通话')).dy,
          lessThanOrEqualTo(layout.size.height),
        );
        expect(tester.takeException(), isNull);
        if (path != null && path.isNotEmpty) {
          final boundary = tester.renderObject<RenderRepaintBoundary>(
            find.byKey(const ValueKey('call-preview')),
          );
          await tester.runAsync(() async {
            final image = await boundary.toImage(pixelRatio: 2);
            try {
              final bytes = await image.toByteData(
                format: ui.ImageByteFormat.png,
              );
              final file = File(path);
              await file.parent.create(recursive: true);
              await file.writeAsBytes(bytes!.buffer.asUint8List(), flush: true);
            } finally {
              image.dispose();
            }
          });
        }
      },
    );
  }

  testWidgets(
    'compact bar hides captions and tasks and expands without stopping',
    (tester) async {
      final session = PanelSession();
      addTearDown(session.dispose);
      var expansions = 0;
      await tester.pumpWidget(
        panelHost(session, compact: true, onExpand: () => expansions++),
      );
      expect(find.byKey(const ValueKey('voice-compact-bar')), findsOneWidget);
      expect(find.byKey(const ValueKey('voice-captions')), findsNothing);
      expect(find.text(session.caption), findsNothing);
      expect(find.byType(VoiceCallVisual), findsNothing);
      expect(find.byKey(const ValueKey('voice-task')), findsNothing);
      await tester.tap(find.textContaining('Nova ·'));
      expect(expansions, 1);
      expect(session.endings, 0);
    },
  );

  testWidgets(
    'controls separate playback interruption and task cancellation; end waits',
    (tester) async {
      final session = PanelSession()..playing = true;
      addTearDown(session.dispose);
      var minimized = 0;
      await tester.pumpWidget(
        panelHost(session, reduced: true, onMinimize: () => minimized++),
      );
      await tester.tap(find.byTooltip('静音'));
      await tester.pump();
      expect(session.muted, isTrue);
      await tester.tap(find.byTooltip('扬声器'));
      await tester.pump();
      expect(session.speaker, isTrue);
      await tester.tap(find.text('打断播放'));
      await tester.pump();
      expect(session.interruptions, 1);
      expect(session.taskCancellations, 0);
      session.finishStop = Completer<void>();
      await tester.tap(find.byTooltip('结束通话'));
      await tester.pump();
      expect(minimized, 0);
      session.finishStop!.complete();
      await tester.pump();
      expect(minimized, 1);
      expect(session.endings, 1);
    },
  );

  testWidgets('real levels reach visual and reduced motion stops ticker', (
    tester,
  ) async {
    final session = PanelSession()..userSpeaking = true;
    addTearDown(session.dispose);
    await tester.pumpWidget(panelHost(session));
    await tester.pump(const Duration(milliseconds: 200));
    expect(tester.hasRunningAnimations, isTrue);
    session.level.value = .27;
    await tester.pump();
    expect(
      tester.widget<VoiceCallVisual>(find.byType(VoiceCallVisual)).inputLevel,
      .27,
    );
    await tester.pumpWidget(panelHost(session, reduced: true));
    await tester.pump(const Duration(seconds: 1));
    expect(tester.hasRunningAnimations, isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('task shows human progress and stop without technical details', (
    tester,
  ) async {
    final primary = AgentCoreHost(
      store: ConversationStore(MemoryPersistence()),
      settings: ModelSettings(),
    );
    final worker =
        AgentCoreHost(
            store: ConversationStore(MemoryPersistence()),
            settings: ModelSettings(),
          )
          ..activeTool = 'file_write'
          ..draft = '正在整理内容';
    final bridge = VoiceDelegateBridge(primary: primary, worker: worker)
      ..id = 'synthetic-task';
    final session = PanelSession(delegates: bridge);
    addTearDown(session.dispose);
    addTearDown(bridge.dispose);
    addTearDown(primary.dispose);
    await tester.pumpWidget(panelHost(session));
    await tester.ensureVisible(find.byKey(const ValueKey('voice-task')));
    expect(find.text('正在编写文件'), findsOneWidget);
    expect(find.textContaining('file_write'), findsNothing);
    await tester.tap(find.text('正在编写文件'));
    await tester.pumpAndSettle();
    expect(find.textContaining('file_write'), findsNothing);
    expect(find.text('正在整理内容'), findsNothing);
    expect(find.text('停止任务'), findsOneWidget);
  });
}
