import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../agent_core/schedule_wake.dart';

/// Phone control exists on Android only; iOS has no counterpart and must not
/// grow one.
bool phoneControlSupported([TargetPlatform? platform]) =>
    !kIsWeb && (platform ?? defaultTargetPlatform) == TargetPlatform.android;

// Dart client of the Android phone-control channels. The wire format is the
// contract in docs/specs/mobile-virtual-display.md: MethodChannel
// `nova/phone/v1`, EventChannels `nova/phone/events` and `nova/phone/frames`.

enum PhoneTier { virtual, main }

enum PairingStage { idle, waitingCode, pairing, connecting, done, failed }

enum PairingState { unpaired, searching, paired }

enum HelperState {
  unsupported,
  notPaired,
  wirelessDebuggingOff,
  connecting,
  running,
  failed,
}

enum HelperFailure {
  wrongCode,
  pairingWindowClosed,
  noWifi,
  wifiNotAllowed,
  connectFailed,
  authorizationRevoked,
  keyUnreadable,
  helperStartFailed,
  unknown,
}

enum HelperFix { retry, rePair, openWifi, openWirelessDebugging }

enum PhoneSettingsKind {
  accessibility,
  overlay,
  battery,
  developer,
  wirelessDebugging,
  wifi,
}

enum TakeoverState { requested, active, returned, timedOut, failed }

enum StepStatus { running, completed, failed, unknown }

T _enumByWire<T>(
  List<T> values,
  String? wire,
  T fallback,
  String Function(T) of,
) {
  for (final value in values) {
    if (of(value) == wire) return value;
  }
  return fallback;
}

String _snake(String camel) => camel.replaceAllMapped(
  RegExp('[A-Z]'),
  (match) => '_${match[0]!.toLowerCase()}',
);

T _wire<T extends Enum>(List<T> values, Object? wire, T fallback) =>
    _enumByWire(
      values,
      wire is String ? wire : null,
      fallback,
      (v) => _snake(v.name),
    );

/// Result of `status` and payload of the `status` event.
class PhoneStatus {
  const PhoneStatus({
    this.apiLevel = 0,
    this.tier = PhoneTier.main,
    this.experimental = false,
    this.accessibility = false,
    this.overlay = false,
    this.batteryWhitelisted = false,
    this.notificationsAllowed = false,
    this.pairing = PairingState.unpaired,
    this.pairingStage = PairingStage.idle,
    this.pairingPort,
    this.helper = HelperState.notPaired,
    this.helperFailure,
    this.helperFix,
  });

  factory PhoneStatus.fromJson(Map<dynamic, dynamic> json) => PhoneStatus(
    apiLevel: (json['api_level'] as num?)?.toInt() ?? 0,
    tier: _wire(PhoneTier.values, json['tier'], PhoneTier.main),
    experimental: json['experimental'] == true,
    accessibility: json['accessibility'] == true,
    overlay: json['overlay'] == true,
    batteryWhitelisted: json['battery_whitelisted'] == true,
    notificationsAllowed: json['notifications_allowed'] == true,
    pairing: _wire(PairingState.values, json['pairing'], PairingState.unpaired),
    pairingStage: _wire(
      PairingStage.values,
      json['pairing_stage'],
      PairingStage.idle,
    ),
    pairingPort: (json['pairing_port'] as num?)?.toInt(),
    helper: _wire(HelperState.values, json['helper'], HelperState.notPaired),
    helperFailure: json['helper_failure'] == null
        ? null
        : _wire(
            HelperFailure.values,
            json['helper_failure'],
            HelperFailure.unknown,
          ),
    helperFix: json['helper_fix'] == null
        ? null
        : _wire(HelperFix.values, json['helper_fix'], HelperFix.retry),
  );

  final int apiLevel;
  final PhoneTier tier;

  /// Android 12/13: apps on the virtual screen may briefly take main-screen focus.
  final bool experimental;
  final bool accessibility, overlay, batteryWhitelisted, notificationsAllowed;
  final PairingState pairing;
  final PairingStage pairingStage;
  final int? pairingPort;
  final HelperState helper;
  final HelperFailure? helperFailure;
  final HelperFix? helperFix;

  /// Android 12+ is the first level with the helper path.
  bool get supported => helper != HelperState.unsupported && apiLevel >= 31;
  bool get helperRunning => helper == HelperState.running;
  bool get paired => pairing == PairingState.paired || helperRunning;

