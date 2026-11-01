import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent/phone_channel.dart';
import 'package:nova_mobile/ui/phone_setup_copy.dart';
import 'package:nova_mobile/ui/phone_setup_wizard.dart';
import 'package:nova_mobile/ui/theme.dart';
import 'support/fake_phone_channel.dart';

Future<void> _pump(
  WidgetTester tester,
  FakePhoneChannel channel, {
  bool startAtPairing = false,
  String language = 'zh',
  Size size = const Size(400, 3000),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: novaTheme(),
      home: PhoneSetupWizard(
        channel: channel,
        language: language,
        startAtPairing: startAtPairing,
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
}

const _fresh = PhoneStatus(apiLevel: 34);

void main() {
  group('PhoneSetupProgress', () {
    test('a fresh phone starts at the first step', () {
      final progress = PhoneSetupProgress(_fresh);
      expect(progress.firstOpen, PhoneSetupStep.developer);
      for (final step in PhoneSetupStep.values) {
        expect(progress.done(step), isFalse);
      }
    });

    test(
      'statuses tick their steps; the user confirms what cannot be read',
      () {
        const status = PhoneStatus(
          apiLevel: 34,
          accessibility: true,
          notificationsAllowed: true,
        );
        expect(
          PhoneSetupProgress(status).done(PhoneSetupStep.accessibility),
          isTrue,
        );
        expect(
          PhoneSetupProgress(status).done(PhoneSetupStep.notifications),
          isTrue,
        );
        // Developer options cannot be read: still open until confirmed.
        expect(PhoneSetupProgress(status).firstOpen, PhoneSetupStep.developer);
        final confirmed = PhoneSetupProgress(status, {
          PhoneSetupStep.developer,
        });
        expect(confirmed.firstOpen, PhoneSetupStep.wirelessDebugging);
      },
    );

    test('a found pairing window implies the earlier switches', () {
      const status = PhoneStatus(
        apiLevel: 34,
        pairing: PairingState.searching,
        pairingStage: PairingStage.waitingCode,
      );
      final progress = PhoneSetupProgress(status);
      expect(progress.done(PhoneSetupStep.developer), isTrue);
      expect(progress.done(PhoneSetupStep.wirelessDebugging), isTrue);
      expect(progress.done(PhoneSetupStep.pairingCode), isFalse);
    });

    test(
      'a failure takes the wizard to its step before earlier open steps',
      () {
        const status = PhoneStatus(
          apiLevel: 34,
          pairing: PairingState.searching,
          helper: HelperState.failed,
          helperFailure: HelperFailure.wrongCode,
        );
        final progress = PhoneSetupProgress(status);
        expect(progress.firstOpen, PhoneSetupStep.accessibility);
        expect(progress.target, PhoneSetupStep.pairingCode);
      },
    );

    test('everything running is done', () {
      const status = PhoneStatus(
        apiLevel: 34,
        accessibility: true,
        notificationsAllowed: true,
        pairing: PairingState.paired,
        helper: HelperState.running,
      );
      expect(PhoneSetupProgress(status).firstOpen, isNull);
    });

    test('failures land on the step they belong to and reopen it', () {
      PhoneSetupProgress failing(HelperFailure failure) => PhoneSetupProgress(
        PhoneStatus(
          apiLevel: 34,
          pairing: PairingState.paired,
          helper: HelperState.failed,
          helperFailure: failure,
        ),
      );
      expect(
        failing(HelperFailure.wrongCode).failedStep,
        PhoneSetupStep.pairingCode,
      );
      expect(
        failing(HelperFailure.wrongCode).done(PhoneSetupStep.pairingCode),
        isFalse,
      );
      expect(
        failing(HelperFailure.noWifi).failedStep,
        PhoneSetupStep.wirelessDebugging,
      );
      expect(
        failing(HelperFailure.connectFailed).failedStep,
        PhoneSetupStep.connect,
      );
      expect(
        failing(HelperFailure.helperStartFailed).failedStep,
        PhoneSetupStep.connect,
      );
    });

    test('wireless debugging switched off reopens that step', () {
      const status = PhoneStatus(
        apiLevel: 34,
        pairing: PairingState.paired,
        helper: HelperState.wirelessDebuggingOff,
      );
      final progress = PhoneSetupProgress(status, {
        PhoneSetupStep.wirelessDebugging,
      });
      expect(progress.failedStep, PhoneSetupStep.wirelessDebugging);
      expect(progress.done(PhoneSetupStep.wirelessDebugging), isFalse);
    });

    test('a live helper ignores a non-pairing failure', () {
      const status = PhoneStatus(
        apiLevel: 34,
        pairing: PairingState.paired,
        helper: HelperState.running,
        helperFailure: HelperFailure.connectFailed,
      );
      expect(PhoneSetupProgress(status).failure, isNull);
    });
  });

  testWidgets('lists the six numbered steps and the first one is open', (
    tester,
  ) async {
    final channel = FakePhoneChannel(_fresh);
    addTearDown(channel.close);
    await _pump(tester, channel);
    for (final title in [
      '打开开发者选项',
      '打开 Nova 的无障碍',
      '允许通知',
      '打开无线调试',
      '用配对码配对',
      '自动连接',
    ]) {
      expect(find.text(title), findsAtLeastNWidgets(1));
    }
    expect(find.text('1'), findsOneWidget);
    expect(find.text('6'), findsOneWidget);
    // Only the current step shows its full text and its fix button.
    expect(find.textContaining('连续点「版本号」7 次'), findsAtLeastNWidgets(1));
    // The title, and the button that opens that settings page.
    expect(find.text('打开开发者选项'), findsNWidgets(2));
    expect(find.text('稍后再说'), findsOneWidget);
  });

  testWidgets(
    'the developer step opens developer settings and waits for the user',
    (tester) async {
      final channel = FakePhoneChannel(_fresh);
      addTearDown(channel.close);
      await _pump(tester, channel);
      await tester.tap(find.widgetWithText(FilledButton, '打开开发者选项'));
      await tester.pump();
      expect(channel.opened, [PhoneSettingsKind.developer]);
      // Unreadable switch: nothing advances until the user says so.
      expect(find.text('我已经打开了，下一步'), findsOneWidget);
      await tester.tap(find.text('我已经打开了，下一步'));
      await tester.pump();
      expect(find.textContaining('在系统的「无障碍」设置里找到 Nova'), findsOneWidget);
      expect(find.text('已打开'), findsOneWidget);
    },
  );

  testWidgets('a readable status ticks its step without asking', (
    tester,
  ) async {
    final channel = FakePhoneChannel(_fresh);
    addTearDown(channel.close);
    await _pump(tester, channel);
    await tester.tap(find.text('我已经打开了，下一步'));
    await tester.pump();
    channel.push(
      const PhoneStatus(
        apiLevel: 34,
        accessibility: true,
        notificationsAllowed: true,
      ),
    );
    await tester.pump();
    await tester.pump();
    // Accessibility and notifications were switched on elsewhere: the wizard
    // is now on wireless debugging.
    expect(find.textContaining('「无线调试」并打开'), findsOneWidget);
  });

  testWidgets('done steps can be revisited', (tester) async {
    final channel = FakePhoneChannel(
      const PhoneStatus(
        apiLevel: 34,
        accessibility: true,
        notificationsAllowed: true,
      ),
    );
    addTearDown(channel.close);
    await _pump(tester, channel);
    await tester.tap(find.text('我已经打开了，下一步')); // developer
    await tester.pump();
    expect(find.textContaining('「无线调试」并打开'), findsOneWidget);
    await tester.tap(find.text('打开 Nova 的无障碍'));
    await tester.pump();
    expect(find.textContaining('在系统的「无障碍」设置里找到 Nova'), findsOneWidget);
    expect(find.textContaining('「无线调试」并打开'), findsNothing);
    await tester.tap(find.widgetWithText(FilledButton, '去无障碍设置'));
    await tester.pump();
    expect(channel.opened.last, PhoneSettingsKind.accessibility);
  });

  testWidgets(
    'entering the pairing step starts the pairing window search once',
    (tester) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(
          apiLevel: 34,
          notificationsAllowed: true,
          pairing: PairingState.searching,
          pairingStage: PairingStage.waitingCode,
          pairingPort: 41235,
        ),
      );
      addTearDown(channel.close);
      await _pump(tester, channel, startAtPairing: true);
      expect(channel.calls.where((c) => c == 'startPairing'), hasLength(1));
      expect(find.text('已找到配对窗口，请在通知里填写配对码。'), findsOneWidget);
      expect(find.text('1. 点「使用配对码配对设备」'), findsOneWidget);
      expect(find.text('3. 点「填配对码」，输入 6 位数字'), findsOneWidget);
      channel.push(channel.current);
      await tester.pump();
      expect(channel.calls.where((c) => c == 'startPairing'), hasLength(1));
    },
  );

  testWidgets('with accessibility on the code is read automatically', (
    tester,
  ) async {
    final channel = FakePhoneChannel(
      const PhoneStatus(
        apiLevel: 34,
        accessibility: true,
        notificationsAllowed: true,
        pairing: PairingState.searching,
        pairingStage: PairingStage.waitingCode,
      ),
    );
    addTearDown(channel.close);
    await _pump(tester, channel);
    expect(find.textContaining('Nova 会自己读出来'), findsOneWidget);
    expect(find.textContaining('点「填配对码」'), findsNothing);
  });

  testWidgets('without notification access the pairing step asks for it', (
    tester,
  ) async {
    final channel = FakePhoneChannel(
      const PhoneStatus(
        apiLevel: 34,
        pairing: PairingState.searching,
        pairingStage: PairingStage.waitingCode,
      ),
    );
    addTearDown(channel.close);
    await _pump(tester, channel, startAtPairing: true);
    expect(find.text('配对码要在通知里填，先允许 Nova 发通知。'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '允许通知').last);
    await tester.pump();
    expect(channel.calls, contains('requestNotifications'));
  });

  group('manual code', () {
    const pairing = PhoneStatus(
      apiLevel: 34,
      notificationsAllowed: true,
      pairing: PairingState.searching,
      pairingStage: PairingStage.waitingCode,
    );

    testWidgets('validates before sending', (tester) async {
      final channel = FakePhoneChannel(pairing);
      addTearDown(channel.close);
      await _pump(tester, channel, startAtPairing: true);
      await tester.tap(find.text('通知没出来？在这里填'));
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, '配对'));
      await tester.pump();
      expect(find.text('要填 6 位数字'), findsOneWidget);
      expect(channel.submitted, isEmpty);
      await tester.enterText(find.byType(TextField).first, '12a3456789');
      await tester.enterText(find.byType(TextField).last, '70000');
      await tester.tap(find.widgetWithText(FilledButton, '配对'));
      await tester.pump();
      // Digits only and at most six: "123456" is kept, the port is out of range.
      expect(find.text('冒号后面的数字不对'), findsOneWidget);
      expect(channel.submitted, isEmpty);
    });

    testWidgets('sends the code with the optional port', (tester) async {
      final channel = FakePhoneChannel(pairing);
      addTearDown(channel.close);
      await _pump(tester, channel, startAtPairing: true);
      await tester.tap(find.text('通知没出来？在这里填'));
      await tester.pump();
      await tester.enterText(find.byType(TextField).first, '123456');
      await tester.enterText(find.byType(TextField).last, '41235');
      await tester.tap(find.widgetWithText(FilledButton, '配对'));
      await tester.pump();
      await tester.pump();
      expect(channel.submitted, [('123456', 41235)]);
    });

    testWidgets('the port is optional', (tester) async {
      final channel = FakePhoneChannel(pairing);
      addTearDown(channel.close);
      await _pump(tester, channel, startAtPairing: true);
      await tester.tap(find.text('通知没出来？在这里填'));
      await tester.pump();
      await tester.enterText(find.byType(TextField).first, '654321');
      await tester.tap(find.widgetWithText(FilledButton, '配对'));
      await tester.pump();
      await tester.pump();
      expect(channel.submitted, [('654321', null)]);
    });
  });

  group('failure cards', () {
    testWidgets('a wrong code shows one fix button that pairs again', (
      tester,
    ) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(
          apiLevel: 34,
          notificationsAllowed: true,
          pairing: PairingState.searching,
          helper: HelperState.failed,
          helperFailure: HelperFailure.wrongCode,
          helperFix: HelperFix.rePair,
        ),
      );
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(
        find.byKey(const ValueKey('phone-wizard-failure-wrongCode')),
        findsOneWidget,
      );
      expect(find.text('配对码不对或已过期'), findsOneWidget);
      final before = channel.calls.where((c) => c == 'startPairing').length;
      await tester.tap(find.widgetWithText(FilledButton, '重新配对'));
      await tester.pump();
      await tester.pump();
      expect(
        channel.calls.where((c) => c == 'startPairing').length,
        greaterThan(before),
      );
    });

    testWidgets('a connection failure retries from the connect step', (
      tester,
    ) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(
          apiLevel: 34,
          accessibility: true,
          notificationsAllowed: true,
          pairing: PairingState.paired,
          helper: HelperState.failed,
          helperFailure: HelperFailure.connectFailed,
          helperFix: HelperFix.retry,
        ),
      );
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(
        find.byKey(const ValueKey('phone-wizard-failure-connectFailed')),
        findsOneWidget,
      );
      await tester.tap(find.widgetWithText(FilledButton, '重试'));
      await tester.pump();
      expect(channel.calls, contains('ensureHelper'));
    });

    testWidgets(
      'no Wi-Fi sits on the wireless debugging step with the Wi-Fi fix',
      (tester) async {
        final channel = FakePhoneChannel(
          const PhoneStatus(
            apiLevel: 34,
            accessibility: true,
            notificationsAllowed: true,
            pairing: PairingState.paired,
            helper: HelperState.failed,
            helperFailure: HelperFailure.noWifi,
            helperFix: HelperFix.openWifi,
          ),
        );
        addTearDown(channel.close);
        await _pump(tester, channel);
        await tester.tap(find.widgetWithText(FilledButton, '打开 Wi-Fi 设置'));
        await tester.pump();
        expect(channel.opened.last, PhoneSettingsKind.wifi);
      },
    );
  });

  testWidgets('connecting shows progress; success offers Done', (tester) async {
    final channel = FakePhoneChannel(
      const PhoneStatus(
        apiLevel: 34,
        accessibility: true,
        notificationsAllowed: true,
        pairing: PairingState.paired,
        pairingStage: PairingStage.connecting,
        helper: HelperState.connecting,
      ),
    );
    addTearDown(channel.close);
    await _pump(tester, channel);
    expect(find.text('正在配对并连接，几秒钟就好'), findsOneWidget);
    channel.push(
      const PhoneStatus(
        apiLevel: 34,
        accessibility: true,
        notificationsAllowed: true,
        pairing: PairingState.paired,
        pairingStage: PairingStage.done,
        helper: HelperState.running,
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const ValueKey('phone-wizard-success')), findsOneWidget);
    expect(find.text('手机操作已经设置好了'), findsOneWidget);
    expect(find.text('已连接'), findsOneWidget);
  });

  testWidgets(
    '"Not now" is always there and leaves without changing anything',
    (tester) async {
      final channel = FakePhoneChannel(_fresh);
      addTearDown(channel.close);
      tester.view.physicalSize = const Size(400, 3000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: novaTheme(),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => openPhoneSetupWizard(context, channel),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('稍后再说'), findsOneWidget);
      await tester.tap(find.text('稍后再说'));
      await tester.pumpAndSettle();
      expect(find.text('open'), findsOneWidget);
      expect(channel.calls, isNot(contains('unpair')));
    },
  );

  testWidgets('re-pairing opens on the pairing step even if paired', (
    tester,
  ) async {
    final channel = FakePhoneChannel(
      const PhoneStatus(
        apiLevel: 34,
        accessibility: true,
        notificationsAllowed: true,
        pairing: PairingState.paired,
        helper: HelperState.running,
      ),
    );
    addTearDown(channel.close);
    await _pump(tester, channel, startAtPairing: true);
    expect(channel.calls, contains('startPairing'));
    expect(find.textContaining('点进「无线调试」'), findsOneWidget);
  });

  testWidgets('fits a 360dp wide phone and large text without overflow', (
    tester,
  ) async {
    final channel = FakePhoneChannel(
      const PhoneStatus(
        apiLevel: 34,
        notificationsAllowed: true,
        pairing: PairingState.searching,
        pairingStage: PairingStage.waitingCode,
      ),
    );
    addTearDown(channel.close);
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: novaTheme(),
        home: MediaQuery(
          data: const MediaQueryData(
            size: Size(360, 800),
            textScaler: TextScaler.linear(1.6),
          ),
          child: PhoneSetupWizard(channel: channel, startAtPairing: true),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    await tester.ensureVisible(find.text('通知没出来？在这里填'));
    await tester.pump();
    await tester.tap(find.text('通知没出来？在这里填'));
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('English copy', (tester) async {
    final channel = FakePhoneChannel(_fresh);
    addTearDown(channel.close);
    await _pump(tester, channel, language: 'en');
    expect(find.text('Turn on Developer options'), findsOneWidget);
    expect(find.text('I’ve turned it on, next'), findsOneWidget);
    expect(find.text('Not now'), findsOneWidget);
  });

  group('pairing code and port input', () {
    test('a pasted address keeps only the port; full-width digits count', () {
      expect(parsePairingPort('192.168.1.5:41235'), (valid: true, port: 41235));
      expect(parsePairingPort('192.168.1.5：41235'), (valid: true, port: 41235));
      expect(parsePairingPort(' ４１２３５ '), (valid: true, port: 41235));
      expect(parsePairingPort(''), (valid: true, port: null));
      expect(parsePairingPort('   '), (valid: true, port: null));
      expect(parsePairingPort('70000').valid, isFalse);
      expect(parsePairingPort('0').valid, isFalse);
      expect(parsePairingPort('abc').valid, isFalse);
      expect(parsePairingPort('192.168.1.5:').valid, isFalse);
      expect(parsePairingCode('１２３４５６'), '123456');
      expect(parsePairingCode('123 456'), '123456');
      expect(parsePairingCode('12345'), isNull);
    });

    testWidgets('pasting host:port into the form sends the port', (
      tester,
    ) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(
          apiLevel: 34,
          notificationsAllowed: true,
          pairing: PairingState.searching,
          pairingStage: PairingStage.waitingCode,
        ),
      );
      addTearDown(channel.close);
      await _pump(tester, channel, startAtPairing: true);
      await tester.tap(find.text('通知没出来？在这里填'));
      await tester.pump();
      await tester.enterText(find.byType(TextField).first, '１２３４５６');
      await tester.enterText(find.byType(TextField).last, '192.168.1.5:41235');
      await tester.tap(find.widgetWithText(FilledButton, '配对'));
      await tester.pump();
      await tester.pump();
      expect(channel.submitted, [('123456', 41235)]);
    });
  });

  testWidgets('returning to the pairing step arms the search again', (
    tester,
  ) async {
    final channel = FakePhoneChannel(
      const PhoneStatus(
        apiLevel: 34,
        notificationsAllowed: true,
        pairing: PairingState.searching,
        pairingStage: PairingStage.waitingCode,
      ),
    );
    addTearDown(channel.close);
    await _pump(tester, channel, startAtPairing: true);
    int starts() => channel.calls.where((c) => c == 'startPairing').length;
    expect(starts(), 1);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    await tester.pump();
    expect(starts(), 2);
  });

  testWidgets('resuming on another step does not start pairing', (
    tester,
  ) async {
    final channel = FakePhoneChannel(_fresh);
    addTearDown(channel.close);
    await _pump(tester, channel);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    await tester.pump();
    expect(channel.calls, isNot(contains('startPairing')));
  });

  testWidgets('restricted settings: text and a button to App info', (
    tester,
  ) async {
    final channel = FakePhoneChannel(
      const PhoneStatus(apiLevel: 34, pairing: PairingState.searching),
    );
    addTearDown(channel.close);
    await _pump(tester, channel);
    expect(find.textContaining('允许受限制的设置'), findsOneWidget);
    expect(find.textContaining('不打开也行'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '打开应用信息'));
    await tester.pump();
    expect(channel.opened, [PhoneSettingsKind.appInfo]);
  });

  testWidgets('notifications that stay blocked open the notification page', (
    tester,
  ) async {
    final channel = FakePhoneChannel(
      const PhoneStatus(
        apiLevel: 34,
        accessibility: true,
        pairing: PairingState.searching,
      ),
    );
    addTearDown(channel.close);
    await _pump(tester, channel);
    await tester.tap(find.widgetWithText(FilledButton, '允许通知').last);
    await tester.pump();
    await tester.pump();
    expect(channel.calls, contains('requestNotifications'));
    expect(channel.opened, [PhoneSettingsKind.notifications]);
  });

  group('Android 12/13 acknowledgement', () {
    const ready = PhoneStatus(
      apiLevel: 33,
      experimental: true,
      accessibility: true,
      notificationsAllowed: true,
      pairing: PairingState.paired,
      helper: HelperState.running,
    );

    testWidgets('all steps done is not "set up" until it is accepted', (
      tester,
    ) async {
      final channel = FakePhoneChannel(ready);
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(
        find.byKey(const ValueKey('phone-wizard-experimental')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('phone-wizard-success')), findsNothing);
      await tester.tap(find.widgetWithText(FilledButton, '我知道了，仍要使用'));
      await tester.pump();
      await tester.pump();
      expect(channel.calls, contains('setExperimentalAck:true'));
      expect(
        find.byKey(const ValueKey('phone-wizard-experimental')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('phone-wizard-success')),
        findsOneWidget,
      );
    });

    testWidgets('a failed acknowledgement stays open and says so', (
      tester,
    ) async {
      final channel = FakePhoneChannel(ready)
        ..ackError = const PhoneChannelException('unavailable');
      addTearDown(channel.close);
      await _pump(tester, channel);
      await tester.tap(find.widgetWithText(FilledButton, '我知道了，仍要使用'));
      await tester.pump();
      await tester.pump();
      expect(find.text('操作没有成功，请重试。'), findsOneWidget);
      expect(find.byKey(const ValueKey('phone-wizard-success')), findsNothing);
    });

    testWidgets('Android 14 needs none', (tester) async {
      final channel = FakePhoneChannel(
        const PhoneStatus(
          apiLevel: 34,
          accessibility: true,
          notificationsAllowed: true,
          pairing: PairingState.paired,
          helper: HelperState.running,
        ),
      );
      addTearDown(channel.close);
      await _pump(tester, channel);
      expect(
        find.byKey(const ValueKey('phone-wizard-experimental')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('phone-wizard-success')),
        findsOneWidget,
      );
    });
  });

  testWidgets('a too-old Android says so inside the wizard', (tester) async {
    final channel = FakePhoneChannel(
      const PhoneStatus(apiLevel: 30, helper: HelperState.unsupported),
    );
    addTearDown(channel.close);
    await _pump(tester, channel);
    expect(find.byKey(const ValueKey('phone-wizard-too-old')), findsOneWidget);
    expect(find.text('正在本机查找无线调试…'), findsNothing);
    expect(channel.calls, isNot(contains('startPairing')));
  });

  testWidgets('each step is announced once, not by container and texts', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final channel = FakePhoneChannel(_fresh);
    addTearDown(channel.close);
    await _pump(tester, channel);
    expect(find.bySemanticsLabel(RegExp(r'^1\. 打开开发者选项$')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^2\. 打开 Nova 的无障碍')), findsOneWidget);
    // The title text and the numbered badge add no nodes of their own; the
    // one bare match is the step's action button, which has the same words.
    expect(find.bySemanticsLabel('打开开发者选项'), findsOneWidget);
    expect(find.bySemanticsLabel('1'), findsNothing);
    final current = tester.getSemantics(
      find.bySemanticsLabel(RegExp(r'^1\. 打开开发者选项$')),
    );
    // ignore: deprecated_member_use
    expect(current.hasFlag(SemanticsFlag.isSelected), isTrue);
    semantics.dispose();
  });

  testWidgets('"Not now" stays on screen however long the steps are', (
    tester,
  ) async {
    final channel = FakePhoneChannel(
      const PhoneStatus(
        apiLevel: 34,
        notificationsAllowed: true,
        pairing: PairingState.searching,
        pairingStage: PairingStage.waitingCode,
      ),
    );
    addTearDown(channel.close);
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: novaTheme(),
        home: MediaQuery(
          data: const MediaQueryData(
            size: Size(360, 640),
            textScaler: TextScaler.linear(2),
          ),
          child: PhoneSetupWizard(channel: channel, startAtPairing: true),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    await tester.ensureVisible(find.text('通知没出来？在这里填'));
    await tester.tap(find.text('通知没出来？在这里填'));
    await tester.pump();
    final later = tester.getRect(
      find.byKey(const ValueKey('phone-wizard-later')),
    );
    expect(later.bottom, lessThanOrEqualTo(640));
    expect(later.top, greaterThanOrEqualTo(0));
    expect(later.height, greaterThanOrEqualTo(48));
    // Scrolled to the very top it is still there.
    await tester.drag(find.byType(ListView), const Offset(0, 4000));
    await tester.pump();
    expect(
      tester.getRect(find.byKey(const ValueKey('phone-wizard-later'))).bottom,
      lessThanOrEqualTo(640),
    );
  });
}
