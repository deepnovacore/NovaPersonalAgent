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
  // `wifiNotAllowed` is reserved: native never reports it today.
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

  /// Where the wizard should be: the step a failure belongs to, else the
  /// first step that is not done; null when everything is done.
  PhoneSetupStep? get target => failedStep ?? firstOpen;

  /// First step that is not done, or null when everything is.
  PhoneSetupStep? get firstOpen {
    for (final step in PhoneSetupStep.values) {
      if (!done(step)) return step;
    }
    return null;
  }
}

const _fullWidthZero = 0xff10;

/// Full-width digits (０-９) as ASCII, so a code typed with a Chinese keyboard
/// reads the same.
String asciiDigits(String text) => String.fromCharCodes(
  text.runes.map(
    (r) => r >= _fullWidthZero && r <= _fullWidthZero + 9
        ? 0x30 + r - _fullWidthZero
        : r,
  ),
);

/// The 6-digit pairing code from what the user typed or pasted, or null.
String? parsePairingCode(String raw) {
  final digits = asciiDigits(raw).replaceAll(RegExp(r'[\s-]'), '');
  return RegExp(r'^\d{6}$').hasMatch(digits) ? digits : null;
}

/// The pairing port from what the user typed or pasted: a bare number, or
/// "192.168.1.5:41235" (the part after the last colon). Empty input is "no
/// port" (`valid`, null); anything else that is not 1..65535 is invalid.
({bool valid, int? port}) parsePairingPort(String raw) {
  var text = asciiDigits(raw).trim();
  final colon = text.lastIndexOf(RegExp('[:：]'));
  if (colon >= 0) text = text.substring(colon + 1);
  text = text.replaceAll(RegExp(r'\s'), '');
  if (text.isEmpty) return (valid: raw.trim().isEmpty, port: null);
  final port = RegExp(r'^\d{1,5}$').hasMatch(text) ? int.parse(text) : null;
  return port != null && port >= 1 && port <= 65535
      ? (valid: true, port: port)
      : (valid: false, port: null);
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

/// Maps full-width digits to ASCII and drops everything else.
class _DigitsFormatter extends TextInputFormatter {
  const _DigitsFormatter();
  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final text = asciiDigits(newValue.text).replaceAll(RegExp(r'\D'), '');
    return TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }
}

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

