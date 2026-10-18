// Standalone device entrypoint; no personal store, model API, or audio access.
// Root builds/installs this in the isolated .autonomy application package.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

const _channel = MethodChannel('nova/artifacts/v1');
const _exerciseTimeout = bool.fromEnvironment('ARTIFACT_ACCEPTANCE_TIMEOUT');
const _openPreview = bool.fromEnvironment('ARTIFACT_ACCEPTANCE_PREVIEW');
const _simpleHtml = '''<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Native artifact acceptance</title></head><body>
<h1 id="heading">Local HTML works</h1>
<button id="increment">Increment</button><output id="count">0</output>
<script>document.querySelector('#increment').addEventListener('click',()=>{
const count=document.querySelector('#count'); count.textContent=String(Number(count.textContent)+1);
});</script></body></html>''';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const _AcceptanceApp());
}

class _AcceptanceApp extends StatefulWidget {
  const _AcceptanceApp();
  @override
  State<_AcceptanceApp> createState() => _AcceptanceAppState();
}

class _AcceptanceAppState extends State<_AcceptanceApp> {
  final _rows = <Map<String, Object?>>[];
  bool _finished = false, _stop = false;
  String _status = 'Waiting for native foreground';
  HttpServer? _server;
  Directory? _temporary;
  int _requests = 0;
  String? _lastNativeResult;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(_start());
    });
  }

  Future<Map<String, dynamic>> _inspect(String html, String script) async {
    final raw = await _channel
        .invokeMethod<Object?>('inspect', {'html': html, 'script': script})
        .timeout(const Duration(seconds: 20));
    if (raw is! Map) throw StateError('non_map_result');
    final result = Map<String, dynamic>.from(raw);
    final encoded = jsonEncode(
      result,
    ).replaceAll(RegExp(r'file:[^"\s]+'), 'file:[synthetic-fixture]');
    _lastNativeResult = encoded.length > 2500
        ? '${encoded.substring(0, 2500)}...[truncated]'
        : encoded;
    return result;
  }

  void _require(bool condition, String code) {
    if (!condition) throw StateError(code);
  }

  Future<void> _case(String name, Future<void> Function() run) async {
    if (_stop) return;
    if (mounted) setState(() => _status = name);
    final clock = Stopwatch()..start();
    _lastNativeResult = null;
    try {
      await run().timeout(const Duration(seconds: 23));
      _rows.add({
        'name': name,
        'passed': true,
        'elapsed_ms': clock.elapsedMilliseconds,
      });
    } catch (error) {
      // Only fixed fixture verdicts/native error codes; no page source or paths.
      final code = switch (error) {
        PlatformException value => value.code,
        TimeoutException _ => 'fixture_timeout',
        StateError value => value.message.toString(),
        _ => 'fixture_exception',
      };
      _rows.add({
        'name': name,
        'passed': false,
        'error': code,
        'native_result': _lastNativeResult,
        'elapsed_ms': clock.elapsedMilliseconds,
      });
    }
    if (mounted) setState(() {});
  }

  Future<void> _start() async {
    try {
      // Native MainActivity must have completed onResume, not only engine setup.
      await Future<void>.delayed(const Duration(seconds: 1));
      await _suite().timeout(const Duration(seconds: 100));
    } catch (_) {
      _stop = true;
      _rows.add({
        'name': 'suite_completion',
        'passed': false,
        'error': 'suite_setup_or_timeout',
      });
    } finally {
      _stop = true;
      try {
        await _server?.close(force: true).timeout(const Duration(seconds: 2));
      } catch (_) {}
      try {
        await _temporary
            ?.delete(recursive: true)
            .timeout(const Duration(seconds: 2));
      } catch (_) {}
      final report = {
        'schema_version': 1,
        'suite': 'android_native_artifact_webview',
        'platform': Platform.operatingSystem,
        'passed':
            _rows.isNotEmpty && _rows.every((row) => row['passed'] == true),
        'checks': List<Map<String, Object?>>.from(_rows),
        'loopback_requests': _requests,
        'native_timeout_test': _exerciseTimeout ? 'requested' : 'not_run',
        'fullscreen_preview': _openPreview
            ? 'open_requested_close_requires_ui_check'
            : 'manual_button_available',
        'personal_store_used': false,
      };
      // One machine-readable terminal record, intentionally free of credentials.
      debugPrint(
        'ARTIFACT_ACCEPTANCE_JSON ${jsonEncode(report)}',
        wrapWidth: null,
      );
      if (mounted) {
        setState(() {
          _finished = true;
          _status = report['passed'] == true ? 'PASS' : 'FAIL';
        });
      }
      if (_openPreview && !_exerciseTimeout && mounted) await _preview();
    }
  }

  Future<void> _suite() async {
    await _case('dom_interaction_and_json_contract', () async {
      final value = await _inspect(_simpleHtml, '''
        document.querySelector('#increment').click();
        document.querySelector('#increment').click();
        return {heading:document.querySelector('#heading').textContent,
          count:Number(document.querySelector('#count').textContent),
          nested:{values:[true,null,2.5]},viewport:innerWidth>0};
      ''');
      _require(
        value['loaded'] == true &&
            value['title'] == 'Native artifact acceptance',
        'document_not_loaded',
      );
      _require(
        value['errors'] is List && (value['errors'] as List).isEmpty,
        'unexpected_javascript_errors',
      );
      final result = value['result'];
      _require(
        result is Map &&
            result['count'] == 2 &&
            result['heading'] == 'Local HTML works' &&
            result['viewport'] == true,
        'dom_interaction_failed',
      );
      _require(
        jsonEncode(result['nested']) == '{"values":[true,null,2.5]}',
        'nested_json_contract_failed',
      );
    });

    await _case('runtime_and_rejection_error_capture', () async {
      final value = await _inspect('''<!doctype html><script>
        setTimeout(()=>{throw new Error('synthetic_preview_error');},0);
        Promise.reject('synthetic_preview_rejection');
      </script>''', 'return {ran:true};');
      final errors = value['errors'];
      _require(
        value['loaded'] == true && errors is List,
        'error_contract_failed',
      );
      _require(
        (errors as List).any(
          (e) => e.toString().contains('synthetic_preview_error'),
        ),
        'runtime_error_not_captured',
      );
      _require(
        errors.any((e) => e.toString().contains('synthetic_preview_rejection')),
        'rejection_not_captured',
      );
    });

    await _case('test_script_exception_is_reported', () async {
      final value = await _inspect(
        _simpleHtml,
        "throw new Error('synthetic_test_exception');",
      );
      _require(
        value['loaded'] == true &&
            (value['errors'] as List? ?? []).any(
              (e) => e.toString().contains('synthetic_test_exception'),
            ),
        'test_exception_not_reported',
      );
    });

    _temporary = await Directory.systemTemp.createTemp(
      'nova-artifact-acceptance-',
    );
    final secret = File('${_temporary!.path}/synthetic-only.txt');
    await secret.writeAsString('synthetic_fixture_marker_not_personal_data');
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server!.listen((request) async {
      _requests++;
      request.response.headers.set('Access-Control-Allow-Origin', '*');
      request.response.write('unexpected_fixture_network_access');
      await request.response.close();
    });
    final address = 'http://127.0.0.1:${_server!.port}/blocked';
    final file = secret.uri.toString();
    await _case('network_file_and_iframe_are_denied', () async {
      final value = await _inspect(
        '''<!doctype html><html><head><script>
        window.checks={network:'pending',file:'pending',socket:'pending',violations:[]};
        addEventListener('securitypolicyviolation',e=>checks.violations.push({directive:e.effectiveDirective,uri:e.blockedURI}));
        fetch(${jsonEncode(address)}).then(()=>checks.network='allowed',()=>checks.network='blocked');
        fetch(${jsonEncode(file)}).then(()=>checks.file='allowed',()=>checks.file='blocked');
        try {const socket=new WebSocket(${jsonEncode(address.replaceFirst('http:', 'ws:'))});
          socket.onopen=()=>{checks.socket='allowed';socket.close();};
          socket.onerror=()=>checks.socket='blocked';
        }catch(e){checks.socket='blocked';}
      </script></head><body><iframe id="outside" src="$address"></iframe></body></html>''',
        '''
        return {...checks, iframeReadable:!!document.querySelector('#outside').contentDocument};
      ''',
      );
      final result = value['result'];
      _require(
        value['loaded'] == true && result is Map,
        'isolation_document_not_loaded',
      );
      _require(
        result['network'] == 'blocked' &&
            result['file'] == 'blocked' &&
            result['socket'] == 'blocked',
        'network_or_file_not_denied',
      );
      final violations = result['violations'] as List? ?? [];
      _require(
        violations.any((v) => v is Map && v['directive'] == 'connect-src'),
        'connect_csp_not_observed',
      );
      _require(
        violations.any(
          (v) =>
              v is Map &&
              (v['directive'] == 'frame-src' || v['directive'] == 'child-src'),
        ),
        'frame_csp_not_observed',
      );
      _require(_requests == 0, 'loopback_server_received_request');
      // A blocked frame can retain its initial empty about:blank document. Its
      // readability alone is not evidence that external content was loaded.
    });

    await _case('oversized_result_is_rejected', () async {
      final value = await _inspect(_simpleHtml, "return 'x'.repeat(40000);");
      _require(
        (value['errors'] as List? ?? []).contains('invalid_test_result'),
        'oversized_result_was_accepted',
      );
    });

    await _case('consecutive_inspection_cleanup', () async {
      for (var i = 0; i < 3; i++) {
        final value = await _inspect(_simpleHtml, 'return {sequence:$i};');
        _require(
          value['loaded'] == true &&
              (value['result'] as Map?)?['sequence'] == i,
          'inspection_not_released',
        );
      }
    });

    if (_exerciseTimeout) {
      // Opt-in, last case: renderer nontermination should hit the native15s
      // watchdog. Root must force-stop the isolated app afterward if needed.
      await _case('native_nonterminating_script_timeout', () async {
        final clock = Stopwatch()..start();
        final value = await _inspect(_simpleHtml, 'while(true){}');
        _require(
          value['loaded'] == false &&
              (value['errors'] as List? ?? []).contains('preview_timeout'),
          'native_timeout_not_reported',
        );
        _require(
          clock.elapsedMilliseconds >= 14000 &&
              clock.elapsedMilliseconds < 20000,
          'native_timeout_out_of_bounds',
        );
      });
    }
  }

  Future<void> _preview() async {
    try {
      await _channel
          .invokeMethod<Object?>('open', {
            'html': _simpleHtml,
            'title': 'Artifact acceptance · close to return',
          })
          .timeout(const Duration(seconds: 5));
    } catch (_) {
      if (mounted) setState(() => _status = 'Preview open failed');
    }
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    home: Scaffold(
      appBar: AppBar(title: const Text('Native artifact acceptance')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              _status,
              key: const ValueKey('artifact-acceptance-status'),
              style: const TextStyle(fontSize: 28, fontWeight: FontWeight.bold),
            ),
            const Text(
              'Synthetic local HTML/JavaScript only. No model credentials, audio, or personal artifact store.',
            ),
            const SizedBox(height: 16),
            for (final row in _rows)
              ListTile(
                leading: Icon(
                  row['passed'] == true ? Icons.check_circle : Icons.error,
                  color: row['passed'] == true ? Colors.green : Colors.red,
                ),
                title: Text(row['name'] as String),
                subtitle: Text(
                  row['error']?.toString() ?? '${row['elapsed_ms']} ms',
                ),
              ),
            if (_finished)
              FilledButton(
                onPressed: () => unawaited(_preview()),
                child: const Text('Open native preview'),
              ),
            if (!_finished) const LinearProgressIndicator(),
          ],
        ),
      ),
    ),
  );
}
