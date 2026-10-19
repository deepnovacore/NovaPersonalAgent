import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:nova_mobile/agent_core/model_client.dart';
import 'package:nova_mobile/agent_core/agent_workspace.dart';
import 'package:nova_mobile/agent_core/workspace_shell.dart';
import 'package:nova_mobile/agent_core/workspace_browser.dart';

class DelayedWorkspace extends AgentWorkspace {
  DelayedWorkspace(super.root)
    : super(inspect: (html, script) async => {'loaded': true});
  final resolving = Completer<void>();
  final release = Completer<void>();
  bool delayed = false;
  @override
  Future<File> resolve(String path) async {
    if (!delayed) {
      delayed = true;
      resolving.complete();
      await release.future;
    }
    return super.resolve(path);
  }
}

void main() {
  late Directory root;
  late AgentWorkspace workspace;
  setUp(() async {
    root = await Directory.systemTemp.createTemp('shell-test-');
    workspace = AgentWorkspace(
      root,
      inspect: (html, script) async => {
        'loaded': true,
        'result': html + script,
      },
    );
    await workspace.initialize();
  });
  tearDown(() async => root.delete(recursive: true));
  test(
    'shell passes guest cwd, command, deadline and scoped browser environment to native',
    () async {
      final calls = <String>[];
      final shell = WorkspaceShell(
        workspace,
        native: (method, input) async {
          calls.add(method);
          if (method == 'initialize') {
            expect(input['root_path'], root.path);
            return {'ready': true};
          }
          expect(input['id'], 'exec-1');
          expect(input['cwd'], '/workspace');
          expect(input['command'], contains('printf hello'));
          expect(input['timeout_ms'], 12000);
          expect(input['environment']['NOVA_BROWSER_TOKEN'], isNotEmpty);
          return {
            'status': 'completed',
            'stdout': 'hello',
            'stderr': '',
            'exit_code': 7,
            'truncated': false,
          };
        },
      );
      final result = await shell.run({
        'command': 'printf hello',
        'timeout': 12,
      }, 'exec-1');
      expect(result['stdout'], 'hello');
      expect(result['exit_code'], 7);
      expect(calls, ['initialize', 'execute']);
      expect(shell.busy, false);
      expect(await File('${root.path}/.nova/bin/nova-browser').exists(), true);
    },
  );
  test(
    'cancellation targets the active execution and preserves terminal evidence',
    () async {
      final started = Completer<void>(),
          done = Completer<Map<String, dynamic>>();
      final shell = WorkspaceShell(
        workspace,
        native: (method, args) async {
          if (method == 'initialize') return {'ready': true};
          if (method == 'execute') {
            started.complete();
            return done.future;
          }
          expect(method, 'cancel');
          expect(args['id'], 'cancel-me');
          done.complete({
            'status': 'cancelled',
            'stdout': 'partial',
            'stderr': '',
            'exit_code': 137,
            'truncated': false,
          });
          return {};
        },
      );
      final pending = shell.run({'command': 'sleep 90'}, 'cancel-me');
      await started.future;
      await shell.cancel();
      final result = await pending;
      expect(result['status'], 'cancelled');
      expect(result['stdout'], 'partial');
      await shell.cancel(); // Idle cancellation never targets another worker.
    },
  );
  test(
    'browser endpoint authenticates and executes the exact saved sources',
    () async {
      await workspace.write('index.html', '<html>saved</html>');
      await workspace.write('check.js', 'return 42;');
      final bridge = await WorkspaceBrowser.start(workspace);
      final http = HttpClient();
      Future<(int, String)> post(String token, String body) async {
        final request = await http.postUrl(
          Uri.parse(bridge.environment['NOVA_BROWSER_URL']!),
        );
        request.headers.set('X-Nova-Token', token);
        request.write(body);
        final reply = await request.close();
        return (reply.statusCode, await utf8.decoder.bind(reply).join());
      }

      try {
        expect(
          (await post(
            'wrong',
            '/workspace/index.html\n/workspace/check.js',
          )).$1,
          403,
        );
        final result = await post(
          bridge.environment['NOVA_BROWSER_TOKEN']!,
          '/workspace/index.html\n/workspace/check.js',
        );
        expect(result.$1, 200);
        expect(jsonDecode(result.$2)['result'], '<html>saved</html>return 42;');
        expect(
          (await post(
            bridge.environment['NOVA_BROWSER_TOKEN']!,
            '/etc/passwd\n/workspace/check.js',
          )).$1,
          400,
        );
      } finally {
        http.close(force: true);
        await bridge.close();
      }
    },
  );
  test(
    'browser serializes requests before asynchronous path validation',
    () async {
      await workspace.write('index.html', '<html>saved</html>');
      await workspace.write('check.js', 'return 42;');
      final delayed = DelayedWorkspace(root);
      final bridge = await WorkspaceBrowser.start(delayed);
      final http = HttpClient();
      Future<int> post() async {
        final request = await http.postUrl(
          Uri.parse(bridge.environment['NOVA_BROWSER_URL']!),
        );
        request.headers.set(
          'X-Nova-Token',
          bridge.environment['NOVA_BROWSER_TOKEN']!,
        );
        request.write('/workspace/index.html\n/workspace/check.js');
        final response = await request.close();
        await response.drain<void>();
        return response.statusCode;
      }

      final first = post();
      try {
        await delayed.resolving.future;
        expect(await post(), 429);
      } finally {
        delayed.release.complete();
        await first;
        http.close(force: true);
        await bridge.close();
      }
    },
  );
  test(
    'initialization failure is known not to have dispatched the command',
    () async {
      final calls = <String>[];
      final shell = WorkspaceShell(
        workspace,
        native: (method, args) async {
          calls.add(method);
          throw PlatformException(code: 'runtime_resources_missing');
        },
      );
      await expectLater(
        shell.run({'command': 'touch marker'}, 'not-started'),
        throwsA(
          isA<AgentFailure>().having(
            (error) => error.code,
            'code',
            'linux_runtime_unavailable',
          ),
        ),
      );
      expect(calls, ['initialize']);
      expect(shell.busy, false);
    },
  );
  test('invalid native command bytes are rejected before dispatch', () async {
    final calls = <String>[];
    final shell = WorkspaceShell(
      workspace,
      native: (method, args) async {
        calls.add(method);
        return method == 'initialize'
            ? {'ready': true}
            : {
                'status': 'completed',
                'stdout': '',
                'stderr': '',
                'exit_code': 0,
                'truncated': false,
              };
      },
    );
    for (final command in ['echo bad\u0000command', '中' * 30000, 'x' * 65536]) {
      await expectLater(
        shell.run({'command': command}, 'invalid-bytes'),
        throwsA(
          isA<AgentFailure>().having(
            (error) => error.code,
            'code',
            'invalid_shell_arguments',
          ),
        ),
      );
    }
    expect(calls, isEmpty);
  });
  test(
    'native transport failure is unknown rather than a completed shell command',
    () async {
      final shell = WorkspaceShell(
        workspace,
        native: (method, args) async {
          if (method == 'initialize') return {'ready': true};
          throw StateError('lost transport');
        },
      );
      expect(
        (await shell.run({
          'command': 'touch /workspace/file',
        }, 'uncertain'))['status'],
        'outcome_unknown',
      );
      expect(shell.busy, false);
    },
  );
}