class _PhoneSetupWizardState extends State<PhoneSetupWizard>
    with WidgetsBindingObserver {
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

  PhoneSetupStep? get current => viewing ?? progress.target;

  @override
  void initState() {
    super.initState();
    if (widget.startAtPairing) viewing = PhoneSetupStep.pairingCode;
    WidgetsBinding.instance.addObserver(this);
    watcher.addListener(_changed);
    watcher.start();
  }

  void _changed() {
    if (!mounted) return;
    setState(() {
      // Progress made elsewhere (the user came back from a settings page)
      // moves the wizard on; an explicit revisit stays until then.
      final open = progress.target;
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

  /// The pairing window is open only for a while and the user leaves for the
  /// system pairing screen: coming back on the pairing step arms it again.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed ||
        current != PhoneSetupStep.pairingCode) {
      return;
    }
    pairingRequested = false;
    _maybeStartPairing();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
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
    PhoneSetupStep.notifications => _allowNotifications(),
    PhoneSetupStep.wirelessDebugging ||
    PhoneSetupStep.pairingCode => _open(PhoneSettingsKind.wirelessDebugging),
    PhoneSetupStep.connect => Future.value(),
  };

  /// The system prompt first; if notifications stay blocked (denied for good,
  /// or the pairing channel is off) the app's notification settings.
  Future<void> _allowNotifications() => _guard(() async {
    await widget.channel.requestNotifications();
    await watcher.refresh();
    if (watcher.status?.notificationsAllowed != true) {
      await widget.channel.openSettings(PhoneSettingsKind.notifications);
    }
  });

  Future<void> _acknowledge() =>
      _guard(() => watcher.run(() => widget.channel.setExperimentalAck(true)));

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
    final digits = parsePairingCode(code.text);
    final parsedPort = parsePairingPort(port.text);
    setState(() {
      codeError = digits != null ? null : c.codeInvalid;
      portError = parsedPort.valid ? null : c.portInvalid;
    });
    if (digits == null || !parsedPort.valid) return;
    setState(() => busy = true);
    await _guard(
      () => watcher.run(
        () => widget.channel.submitCode(digits, port: parsedPort.port),
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
      bottomNavigationBar: status == null || _showsSuccess(status)
          ? null
          : _laterBar(),
    );
  }

  bool _showsSuccess(PhoneStatus s) =>
      progress.firstOpen == null && viewing == null && !_needsAck(s);

  /// Android 12/13: the focus warning has to be accepted before the virtual
  /// screen is used, so the wizard is not finished until it is.
  bool _needsAck(PhoneStatus s) =>
      s.supported && s.experimental && !s.experimentalAck;

  /// "Not now" stays in reach however long the steps above grow.
  Widget _laterBar() => SafeArea(
    top: false,
    child: DecoratedBox(
      decoration: const BoxDecoration(
        color: Nova.sheet,
        border: Border(top: BorderSide(color: Nova.separator, width: .5)),
      ),
      child: Align(
        alignment: Alignment.center,
        heightFactor: 1,
        child: TextButton(
          key: const ValueKey('phone-wizard-later'),
          style: TextButton.styleFrom(minimumSize: const Size(88, 48)),
          onPressed: () => Navigator.maybePop(context),
          child: Text(c.later),
        ),
      ),
    ),
  );

  Widget _body(PhoneStatus s) {
    final p = progress;
    final open = current;
    final needsAck = _needsAck(s);
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 28),
      children: [
        if (!s.supported)
          Padding(
            key: const ValueKey('phone-wizard-too-old'),
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 14),
            child: Text(
              c.tooOldLine,
              style: const TextStyle(
                color: Nova.amber,
                fontSize: 13,
                height: 1.45,
              ),
            ),
          ),
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
        if (needsAck) _experimentalCard(p.firstOpen == null),
        if (_showsSuccess(s)) _success() else _footer(),
      ],
    );
  }

  Widget _experimentalCard(bool stepsDone) => Container(
    key: const ValueKey('phone-wizard-experimental'),
    margin: const EdgeInsets.only(top: 14),
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
          stepsDone ? c.experimentalWizardNote : c.experimentalBody,
          style: const TextStyle(
            color: Nova.secondary,
            fontSize: 13,
            height: 1.4,
          ),
        ),
        if (stepsDone) ...[
          const SizedBox(height: 4),
          Text(
            c.experimentalBody,
            style: const TextStyle(
              color: Nova.secondary,
              fontSize: 13,
              height: 1.4,
            ),
          ),
        ],
        const SizedBox(height: 8),
        FilledButton.tonal(
          onPressed: _acknowledge,
          child: Text(c.experimentalAck),
        ),
      ],
    ),
  );

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
    // The header is one node ("2. Title, summary, state"); the badge number
    // and texts under it are not announced again, and the step's own body
    // keeps its separate nodes.
    final spoken = [
      '${index + 1}. ${copy.title}',
      if (!isCurrent) copy.brief,
      if (failed) c.stepFailedLabel else if (done) c.doneValue(step),
    ].join(', ');
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            container: true,
            label: spoken,
            selected: isCurrent,
            button: canRevisit,
            excludeSemantics: true,
            onTap: canRevisit ? () => _revisit(step) : null,
            child: InkWell(
              onTap: canRevisit ? () => _revisit(step) : null,
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 48),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  child: header,
                ),
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
        } else if (!s.helperRunning && failure == null && s.supported) {
          children.add(_working(c.scanning));
        }
      case PhoneSetupStep.notifications:
      case PhoneSetupStep.developer:
      case PhoneSetupStep.accessibility:
      case PhoneSetupStep.wirelessDebugging:
        break;
    }
    if (step == PhoneSetupStep.accessibility) {
      children
        ..add(_text(c.appInfoHint))
        ..add(
          _button(
            c.openAppInfo,
            () => unawaited(_open(PhoneSettingsKind.appInfo)),
            tonal: true,
          ),
        )
        ..add(_text(c.accessibilityOffNote));
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
            _lastOpen = progress.target;
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
        _button(
          c.allowNotifications,
          () => unawaited(_allowNotifications()),
          tonal: true,
        ),
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
          const _DigitsFormatter(),
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
        // Not digits-only: a pasted "192.168.1.5:41235" keeps its port.
        keyboardType: TextInputType.text,
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
