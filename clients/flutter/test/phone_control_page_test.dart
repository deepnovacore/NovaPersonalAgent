import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/phone_channel.dart';
import 'package:nova_mobile/ui/phone_control_page.dart';
import 'package:nova_mobile/ui/phone_setup_copy.dart';
import 'package:nova_mobile/ui/settings_sheet.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'support/fake_phone_channel.dart';

const _ready = PhoneStatus(
  apiLevel: 34,
  tier: PhoneTier.virtual,
  accessibility: true,
  overlay: true,
  batteryWhitelisted: true,
  notificationsAllowed: true,
  pairing: PairingState.paired,
  helper: HelperState.running,
);

Future<void> _pump(
  WidgetTester tester,
  FakePhoneChannel channel, {
  String language = 'zh',
  TargetPlatform? platform,
}) async {
  tester.view.physicalSize = const Size(400, 3600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: novaTheme(),
      home: PhoneControlPage(
        channel: channel,
        language: language,
        platform: platform ?? TargetPlatform.android,
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
}

Finder _row(String title) => find.widgetWithText(CupertinoListTile, title);

void main() {
  testWidgets(
    'everything ready: every row reports on and the helper is connected',
    (tester) async {
      final channel = FakePhoneChannel(_ready);
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(find.text('手机操作'), findsOneWidget);
      expect(
        find.text('已开启'),
        findsNWidgets(2),
      ); // accessibility, notifications
      expect(find.text('已允许'), findsNWidgets(2)); // overlay, battery
      expect(find.text('已配对'), findsOneWidget);
      expect(find.text('已连接'), findsOneWidget);
      expect(find.text('安卓 14'), findsOneWidget);
      expect(find.text('满足要求'), findsOneWidget);
      expect(find.byKey(const ValueKey('phone-experimental')), findsNothing);
      expect(find.byKey(const ValueKey('phone-helper-problem')), findsNothing);
    },
  );

  testWidgets(
    'nothing set up: rows show what is missing and open the right page',
    (tester) async {
      final channel = FakePhoneChannel(const PhoneStatus(apiLevel: 34));
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(find.text('未开启'), findsNWidgets(2));
      expect(find.text('未允许'), findsNWidgets(2));
      expect(find.text('未配对'), findsOneWidget);
      expect(find.text('未设置'), findsOneWidget);
      await tester.tap(_row('无障碍'));
      await tester.pump();
      await tester.tap(_row('悬浮窗'));
      await tester.pump();
      await tester.tap(_row('后台不被杀'));
      await tester.pump();
      expect(channel.opened, [
        PhoneSettingsKind.accessibility,
        PhoneSettingsKind.overlay,
        PhoneSettingsKind.battery,
      ]);
      await tester.tap(_row('通知'));
      await tester.pump();
      // The runtime prompt cannot fix a disabled channel: open its settings.
      expect(channel.opened.last, PhoneSettingsKind.notifications);
      expect(channel.calls, isNot(contains('requestNotifications')));
    },
  );

  testWidgets('a long status value at 2x text keeps the title readable', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(360, 4000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final channel = FakePhoneChannel(
      const PhoneStatus(
        apiLevel: 34,
        helper: HelperState.wirelessDebuggingOff,
        pairing: PairingState.paired,
      ),
    );
    addTearDown(channel.close);
    await tester.pumpWidget(
      MaterialApp(
        theme: novaTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: const TextScaler.linear(2)),
          child: child!,
        ),
        home: PhoneControlPage(
          channel: channel,
          language: 'en',
          platform: TargetPlatform.android,
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(tester.takeException(), isNull);
    final title = tester.getRect(find.text('Helper').first);
    final value = tester.getRect(find.text('Wireless debugging off').first);
    expect(title.width, greaterThan(60));
    expect(value.width, lessThanOrEqualTo(360 * .36 + 1));
    expect(title.right, lessThanOrEqualTo(value.left + 1));
  });

  testWidgets('a status event updates the page', (tester) async {
    final channel = FakePhoneChannel(const PhoneStatus(apiLevel: 34));
    addTearDown(channel.close);
    await _pump(tester, channel);
    expect(find.text('已连接'), findsNothing);
    channel.push(_ready);
    await tester.pump();
    await tester.pump();
    expect(find.text('已连接'), findsOneWidget);
  });

  group('helper states', () {
    testWidgets('searching for the pairing window', (tester) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(
          apiLevel: 34,
          pairing: PairingState.searching,
          helper: HelperState.notPaired,
        ),
      );
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(find.text('正在查找'), findsOneWidget);
    });

    testWidgets('wireless debugging off offers the fix', (tester) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(
          apiLevel: 34,
          pairing: PairingState.paired,
          helper: HelperState.wirelessDebuggingOff,
        ),
      );
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(find.text('无线调试已关'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, '去打开无线调试'));
      await tester.pump();
      expect(channel.opened.single, PhoneSettingsKind.wirelessDebugging);
    });

    testWidgets('connecting shows progress without a problem card', (
      tester,
    ) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(
          apiLevel: 34,
          pairing: PairingState.paired,
          helper: HelperState.connecting,
        ),
      );
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(find.text('正在连接'), findsAtLeastNWidgets(1));
      expect(find.byKey(const ValueKey('phone-helper-problem')), findsNothing);
    });

    testWidgets('a retryable failure explains itself and retries', (
      tester,
    ) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(
          apiLevel: 34,
          pairing: PairingState.paired,
          helper: HelperState.failed,
          helperFailure: HelperFailure.connectFailed,
          helperFix: HelperFix.retry,
        ),
      );
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(find.text('出错了'), findsOneWidget);
      expect(find.text('没能连上无线调试'), findsAtLeastNWidgets(1));
      await tester.tap(find.widgetWithText(FilledButton, '重试'));
      await tester.pump();
      expect(channel.calls, contains('ensureHelper'));
    });

    testWidgets('a wrong code sends the user to pair again', (tester) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(
          apiLevel: 34,
          helper: HelperState.failed,
          helperFailure: HelperFailure.wrongCode,
          helperFix: HelperFix.rePair,
        ),
      );
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(find.text('配对码不对或已过期'), findsAtLeastNWidgets(1));
      await tester.tap(find.widgetWithText(FilledButton, '重新配对'));
      await tester.pumpAndSettle();
      // The wizard opens on the pairing step and starts looking for the window.
      expect(find.text('用配对码配对'), findsOneWidget);
      expect(channel.calls, contains('startPairing'));
    });

    testWidgets('no Wi-Fi offers the Wi-Fi settings', (tester) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(
          apiLevel: 34,
          helper: HelperState.failed,
          helperFailure: HelperFailure.noWifi,
          helperFix: HelperFix.openWifi,
        ),
      );
      addTearDown(channel.close);
      await _pump(tester, channel);
      await tester.tap(find.widgetWithText(FilledButton, '打开 Wi-Fi 设置'));
      await tester.pump();
      expect(channel.opened.single, PhoneSettingsKind.wifi);
    });
  });

  group('system version', () {
    testWidgets('below Android 12 the helper rows are hidden', (tester) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(apiLevel: 30, helper: HelperState.unsupported),
      );
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(find.text('不支持'), findsOneWidget);
      expect(find.text('安卓 11'), findsNothing); // the row explains instead
      expect(find.textContaining('系统低于安卓 12'), findsOneWidget);
      expect(find.text('助手状态'), findsNothing);
      expect(find.text('无线调试配对'), findsNothing);
      expect(find.text('重新配对'), findsNothing);
      expect(find.text('开始自检'), findsNothing);
    });

    testWidgets('Android 12/13 warn and need an explicit acknowledgement', (
      tester,
    ) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(
          apiLevel: 33,
          tier: PhoneTier.virtual,
          experimental: true,
          accessibility: true,
          helper: HelperState.running,
          pairing: PairingState.paired,
        ),
      );
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(find.text('实验支持'), findsOneWidget);
      expect(find.text('安卓 13'), findsOneWidget);
      expect(find.text('安卓 12、13 上是实验功能'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, '我知道了，仍要使用'));
      await tester.pump();
      await tester.pump();
      expect(channel.calls, contains('setExperimentalAck:true'));
      expect(channel.current.experimentalAck, isTrue);
      expect(find.text('我知道了，仍要使用'), findsNothing);
      expect(find.text('已确认，仍要使用'), findsOneWidget);
    });

    testWidgets('an earlier acknowledgement is remembered', (tester) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(
          apiLevel: 32,
          experimental: true,
          experimentalAck: true,
        ),
      );
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(find.text('已确认，仍要使用'), findsOneWidget);
      expect(find.text('我知道了，仍要使用'), findsNothing);
    });

    testWidgets('a failed acknowledgement is shown, not swallowed', (
      tester,
    ) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(apiLevel: 33, experimental: true),
      )..ackError = const PhoneChannelException('unavailable');
      addTearDown(channel.close);
      await _pump(tester, channel);
      await tester.tap(find.widgetWithText(FilledButton, '我知道了，仍要使用'));
      await tester.pump();
      await tester.pump();
      expect(find.text('操作没有成功，请重试。'), findsOneWidget);
      expect(find.text('已确认，仍要使用'), findsNothing);
      expect(find.text('我知道了，仍要使用'), findsOneWidget);
    });

    testWidgets('the warning follows the native experimental flag', (
      tester,
    ) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(apiLevel: 33, experimental: false),
      );
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(find.byKey(const ValueKey('phone-experimental')), findsNothing);
    });

    testWidgets('English copy', (tester) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(apiLevel: 32, experimental: true),
      );
      addTearDown(channel.close);
      await _pump(tester, channel, language: 'en');
      expect(find.text('Phone control'), findsOneWidget);
      expect(find.text('Android 12L'), findsOneWidget);
      expect(find.text('I understand, use it anyway'), findsOneWidget);
    });
  });

  group('pairing actions', () {
    testWidgets('unpair asks first, then clears the pairing', (tester) async {
      final channel = FakePhoneChannel(_ready);
      addTearDown(channel.close);
      await _pump(tester, channel);
      await tester.tap(_row('解除配对'));
      await tester.pumpAndSettle();
      expect(find.text('解除配对？'), findsOneWidget);
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(channel.calls, isNot(contains('unpair')));
      await tester.tap(_row('解除配对'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, '解除'));
      await tester.pumpAndSettle();
      expect(channel.calls, contains('unpair'));
    });

    testWidgets('unpair is inert while unpaired', (tester) async {
      final channel = FakePhoneChannel(const PhoneStatus(apiLevel: 34));
      addTearDown(channel.close);
      await _pump(tester, channel);
      await tester.tap(_row('解除配对'));
      await tester.pumpAndSettle();
      expect(find.text('解除配对？'), findsNothing);
    });

    testWidgets('pair again opens the wizard on the pairing step', (
      tester,
    ) async {
      final channel = FakePhoneChannel(_ready);
      addTearDown(channel.close);
      await _pump(tester, channel);
      await tester.tap(_row('重新配对'));
      await tester.pumpAndSettle();
      expect(find.text('用配对码配对'), findsOneWidget);
      expect(channel.calls, contains('startPairing'));
    });
  });

  group('self-check', () {
    testWidgets('runs and lists each check with plain advice', (tester) async {
      final channel = FakePhoneChannel(_ready)
        ..checks = const [
          SelfCheckResult(id: 'helper', ok: true),
          SelfCheckResult(id: 'create_display', ok: true),
          SelfCheckResult(id: 'start_app', ok: true),
          SelfCheckResult(id: 'read_tree', ok: false, detail: 'empty_tree'),
          SelfCheckResult(id: 'tap', ok: true, detail: 'injection_only'),
          SelfCheckResult(id: 'type', ok: false, detail: 'no_text_field'),
          SelfCheckResult(id: 'back', ok: false, detail: 'not_run'),
          SelfCheckResult(id: 'main_focus', ok: false, detail: 'shared_focus'),
        ];
      addTearDown(channel.close);
      await _pump(tester, channel);
      await tester.tap(_row('开始自检'));
      await tester.pumpAndSettle();
      expect(channel.calls, contains('selfCheck'));
      expect(find.text('通过'), findsNWidgets(3));
      expect(find.text('未通过'), findsOneWidget);
      expect(find.text('部分可用'), findsNWidgets(2)); // tap fallback, shared focus
      expect(find.text('跳过'), findsNWidgets(2));
      expect(find.textContaining('读不到页面上的控件'), findsOneWidget);
      expect(find.textContaining('输入焦点可能短暂丢失'), findsOneWidget);
      expect(find.text('再查一次'), findsOneWidget);
    });

    testWidgets('every native detail code has a next step', (tester) async {
      const failing = {
        'helper': ['unsupported', 'not_running', 'helper_unavailable'],
        'create_display': ['accessibility_flags_failed', 'create_failed'],
        'start_app': [
          'app_in_use_on_main',
          'app_not_launchable',
          'display_unavailable',
          'accessibility_required',
          'not_on_display',
          'accessibility_unavailable',
        ],
        'read_tree': ['empty_tree', 'no_frame', 'black_frame'],
        'tap': ['no_free_point', 'gesture_uncertain', 'tap_refused'],
        'type': ['text_not_set'],
        'back': ['injection_refused', 'no_effect'],
      };
      for (final entry in failing.entries) {
        for (final detail in entry.value) {
          final advice = const PhoneCopy('en').selfCheckAdvice(
            SelfCheckResult(id: entry.key, ok: false, detail: detail),
          );
          expect(advice, isNotNull, reason: detail);
          expect(
            advice,
            isNot(contains('Please report')),
            reason: '$detail must say what to do',
          );
        }
      }
    });

    testWidgets('an unreadable focus is a warning, not a failure', (
      tester,
    ) async {
      final channel = FakePhoneChannel(_ready)
        ..checks = const [
          SelfCheckResult(id: 'helper', ok: true),
          SelfCheckResult(id: 'main_focus', ok: false, detail: 'unknown'),
        ];
      addTearDown(channel.close);
      await _pump(tester, channel);
      await tester.tap(_row('开始自检'));
      await tester.pumpAndSettle();
      expect(find.text('未通过'), findsNothing);
      expect(find.text('部分可用'), findsOneWidget);
    });

    testWidgets('copies redacted details for a report', (tester) async {
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      final channel = FakePhoneChannel(_ready)
        ..checks = const [
          SelfCheckResult(id: 'helper', ok: true),
          SelfCheckResult(id: 'tap', ok: false, detail: 'tap_refused'),
          SelfCheckResult(
            id: 'type',
            ok: false,
            detail: 'Bearer sk-secret leaked text',
          ),
        ];
      addTearDown(channel.close);
      await _pump(tester, channel);
      await tester.tap(_row('开始自检'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('phone-selfcheck-copy')));
      await tester.pumpAndSettle();
      expect(copied, contains('android_api=34'));
      expect(copied, contains('tap: FAIL (tap_refused)'));
      expect(copied, contains('type: FAIL (redacted)'));
      expect(copied, isNot(contains('sk-secret')));
      expect(find.text('已复制'), findsOneWidget);
    });

    testWidgets('run_active as a channel error reads the same', (tester) async {
      final channel = FakePhoneChannel(_ready)
        ..selfCheckError = const PhoneChannelException('run_active');
      addTearDown(channel.close);
      await _pump(tester, channel);
      await tester.tap(_row('开始自检'));
      await tester.pumpAndSettle();
      expect(find.text('有任务正在进行，等它结束后再自检。'), findsOneWidget);
    });

    testWidgets('other errors say the check did not finish', (tester) async {
      final channel = FakePhoneChannel(_ready)
        ..selfCheckError = const PhoneChannelException('unknown');
      addTearDown(channel.close);
      await _pump(tester, channel);
      await tester.tap(_row('开始自检'));
      await tester.pumpAndSettle();
      expect(find.text('自检没能完成，请重试。'), findsOneWidget);
    });

    testWidgets('is unavailable until the helper runs', (tester) async {
      final channel = FakePhoneChannel(const PhoneStatus(apiLevel: 34));
      addTearDown(channel.close);
      await _pump(tester, channel);
      await tester.tap(_row('开始自检'));
      await tester.pumpAndSettle();
      expect(channel.calls, isNot(contains('selfCheck')));
      expect(find.text('先完成设置并连上助手，再来自检。'), findsOneWidget);
    });
  });

  group('platform', () {
    test('iOS has no phone-control entry and the check says so', () {
      expect(phoneControlSupported(TargetPlatform.iOS), isFalse);
      expect(phoneControlSupported(TargetPlatform.android), isTrue);
      expect(phoneControlSettingsRows('zh', available: false), isEmpty);
      final rows = phoneControlSettingsRows('zh');
      expect(rows.single.$1, 'phone_control');
      expect(rows.single.$2, '手机操作');
    });

    testWidgets('the page on iOS is a note and never reads the bridge', (
      tester,
    ) async {
      final channel = FakePhoneChannel(_ready);
      addTearDown(channel.close);
      await _pump(tester, channel, platform: TargetPlatform.iOS);
      expect(find.text('手机操作只在安卓上可用。'), findsOneWidget);
      expect(channel.calls, isEmpty);
    });

    testWidgets('an unreachable bridge offers a retry', (tester) async {
      final channel = FakePhoneChannel(_ready)
        ..commandError = StateError('no bridge');
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(find.text('暂时读不到手机状态。'), findsOneWidget);
      channel.commandError = null;
      await tester.tap(find.text('重试'));
      await tester.pump();
      await tester.pump();
      expect(find.text('已连接'), findsOneWidget);
    });
  });
}
