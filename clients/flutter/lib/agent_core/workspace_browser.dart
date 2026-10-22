import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'agent_workspace.dart';
import 'model_client.dart';

const browserScriptInstructions =
    'check.js must contain a synchronous JavaScript function BODY, with no enclosing function or arrow wrapper, no Promise, await or timer-based checks. Example: const button = document.querySelector("button"); if (!button) throw new Error("missing button"); button.click(); return {title: document.title, clicked: true}; Return JSON-safe data and throw on failed assertions. execution_ok only means the inspection ran without reported errors; inspect the returned checks before claiming behavior passed.';

/// A short-lived capability for a single guest execution. No public listener,
/// host file paths, model credentials, or native commands cross this bridge.
class WorkspaceBrowser {
  WorkspaceBrowser._(this.workspace, this.server, this.token);
  final AgentWorkspace workspace;
  final HttpServer server;
  final String token;
  bool _closed = false;
  bool _inspecting = false;
  int _requests = 0;

  static Future<WorkspaceBrowser> start(AgentWorkspace workspace) async {
    final random = Random.secure();
    final token = base64Url.encode(
      List.generate(32, (_) => random.nextInt(256)),
    );
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final bridge = WorkspaceBrowser._(workspace, server, token);
    server.listen((request) => unawaited(bridge._request(request)));
    return bridge;
  }

  Map<String, String> get environment => {
    'NOVA_BROWSER_URL': 'http://127.0.0.1:${server.port}/inspect',
    'NOVA_BROWSER_TOKEN': token,
  };

  Future<void> _request(HttpRequest request) async {
    var ownsInspection = false;
    try {
      if (_closed || request.headers.value('X-Nova-Token') != token) {
        request.response.statusCode = 403;
      } else if (request.method != 'POST' || request.uri.path != '/inspect') {
        request.response.statusCode = 404;
      } else if (_inspecting || ++_requests > 32) {
        request.response.statusCode = 429;
      } else {
        _inspecting = true;
        ownsInspection = true;
        final bytes = <int>[];
        await for (final chunk in request.timeout(const Duration(seconds: 5))) {
          bytes.addAll(chunk);
          if (bytes.length > 8192) {
            throw const AgentFailure('browser_request_too_large');
          }
        }
        final paths = utf8.decode(bytes).split('\n');
        if (paths.length != 2 || paths.any((p) => p.isEmpty)) {
          throw const AgentFailure('invalid_browser_paths');
        }
        // Validate before running WebKit; even an authorized guest can only
        // ask the renderer to inspect files in this execution's workspace.
        await workspace.resolve(paths[0]);
        await workspace.resolve(paths[1]);
        if (_closed) throw const AgentFailure('browser_closed');
        final result = await workspace.inspectFiles(paths[0], paths[1]);
        request.response.headers.contentType = ContentType.json;
        final ok =
            result['loaded'] == true &&
            result['errors'] is List &&
            (result['errors'] as List).isEmpty;
        // Keep HTTP 200 for completed inspections so BusyBox wget retains errors.
        request.response.write(
          jsonEncode(
            {
              'execution_ok': ok,
              ...result,
              if (!ok)
                'hint':
                    'Inspection failed; read errors, fix the page or check script, and rerun. $browserScriptInstructions',
            }..['execution_ok'] = ok,
          ),
        );
      }
    } catch (error) {
      request.response.statusCode = 400;
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'error': error is AgentFailure
              ? error.code
              : 'browser_inspection_failed',
        }),
      );
    } finally {
      if (ownsInspection) _inspecting = false;
      try {
        await request.response.close();
      } catch (_) {
        /* Guest cancelled. */
      }
    }
  }

  Future<void> close() async {
    _closed = true;
    await server.close(force: true);
  }
}

const browserCommand = r'''#!/bin/sh
set -eu
if [ "${1:-}" != inspect ]; then
  echo 'usage: nova-browser inspect --path /workspace/index.html --script /workspace/check.js' >&2
  exit 2
fi
shift
page=''
script=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --path) [ "$#" -ge 2 ] || exit 2; page="$2"; shift 2 ;;
    --script) [ "$#" -ge 2 ] || exit 2; script="$2"; shift 2 ;;
    *) echo 'unknown nova-browser argument' >&2; exit 2 ;;
  esac
done
[ -n "$page" ] && [ -n "$script" ] || exit 2
[ -n "${NOVA_BROWSER_URL:-}" ] && [ -n "${NOVA_BROWSER_TOKEN:-}" ] || {
  echo 'nova-browser must run inside an active Nova shell task' >&2; exit 1;
}
status=0
response=$(/bin/busybox wget -q -O - --timeout=25 \
  --header "X-Nova-Token: $NOVA_BROWSER_TOKEN" \
  --post-data "$(printf '%s\n%s' "$page" "$script")" "$NOVA_BROWSER_URL") || status=$?
printf '%s\n' "$response"
if [ "$status" -ne 0 ]; then
  echo 'Browser request failed; inspection did not complete.' >&2
  exit "$status"
fi
case "$response" in
  '{"execution_ok":true,'*) exit 0 ;;
  *) echo 'Browser inspection failed; read the JSON errors and hint, fix and rerun.' >&2; exit 1 ;;
esac
''';
