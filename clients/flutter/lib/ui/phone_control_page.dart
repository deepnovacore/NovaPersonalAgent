// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: Flutter reimplementation of
// PhoneOpsScreen (SettingsSubPages.kt) and SelfCheckScreen.kt on the
// nova/phone/v1 status; no Mika code or assets are copied.
import 'dart:async';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../agent/phone_channel.dart';
import '../agent/phone_status_watcher.dart';
import 'components.dart';
import 'phone_setup_copy.dart';
import 'phone_setup_wizard.dart';
import 'theme.dart';

/// Settings › 手机操作: what is switched on, what the helper is doing, how to
/// pair again, and a self-check of the virtual screen. Android only.
class PhoneControlPage extends StatefulWidget {
  const PhoneControlPage({
    super.key,
    required this.channel,
    this.language = 'zh',
    this.platform,
  });
  final PhoneChannel channel;
  final String language;

  /// Overrides the platform for tests.
  final TargetPlatform? platform;

  @override
  State<PhoneControlPage> createState() => _PhoneControlPageState();
}

enum _Tone { ok, bad, warn, plain }

class _PhoneControlPageState extends State<PhoneControlPage> {
  late final PhoneStatusWatcher watcher = PhoneStatusWatcher(widget.channel);
  PhoneCopy get c => PhoneCopy(widget.language);
  bool selfChecking = false, failedAction = false;
  List<SelfCheckResult>? results;
  String? selfCheckError;

  bool get supported => phoneControlSupported(widget.platform);

  @override
  void initState() {
    super.initState();
    if (!supported) return;
    watcher.addListener(_changed);
    watcher.start();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    watcher.removeListener(_changed);
    watcher.dispose();
    super.dispose();
  }

  Color _color(_Tone tone) => switch (tone) {
    _Tone.ok => Nova.mint,
    _Tone.bad => Nova.red,
    _Tone.warn => Nova.amber,
    _Tone.plain => Nova.secondary,
  };

