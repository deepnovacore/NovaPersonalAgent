// Derived from Mika (https://github.com/wangzan101/Mika, Apache-2.0, commit 5f630d9),
// Copyright 2026 wangzan101. Modified by Nova: Flutter reimplementation of
// PhoneSetupScreen.kt (numbered steps, auto-tick plus manual next, revisitable
// rows, per-step failure card, always-available "not now") driven by the
// nova/phone/v1 status; no Mika code or assets are copied.
import 'dart:async';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../agent/phone_channel.dart';
import '../agent/phone_status_watcher.dart';
import 'phone_setup_copy.dart';
import 'theme.dart';

/// Steps whose switch the app cannot always read (OEM builds report them
/// wrongly), so they are ticked by the status *or* by the user.
const _manualSteps = {
  PhoneSetupStep.developer,
  PhoneSetupStep.accessibility,
  PhoneSetupStep.notifications,
  PhoneSetupStep.wirelessDebugging,
};

PhoneSetupStep _stepOf(HelperFailure failure) => switch (failure) {
  HelperFailure.wrongCode ||
  HelperFailure.pairingWindowClosed ||
  HelperFailure.authorizationRevoked ||
  HelperFailure.keyUnreadable => PhoneSetupStep.pairingCode,
  HelperFailure.noWifi ||
  HelperFailure.wifiNotAllowed => PhoneSetupStep.wirelessDebugging,
  _ => PhoneSetupStep.connect,
};

/// The wizard's reading of [PhoneStatus]: which steps are done and where a
/// failure belongs. Pure so tests can state it directly.
class PhoneSetupProgress {
  PhoneSetupProgress(this.status, [this.confirmed = const {}]);
  final PhoneStatus status;
  final Set<PhoneSetupStep> confirmed;

  /// The failure that applies now; a live helper only keeps pairing failures
  /// (a re-pair that went wrong), because it still works.
  HelperFailure? get failure {
    final f = status.helperFailure;
    if (f == null) return null;
    if (status.helperRunning && _stepOf(f) != PhoneSetupStep.pairingCode) {
      return null;
    }
    return f;
  }

  bool get _pairingSeen =>
      status.paired ||
      status.pairing == PairingState.searching ||
      status.pairingStage != PairingStage.idle;

  bool _auto(PhoneSetupStep step) => switch (step) {
    PhoneSetupStep.developer => _pairingSeen,
    PhoneSetupStep.accessibility => status.accessibility,
    PhoneSetupStep.notifications => status.notificationsAllowed,
    PhoneSetupStep.wirelessDebugging =>
      status.helper != HelperState.wirelessDebuggingOff && _pairingSeen,
    PhoneSetupStep.pairingCode => status.paired,
    PhoneSetupStep.connect => status.helperRunning,
  };

  PhoneSetupStep? get failedStep {
    final f = failure;
    if (f != null) return _stepOf(f);
    return status.helper == HelperState.wirelessDebuggingOff
        ? PhoneSetupStep.wirelessDebugging
        : null;
  }

  bool failed(PhoneSetupStep step) => failedStep == step;

  bool done(PhoneSetupStep step) =>
      !failed(step) &&
      (_auto(step) ||
          (confirmed.contains(step) &&
              status.helper != HelperState.wirelessDebuggingOff));

  /// First step that is not done, or null when everything is.
  PhoneSetupStep? get firstOpen {
    for (final step in PhoneSetupStep.values) {
      if (!done(step)) return step;
    }
    return null;
  }
}

Future<void> openPhoneSetupWizard(
  BuildContext context,
  PhoneChannel channel, {
  String language = 'zh',
  bool startAtPairing = false,
}) => Navigator.of(context).push<void>(
  MaterialPageRoute(
    builder: (_) => PhoneSetupWizard(
      channel: channel,
      language: language,
      startAtPairing: startAtPairing,
    ),
  ),
);

class PhoneSetupWizard extends StatefulWidget {
  const PhoneSetupWizard({
    super.key,
    required this.channel,
    this.language = 'zh',
    this.startAtPairing = false,
  });
  final PhoneChannel channel;
  final String language;

  /// Re-pairing: open on the pairing step even if it is already done.
  final bool startAtPairing;

  @override
  State<PhoneSetupWizard> createState() => _PhoneSetupWizardState();
}

class _PhoneSetupWizardState extends State<PhoneSetupWizard> {
  late final PhoneStatusWatcher watcher = PhoneStatusWatcher(widget.channel);
  PhoneCopy get c => PhoneCopy(widget.language);
  final confirmed = <PhoneSetupStep>{};
  PhoneSetupStep? viewing;
  PhoneSetupStep? _lastOpen;
  bool pairingRequested = false, manualOpen = false, busy = false;
  bool actionFailed = false;
  final code = TextEditingController(), port = TextEditingController();
  String? codeError, portError;

