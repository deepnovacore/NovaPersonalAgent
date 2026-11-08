import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/rendering.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/app.dart' show BottomAppBarTabs;
import 'package:nova_mobile/ui/components.dart';
import 'support/space_client_fixture.dart';
import 'package:nova_mobile/ui/settings_sheet.dart';
import 'package:nova_mobile/ui/pet_avatar.dart';
import 'package:nova_mobile/ui/conversation_home.dart';
import 'package:nova_mobile/ui/timeline_page.dart';
import 'package:nova_mobile/ui/timeline_briefs.dart';
import 'package:nova_mobile/ui/workbench_page.dart';
import 'remote_model_settings_backend_test.dart' show fixture;

void main() {
  setUpAll(
    () => loadSpaceTestFonts(cjk: Platform.environment['NOVA_CLIENT_CJK_FONT']),
  );
  testWidgets(
    'Timeline contains real dated progress only; task notifications stay in Tasks',
    (tester) async {
      final state = seededState();
      state.snapshot['notifications'] = [
        {'id': 'event', 'title': '任务处理完成', 'body': '来自 Host 的真实执行回执'},
      ];
      state.snapshot['timeline_entries'] = [
        for (final day in [1, 2, 3, 4, 5, 6, 7, 8, 9])
          {
            'key': 'p$day',
            'kind': 'timeline',
            'text': '真实进展$day',
            'observed_at':
                '2026-11-${day.toString().padLeft(2, '0')}T10:00:00+08:00',
            'evidence_ids': <String>[],
            'brief': {
              'title': '真实进展$day',
              'facts': [
                {'text': '来自原始时间线'},
              ],
              'next_steps': <Map>[],
            },
          },
      ];
      await pumpClient(
        tester,
        state,
        wrap: (app) => RepaintBoundary(
          key: const ValueKey('client-timeline-preview'),
          child: app,
        ),
      );
      await tester.tap(find.text('时间线'));
      await tester.pumpAndSettle();
      expect(find.text('真实进展9'), findsOneWidget);
      expect(find.text('来自 Host 的真实执行回执'), findsNothing);
      expect(find.text('今日简报'), findsNothing);
      expect(find.byType(TimelinePage), findsOneWidget);
      expect(find.byType(TimelineBriefs), findsOneWidget);
      expect(find.text('真实进展1'), findsNothing);
      expect(find.textContaining('原文请在电脑上查看'), findsWidgets);
      expect(find.textContaining('条原文 ›'), findsNothing);
      final previewPath = Platform.environment['NOVA_CLIENT_TIMELINE_PREVIEW'];
      if (previewPath != null && previewPath.isNotEmpty) {
        final boundary = tester.renderObject<RenderRepaintBoundary>(
          find.byKey(const ValueKey('client-timeline-preview')),
        );
        await tester.runAsync(() async {
          final image = await boundary.toImage(pixelRatio: 2);
          try {
            final png = await image.toByteData(format: ui.ImageByteFormat.png);
            final file = File(previewPath);
            await file.parent.create(recursive: true);
            await file.writeAsBytes(png!.buffer.asUint8List(), flush: true);
          } finally {
            image.dispose();
          }
        });
      }
      await tester.scrollUntilVisible(
        find.text('继续查看进展').hitTestable(),
        500,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('继续查看进展'));
      await tester.pumpAndSettle();
      expect(find.text('真实进展1'), findsOneWidget);
      await tester.tap(find.text('任务'));
      await tester.pumpAndSettle();
      expect(find.byType(ConversationHome), findsOneWidget);
      expect(find.text('来自 Host 的真实执行回执'), findsNothing);
      await tester.tap(find.text('执行动态'));
      await tester.pumpAndSettle();
      expect(find.text('任务处理完成'), findsOneWidget);
      expect(find.text('来自 Host 的真实执行回执'), findsOneWidget);
    },
  );
  testWidgets('pending approval is not presented as an offline Host', (
    tester,
  ) async {
    final state = seededState(online: false)..waitingForApproval = true;
    await pumpClient(tester, state);
    expect(find.textContaining('配对中，等待电脑确认绑定。'), findsOneWidget);
    expect(find.textContaining('Host 不在线 ·'), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.byTooltip('复制手机指纹'), findsOneWidget);
    expect(find.text('等待电脑确认绑定'), findsOneWidget);
  });
  testWidgets(
    'generated Host profile is displayed without replacing editable manual state',
    (tester) async {
      final state = seededState();
      await state.apply({
        'v': 1,
        'type': 'snapshot',
        'snapshot': {
          ...state.snapshot,
          'schema_version': 1,
          'revision': 2,
          'profile': {'about': '', 'version': 0},
          'profile_presentation': {
            'about': '电脑整理的介绍',
            'source': 'current',
            'work': [
              {'title': '当前项目', 'text': '项目进展'},
            ],
            'interests': ['天文摄影'],
          },
        },
      });
      await pumpClient(tester, state);
      await tester.tap(find.text('我的'));
      await tester.pumpAndSettle();
      expect(find.text('电脑整理的介绍'), findsOneWidget);
      await tester.tap(find.text('查看与编辑'));
      await tester.pumpAndSettle();
      expect(find.text('项目进展'), findsOneWidget);
      expect(find.text('天文摄影'), findsOneWidget);
      expect(state.snapshot['profile'], {'about': '', 'version': 0});
    },
  );
  testWidgets(
    'routine edits stay queued in the background without internal request labels',
    (tester) async {
      final state = seededState();
      await state.enqueue('life.mutate', {
        'op': 'update',
        'kind': 'todo',
        'id': 't1',
        'status': 'done',
      });
      await pumpClient(tester, state);
      await tester.tap(find.text('任务'));
      await tester.pump();
      expect(state.pending, hasLength(1));
      expect(find.textContaining('life.mutate'), findsNothing);
      expect(find.text('等待 Host 确认'), findsNothing);
      expect(find.text('待处理请求'), findsNothing);
    },
  );
  testWidgets(
    'conflicts and rejected edits remain actionable with ordinary labels',
    (tester) async {
      final state = seededState();
      await state.enqueue('life.mutate', {
        'op': 'update',
        'kind': 'todo',
        'id': 't1',
        'status': 'done',
      });
      state.pending.single.addAll({
        'status': 'conflict',
        'error': 'internal_version_conflict',
      });
      await pumpClient(tester, state);
      await tester.tap(find.text('任务'));
      await tester.pump();
      expect(find.text('编辑冲突 · 修改已保留'), findsOneWidget);
      expect(find.textContaining('life.mutate'), findsNothing);
      expect(find.textContaining('internal_version_conflict'), findsNothing);
      state.pending.single['status'] = 'rejected';
      state.changed();
      await tester.pump();
      expect(find.text('修改未能保存'), findsOneWidget);
      expect(state.pending, hasLength(1));
    },
  );
  testWidgets('phone-width title stays centered with refresh on the left', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await pumpClient(tester, seededState());
    final title = find.byType(PetAvatarTitle);
    expect(tester.getCenter(title).dx, closeTo(195, 1));
    expect(tester.getCenter(find.byTooltip('刷新')).dx, lessThan(100));
    expect(
      find.descendant(of: find.byType(AppBar), matching: find.text('Space')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });
  testWidgets('every Client tab offers the same quick Space switch', (
    tester,
  ) async {
    var switched = 0;
    await pumpClient(tester, seededState(), onSwitchSpace: () => switched++);
    for (final label in ['Nova', '任务', '时间线', '我的']) {
      await tester.tap(
        find.descendant(
          of: find.byType(BottomAppBarTabs),
          matching: find.text(label),
        ),
      );
      await tester.pump();
      expect(find.byTooltip('切换 Space'), findsOneWidget);
      await tester.tap(find.byTooltip('切换 Space'));
    }
    expect(switched, 4);
  });

  testWidgets('bottom tabs match the local app: Nova, 任务, 时间线, 我的', (
    tester,
  ) async {
    await pumpClient(tester, seededState());
    expect(find.byType(NavigationBar), findsNothing);
    final tabs = tester.widget<BottomAppBarTabs>(find.byType(BottomAppBarTabs));
    expect(tabs.items.map((i) => i.$3), ['Nova', '任务', '时间线', '我的']);
    expect(tabs.items.map((i) => i.$1), [
      CupertinoIcons.chat_bubble,
      CupertinoIcons.square_stack,
      CupertinoIcons.clock,
      CupertinoIcons.person,
    ]);
    expect(tabs.index, 0);
  });

  testWidgets('single centered title follows the selected tab', (tester) async {
    await pumpClient(tester, seededState());
    for (final (label, title) in [
      ('任务', '任务'),
      ('时间线', '时间线'),
      ('我的', '我的'),
      ('Nova', 'NovaCore'),
    ]) {
      await tester.tap(
        find.descendant(
          of: find.byType(BottomAppBarTabs),
          matching: find.text(label),
        ),
      );
      await tester.pump();
      expect(
        find.descendant(of: find.byType(AppBar), matching: find.text(title)),
        findsOneWidget,
      );
    }
  });

  testWidgets('offline notice appears only on chat and tasks', (tester) async {
    await pumpClient(tester, seededState(online: false));
    expect(find.byType(NovaNotice), findsOneWidget);
    expect(find.textContaining('Host 不在线 · 展示上次缓存'), findsOneWidget);
    expect(find.byType(ListTile), findsNothing);
    await tester.tap(find.text('任务'));
    await tester.pump();
    expect(find.byType(NovaNotice), findsOneWidget);
    await tester.tap(find.text('时间线'));
    await tester.pump();
    expect(find.byType(NovaNotice), findsNothing);
    await tester.tap(find.text('我的'));
    await tester.pump();
    expect(find.byType(NovaNotice), findsNothing);
  });

  testWidgets('online shows no banner at all', (tester) async {
    await pumpClient(tester, seededState());
    expect(find.byType(NovaNotice), findsNothing);
    expect(find.textContaining('Host 在线'), findsNothing);
  });

  testWidgets(
    'Client task tab uses the shared task home without treating Life items as conversations',
    (tester) async {
      await pumpClient(tester, seededState());
      await tester.tap(find.text('任务'));
      await tester.pumpAndSettle();
      expect(find.byType(ConversationHome), findsOneWidget);
      expect(find.text('独立的事，在这里处理'), findsOneWidget);
      expect(find.text('把 Space 客户端做漂亮'), findsNothing);
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, '新建任务'))
            .onPressed,
        isNull,
      );
    },
  );

  testWidgets(
    'a todo uses the shared editor and versioned completion control',
    (tester) async {
      final state = seededState();
      await pumpClient(tester, state);
      await tester.tap(find.text('我的'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('全部待办'));
      await tester.tap(find.text('全部待办'));
      await tester.pumpAndSettle();
      expect(find.byType(WorkbenchPage), findsOneWidget);
      final check = find.byType(RoundCheck).first;
      await tester.tap(check);
      await tester.pumpAndSettle();
      expect(state.pending.single['input'], containsPair('status', 'done'));
      expect(state.pending.single['base_version'], 1);
    },
  );

  testWidgets(
    'Host task metadata uses shared history and plan tasks remain read-only',
    (tester) async {
      final state = seededState();
      await state.apply({
        'v': 1,
        'type': 'snapshot',
        'snapshot': {
          ...state.snapshot,
          'schema_version': 1,
          'revision': 2,
          'conversations': [
            {
              'id': 'topic:1',
              'kind': 'topic',
              'mode': 'chat',
              'title': '远程任务',
              'preview': '远程任务预览',
              'updated_at': '2026-11-01T10:00:00Z',
            },
            {
              'id': 'plan:1',
              'kind': 'chat',
              'mode': 'plan',
              'title': '电脑计划',
              'preview': '计划预览',
              'updated_at': '2026-11-01T09:00:00Z',
            },
          ],
        },
      });
      state.messages.add({
        'id': 'topic-message',
        'conversation_id': 'topic:1',
        'role': 'assistant',
        'text': '此任务的真实回复',
        'status': 'completed',
      });
      await pumpClient(tester, state);
      await tester.tap(find.text('任务'));
      await tester.pumpAndSettle();
      expect(find.byType(ConversationHome), findsOneWidget);
      await tester.tap(find.text('远程任务'));
      await tester.pumpAndSettle();
      expect(find.text('此任务的真实回复'), findsOneWidget);
      expect(find.text('hi?'), findsNothing);
      await tester.tap(find.byTooltip('返回任务'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('电脑计划'));
      await tester.pumpAndSettle();
      expect(find.textContaining('请在电脑上继续处理此任务'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.byType(TextField),
        ),
        findsNothing,
      );
      expect(state.pending, isEmpty);
    },
  );

  testWidgets('chat input is disabled with an explanation while offline', (
    tester,
  ) async {
    await pumpClient(tester, seededState(online: false));
    expect(find.text('Host 离线，聊天不可用'), findsOneWidget);
    final send = find.byWidgetPredicate(
      (w) => w is IconButton && w.tooltip == '发送',
    );
    expect(tester.widget<IconButton>(send).onPressed, isNull);
  });

  testWidgets(
    'settings groups Space, Host and authorisation, and switches Space',
    (tester) async {
      var switched = 0;
      await pumpClient(tester, seededState(), onSwitchSpace: () => switched++);
      await tester.tap(find.text('我的'));
      await tester.pump();
      await tester.tap(find.byTooltip('设置'));
      await tester.pumpAndSettle();
      expect(find.byType(SettingsGroup), findsAtLeastNWidgets(2));
      for (final title in ['模型服务', 'API 密钥', '设备', '宠物头像', '连接器', '助手设置']) {
        expect(find.text(title), findsOneWidget);
      }
      expect(find.text('Host 模型密钥'), findsNothing);
      await tester.tap(find.text('设备'));
      await tester.pumpAndSettle();
      expect(find.text('Host 连接'), findsOneWidget);

      // SelectableText carries its own Scrollable; scroll the page list.
      await tester.scrollUntilVisible(
        find.text('手机工具'),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('手机工具'));
      await tester.pumpAndSettle();
      expect(find.textContaining('iOS 支持日历读取'), findsOneWidget);
      Navigator.of(tester.element(find.byType(AlertDialog))).pop();
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('切换或新建 Space'),
        -500,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('切换或新建 Space'));
      await tester.pumpAndSettle();
      expect(switched, 1);
      expect(find.byTooltip('设置'), findsOneWidget);
    },
  );

  testWidgets(
    'Client connectors reuse the shared cards and keep phone consent separate',
    (tester) async {
      await pumpClient(tester, seededState());
      await tester.tap(find.byTooltip('设置'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('连接器'));
      await tester.pumpAndSettle();
      expect(find.text('飞书'), findsOneWidget);
      expect(find.text('日历与提醒事项'), findsNothing);
      expect(find.text('手动提交内容，管理上传与处理授权。'), findsOneWidget);
      await tester.tap(find.text('手机采集与授权'));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: find.byType(AppBar),
          matching: find.text('手机采集与授权'),
        ),
        findsOneWidget,
      );
      expect(find.text('发送采集输入'), findsOneWidget);
    },
  );

  testWidgets(
    'personal overview opens profile and feeds without connection details',
    (tester) async {
      final state = seededState();
      state.snapshot['profile'] = {'about': '我喜欢徒步', 'version': 2};
      await pumpClient(tester, state);
      await tester.tap(find.text('我的'));
      await tester.pumpAndSettle();
      expect(find.text('我喜欢徒步'), findsOneWidget);
      expect(find.text('Host 连接'), findsNothing);
      await tester.tap(find.text('查看与编辑'));
      await tester.pumpAndSettle();
      expect(find.text('我喜欢徒步'), findsOneWidget);
      expect(find.text('编辑'), findsOneWidget);
      expect(find.byType(WorkbenchPage), findsOneWidget);
      state.snapshot['profile'] = {'about': 'Host 更新后的介绍', 'version': 3};
      state.notifyListeners();
      await tester.pump();
      expect(find.text('Host 更新后的介绍'), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('资讯'));
      await tester.tap(find.text('资讯'));
      await tester.pumpAndSettle();
      expect(find.text('今日简报'), findsOneWidget);
      expect(find.text('Host 已完成处理'), findsNothing);
      state.snapshot['feed'] = <Map<String, dynamic>>[];
      state.notifyListeners();
      await tester.pump();
      expect(find.text('暂无资讯'), findsOneWidget);
    },
  );

  testWidgets(
    'Client API keys have their own provider-labelled settings page',
    (tester) async {
      final state = seededState();
      state.snapshot.addAll(fixture().snapshot);
      state.snapshot['host_credentials'] = {
        'credentials': [
          {'name': 'DEEPSEEK_API_KEY', 'configured': false},
        ],
      };
      await pumpClient(tester, state);
      await tester.tap(find.byTooltip('设置'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('API 密钥'));
      await tester.pumpAndSettle();
      expect(find.text('DeepSeek'), findsOneWidget);
      expect(find.text('DEEPSEEK_API_KEY'), findsNothing);
      expect(find.text('对话模型'), findsNothing);
      await tester.tap(find.text('DeepSeek'));
      await tester.pumpAndSettle();
      expect(find.text('DeepSeek API 密钥'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField)).obscureText,
        true,
      );
      await tester.enterText(find.byType(TextField), 'private-key');
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(state.pending.single['kind'], 'secret.put');
      expect(state.pending.single['input'], {
        'name': 'DEEPSEEK_API_KEY',
        'value': 'private-key',
      });
    },
  );

  testWidgets(
    'Client model editor uses the shared form and sends writes to Host',
    (tester) async {
      final state = seededState();
      state.snapshot.addAll(fixture().snapshot);
      await pumpClient(tester, state);
      await tester.tap(find.byTooltip('设置'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('模型服务'));
      await tester.pumpAndSettle();
      expect(find.text('DeepSeek · current'), findsOneWidget);
      expect(find.text('模型密钥'), findsNothing);
      expect(find.text('API 密钥'), findsNothing);
      await tester.tap(find.text('对话模型'));
      await tester.pumpAndSettle();
      expect(find.text('API 地址'), findsNothing);
      expect(find.text('API 密钥'), findsNothing);
      expect(find.byKey(const ValueKey('model.credentials')), findsNothing);
      final model = find.byWidgetPredicate(
        (w) => w is TextField && w.controller?.text == 'current',
      );
      await tester.enterText(model, 'phone-selected');
      await tester.tap(find.text('保存'));
      await tester.pumpAndSettle();
      expect(state.pending, hasLength(1));
      expect(state.pending.single['kind'], 'settings.patch');
      expect(state.pending.single['input'], {
        'method': 'models.configure',
        'params': {
          'expected_version': 7,
          'routes': {
            'conversationText': {
              'provider': 'deepseek',
              'model': 'phone-selected',
            },
          },
        },
      });
      expect(find.textContaining('等待 Host'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('Client pet avatar uses the same local settings as standalone', (
    tester,
  ) async {
    await pumpClient(tester, seededState());
    expect(find.byType(PetAvatarTitle), findsOneWidget);
    await tester.tap(find.byTooltip('设置'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('宠物头像'));
    await tester.pumpAndSettle();
    expect(find.text('仅保存在本机'), findsOneWidget);
    expect(find.text('从相册选择'), findsOneWidget);
  });

  testWidgets('keyboard hides the tab bar like the local app', (tester) async {
    await pumpClient(tester, seededState());
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    addTearDown(tester.view.resetViewInsets);
    await tester.pump();
    expect(find.byType(BottomAppBarTabs), findsNothing);
  });
}
