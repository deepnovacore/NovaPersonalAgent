import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:nova_mobile/agent/phone_channel.dart';

/// A 1x1 PNG, a frame that decodes in widget tests.
final tinyFrame = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);

/// In-memory [PhoneChannel]: scripted answers, recorded calls, and controllers
/// for the event and frame streams.
class FakePhoneChannel implements PhoneChannel {
  FakePhoneChannel([this.current = const PhoneStatus(apiLevel: 34)]);

  PhoneStatus current;
  final calls = <String>[];
  final previews = <bool>[];
  final opened = <PhoneSettingsKind>[];
  final submitted = <(String, int?)>[];
  List<SelfCheckResult> checks = const [];
  Object? selfCheckError;
  Object? commandError;
  bool acknowledged = false;
  TakeoverState takeoverResult = TakeoverState.active;
  TakeoverState handBackResult = TakeoverState.returned;
  final eventController = StreamController<PhoneEvent>.broadcast();
  final frameController = StreamController<Uint8List>.broadcast();

  void push(PhoneStatus status) {
    current = status;
    eventController.add(PhoneStatusEvent(status));
  }

  void emit(PhoneEvent event) => eventController.add(event);

  Future<PhoneStatus> _status(String name) async {
    calls.add(name);
    if (commandError != null) throw commandError!;
    return current;
  }

  @override
  Future<PhoneStatus> status() => _status('status');
  @override
  Future<PhoneStatus> startPairing() => _status('startPairing');
  @override
  Future<PhoneStatus> ensureHelper() => _status('ensureHelper');
  @override
  Future<PhoneStatus> unpair() => _status('unpair');
  @override
  Future<PhoneStatus> submitCode(String code, {int? port}) {
    submitted.add((code, port));
    return _status('submitCode');
  }

  @override
  Future<bool> openSettings(PhoneSettingsKind kind) async {
    calls.add('openSettings');
    opened.add(kind);
    return true;
  }

  @override
  Future<List<SelfCheckResult>> selfCheck() async {
    calls.add('selfCheck');
    if (selfCheckError != null) throw selfCheckError!;
    return checks;
  }

  @override
  Future<void> setPreview(bool visible) async {
    calls.add('setPreview');
    previews.add(visible);
  }

  @override
  Future<TakeoverState> takeover(String taskId) async {
    calls.add('takeover:$taskId');
    return takeoverResult;
  }

  @override
  Future<TakeoverState> handBack(String taskId) async {
    calls.add('handBack:$taskId');
    return handBackResult;
  }

  @override
  Future<void> requestNotifications() async =>
      calls.add('requestNotifications');
  @override
  Future<bool> experimentalAcknowledged() async => acknowledged;
  @override
  Future<void> setExperimentalAck(bool value) async {
    calls.add('setExperimentalAck:$value');
    acknowledged = value;
  }

  @override
  Stream<PhoneEvent> get events => eventController.stream;
  @override
  Stream<Uint8List> get frames => frameController.stream;

  Future<void> close() async {
    await eventController.close();
    await frameController.close();
  }
}

PhoneStepEvent stepEvent({
  String taskId = 't1',
  int step = 1,
  String tool = 'tap',
  String label = '点击搜索',
  StepStatus status = StepStatus.completed,
  String? ref,
  PhoneTier tier = PhoneTier.virtual,
}) => PhoneStepEvent(
  taskId: taskId,
  step: step,
  tool: tool,
  label: label,
  status: status,
  ref: ref,
  tier: tier,
);

PhoneTakeoverEvent takeoverEvent(
  TakeoverState state, {
  String taskId = 't1',
  bool byModel = true,
}) => PhoneTakeoverEvent(taskId: taskId, state: state, byModel: byModel);

PhoneDoneEvent doneEvent({
  String taskId = 't1',
  String outcome = 'completed',
}) => PhoneDoneEvent(
  taskId: taskId,
  outcome: outcome,
  steps: 3,
  durationMs: 1000,
);