  PhoneSetupProgress get progress =>
      PhoneSetupProgress(watcher.status ?? const PhoneStatus(), confirmed);

  PhoneSetupStep? get current => viewing ?? progress.firstOpen;

  @override
  void initState() {
    super.initState();
    if (widget.startAtPairing) viewing = PhoneSetupStep.pairingCode;
    watcher.addListener(_changed);
    watcher.start();
  }

  void _changed() {
    if (!mounted) return;
    setState(() {
      // Progress made elsewhere (the user came back from a settings page)
      // moves the wizard on; an explicit revisit stays until then.
      final open = progress.firstOpen;
      if (_lastOpen != open && watcher.status != null) {
        if (_lastOpen != null) viewing = null;
        _lastOpen = open;
      }
    });
    _maybeStartPairing();
  }

  /// Entering the pairing step starts the pairing window search once.
  void _maybeStartPairing() {
    final s = watcher.status;
    if (s == null) return;
    final onPairing = current == PhoneSetupStep.pairingCode;
    if (!onPairing) {
      pairingRequested = false;
      return;
    }
    if (pairingRequested || !s.supported) return;
    pairingRequested = true;
    unawaited(_guard(() => watcher.run(widget.channel.startPairing)));
  }

  Future<void> _guard(Future<void> Function() action) async {
    if (actionFailed && mounted) setState(() => actionFailed = false);
    try {
      await action();
    } catch (_) {
      if (mounted) setState(() => actionFailed = true);
    }
  }

  @override
  void dispose() {
    watcher.removeListener(_changed);
    watcher.dispose();
    code.dispose();
    port.dispose();
    super.dispose();
  }

  Future<void> _open(PhoneSettingsKind kind) =>
      _guard(() async => await widget.channel.openSettings(kind));

  Future<void> _stepAction(PhoneSetupStep step) => switch (step) {
    PhoneSetupStep.developer => _open(PhoneSettingsKind.developer),
    PhoneSetupStep.accessibility => _open(PhoneSettingsKind.accessibility),
    PhoneSetupStep.notifications => _guard(() async {
      await widget.channel.requestNotifications();
      await watcher.refresh();
    }),
    PhoneSetupStep.wirelessDebugging ||
    PhoneSetupStep.pairingCode => _open(PhoneSettingsKind.wirelessDebugging),
    PhoneSetupStep.connect => Future.value(),
  };

  Future<void> _fix(HelperFix fix) async {
    switch (fix) {
      case HelperFix.retry:
        await _guard(() => watcher.run(widget.channel.ensureHelper));
      case HelperFix.rePair:
        setState(() {
          viewing = PhoneSetupStep.pairingCode;
          pairingRequested = true;
        });
        await _guard(() => watcher.run(widget.channel.startPairing));
      case HelperFix.openWifi:
        await _open(PhoneSettingsKind.wifi);
      case HelperFix.openWirelessDebugging:
        await _open(PhoneSettingsKind.wirelessDebugging);
    }
  }

  Future<void> _submit() async {
    final digits = code.text.trim();
    final rawPort = port.text.trim();
    final parsedPort = rawPort.isEmpty ? null : int.tryParse(rawPort);
    setState(() {
      codeError = RegExp(r'^\d{6}$').hasMatch(digits) ? null : c.codeInvalid;
      portError =
          rawPort.isEmpty ||
              (parsedPort != null && parsedPort >= 1 && parsedPort <= 65535)
          ? null
          : c.portInvalid;
    });
    if (codeError != null || portError != null) return;
    setState(() => busy = true);
    await _guard(
      () => watcher.run(
        () => widget.channel.submitCode(digits, port: parsedPort),
      ),
    );
    if (mounted) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final status = watcher.status;
    return Scaffold(
      backgroundColor: Nova.sheet,
      appBar: AppBar(title: Text(c.title)),
      body: status == null
          ? Center(
              child: watcher.unavailable
                  ? Padding(
                      padding: const EdgeInsets.all(32),
                      child: Column(
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
                      ),
                    )
                  : const CircularProgressIndicator(),
            )
          : _body(status),
    );
  }

