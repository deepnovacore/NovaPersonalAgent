import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/ui/app.dart' show BottomAppBarTabs;
import 'package:nova_mobile/ui/components.dart';
import 'support/space_client_fixture.dart';

void main() {
  setUpAll(loadSpaceTestFonts);

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

  testWidgets('offline shows one quiet notice on chat and tasks, not on 我的', (
    tester,
  ) async {
    await pumpClient(tester, seededState(online: false));
    expect(find.byType(NovaNotice), findsOneWidget);
    expect(find.textContaining('Host 不在线 · 展示上次缓存'), findsOneWidget);
    expect(find.byType(ListTile), findsNothing);
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

  testWidgets('我的 groups Space, Host and authorisation, and switches Space', (
    tester,
  ) async {
    var switched = 0;
    await pumpClient(tester, seededState(), onSwitchSpace: () => switched++);
    await tester.tap(find.text('我的'));
    await tester.pump();
    for (final header in ['Space', 'Host 连接', '手机采集与授权']) {
      expect(find.text(header), findsOneWidget);
    }
    await tester.tap(find.text('切换或新建 Space'));
    expect(switched, 1);
    // SelectableText carries its own Scrollable; scroll the page list.
    await tester.scrollUntilVisible(
      find.text('手机工具'),
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('手机工具'));
    await tester.pumpAndSettle();
    expect(find.textContaining('iOS 支持日历读取'), findsOneWidget);
  });

  testWidgets('keyboard hides the tab bar like the local app', (tester) async {
    await pumpClient(tester, seededState());
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    addTearDown(tester.view.resetViewInsets);
    await tester.pump();
    expect(find.byType(BottomAppBarTabs), findsNothing);
  });
}
