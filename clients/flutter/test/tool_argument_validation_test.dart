import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'agent_core_test.dart' show MemoryPersistence;

ToolRegistry _android({void Function()? onRun}) => ToolRegistry(
  snapshot: () => {},
  mutate: (_, {required operationId}) async => {},
  hasConflict: () => false,
  fetch: (_) async => {},
  automaticExecution: true,
  requestDeviceTask: (_, _) async {
    onRun?.call();
    return {'status': 'completed'};
  },
);

ToolRegistry _ios() => ToolRegistry(
  snapshot: () => {},
  mutate: (_, {required operationId}) async => {},
  hasConflict: () => false,
  fetch: (_) async => {},
  automaticExecution: true,
  runChatTask: (_, _) async => {'status': 'completed'},
);

List<String> _issues(ToolRegistry registry, Map<String, dynamic> args) {
  try {
    registry.resolve('device_run_task', args);
  } on ToolArgumentsInvalid catch (failure) {
    expect(failure.code, 'invalid_tool_arguments');
    return failure.issues.map((e) => '$e').toList();
  }
  return [];
}

void main() {
  const valid = {
    'goal': '打开小红书，搜索申琼星',
    'app_name': '小红书',
    'acceptance': '小红书搜索结果页显示申琼星',
  };

  test('valid Android arguments resolve', () {
    expect(_issues(_android(), valid), isEmpty);
    expect(
      _issues(_android(), {...valid, 'target_package': 'com.xingin.xhs'}),
      isEmpty,
    );
  });

  test('each invalid shape names the field and problem, never the value', () {
    final registry = _android();
    expect(
      _issues(registry, {
        ...valid,
        'acceptance': ['已打开', '有结果'],
      }),
      ['acceptance:wrong_type(array)'],
    );
    expect(_issues(registry, {...valid, 'target_package': null}), [
      'target_package:wrong_type(null)',
    ]);
    expect(_issues(registry, {'goal': '打开小红书', 'app_name': '小红书'}), [
      'acceptance:missing',
    ]);
    expect(_issues(registry, {...valid, 'scope': 'nova'}), [
      'scope:unknown_field(string)',
    ]);
    expect(_issues(registry, {...valid, '申琼星': 1}), [
      '<unnamed>:unknown_field(integer)',
    ]);
    expect(_issues(registry, {...valid, 'goal': 'x' * 8001}), [
      'goal:too_long(string,8001)',
    ]);
    // Several problems are all reported, not just the first.
    expect(
      _issues(registry, {'goal': 7, 'app_name': '小红书'}),
      unorderedEquals(['acceptance:missing', 'goal:wrong_type(integer)']),
    );
  });

  test('iOS scope stays an enforced enum', () {
    const request = {
      'goal': 'Read note',
      'scope': 'nova',
      'acceptance': 'Done',
    };
    expect(_issues(_ios(), request), isEmpty);
    expect(_issues(_ios(), {...request, 'scope': 'shell'}), [
      'scope:bad_enum(string)',
    ]);
  });

  test('invalid arguments never write an intent or dispatch', () async {
    var runs = 0;
    final journal = ToolJournal(MemoryPersistence());
    await journal.open();
    final runner = ToolRunner(
      registry: _android(onRun: () => runs++),
      journal: journal,
    );
    Future<Map<String, dynamic>> run(Map<String, dynamic> args) => runner.run(
      turnId: 't',
      callId: 'c',
      name: 'device_run_task',
      arguments: args,
      approve: (_) async => true,
    );
    await expectLater(
      run({
        ...valid,
        'acceptance': ['已打开'],
      }),
      throwsA(isA<ToolArgumentsInvalid>()),
    );
    expect(journal.hasUnresolved, isFalse);
    expect(runs, 0);
    // A corrected call afterwards executes exactly once.
    expect((await run(valid))['status'], 'completed');
    expect((await run(valid))['status'], 'completed');
    expect(runs, 1);
  });

  for (final (platform, registry) in [
    ('android', _android()),
    ('ios', _ios()),
  ]) {
    test('$platform device_run_task description matches its schema', () {
      final tool = registry.definitions.singleWhere(
        (e) => e.name == 'device.run_task',
      );
      final function = tool.wire['function'] as Map;
      final description = function['description'] as String;
      final properties = (tool.parameters['properties'] as Map).keys;
      for (final field in properties) {
        expect(description, contains(field), reason: '$field undocumented');
      }
      for (final field in ['app_name', 'target_package', 'scope']) {
        expect(
          description.contains(field),
          properties.contains(field),
          reason: '$field described on the wrong platform',
        );
      }
      expect(description, contains('never a list'));
    });
  }
}