  @override
  bool operator ==(Object other) =>
      other is PhoneStatus &&
      other.apiLevel == apiLevel &&
      other.tier == tier &&
      other.experimental == experimental &&
      other.accessibility == accessibility &&
      other.overlay == overlay &&
      other.batteryWhitelisted == batteryWhitelisted &&
      other.notificationsAllowed == notificationsAllowed &&
      other.pairing == pairing &&
      other.pairingStage == pairingStage &&
      other.pairingPort == pairingPort &&
      other.helper == helper &&
      other.helperFailure == helperFailure &&
      other.helperFix == helperFix;

  @override
  int get hashCode => Object.hash(
    apiLevel,
    tier,
    experimental,
    accessibility,
    overlay,
    batteryWhitelisted,
    notificationsAllowed,
    pairing,
    pairingStage,
    pairingPort,
    helper,
    helperFailure,
    helperFix,
  );
}

/// One row of the `selfCheck` result.
class SelfCheckResult {
  const SelfCheckResult({required this.id, required this.ok, this.detail});
  final String id;
  final bool ok;
  final String? detail;
}

/// A failed channel call; [code] is the native safe code (never provider text).
class PhoneChannelException implements Exception {
  const PhoneChannelException(this.code);
  final String code;
  @override
  String toString() => 'PhoneChannelException($code)';
}

sealed class PhoneEvent {
  const PhoneEvent();

  /// Parses one event JSON string; null for unknown or malformed events.
  static PhoneEvent? parse(Object? raw) {
    try {
      final json = raw is String ? jsonDecode(raw) : raw;
      if (json is! Map) return null;
      switch (json['type']) {
        case 'status':
          final status = json['status'];
          return status is Map
              ? PhoneStatusEvent(PhoneStatus.fromJson(status))
              : null;
        case 'step':
          final taskId = json['task_id'], step = json['step'];
          if (taskId is! String || step is! num) return null;
          return PhoneStepEvent(
            taskId: taskId,
            step: step.toInt(),
            tool: json['tool'] as String? ?? '',
            label: json['label'] as String? ?? '',
            status: _wire(
              StepStatus.values,
              json['status'],
              StepStatus.unknown,
            ),
            changed: json['changed'] as bool?,
            ref: json['ref'] as String?,
            tier: _wire(PhoneTier.values, json['tier'], PhoneTier.main),
          );
        case 'takeover':
          final taskId = json['task_id'];
          if (taskId is! String) return null;
          return PhoneTakeoverEvent(
            taskId: taskId,
            state: _wire(
              TakeoverState.values,
              json['state'],
              TakeoverState.failed,
            ),
            byModel: json['by'] != 'user',
            reason: json['reason'] as String?,
          );
        case 'done':
          final taskId = json['task_id'];
          if (taskId is! String) return null;
          return PhoneDoneEvent(
            taskId: taskId,
            outcome: json['outcome'] as String? ?? 'interrupted',
            reason: json['reason'] as String?,
            summary: json['summary'] as String?,
            steps: (json['steps'] as num?)?.toInt() ?? 0,
            durationMs: (json['duration_ms'] as num?)?.toInt() ?? 0,
          );
      }
    } catch (_) {}
    return null;
  }
}

class PhoneStatusEvent extends PhoneEvent {
  const PhoneStatusEvent(this.status);
  final PhoneStatus status;
}

class PhoneStepEvent extends PhoneEvent {
  const PhoneStepEvent({
    required this.taskId,
    required this.step,
    required this.tool,
    required this.label,
    required this.status,
    required this.tier,
    this.changed,
    this.ref,
  });
  final String taskId, tool, label;
  final int step;
  final StepStatus status;
  final bool? changed;
  final String? ref;
  final PhoneTier tier;
}

class PhoneTakeoverEvent extends PhoneEvent {
  const PhoneTakeoverEvent({
    required this.taskId,
    required this.state,
    required this.byModel,
    this.reason,
  });
  final String taskId;
  final TakeoverState state;
  final bool byModel;
  final String? reason;
}

class PhoneDoneEvent extends PhoneEvent {
  const PhoneDoneEvent({
    required this.taskId,
    required this.outcome,
    required this.steps,
    required this.durationMs,
    this.reason,
    this.summary,
  });
  final String taskId, outcome;
  final String? reason, summary;
  final int steps, durationMs;
}

/// UI-facing phone-control surface. Tests substitute a fake.
abstract interface class PhoneChannel {
  Future<PhoneStatus> status();
  Future<bool> openSettings(PhoneSettingsKind kind);
  Future<PhoneStatus> startPairing();
  Future<PhoneStatus> submitCode(String code, {int? port});
  Future<PhoneStatus> ensureHelper();
  Future<PhoneStatus> unpair();
  Future<List<SelfCheckResult>> selfCheck();
  Future<void> setPreview(bool visible);
  Future<TakeoverState> takeover(String taskId);
  Future<TakeoverState> handBack(String taskId);