  Widget _body(PhoneStatus s) {
    final p = progress;
    final open = current;
    final allDone = p.firstOpen == null;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 28),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 14),
          child: Text(
            c.intro,
            style: const TextStyle(
              color: Nova.secondary,
              fontSize: 13,
              height: 1.45,
            ),
          ),
        ),
        DecoratedBox(
          decoration: BoxDecoration(
            color: Nova.sheetCell,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            children: [
              for (final (i, step) in PhoneSetupStep.values.indexed) ...[
                if (i > 0)
                  const Divider(height: 1, indent: 56, color: Nova.separator),
                _stepRow(i, step, s, p, open),
              ],
            ],
          ),
        ),
        if (actionFailed)
          Padding(
            padding: const EdgeInsets.only(top: 10, left: 16),
            child: Text(
              c.actionFailed,
              style: const TextStyle(color: Nova.red, fontSize: 13),
            ),
          ),
        if (allDone && viewing == null) _success() else _footer(),
      ],
    );
  }

  Widget _success() => Padding(
    key: const ValueKey('phone-wizard-success'),
    padding: const EdgeInsets.only(top: 20),
    child: Column(
      children: [
        Text(
          c.success,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 6),
        Text(
          c.successNote,
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: Nova.secondary,
            fontSize: 13,
            height: 1.4,
          ),
        ),
        const SizedBox(height: 14),
        FilledButton(
          onPressed: () => Navigator.maybePop(context),
          child: Text(c.done),
        ),
      ],
    ),
  );

  Widget _footer() => Padding(
    padding: const EdgeInsets.only(top: 14),
    child: Column(
      children: [
        Text(
          viewing != null && progress.firstOpen == null
              ? c.revisitNote
              : c.wizardIntroSkip,
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: Nova.secondary,
            fontSize: 13,
            height: 1.4,
          ),
        ),
        TextButton(
          onPressed: () => Navigator.maybePop(context),
          child: Text(c.later),
        ),
      ],
    ),
  );

  Widget _badge(int index, bool done, bool failed, bool isCurrent) {
    final Color color = failed
        ? Nova.red
        : done
        ? Nova.mint
        : isCurrent
        ? Nova.mint
        : Nova.tertiary;
    return Container(
      width: 28,
      height: 28,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: done || failed ? color : Colors.transparent,
        border: Border.all(color: color, width: 1.5),
      ),
      child: failed
          ? const Text(
              '!',
              style: TextStyle(color: Nova.ink, fontWeight: FontWeight.w700),
            )
          : done
          ? const Icon(CupertinoIcons.checkmark_alt, size: 16, color: Nova.ink)
          : Text(
              '${index + 1}',
              style: TextStyle(
                color: color,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
    );
  }

  Widget _stepRow(
    int index,
    PhoneSetupStep step,
    PhoneStatus s,
    PhoneSetupProgress p,
    PhoneSetupStep? open,
  ) {
    final isCurrent = open == step;
    final done = p.done(step);
    final failed = p.failed(step);
    final copy = c.step(step);
    final canRevisit = !isCurrent && (done || failed);
    final header = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _badge(index, done, failed, isCurrent),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                copy.title,
                style: const TextStyle(fontSize: 16, height: 1.3),
              ),
              if (!isCurrent)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    copy.brief,
                    style: const TextStyle(
                      color: Nova.secondary,
                      fontSize: 13,
                      height: 1.35,
                    ),
                  ),
                ),
            ],
          ),
        ),
        if (done && !isCurrent)
          Padding(
            padding: const EdgeInsets.only(left: 8, top: 2),
            child: Text(
              c.doneValue(step),
              style: const TextStyle(color: Nova.mint, fontSize: 13),
            ),
          ),
      ],
    );
    return Semantics(
      container: true,
      label: '${index + 1}. ${copy.title}',
      selected: isCurrent,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            InkWell(
              onTap: canRevisit ? () => _revisit(step) : null,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 48),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  child: header,
                ),
              ),
            ),
            if (isCurrent)
              Padding(
                padding: const EdgeInsets.only(left: 42, bottom: 14),
                child: _stepBody(step, s, p),
              ),
          ],
        ),
      ),
    );
  }

  void _revisit(PhoneSetupStep step) {
    setState(() => viewing = step);
    _maybeStartPairing();
  }

  Widget _text(String text, {Color color = Nova.secondary}) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Text(
      text,
      style: TextStyle(color: color, fontSize: 13, height: 1.45),
    ),
  );

  Widget _button(String label, VoidCallback onPressed, {bool tonal = false}) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Align(
          alignment: Alignment.centerLeft,
          child: tonal
              ? FilledButton.tonal(onPressed: onPressed, child: Text(label))
              : FilledButton(onPressed: onPressed, child: Text(label)),
        ),
      );

  Widget _working(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      children: [
        const SizedBox(
          width: 16,
          height: 16,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(color: Nova.secondary, fontSize: 13),
          ),
        ),
      ],
    ),
  );

  Widget _failureCard(HelperFailure failure, HelperFix? fix) {
    final copy = c.failure(failure);
    final action = fix ?? HelperFix.retry;
    return Container(
      key: ValueKey('phone-wizard-failure-${failure.name}'),
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Nova.red.withValues(alpha: .06),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            copy.title,
            style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
          ),
          const SizedBox(height: 4),
          Text(
            copy.body,
            style: const TextStyle(
              color: Nova.secondary,
              fontSize: 13,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 8),
          FilledButton.tonal(
            onPressed: () => _fix(action),
            child: Text(c.fixLabel(action)),
          ),
        ],
      ),
    );
  }

  Widget _stepBody(PhoneSetupStep step, PhoneStatus s, PhoneSetupProgress p) {
    final copy = c.step(step);
    final failure = p.failure;
    final children = <Widget>[
      if (failure != null && p.failed(step)) _failureCard(failure, s.helperFix),
      _text(copy.body),
    ];
    switch (step) {
      case PhoneSetupStep.pairingCode:
        children.addAll(_pairingExtras(s));
      case PhoneSetupStep.connect:
        if (s.helper == HelperState.connecting ||
            s.pairingStage == PairingStage.connecting ||
            s.pairingStage == PairingStage.pairing) {
          children.add(_working(c.working));
        } else if (!s.helperRunning && failure == null) {
          children.add(_working(c.scanning));
        }
      case PhoneSetupStep.notifications:
      case PhoneSetupStep.developer:
      case PhoneSetupStep.accessibility:
      case PhoneSetupStep.wirelessDebugging:
        break;
    }
    if (step == PhoneSetupStep.accessibility) {
      children.add(_text(c.appInfoHint));
    }
    final action = copy.action;
    if (action != null && step != PhoneSetupStep.pairingCode) {
      children.add(_button(action, () => _stepAction(step), tonal: true));
    }
    if (_manualSteps.contains(step)) {
      children.add(
        TextButton(
          onPressed: () => setState(() {
            confirmed.add(step);
            viewing = null;
            _lastOpen = progress.firstOpen;
            _maybeStartPairing();
          }),
          child: Text(c.turnedOnNext),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    );
  }

  List<Widget> _pairingExtras(PhoneStatus s) {
    final stage = s.pairingStage;
    final found =
        s.pairing == PairingState.searching ||
        stage == PairingStage.waitingCode;
    return [
      if (!s.notificationsAllowed && !s.accessibility) ...[
        _text(c.needNotifications, color: Nova.amber),
        _button(c.allowNotifications, () async {
          await _guard(() async {
            await widget.channel.requestNotifications();
            await watcher.refresh();
          });
        }, tonal: true),
      ],
      if (s.accessibility)
        _text(c.autoRead)
      else ...[
        for (final (i, line) in c.notifyGuide.indexed) _text('${i + 1}. $line'),
      ],
      if (found) _text(c.portFound, color: Nova.mint),
      if (stage == PairingStage.pairing || stage == PairingStage.connecting)
        _working(c.working),
      _button(c.step(PhoneSetupStep.pairingCode).action!, () {
        unawaited(_open(PhoneSettingsKind.wirelessDebugging));
      }, tonal: true),
      TextButton(
        onPressed: () => setState(() => manualOpen = !manualOpen),
        child: Text(c.manualToggle),
      ),
      if (manualOpen) _manualForm(),
    ];
  }

  Widget _manualForm() => Column(
    key: const ValueKey('phone-wizard-manual'),
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _text(c.manualHint),
      TextField(
        controller: code,
        keyboardType: TextInputType.number,
        inputFormatters: [
          FilteringTextInputFormatter.digitsOnly,
          LengthLimitingTextInputFormatter(6),
        ],
        decoration: InputDecoration(
          labelText: c.codeLabel,
          errorText: codeError,
        ),
      ),
      const SizedBox(height: 8),
      TextField(
        controller: port,
        keyboardType: TextInputType.number,
        inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        decoration: InputDecoration(
          labelText: c.portLabel,
          helperText: c.portHint,
          helperMaxLines: 2,
          labelStyle: const TextStyle(fontSize: 13),
          errorText: portError,
        ),
      ),
      const SizedBox(height: 10),
      FilledButton(
        onPressed: busy ? null : _submit,
        child: Text(busy ? c.working : c.submit),
      ),
    ],
  );
}
