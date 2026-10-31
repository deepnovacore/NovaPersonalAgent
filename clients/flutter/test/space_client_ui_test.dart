import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/app.dart' show BottomAppBarTabs;
import 'package:nova_mobile/ui/components.dart';
import 'support/space_client_fixture.dart';
import 'package:nova_mobile/ui/settings_sheet.dart';
import 'package:nova_mobile/ui/pet_avatar.dart';
import 'remote_model_settings_backend_test.dart' show fixture;

void main() {
  setUpAll(loadSpaceTestFonts);
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
      ('Nova', 'Nova'),
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
    'tasks group by kind, hide empty kinds, and create from a sheet',
    (tester) async {
      await pumpClient(tester, seededState());
      await tester.tap(find.text('任务'));
      // The create button animates in; it ignores taps until it has settled.
      await tester.pumpAndSettle();
      expect(find.text('目标'), findsOneWidget);
      expect(find.text('待办'), findsOneWidget);
      expect(find.text('想法'), findsNothing);
      expect(find.text('创建 goal'), findsNothing);
      await tester.tap(find.byTooltip('创建'));
      await tester.pumpAndSettle();
      expect(find.byType(CupertinoActionSheet), findsOneWidget);
      await tester.tap(find.text('待办').last);
      await tester.pumpAndSettle();
      expect(find.text('创建待办'), findsOneWidget);
    },
  );

  testWidgets('a todo is completed from its circle', (tester) async {
    final state = seededState();
    await pumpClient(tester, state);
    await tester.tap(find.text('任务'));
    await tester.pump();
    await tester.tap(find.byTooltip('标记完成'));
    await tester.pump();
    expect(state.pending.single['input'], containsPair('status', 'done'));
  });

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
      for (final title in ['模型服务', '设备', '宠物头像', '连接器', '助手设置']) {
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
      expect(find.text('编辑个人资料'), findsOneWidget);
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
      await tester.tap(find.text('对话模型'));
      await tester.pumpAndSettle();
      expect(find.text('API 地址'), findsNothing);
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
