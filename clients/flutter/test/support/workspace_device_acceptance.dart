// Isolated debug application entrypoint. No model API, microphone or personal data.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:nova_mobile/agent_core/agent_workspace.dart';
import 'package:nova_mobile/agent_core/workspace_shell.dart';
import 'package:nova_mobile/agent_core/tool_registry.dart';
import 'package:nova_mobile/personal/life_reducer.dart';
import 'package:nova_mobile/personal/local_life.dart';
import 'package:nova_mobile/protocol/request_id.dart';

class _Journal implements LifePersistence {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String data) async {
    value = data;
  }
}

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MaterialApp(home: _Acceptance()));
}

class _Acceptance extends StatefulWidget {
  const _Acceptance();
  @override
  State<_Acceptance> createState() => _AcceptanceState();
}

class _AcceptanceState extends State<_Acceptance> {
  String status = 'Starting workspace acceptance';
  final checks = <Map<String, dynamic>>[];
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(run()));
  }

  void require(bool value, String message) {
    if (!value) throw StateError(message);
  }

  Future<void> check(String name, Future<void> Function() action) async {
    if (mounted) setState(() => status = name);
    try {
      await action();
      checks.add({'name': name, 'passed': true});
    } catch (e) {
      checks.add({'name': name, 'passed': false, 'error': e.toString()});
    }
  }

  Future<void> run() async {
    try {
      final workspace = await AgentWorkspace.open();
      if (Platform.isIOS) {
        if (mounted) {
          setState(
            () => status =
                'Checking app network access; allow the iOS network prompt if shown',
          );
        }
        final network = <String, dynamic>{};
        try {
          network['url_session'] =
              await const MethodChannel('nova/acceptance_network/v1')
                  .invokeMapMethod<String, dynamic>('probe')
                  .timeout(const Duration(seconds: 30));
        } catch (error) {
          network['url_session_error'] = error.toString();
        }
        try {
          network['dns'] =
              (await InternetAddress.lookup(
                    'mirrors.tuna.tsinghua.edu.cn',
                  ).timeout(const Duration(seconds: 8)))
                  .map((address) => address.address)
                  .toList();
        } catch (error) {
          network['dns_error'] = error.toString();
        }
        final client = HttpClient()
          ..connectionTimeout = const Duration(seconds: 8);
        try {
          final response = await (() async {
            final request = await client.headUrl(
              Uri.parse(
                'https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.21/main/aarch64/APKINDEX.tar.gz',
              ),
            );
            return request.close();
          })().timeout(const Duration(seconds: 12));
          network['http_status'] = response.statusCode;
        } catch (error) {
          network['http_error'] = error.toString();
        } finally {
          client.close(force: true);
        }
        await workspace.write(
          'native-network-diagnostics.json',
          jsonEncode(network),
        );
      }
      final shell = WorkspaceShell(workspace);
      final registry = ToolRegistry(
        snapshot: emptyLife,
        mutate: (_, {required operationId}) async => {},
        hasConflict: () => false,
        fetch: (_) async => {},
        workspace: workspace,
        shell: shell,
        automaticExecution: true,
      );
      final journal = ToolJournal(_Journal());
      await journal.open();
      final runner = ToolRunner(registry: registry, journal: journal);
      final turn = requestId(), dir = '/workspace/acceptance-$turn';
      Future<Map<String, dynamic>> tool(
        String name,
        Map<String, dynamic> args,
      ) async {
        final reply = await runner.run(
          turnId: turn,
          callId: requestId(),
          name: name,
          arguments: args,
          approve: (_) async => true,
        );
        require(
          reply['status'] == 'completed',
          'tool terminal ${reply['status']}',
        );
        return Map<String, dynamic>.from(reply['data'] as Map);
      }

      await check('file_shell_same_workspace', () async {
        await tool('file_write', {
          'path': '$dir/文件 🎧.txt',
          'content': 'before\n',
        });
        final output = await tool('shell_execute', {
          'command': "cat '$dir/文件 🎧.txt'",
        });
        require(
          output['exit_code'] == 0 && output['stdout'] == 'before\n',
          'guest did not read native file',
        );
        await tool('file_edit', {
          'path': '$dir/文件 🎧.txt',
          'old_string': 'before',
          'new_string': 'after',
        });
        final edited = await tool('shell_execute', {
          'command':
              "cat '$dir/文件 🎧.txt'; printf 'guest' > '$dir/from-shell.txt'",
        });
        require(
          edited['stdout'] == 'after\n' && edited['exit_code'] == 0,
          'edit not visible',
        );
        require(
          (await tool('file_read', {
                'path': '$dir/from-shell.txt',
              }))['content'] ==
              'guest',
          'native did not read guest file',
        );
      });
      await check('browser_command_executes_saved_dom', () async {
        await tool('file_write', {
          'path': '$dir/index.html',
          'content':
              '<html><body><button id="b" onclick="this.textContent=42">Click</button></body></html>',
        });
        await tool('file_write', {
          'path': '$dir/check.js',
          'content':
              'document.querySelector("#b").click(); return {answer:document.querySelector("#b").textContent};',
        });
        final output = await tool('shell_execute', {
          'command':
              'nova-browser inspect --path $dir/index.html --script $dir/check.js',
          'timeout': 60,
        });
        require(
          output['exit_code'] == 0,
          'browser command failed: ${output['stderr']}',
        );
        final value = jsonDecode(output['stdout'] as String) as Map;
        require(
          value['loaded'] == true && value['result']['answer'] == '42',
          'real DOM result missing',
        );
      });
      await check('nonzero_exit_and_separate_stderr', () async {
        final output = await tool('shell_execute', {
          'command': 'printf out; printf err >&2; exit 7',
        });
        require(
          output['stdout'] == 'out' &&
              output['stderr'] == 'err' &&
              output['exit_code'] == 7,
          'incorrect streams/exit',
        );
      });
      await check('timeout_stops_command', () async {
        final output = await shell.run({
          'command': 'printf partial; sleep 30',
          'timeout': 1,
        }, requestId());
        require(
          output['status'] == 'timed_out' && output['stdout'] == 'partial',
          'timeout not confirmed: ${output['status']}',
        );
      });
      await check('cancel_targets_running_process', () async {
        final id = requestId();
        final pending = shell.run({
          'command': "printf started > '$dir/started'; sleep 30",
          'timeout': 35,
        }, id);
        var started = false;
        for (var i = 0; i < 100; i++) {
          try {
            started =
                (await workspace.read('$dir/started'))['content'] == 'started';
          } catch (_) {}
          if (started) break;
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        await shell.cancel();
        final output = await pending;
        require(started, 'command did not reach its readiness marker');
        require(
          output['status'] == 'cancelled',
          'cancellation not confirmed: ${output['status']}',
        );
      });
      if (Platform.isIOS) {
        final network = await shell.run({
          'command':
              'cat /etc/resolv.conf; timeout 6 nslookup dl-cdn.alpinelinux.org; timeout 6 nslookup dl-cdn.alpinelinux.org 1.1.1.1; wget -S -T 6 -O /tmp/nova-network-test https://dl-cdn.alpinelinux.org/alpine/v3.21/main/aarch64/APKINDEX.tar.gz',
          'timeout': 25,
        }, requestId());
        await workspace.write('network-diagnostics.json', jsonEncode(network));
      }
      await check('python_package_and_script', () async {
        await tool('file_write', {
          'path': '$dir/check.py',
          'content': 'print(sum(range(10)))\n',
        });
        // Test-only regional mirror override; retain Alpine package signatures
        // and leave the installed runtime's repository configuration untouched.
        const mirror = String.fromEnvironment('NOVA_ACCEPTANCE_APK_MIRROR');
        require(
          mirror.isEmpty ||
              RegExp(r'^https://[a-zA-Z0-9.-]+/alpine$').hasMatch(mirror),
          'invalid acceptance mirror',
        );
        final install = mirror.isEmpty
            ? 'apk add --no-cache python3'
            : "sed 's|https://dl-cdn.alpinelinux.org/alpine|$mirror|g' /etc/apk/repositories > '$dir/repositories' && apk --repositories-file '$dir/repositories' add --no-cache python3";
        final output = await tool('shell_execute', {
          'command':
              '$install >/tmp/nova-python-install.log 2>&1 || { cat /tmp/nova-python-install.log >&2; exit 1; }; python3 $dir/check.py',
          'timeout': 180,
        });
        require(
          output['exit_code'] == 0 &&
              (output['stdout'] as String).trim() == '45',
          'python installation/execution failed (${output['exit_code']}): ${output['stderr']}',
        );
      });
    } catch (e) {
      checks.add({'name': 'setup', 'passed': false, 'error': e.toString()});
    }
    final report = {
      'suite': 'mobile_general_workspace',
      'passed': checks.isNotEmpty && checks.every((c) => c['passed'] == true),
      'checks': checks,
    };
    try {
      await (await AgentWorkspace.open()).write(
        'acceptance-report.json',
        jsonEncode(report),
      );
    } catch (error) {
      report['report_write_error'] = error.toString();
    }
    debugPrint(
      'WORKSPACE_ACCEPTANCE_JSON ${jsonEncode(report)}',
      wrapWidth: null,
    );
    if (mounted) {
      setState(() => status = report['passed'] == true ? 'PASS' : 'FAIL');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            '$status\n${const JsonEncoder.withIndent('  ').convert(checks)}',
          ),
        ),
      ),
    ),
  );
}
