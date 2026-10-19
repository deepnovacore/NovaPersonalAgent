import 'dart:async';
import 'dart:convert';
import 'package:flutter/services.dart';
import 'agent_workspace.dart';
import 'model_client.dart';
import 'workspace_browser.dart';

typedef WorkspaceNativeCall =
    Future<Map<String, dynamic>> Function(
      String method,
      Map<String, dynamic> arguments,
    );

/// The interpreter is native Linux. Dart supplies orchestration, never executes
/// model commands with the phone host's shell or a desktop substitute.
class WorkspaceShell {
  WorkspaceShell(this.workspace, {WorkspaceNativeCall? native})
    : native = native ?? _call;
  final AgentWorkspace workspace;
  final WorkspaceNativeCall native;
  static const channel = MethodChannel('nova/workspace/v1');
  static const _prepareBrowser =
      'chmod 700 /workspace/.nova/bin/nova-browser || exit \$?\n';
  bool _ready = false;
  String? _id;
  bool _cancelled = false;
  bool _submitted = false;
  bool get busy => _id != null;
  static Future<Map<String, dynamic>> _call(
    String method,
    Map<String, dynamic> args,
  ) async => Map<String, dynamic>.from(
    await channel.invokeMapMethod<String, dynamic>(method, args) ?? {},
  );

  Future<Map<String, dynamic>> run(
    Map<String, dynamic> arguments,
    String id,
  ) async {
    if (busy) throw const AgentFailure('shell_busy');
    final command = arguments['command'];
    final timeout = arguments['timeout'] ?? 60;
    if (command is! String ||
        command.trim().isEmpty ||
        command.contains('\u0000') ||
        utf8.encode('$_prepareBrowser$command').length > 65536 ||
        timeout is! int ||
        timeout < 1 ||
        timeout > 3600 ||
        !RegExp(r'^[a-zA-Z0-9_-]{1,128}$').hasMatch(id)) {
      throw const AgentFailure('invalid_shell_arguments');
    }
    final cwd = workspace.normalize(
      arguments['cwd'] as String? ?? '/workspace',
    );
    _id = id;
    _cancelled = false;
    _submitted = false;
    WorkspaceBrowser? browser;
    try {
      await workspace.initialize();
      if (!_ready) {
        Map<String, dynamic> initialized;
        try {
          initialized = await native('initialize', {
            'root_path': workspace.root.path,
          });
        } on PlatformException {
          throw const AgentFailure('linux_runtime_unavailable');
        } on MissingPluginException {
          throw const AgentFailure('linux_runtime_unavailable');
        }
        if (initialized['ready'] != true) {
          throw const AgentFailure('linux_runtime_unavailable');
        }
        _ready = true;
      }
      if (_cancelled) {
        return {
          'status': 'cancelled',
          'stdout': '',
          'stderr': '',
          'exit_code': null,
          'truncated': false,
        };
      }
      await workspace.write('.nova/bin/nova-browser', browserCommand);
      browser = await WorkspaceBrowser.start(workspace);
      if (_cancelled) {
        return {
          'status': 'cancelled',
          'stdout': '',
          'stderr': '',
          'exit_code': null,
          'truncated': false,
        };
      }
      _submitted = true;
      final result = await native('execute', {
        'id': id,
        'command': '$_prepareBrowser$command',
        'cwd': cwd,
        'timeout_ms': timeout * 1000,
        'environment': browser.environment,
      }).timeout(Duration(seconds: timeout + 10));
      if (![
            'completed',
            'cancelled',
            'timed_out',
            'outcome_unknown',
          ].contains(result['status']) ||
          result['stdout'] is! String ||
          result['stderr'] is! String ||
          (result['status'] == 'completed' && result['exit_code'] is! int)) {
        throw const AgentFailure('invalid_shell_result');
      }
      return result;
    } catch (error) {
      if (_submitted) {
        try {
          await native('cancel', {
            'id': id,
          }).timeout(const Duration(seconds: 2));
        } catch (_) {}
        return {
          'status': 'outcome_unknown',
          'stdout': '',
          'stderr':
              'Shell result unavailable; inspect existing effects before retrying.',
          'exit_code': null,
          'truncated': false,
        };
      }
      rethrow;
    } finally {
      await browser?.close();
      _id = null;
      _submitted = false;
    }
  }

  Future<void> cancel() async {
    final id = _id;
    if (id == null) return;
    _cancelled = true;
    if (_submitted) {
      try {
        await native('cancel', {'id': id}).timeout(const Duration(seconds: 2));
      } catch (_) {
        /* execute remains authoritative */
      }
    }
  }
}