  /// Asks the system for notification access (runtime permission prompt).
  Future<void> requestNotifications();

  /// Whether the user accepted the Android 12/13 focus warning.
  Future<bool> experimentalAcknowledged();

  /// Records the acceptance for native gating; tolerates a native side that
  /// has no handler yet.
  Future<void> setExperimentalAck(bool acknowledged);

  /// Status, step, takeover and done events. Empty when the host has no
  /// phone bridge.
  Stream<PhoneEvent> get events;

  /// JPEG frames of the virtual screen; flow only while a preview is visible.
  Stream<Uint8List> get frames;
}

class NativePhoneChannel implements PhoneChannel {
  const NativePhoneChannel();
  static const _method = MethodChannel('nova/phone/v1');
  static const _events = EventChannel('nova/phone/events');
  static const _frames = EventChannel('nova/phone/frames');
  static const ackKey = 'phone.experimental_ack';

  Future<Map<dynamic, dynamic>> _call(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async {
    try {
      final reply = await _method.invokeMethod<String>(
        method,
        jsonEncode(input),
      );
      final decoded = reply == null ? null : jsonDecode(reply);
      return decoded is Map ? decoded : const {};
    } on PlatformException catch (error) {
      throw PhoneChannelException(error.message ?? error.code);
    }
  }

  Future<PhoneStatus> _status(
    String method, [
    Map<String, dynamic> input = const {},
  ]) async => PhoneStatus.fromJson(await _call(method, input));

  @override
  Future<PhoneStatus> status() => _status('status');
  @override
  Future<bool> openSettings(PhoneSettingsKind kind) async =>
      (await _call('openSettings', {'kind': _snake(kind.name)}))['opened'] ==
      true;
  @override
  Future<PhoneStatus> startPairing() => _status('startPairing');
  @override
  Future<PhoneStatus> submitCode(String code, {int? port}) =>
      _status('submitCode', {'code': code, 'port': ?port});
  @override
  Future<PhoneStatus> ensureHelper() => _status('ensureHelper');
  @override
  Future<PhoneStatus> unpair() => _status('unpair');
  @override
  Future<List<SelfCheckResult>> selfCheck() async {
    final checks = (await _call('selfCheck'))['checks'];
    return [
      if (checks is List)
        for (final check in checks.whereType<Map>())
          if (check['id'] is String)
            SelfCheckResult(
              id: check['id'] as String,
              ok: check['ok'] == true,
              detail: check['detail'] as String?,
            ),
    ];
  }

  @override
  Future<void> setPreview(bool visible) async {
    await _call('setPreview', {'visible': visible});
  }

  TakeoverState _takeoverState(Map<dynamic, dynamic> reply) =>
      _wire(TakeoverState.values, reply['state'], TakeoverState.failed);
  @override
  Future<TakeoverState> takeover(String taskId) async =>
      _takeoverState(await _call('takeover', {'task_id': taskId}));
  @override
  Future<TakeoverState> handBack(String taskId) async =>
      _takeoverState(await _call('handBack', {'task_id': taskId}));

  @override
  Future<void> requestNotifications() => ScheduleWake.requestNotifications();

  @override
  Future<bool> experimentalAcknowledged() async {
    try {
      return (await SharedPreferences.getInstance()).getBool(ackKey) ?? false;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<void> setExperimentalAck(bool acknowledged) async {
    try {
      await (await SharedPreferences.getInstance()).setBool(
        ackKey,
        acknowledged,
      );
    } catch (_) {}
    try {
      await _call('setExperimentalAck', {'acknowledged': acknowledged});
    } on MissingPluginException {
      /* The native handler lands with the display lane. */
    } on PhoneChannelException {
      /* Native gating can catch up on the next ack; the UI state is kept. */
    }
  }

  /// A host without the bridge (tests, desktop) answers the probe with
  /// MissingPluginException; subscribing then would report a platform error.
  Stream<T> _stream<T>(
    EventChannel channel,
    T Function(Object?) convert,
  ) async* {
    try {
      await _method.invokeMethod<String>('status', '{}');
    } on MissingPluginException {
      return;
    } on PlatformException {
      // A bridge that answers with an error still owns the channel.
    }
    yield* channel.receiveBroadcastStream().map(convert);
  }

  @override
  Stream<PhoneEvent> get events => _stream<PhoneEvent?>(
    _events,
    PhoneEvent.parse,
  ).where((event) => event != null).cast<PhoneEvent>();

  @override
  Stream<Uint8List> get frames => _stream<Uint8List?>(
    _frames,
    (frame) => frame is Uint8List ? frame : null,
  ).where((frame) => frame != null && frame.isNotEmpty).cast<Uint8List>();
}
