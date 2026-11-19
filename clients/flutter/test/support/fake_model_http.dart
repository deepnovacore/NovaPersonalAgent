import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Network answers cross real event-loop turns (stream cancellation, response
/// decoding) before the page reacts, so give them real time, then settle.
Future<void> flushModelNetwork(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump();
  }
  await tester.pumpAndSettle();
}

ModelHttp installModelHttp() {
  final previous = HttpOverrides.current;
  final http = ModelHttp();
  HttpOverrides.global = http;
  addTearDown(() => HttpOverrides.global = previous);
  return http;
}

/// Model listings (GET) and tool probes (POST) wait here until a test answers.
class ModelHttp extends HttpOverrides {
  final lists = <ModelRequest>[];
  final probes = <ModelRequest>[];
  @override
  HttpClient createHttpClient(SecurityContext? context) => ModelClient(this);
}

class ModelClient implements HttpClient {
  ModelClient(this.http);
  final ModelHttp http;
  @override
  Duration? connectionTimeout;
  @override
  Future<HttpClientRequest> getUrl(Uri url) async {
    final request = ModelRequest(url);
    http.lists.add(request);
    return request;
  }

  @override
  Future<HttpClientRequest> postUrl(Uri url) async {
    final request = ModelRequest(url);
    http.probes.add(request);
    return request;
  }

  @override
  void close({bool force = false}) {}
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class ModelRequest implements HttpClientRequest {
  ModelRequest(this.url);
  final Uri url;
  final response = Completer<HttpClientResponse>();
  final StringBuffer _body = StringBuffer();
  String get body => _body.toString();
  @override
  final ModelHeaders headers = ModelHeaders();
  @override
  bool followRedirects = true;

  /// Answers a listing, then lets the page act on it.
  Future<void> complete(
    WidgetTester tester,
    List<String> ids, {
    int status = 200,
  }) {
    response.complete(
      ModelResponse(
        status,
        jsonEncode({
          'data': [
            for (final id in ids) {'id': id},
          ],
        }),
      ),
    );
    return flushModelNetwork(tester);
  }

  /// The model called the test tool.
  Future<void> callTool(WidgetTester tester) {
    final delta = {
      'choices': [
        {
          'delta': {
            'tool_calls': [
              {
                'index': 0,
                'id': 'call_1',
                'type': 'function',
                'function': {'name': 'get_time', 'arguments': '{}'},
              },
            ],
          },
        },
      ],
    };
    response.complete(
      ModelResponse(200, 'data: ${jsonEncode(delta)}\n\ndata: [DONE]\n\n'),
    );
    return flushModelNetwork(tester);
  }

  Future<void> reject(WidgetTester tester, int status) {
    response.complete(
      ModelResponse(
        status,
        jsonEncode({
          'error': {'message': 'Incorrect API key provided'},
        }),
      ),
    );
    return flushModelNetwork(tester);
  }

  @override
  void write(Object? object) => _body.write(object);
  @override
  Future<HttpClientResponse> close() => response.future;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class ModelHeaders implements HttpHeaders {
  final values = <String, Object>{};
  @override
  ContentType? contentType;
  @override
  void set(String name, Object value, {bool preserveHeaderCase = false}) {
    values[name] = value;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class ResponseHeaders implements HttpHeaders {
  @override
  ContentType? get contentType => ContentType('text', 'event-stream');
  @override
  String? value(String name) => null;
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class ModelResponse extends Stream<List<int>> implements HttpClientResponse {
  ModelResponse(this.statusCode, this.body);
  @override
  final int statusCode;
  final String body;
  @override
  final HttpHeaders headers = ResponseHeaders();
  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int>)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => Stream.value(utf8.encode(body)).listen(
    onData,
    onError: onError,
    onDone: onDone,
    cancelOnError: cancelOnError,
  );
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