  Widget _row({
    required IconData icon,
    required String title,
    required String subtitle,
    required String value,
    required _Tone tone,
    VoidCallback? onTap,
  }) => NovaTile(
    surface: Nova.sheetCell,
    leading: NovaIconTile(icon),
    title: title,
    subtitle: Text(subtitle),
    trailing: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (value.isNotEmpty)
          Flexible(
            child: Text(
              value,
              textAlign: TextAlign.end,
              style: TextStyle(color: _color(tone), fontSize: 14),
            ),
          ),
        if (onTap != null) const CupertinoListTileChevron(),
      ],
    ),
    onTap: onTap,
  );

  Future<void> _guard(Future<void> Function() action) async {
    if (failedAction) setState(() => failedAction = false);
    try {
      await action();
    } catch (_) {
      if (mounted) setState(() => failedAction = true);
    }
  }

  Future<void> _open(PhoneSettingsKind kind) =>
      _guard(() async => await widget.channel.openSettings(kind));

  Future<void> _requestNotifications() => _guard(() async {
    await widget.channel.requestNotifications();
    await watcher.refresh();
  });

  Future<void> _wizard({bool repair = false}) async {
    await openPhoneSetupWizard(
      context,
      widget.channel,
      language: widget.language,
      startAtPairing: repair,
    );
    if (mounted) unawaited(watcher.refresh());
  }

  Future<void> _fix(HelperFix fix) => switch (fix) {
    HelperFix.retry => _guard(() => watcher.run(widget.channel.ensureHelper)),
    HelperFix.rePair => _wizard(repair: true),
    HelperFix.openWifi => _open(PhoneSettingsKind.wifi),
    HelperFix.openWirelessDebugging => _open(
      PhoneSettingsKind.wirelessDebugging,
    ),
  };

  Future<void> _unpair() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(c.unpairTitle),
        content: Text(c.unpairBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: Text(c.cancel),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            style: TextButton.styleFrom(foregroundColor: Nova.red),
            child: Text(c.unpairConfirm),
          ),
        ],
      ),
    );
    if (confirmed == true && mounted) {
      await _guard(() => watcher.run(widget.channel.unpair));
    }
  }

  Future<void> _acknowledge() =>
      _guard(() => watcher.run(() => widget.channel.setExperimentalAck(true)));

  Future<void> _selfCheck() async {
    setState(() {
      selfChecking = true;
      results = null;
      selfCheckError = null;
    });
    try {
      final next = await widget.channel.selfCheck();
      if (!mounted) return;
      setState(() => results = next);
    } on PhoneChannelException catch (error) {
      if (mounted) {
        setState(
          () => selfCheckError = error.code == 'run_active'
              ? c.selfCheckRunActive
              : c.selfCheckFailedToRun,
        );
      }
    } catch (_) {
      if (mounted) setState(() => selfCheckError = c.selfCheckFailedToRun);
    } finally {
      if (mounted) setState(() => selfChecking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final status = watcher.status;
    return Scaffold(
      backgroundColor: Nova.sheet,
      appBar: AppBar(title: Text(c.title)),
      body: !supported
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Text(
                  widget.language == 'zh'
                      ? '手机操作只在安卓上可用。'
                      : 'Phone control is only available on Android.',
                  style: const TextStyle(color: Nova.secondary),
                ),
              ),
            )
          : status == null
          ? _loading()
          : ListView(
              padding: const EdgeInsets.fromLTRB(0, 8, 0, 28),
              children: _content(status),
            ),
    );
  }

  Widget _loading() => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: watcher.unavailable
          ? Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  c.unavailable,
                  style: const TextStyle(color: Nova.secondary),
                ),
                TextButton(
                  onPressed: () {
                    setState(() => watcher.unavailable = false);
                    watcher.refresh();
                  },
                  child: Text(c.retry),
                ),
              ],
            )
          : const CircularProgressIndicator(),
    ),
  );

  List<Widget> _content(PhoneStatus s) {
    final tooOld = !s.supported;
    final focusWarning = !tooOld && s.experimental;
    final pairingValue = switch (s.pairing) {
      PairingState.paired => (c.paired, _Tone.ok),
      PairingState.searching => (c.searching, _Tone.plain),
      PairingState.unpaired => (c.unpaired, _Tone.bad),
    };
    final helperTone = switch (s.helper) {
      HelperState.running => _Tone.ok,
      HelperState.connecting => _Tone.plain,
      _ => _Tone.bad,
    };
    return [
      Padding(
        padding: const EdgeInsets.fromLTRB(32, 4, 32, 14),
        child: Text(
          c.intro,
          style: const TextStyle(
            color: Nova.secondary,
            fontSize: 13,
            height: 1.45,
          ),
        ),
      ),
      NovaSection(
        header: c.statusHeader,
        surface: Nova.sheetCell,
        children: [
          _row(
            icon: CupertinoIcons.hand_raised,
            title: c.accessibility,
            subtitle: c.accessibilitySub,
            value: s.accessibility ? c.on : c.off,
            tone: s.accessibility ? _Tone.ok : _Tone.bad,
            onTap: s.accessibility
                ? null
                : () => _open(PhoneSettingsKind.accessibility),
          ),
          _row(
            icon: CupertinoIcons.rectangle_on_rectangle,
            title: c.overlay,
            subtitle: c.overlaySub,
            value: s.overlay ? c.allowed : c.notAllowed,
            tone: s.overlay ? _Tone.ok : _Tone.warn,
            onTap: s.overlay ? null : () => _open(PhoneSettingsKind.overlay),
          ),
          _row(
            icon: CupertinoIcons.battery_charging,
            title: c.battery,
            subtitle: c.batterySub,
            value: s.batteryWhitelisted ? c.allowed : c.notAllowed,
            tone: s.batteryWhitelisted ? _Tone.ok : _Tone.warn,
            onTap: s.batteryWhitelisted
                ? null
                : () => _open(PhoneSettingsKind.battery),
          ),
          _row(
            icon: CupertinoIcons.bell,
            title: c.notifications,
            subtitle: c.notificationsSub,
            value: s.notificationsAllowed ? c.on : c.off,
            tone: s.notificationsAllowed ? _Tone.ok : _Tone.warn,
            onTap: s.notificationsAllowed ? null : _requestNotifications,
          ),
          if (!tooOld) ...[
            _row(
              icon: CupertinoIcons.link,
              title: c.pairing,
              subtitle: c.setUpSub,
              value: pairingValue.$1,
              tone: pairingValue.$2,
              onTap: _wizard,
            ),
            _row(
              icon: CupertinoIcons.sparkles,
              title: c.helper,
              subtitle: c.helperLine(s),
              value: c.helperValue(s),
              tone: helperTone,
              onTap: s.helperRunning ? null : _wizard,
            ),
          ],
          _row(
            icon: CupertinoIcons.device_phone_portrait,
            title: c.systemVersion,
            subtitle: tooOld ? c.tooOldLine : c.versionLine(s.apiLevel),
            value: tooOld
                ? c.versionTooOld
                : focusWarning
                ? c.versionExperimental
                : c.versionOk,
            tone: tooOld
                ? _Tone.bad
                : focusWarning
                ? _Tone.warn
                : _Tone.ok,
          ),
        ],
      ),
      if (focusWarning) _experimentalCard(s),
      if (!tooOld) ..._helperProblem(s),
      if (failedAction)
        Padding(
          padding: const EdgeInsets.fromLTRB(32, 0, 32, 10),
          child: Text(
            c.actionFailed,
            style: const TextStyle(color: Nova.red, fontSize: 13),
          ),
        ),
      if (!tooOld) ...[
        NovaSection(
          header: c.channelHeader,
          surface: Nova.sheetCell,
          footer: c.usageNote,
          children: [
            _row(
              icon: CupertinoIcons.arrow_2_circlepath,
              title: c.repair,
              subtitle: c.repairSub,
              value: '',
              tone: _Tone.plain,
              onTap: () => _wizard(repair: true),
            ),
            NovaTile(
              surface: Nova.sheetCell,
              leading: NovaIconTile(
                CupertinoIcons.xmark_circle,
                color: s.paired ? Nova.red : Nova.tertiary,
              ),
              title: c.unpair,
              subtitle: Text(c.unpairSub),
              onTap: s.paired ? _unpair : null,
            ),
          ],
        ),
        ..._selfCheckSection(s),
      ],
    ];
  }

  /// Android 12 and 13 can lose main-screen focus while Nova works: an
  /// explicit "use it anyway" keeps the warning from being scrolled past.
  Widget _experimentalCard(PhoneStatus s) => Container(
    key: const ValueKey('phone-experimental'),
    margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
    padding: const EdgeInsets.all(14),
    decoration: BoxDecoration(
      color: Nova.amber.withValues(alpha: .08),
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: Nova.amber.withValues(alpha: .35)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          c.experimentalTitle,
          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
        ),
        const SizedBox(height: 4),
        Text(
          c.experimentalBody,
          style: const TextStyle(
            color: Nova.secondary,
            fontSize: 13,
            height: 1.4,
          ),
        ),
        const SizedBox(height: 8),
        if (s.experimentalAck)
          Row(
            children: [
              const Icon(
                CupertinoIcons.checkmark_alt,
                size: 16,
                color: Nova.mint,
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  c.experimentalAcked,
                  style: const TextStyle(color: Nova.mint, fontSize: 13),
                ),
              ),
            ],
          )
        else
          Align(
            alignment: Alignment.centerLeft,
            child: FilledButton.tonal(
              onPressed: _acknowledge,
              child: Text(c.experimentalAck),
            ),
          ),
      ],
    ),
  );

  List<Widget> _helperProblem(PhoneStatus s) {
    final failure = s.helperFailure;
    final HelperFix? fix = switch (s.helper) {
      HelperState.failed => s.helperFix ?? HelperFix.retry,
      HelperState.wirelessDebuggingOff => HelperFix.openWirelessDebugging,
      _ => null,
    };
    if (fix == null) return const [];
    final copy = failure == null || s.helper != HelperState.failed
        ? null
        : c.failure(failure);
    return [
      Container(
        key: const ValueKey('phone-helper-problem'),
        margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: Nova.red.withValues(alpha: .06),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              copy?.title ?? c.helperLine(s),
              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
            ),
            if (copy != null) ...[
              const SizedBox(height: 4),
              Text(
                copy.body,
                style: const TextStyle(
                  color: Nova.secondary,
                  fontSize: 13,
                  height: 1.4,
                ),
              ),
            ],
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: FilledButton.tonal(
                onPressed: () => _fix(fix),
                child: Text(c.fixLabel(fix)),
              ),
            ),
          ],
        ),
      ),
    ];
  }

  List<Widget> _selfCheckSection(PhoneStatus s) {
    final rows = results == null
        ? const <SelfCheckResult>[]
        : [
            for (final id in PhoneCopy.selfCheckOrder)
              ...results!.where((r) => r.id == id),
            ...results!.where((r) => !PhoneCopy.selfCheckOrder.contains(r.id)),
          ];
    final runActive = rows.any((r) => r.detail == 'run_active');
    return [
      NovaSection(
        header: c.selfCheckHeader,
        surface: Nova.sheetCell,
        footer: s.helperRunning ? c.selfCheckIntro : c.selfCheckNeedsSetup,
        children: [
          NovaTile(
            surface: Nova.sheetCell,
            leading: selfChecking
                ? const SizedBox(
                    width: 26,
                    height: 26,
                    child: Padding(
                      padding: EdgeInsets.all(4),
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : const NovaIconTile(CupertinoIcons.checkmark_shield),
            title: selfChecking
                ? c.selfCheckRunning
                : results == null
                ? c.selfCheckStart
                : c.selfCheckAgain,
            onTap: selfChecking || !s.helperRunning ? null : _selfCheck,
          ),
          if (selfCheckError != null)
            NovaTile(
              surface: Nova.sheetCell,
              title: selfCheckError!,
              leading: const NovaIconTile(CupertinoIcons.info),
            ),
          if (runActive)
            NovaTile(
              surface: Nova.sheetCell,
              title: c.selfCheckRunActive,
              leading: const NovaIconTile(CupertinoIcons.hourglass),
            )
          else
            for (final r in rows)
              NovaTile(
                surface: Nova.sheetCell,
                title: c.selfCheckName(r.id),
                subtitle: c.selfCheckAdvice(r) == null
                    ? null
                    : Text(c.selfCheckAdvice(r)!),
                trailing: Text(
                  c.selfCheckStatus(selfCheckOutcome(r)),
                  style: TextStyle(
                    color: switch (selfCheckOutcome(r)) {
                      SelfCheckOutcome.pass => Nova.mint,
                      SelfCheckOutcome.partial => Nova.amber,
                      SelfCheckOutcome.fail => Nova.red,
                      SelfCheckOutcome.skipped => Nova.tertiary,
                    },
                    fontSize: 14,
                  ),
                ),
              ),
        ],
      ),
    ];
  }
}

Future<void> openPhoneControlPage(
  BuildContext context,
  PhoneChannel channel, {
  String language = 'zh',
}) => Navigator.of(context).push<void>(
  MaterialPageRoute(
    builder: (_) => PhoneControlPage(channel: channel, language: language),
  ),
);
